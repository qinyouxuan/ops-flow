// SPDX-License-Identifier: MPL-2.0

import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, safeStorage, shell } from 'electron'
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { createGzip, createGunzip, gunzipSync } from 'node:zlib'
import Module, { createRequire } from 'node:module'
import Store from 'electron-store'
import { Client } from 'ssh2'
import mysql from 'mysql2/promise'
import pg from 'pg'
import mssql from 'mssql'
import oracledb from 'oracledb'
import ExcelJS from 'exceljs'
import { createClient as createRedisClient } from 'redis'
import {
  containsCredentials,
  decryptConfigBackup,
  encryptConfigBackup,
  normalizeConfigSnapshot,
  sanitizeConfigObject,
  summarizeConfig
} from './configCrypto.mjs'
import { inspectDatabaseColumnMetadata, setDatabaseColumnComment } from './database/columnMetadataAdapters.mjs'

const shellSessions = new Map()
let dmdbDriverPromise = null
let dmdbDriverLoadedPath = ''
const shellSessionsByWebContents = new Map()
const sshExecSessions = new Map()
const workflowSshSessions = new Map()
const workflowPrivilegeCredentials = new Map()
const databaseScriptSessions = new Map()
const databaseQueryExportSessions = new Map()
const databaseBackupSessions = new Map()
const redisBackupSessions = new Map()
const redisRestoreSessions = new Map()
const fileTransferSessions = new Map()
const fileTransferProgressEmitTimes = new Map()
const sshTunnelSessions = new Map()
const pendingConfigImports = new Map()
const damengLegacyWorkers = new Set()

const PROTECTED_STORE_KEYS = new Set(['resources', 'servers', 'databases', 'redisStores', 'redis'])
const LOCAL_SECRET_MARKER = '__opsFlowProtectedSecretV1'
const MAX_CONFIG_BACKUP_BYTES = 25 * 1024 * 1024
const CONFIG_IMPORT_TTL_MS = 10 * 60 * 1000
const DAMENG_DRIVER_STORE_KEY = 'damengDriverPath'
const DAMENG_LEGACY_MODE_STORE_KEY = 'damengLegacyCompatibilityEnabled'
const DAMENG_LEGACY_NODE_STORE_KEY = 'damengLegacyNodePath'
const DAMENG_LOCAL_STORE_KEYS = [
  DAMENG_DRIVER_STORE_KEY,
  DAMENG_LEGACY_MODE_STORE_KEY,
  DAMENG_LEGACY_NODE_STORE_KEY
]

if (process.platform === 'win32' && app.isPackaged) {
  app.setAppUserModelId('com.opsflow.plus')
}

const store = new Store({
  name: 'ops-flow',
  defaults: {
    resources: [],
    servers: [],
    databases: [],
    redisStores: [],
    redis: [],
    sshTunnels: [],
    workflows: []
  }
})

function isSensitiveLocalKey(key) {
  return /(?:password|passphrase|privatekey|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret)$/i.test(String(key || ''))
}

function localCredentialProtectionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function transformLocalSecrets(value, mode, key = '', depth = 0) {
  if (depth > 80) throw new Error('Configuration nesting is too deep.')
  if (mode === 'decrypt' && value && typeof value === 'object' && !Array.isArray(value) && value[LOCAL_SECRET_MARKER] === true) {
    if (!localCredentialProtectionAvailable()) throw new Error('本机凭据保护当前不可用，无法读取已加密的连接凭据。')
    return safeStorage.decryptString(Buffer.from(String(value.value || ''), 'base64'))
  }
  if (mode === 'encrypt' && isSensitiveLocalKey(key) && typeof value === 'string' && value) {
    if (!localCredentialProtectionAvailable()) return value
    return {
      [LOCAL_SECRET_MARKER]: true,
      value: safeStorage.encryptString(value).toString('base64')
    }
  }
  if (Array.isArray(value)) return value.map((item) => transformLocalSecrets(item, mode, '', depth + 1))
  if (!value || typeof value !== 'object') return value

  const output = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) continue
    output[childKey] = transformLocalSecrets(childValue, mode, childKey, depth + 1)
  }
  return output
}

function readStoreValue(key) {
  const value = store.get(key)
  return PROTECTED_STORE_KEYS.has(String(key)) ? transformLocalSecrets(value, 'decrypt') : value
}

function writeStoreValue(key, value) {
  const safeValue = PROTECTED_STORE_KEYS.has(String(key)) ? transformLocalSecrets(value, 'encrypt') : value
  store.set(key, safeValue)
  return value
}

function readDecryptedStoreSnapshot() {
  const snapshot = { ...store.store }
  for (const key of DAMENG_LOCAL_STORE_KEYS) delete snapshot[key]
  for (const key of PROTECTED_STORE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) snapshot[key] = transformLocalSecrets(snapshot[key], 'decrypt')
  }
  return sanitizeConfigObject(snapshot)
}

function protectConfigForLocalStorage(config) {
  const protectedConfig = sanitizeConfigObject(config)
  for (const key of PROTECTED_STORE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(protectedConfig, key)) {
      protectedConfig[key] = transformLocalSecrets(protectedConfig[key], 'encrypt')
    }
  }
  return protectedConfig
}

function migrateLocalCredentials() {
  if (!localCredentialProtectionAvailable()) return false
  let changed = false
  for (const key of PROTECTED_STORE_KEYS) {
    const current = store.get(key)
    if (current === undefined) continue
    const protectedValue = transformLocalSecrets(current, 'encrypt')
    if (JSON.stringify(current) !== JSON.stringify(protectedValue)) {
      store.set(key, protectedValue)
      changed = true
    }
  }
  return changed
}

function prepareImportedConfig(config) {
  const normalized = sanitizeConfigObject(config)
  for (const key of DAMENG_LOCAL_STORE_KEYS) delete normalized[key]
  for (const key of ['resources', 'servers', 'databases', 'redisStores', 'redis', 'sshTunnels', 'workflows']) {
    if (normalized[key] !== undefined && !Array.isArray(normalized[key])) {
      throw new Error(`配置字段 ${key} 的格式不正确。`)
    }
  }
  return {
    resources: [],
    servers: [],
    databases: [],
    redisStores: [],
    redis: [],
    sshTunnels: [],
    workflows: [],
    ...normalized
  }
}

function writeFileAtomically(path, content) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    if (existsSync(path)) rmSync(path, { force: true })
    renameSync(temporaryPath, path)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function cleanupPendingConfigImports() {
  const now = Date.now()
  for (const [token, pending] of pendingConfigImports) {
    if (pending.expiresAt <= now) pendingConfigImports.delete(token)
  }
}

function sendConfigOperationProgress(event, operationId, kind, stage, details = {}) {
  if (!operationId || event.sender?.isDestroyed?.()) return
  event.sender.send('config:operation-progress', {
    operationId: String(operationId),
    kind,
    stage,
    timestamp: Date.now(),
    ...details
  })
}

function createWindow() {
  const appIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../build/icon.ico')

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 740,
    title: 'Ops Flow',
    icon: appIconPath,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // In development Electron runs through node_modules/electron/electron.exe,
  // whose embedded icon is Electron's default. Reapply the project icon to
  // the native window so Windows does not keep the executable's Atom icon.
  mainWindow.setIcon(appIconPath)
  mainWindow.once('ready-to-show', () => mainWindow.setIcon(appIconPath))
  if (process.platform === 'win32') {
    mainWindow.setAppDetails({
      appId: app.isPackaged ? 'com.opsflow.plus' : 'com.opsflow.plus.dev',
      appIconPath,
      appIconIndex: 0
    })
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { label: 'Cut', role: 'cut', enabled: params.editFlags?.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags?.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags?.canPaste },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags?.canSelectAll }
      ]).popup({ window: mainWindow })
      return
    }

    const template = [
      {
        label: 'Copy',
        enabled: Boolean(params.selectionText),
        click: () => clipboard.writeText(params.selectionText || '')
      },
      {
        label: 'Paste',
        enabled: Boolean(clipboard.readText()),
        click: () => pasteClipboardToShell(mainWindow.webContents)
      }
    ]
    Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  migrateLocalCredentials()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  workflowPrivilegeCredentials.clear()
  for (const sessionId of [...workflowSshSessions.keys()]) closeWorkflowSshSession(sessionId)
  databaseScriptSessions.clear()
  for (const tunnelId of [...sshTunnelSessions.keys()]) stopManagedSshTunnel(tunnelId, false)
  for (const worker of damengLegacyWorkers) worker.terminate()
  damengLegacyWorkers.clear()
  for (const session of fileTransferSessions.values()) {
    session.canceled = true
    session.sftp?.end()
    if (!session.sharedConnection) session.client?.end()
  }
  fileTransferSessions.clear()
})

ipcMain.handle('store:get', (_event, key) => readStoreValue(key))
ipcMain.handle('store:set', (_event, key, value) => {
  return writeStoreValue(key, value)
})
ipcMain.handle('app:get-version', () => app.getVersion())

ipcMain.handle('dameng-driver:status', () => getDamengDriverStatus())

ipcMain.handle('dameng-driver:select', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const picked = await dialog.showOpenDialog(window, {
    title: 'Select the official dmdb package directory',
    message: 'Select node_modules/dmdb, its node_modules parent, or the project directory that contains it.',
    properties: ['openDirectory']
  })
  if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true }

  const driver = inspectDamengDriverPath(picked.filePaths[0])
  const confirmation = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Use external Dameng driver',
    message: `Use dmdb ${driver.version} from this computer?`,
    detail: [
      'dmdb is commercial third-party software governed by the Dameng vendor license.',
      'Ops Flow will load it directly from the selected folder. It will not copy the driver into the application or include it in exported configuration.',
      'Continue only if you obtained this driver lawfully and accept its license.'
    ].join('\n\n'),
    buttons: ['Cancel', 'Use external driver'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (confirmation.response !== 1) return { canceled: true }

  store.set(DAMENG_DRIVER_STORE_KEY, driver.path)
  resetDmdbDriverCache()
  if (store.get(DAMENG_LEGACY_MODE_STORE_KEY, false)) {
    try {
      await verifyDamengLegacyWorker()
    } catch (error) {
      store.delete(DAMENG_DRIVER_STORE_KEY)
      resetDmdbDriverCache()
      throw error
    }
  }
  return { canceled: false, ...getDamengDriverStatus() }
})

ipcMain.handle('dameng-driver:clear', () => {
  store.delete(DAMENG_DRIVER_STORE_KEY)
  resetDmdbDriverCache()
  return getDamengDriverStatus()
})

ipcMain.handle('dameng-driver:select-legacy-node', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const picked = await dialog.showOpenDialog(window, {
    title: 'Select a Node.js runtime for isolated Dameng compatibility',
    message: 'Select node.exe from an official Node.js installation.',
    properties: ['openFile'],
    filters: [
      { name: 'Node.js runtime', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }
    ]
  })
  if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true }

  const previousPath = store.get(DAMENG_LEGACY_NODE_STORE_KEY)
  damengLegacyRuntimeCache.delete(resolve(picked.filePaths[0]))
  const runtime = inspectDamengLegacyNodeRuntime(picked.filePaths[0])
  if (!runtime.compatible) throw new Error(runtime.error)
  store.set(DAMENG_LEGACY_NODE_STORE_KEY, runtime.path)
  if (store.get(DAMENG_LEGACY_MODE_STORE_KEY, false)) {
    try {
      await verifyDamengLegacyWorker()
    } catch (error) {
      if (previousPath) store.set(DAMENG_LEGACY_NODE_STORE_KEY, previousPath)
      else store.delete(DAMENG_LEGACY_NODE_STORE_KEY)
      throw error
    }
  }
  return { canceled: false, ...getDamengDriverStatus() }
})

ipcMain.handle('dameng-driver:clear-legacy-node', async () => {
  const previousPath = store.get(DAMENG_LEGACY_NODE_STORE_KEY)
  store.delete(DAMENG_LEGACY_NODE_STORE_KEY)
  if (store.get(DAMENG_LEGACY_MODE_STORE_KEY, false)) {
    try {
      await verifyDamengLegacyWorker()
    } catch (error) {
      if (previousPath) store.set(DAMENG_LEGACY_NODE_STORE_KEY, previousPath)
      throw error
    }
  }
  return getDamengDriverStatus()
})

ipcMain.handle('dameng-driver:set-legacy-mode', async (event, enabled) => {
  const nextEnabled = Boolean(enabled)
  if (nextEnabled) {
    const driver = getDamengDriverStatus()
    if (!driver.configured) {
      throw new Error(driver.error || 'Configure the official external dmdb driver before enabling compatibility mode.')
    }
    if (!driver.legacyRuntime?.compatible) {
      throw new Error(driver.legacyRuntime?.error || 'No compatible Node.js runtime was found for isolated Dameng compatibility mode.')
    }
    await verifyDamengLegacyWorker(driver)
    const window = BrowserWindow.fromWebContents(event.sender)
    const chinese = store.get('language', 'zh-CN') === 'zh-CN'
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      title: chinese ? '兼容旧版达梦' : 'Support older Dameng servers',
      message: chinese ? '确定开启旧版达梦兼容？' : 'Enable compatibility for older Dameng servers?',
      detail: chinese
        ? '仅在连接提示旧加密算法或 Unknown cipher 时开启。兼容功能在独立进程中运行，不影响其他数据库和配置加密。'
        : 'Enable only when the connection reports an old cipher or Unknown cipher. Compatibility runs in an isolated process and does not affect other databases or configuration encryption.',
      buttons: chinese ? ['取消', '开启'] : ['Cancel', 'Enable'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (confirmation.response !== 1) return { canceled: true, ...getDamengDriverStatus() }
    store.set(DAMENG_LEGACY_MODE_STORE_KEY, true)
  } else {
    store.delete(DAMENG_LEGACY_MODE_STORE_KEY)
  }
  return { canceled: false, ...getDamengDriverStatus() }
})

ipcMain.handle('config:security-status', () => ({
  localProtectionAvailable: localCredentialProtectionAvailable(),
  backupFormat: 'scrypt + AES-256-GCM',
  importMode: 'replace'
}))

ipcMain.handle('config:export-encrypted', async (event, options = {}) => {
  const operationId = String(options.operationId || '')
  const includeCredentials = Boolean(options.includeCredentials)
  const includeHistory = Boolean(options.includeHistory)
  sendConfigOperationProgress(event, operationId, 'export', 'preparing')
  const snapshot = normalizeConfigSnapshot(readDecryptedStoreSnapshot(), { includeCredentials, includeHistory })
  const defaultName = `ops-flow-config-${backupTimestamp()}.opsflow-backup`
  sendConfigOperationProgress(event, operationId, 'export', 'selecting')
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导出加密配置',
    defaultPath: join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Ops Flow encrypted backup', extensions: ['opsflow-backup'] }]
  })
  if (result.canceled || !result.filePath) {
    sendConfigOperationProgress(event, operationId, 'export', 'canceled')
    return { canceled: true }
  }

  const path = result.filePath.toLowerCase().endsWith('.opsflow-backup')
    ? result.filePath
    : `${result.filePath}.opsflow-backup`
  sendConfigOperationProgress(event, operationId, 'export', 'encrypting')
  const encrypted = encryptConfigBackup(snapshot, options.password, {
    appVersion: app.getVersion(),
    includeCredentials,
    includeHistory
  })
  sendConfigOperationProgress(event, operationId, 'export', 'writing')
  writeFileAtomically(path, encrypted)
  sendConfigOperationProgress(event, operationId, 'export', 'completed', { path })
  return {
    canceled: false,
    path,
    summary: summarizeConfig(snapshot)
  }
})

ipcMain.handle('config:select-import-file', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '选择加密配置文件',
    properties: ['openFile'],
    filters: [{ name: 'Ops Flow encrypted backup', extensions: ['opsflow-backup'] }]
  })
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true }
  return {
    canceled: false,
    path: result.filePaths[0],
    name: basename(result.filePaths[0])
  }
})

ipcMain.handle('config:inspect-import', (event, request = {}) => {
  const operationId = String(request.operationId || '')
  cleanupPendingConfigImports()
  const path = String(request.path || '')
  sendConfigOperationProgress(event, operationId, 'preview', 'reading')
  const info = statSync(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_CONFIG_BACKUP_BYTES) {
    throw new Error('配置文件为空或超过 25 MB，无法导入。')
  }
  const encryptedText = readFileSync(path, 'utf8')
  sendConfigOperationProgress(event, operationId, 'preview', 'decrypting')
  const decrypted = decryptConfigBackup(encryptedText, request.password)
  sendConfigOperationProgress(event, operationId, 'preview', 'validating')
  const config = prepareImportedConfig(decrypted.config)
  const token = randomBytes(24).toString('hex')
  pendingConfigImports.set(token, {
    config,
    password: String(request.password || ''),
    sourcePath: path,
    expiresAt: Date.now() + CONFIG_IMPORT_TTL_MS
  })
  sendConfigOperationProgress(event, operationId, 'preview', 'completed')
  return {
    token,
    expiresAt: Date.now() + CONFIG_IMPORT_TTL_MS,
    sourceName: basename(path),
    createdAt: decrypted.createdAt,
    appVersion: decrypted.appVersion,
    includeCredentials: Boolean(decrypted.includeCredentials),
    includeHistory: Boolean(decrypted.includeHistory),
    summary: summarizeConfig(config)
  }
})

ipcMain.handle('config:apply-import', (event, request = {}) => {
  const token = typeof request === 'string' ? request : request.token
  const operationId = typeof request === 'string' ? '' : String(request.operationId || '')
  sendConfigOperationProgress(event, operationId, 'apply', 'validating')
  cleanupPendingConfigImports()
  const pending = pendingConfigImports.get(String(token || ''))
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingConfigImports.delete(String(token || ''))
    throw new Error('导入预览已过期，请重新选择文件并输入密码。')
  }
  if (containsCredentials(pending.config) && !localCredentialProtectionAvailable()) {
    throw new Error('本机凭据保护不可用，不能安全导入包含连接凭据的配置。')
  }

  const previousRawStore = store.store
  const localDamengSettings = Object.fromEntries(
    DAMENG_LOCAL_STORE_KEYS
      .filter((key) => store.has(key))
      .map((key) => [key, store.get(key)])
  )
  const currentSnapshot = readDecryptedStoreSnapshot()
  sendConfigOperationProgress(event, operationId, 'apply', 'backing-up')
  const rollbackDirectory = join(app.getPath('userData'), 'backups')
  mkdirSync(rollbackDirectory, { recursive: true })
  const rollbackPath = join(rollbackDirectory, `before-import-${backupTimestamp()}.opsflow-backup`)
  const rollbackContent = encryptConfigBackup(currentSnapshot, pending.password, {
    appVersion: app.getVersion(),
    includeCredentials: true,
    includeHistory: true
  })
  writeFileAtomically(rollbackPath, rollbackContent)

  try {
    sendConfigOperationProgress(event, operationId, 'apply', 'writing')
    store.store = protectConfigForLocalStorage(pending.config)
    for (const [key, value] of Object.entries(localDamengSettings)) store.set(key, value)
    for (const tunnelId of [...sshTunnelSessions.keys()]) stopManagedSshTunnel(tunnelId)
  } catch (error) {
    store.store = previousRawStore
    throw error
  } finally {
    pendingConfigImports.delete(String(token || ''))
  }

  sendConfigOperationProgress(event, operationId, 'apply', 'completed', { rollbackPath })
  return {
    ok: true,
    rollbackPath,
    summary: summarizeConfig(pending.config)
  }
})

ipcMain.handle('clipboard:read-text', () => clipboard.readText())
ipcMain.handle('clipboard:write-text', (_event, text) => {
  clipboard.writeText(String(text ?? ''))
  return { ok: true }
})
ipcMain.handle('app:open-external', async (_event, value) => {
  const target = String(value || '').trim()
  if (!/^(https:\/\/|mailto:)/i.test(target)) {
    throw new Error('Only HTTPS and mailto links can be opened externally.')
  }
  await shell.openExternal(target)
  return { ok: true }
})

ipcMain.handle('dialog:select-local-path', async (event, options = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const rememberUploadDirectory = options.historyKey === 'upload'
  const rememberedUploadDirectory = rememberUploadDirectory
    ? String(store.get('lastLocalUploadDirectory', '') || '')
    : ''
  const properties = options.directory
    ? ['openDirectory']
    : options.multiple
      ? ['openFile', 'multiSelections']
      : ['openFile']
  const picked = await dialog.showOpenDialog(window, {
    title: options.title || (options.directory ? 'Select local directory' : 'Select local file'),
    ...(rememberedUploadDirectory && existsSync(rememberedUploadDirectory)
      ? { defaultPath: rememberedUploadDirectory }
      : {}),
    properties
  })
  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true, message: 'Selection canceled' }
  }
  if (rememberUploadDirectory) {
    const selectedDirectory = options.directory ? picked.filePaths[0] : dirname(picked.filePaths[0])
    if (selectedDirectory && existsSync(selectedDirectory)) {
      store.set('lastLocalUploadDirectory', selectedDirectory)
    }
  }
  return { ok: true, path: picked.filePaths[0], paths: picked.filePaths }
})

ipcMain.handle('fs:stat-local-path', async (_event, localPath) => {
  if (!localPath) return { ok: false, message: 'Local path is required' }
  try {
    const stats = statSync(localPath)
    return {
      ok: true,
      path: localPath,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size
    }
  } catch (error) {
    const message = error.code === 'ENOENT'
      ? `Local path not found: ${localPath}`
      : error.message
    return { ok: false, message }
  }
})

ipcMain.handle('dialog:select-sql-file', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showOpenDialog(window, {
    title: '选择 SQL 脚本',
    properties: ['openFile'],
    filters: [
      { name: 'SQL scripts', extensions: ['sql', 'sql.gz', 'gz'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true, message: 'Selection canceled' }
  const filePath = picked.filePaths[0]
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) return { ok: false, message: 'The selected path is not a file' }
    const checksumDetails = await verifyOptionalSha256Sidecar(filePath)
    const maxSqlBytes = 10 * 1024 * 1024
    const compressed = /\.gz$/i.test(filePath)
    if (stats.size > maxSqlBytes) {
      return {
        ok: true,
        path: filePath,
        name: basename(filePath),
        size: stats.size,
        sizeLabel: formatBytes(stats.size),
        encoding: compressed ? 'GZIP · UTF-8 · 流式执行' : 'UTF-8 · 流式执行',
        content: '',
        directExecution: true,
        ...checksumDetails
      }
    }
    let sqlBuffer = readFileSync(filePath)
    if (compressed) {
      try {
        sqlBuffer = gunzipSync(sqlBuffer, { maxOutputLength: maxSqlBytes + 1 })
      } catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') {
          return {
            ok: true,
            path: filePath,
            name: basename(filePath),
            size: stats.size,
            sizeLabel: formatBytes(stats.size),
            encoding: 'GZIP · UTF-8 · 流式执行',
            content: '',
            directExecution: true,
            ...checksumDetails
          }
        }
        return { ok: false, message: `无法解压 SQL 脚本：${error.message}` }
      }
      if (sqlBuffer.length > maxSqlBytes) {
        return {
          ok: true,
          path: filePath,
          name: basename(filePath),
          size: stats.size,
          sizeLabel: formatBytes(stats.size),
          encoding: 'GZIP · UTF-8 · 流式执行',
          content: '',
          directExecution: true,
          ...checksumDetails
        }
      }
    }
    const decoded = decodeSqlFile(sqlBuffer)
    return {
      ok: true,
      path: filePath,
      name: basename(filePath),
      size: stats.size,
      sizeLabel: formatBytes(stats.size),
      encoding: compressed ? `GZIP · ${decoded.encoding}` : decoded.encoding,
      content: decoded.content,
      ...checksumDetails
    }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('ssh:test', async (_event, config) => {
  return withSshClient(config, async () => ({ ok: true, message: 'SSH connected' }))
})

ipcMain.handle('ssh-tunnel:list', (event) => {
  return [...sshTunnelSessions.values()].map((session) => {
    session.webContents = event.sender
    return managedSshTunnelStatus(session)
  })
})

ipcMain.handle('ssh-tunnel:start', async (event, tunnel, sshConfig) => {
  return startManagedSshTunnel(event.sender, tunnel, sshConfig)
})

ipcMain.handle('ssh-tunnel:test', async (_event, tunnel = {}, sshConfig = {}) => {
  const targetHost = String(tunnel.targetHost || '').trim()
  const targetPort = Number(tunnel.targetPort)
  if (!sshConfig?.host || !sshConfig?.username) return { ok: false, message: 'Saved SSH server is missing or incomplete' }
  if (!targetHost || targetHost.length > 253 || /[\u0000\r\n]/.test(targetHost)) return { ok: false, message: 'Destination host is invalid' }
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return { ok: false, message: 'Destination port must be between 1 and 65535' }

  const startedAt = Date.now()
  return withSshClient({ ...sshConfig, readyTimeout: 15000 }, async (client) => {
    let stream = null
    try {
      stream = await openSshForwardStream(client, targetHost, targetPort, 12000)
      return {
        ok: true,
        message: `SSH route can reach ${targetHost}:${targetPort}`,
        elapsedMs: Date.now() - startedAt
      }
    } finally {
      if (stream && !stream.destroyed) stream.destroy()
    }
  })
})

ipcMain.handle('ssh-tunnel:stop', async (_event, tunnelId) => {
  const id = String(tunnelId || '')
  stopManagedSshTunnel(id)
  return { ok: true, id, status: 'stopped' }
})

ipcMain.handle('ssh:exec', async (_event, config, command) => {
  return withSshClient(config, (client) => execCommand(client, wrapInteractiveCommand(command), { pty: true }))
})

ipcMain.handle('ssh:exec-raw', async (_event, config, command) => {
  return withSshClient(config, (client) => execCommand(client, `bash -lc ${shellQuote(command)}`))
})

ipcMain.handle('ssh:workflow-session:start', async (event, config, sessionId) => {
  return startWorkflowSshSession(event.sender, config, sessionId)
})

ipcMain.handle('ssh:workflow-session:stop', async (event, sessionId) => {
  const session = workflowSshSessions.get(String(sessionId || ''))
  if (session && session.webContentsId !== event.sender.id) return { ok: false, message: 'Workflow SSH session belongs to another window' }
  closeWorkflowSshSession(sessionId)
  return { ok: true }
})

ipcMain.handle('ssh:exec-stream', async (event, config, command, executionId, privilege, workflowSessionId) => {
  return execStreamingCommand(event.sender, config, command, executionId, privilege, workflowSessionId)
})

ipcMain.handle('ssh:exec-privileged', async (event, config, command, privilege = {}) => {
  const executionId = `privileged-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return execStreamingCommand(event.sender, config, command, executionId, privilege)
})

ipcMain.handle('ssh:exec-cancel', async (_event, executionId) => {
  const session = sshExecSessions.get(executionId)
  if (!session) return { ok: false, message: 'Command is no longer running' }
  session.cancel()
  return { ok: true, canceled: true, message: 'Cancellation requested' }
})

ipcMain.handle('ssh:privilege-detect', async (event, config, workflowSessionId = '') => {
  return withPreferredSshClient(event.sender, config, workflowSessionId, async (client) => {
    const identity = await execCommand(client, 'id -u')
    if (!identity.ok) return { ok: false, message: identity.message || 'Unable to detect the remote user' }
    if (String(identity.stdout || '').trim() === '0') {
      return { ok: true, mode: 'normal', isRoot: true, passwordRequired: false, cached: false }
    }

    const sudoAvailable = await execCommand(client, 'command -v sudo >/dev/null 2>&1')
    const sudoProbe = sudoAvailable.ok
      ? await execCommand(client, 'LC_ALL=C sudo -n -v')
      : { ok: false, stdout: '', stderr: 'sudo is not installed' }
    if (sudoProbe.ok) {
      return { ok: true, mode: 'sudo', isRoot: false, passwordRequired: false, cached: false }
    }

    for (const mode of ['sudo', 'su']) {
      const key = workflowPrivilegeKey(config, mode)
      const cached = workflowPrivilegeCredentials.get(key)
      if (!cached?.password) continue
      const executionId = `privilege-cache-check-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const verified = await execStreamingCommand(event.sender, config, 'true', executionId, { mode, password: cached.password }, workflowSessionId)
      if (verified.ok) return { ok: true, mode, isRoot: false, passwordRequired: false, cached: true }
      workflowPrivilegeCredentials.delete(key)
    }

    const sudoProbeOutput = `${sudoProbe.stderr || ''}\n${sudoProbe.stdout || ''}`
    const sudoDenied = /not in the sudoers|not allowed to run sudo|may not run sudo|is not allowed to execute/i.test(sudoProbeOutput)
    const sudoBroken = /sudo.*must be owned by uid 0|setuid bit set|effective uid is not 0|no valid sudoers sources found/i.test(sudoProbeOutput)
    const suggestedMode = !sudoAvailable.ok || sudoDenied || sudoBroken ? 'su' : 'sudo'
    return { ok: true, mode: suggestedMode, isRoot: false, passwordRequired: true, cached: false }
  })
})

ipcMain.handle('ssh:privilege-verify', async (event, config, privilege = {}, workflowSessionId = '') => {
  const mode = ['sudo', 'su'].includes(privilege?.mode) ? privilege.mode : 'normal'
  if (mode === 'normal') return { ok: true, mode: 'normal', isRoot: false, cached: false }
  const key = workflowPrivilegeKey(config, mode)
  const suppliedPassword = String(privilege?.password || '')
  const cachedPassword = workflowPrivilegeCredentials.get(key)?.password || ''
  if (!suppliedPassword && !cachedPassword && mode === 'su') {
    return { ok: false, passwordRequired: true, message: 'Enter the root password for su.' }
  }

  const executionId = `privilege-check-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await execStreamingCommand(event.sender, config, 'id -u', executionId, {
    mode,
    password: suppliedPassword || cachedPassword
  }, workflowSessionId)
  const isRoot = String(result.stdout || '').split(/\r?\n/).some((line) => line.trim() === '0')
  if (!result.ok || !isRoot) {
    workflowPrivilegeCredentials.delete(key)
    const suggestedMode = mode === 'sudo' && privilegeFailureSuggestsSu(result) ? 'su' : undefined
    return {
      ok: false,
      passwordRequired: true,
      suggestedMode,
      message: formatPrivilegeFailure(result, mode)
    }
  }
  if (suppliedPassword) {
    workflowPrivilegeCredentials.set(key, { password: suppliedPassword, storedAt: Date.now() })
  }
  return { ok: true, mode, isRoot: true, cached: Boolean(cachedPassword && !suppliedPassword) }
})

ipcMain.handle('ssh:privilege-forget', (_event, config, mode = '') => {
  if (['sudo', 'su'].includes(mode)) {
    workflowPrivilegeCredentials.delete(workflowPrivilegeKey(config, mode))
  } else {
    workflowPrivilegeCredentials.delete(workflowPrivilegeKey(config, 'sudo'))
    workflowPrivilegeCredentials.delete(workflowPrivilegeKey(config, 'su'))
  }
  return { ok: true }
})

ipcMain.handle('ssh:shell:start', async (event, config, size = {}) => {
  return startShellSession(event.sender, config, size)
})

ipcMain.on('ssh:shell:write', (event, sessionId, data) => {
  const session = shellSessions.get(sessionId)
  if (!session?.stream || session.stream.destroyed || !session.stream.writable) return
  try {
    const submittedCommands = captureShellInput(session, data)
    session.stream.write(data)
    submittedCommands.forEach((command) => {
      if (!event.sender.isDestroyed()) event.sender.send('ssh:shell:command', { sessionId, command })
    })
  } catch (error) {
    if (!event.sender.isDestroyed()) {
      event.sender.send('ssh:shell:error', { sessionId, message: error.message || 'Terminal input failed' })
    }
  }
})

ipcMain.handle('ssh:shell:resize', async (_event, sessionId, size = {}) => {
  const session = shellSessions.get(sessionId)
  if (!session?.stream) return { ok: false, message: 'Terminal session is not connected' }
  session.stream.setWindow(Number(size.rows || 24), Number(size.cols || 80), 0, 0)
  return { ok: true }
})

ipcMain.handle('ssh:shell:stop', async (_event, sessionId) => {
  closeShellSession(sessionId)
  return { ok: true }
})

ipcMain.handle('ssh:inspect', async (event, config) => {
  const command = [
    'hostname',
    'uname -a',
    'uptime',
    `awk 'NR==1{u1=$2+$4; t1=$2+$3+$4+$5+$6+$7+$8} NR>1{exit} END{system("sleep 0.25"); getline line < "/proc/stat"; split(line,a," "); u2=a[2]+a[4]; t2=a[2]+a[3]+a[4]+a[5]+a[6]+a[7]+a[8]; if (t2>t1) printf "CPU_USAGE %.1f\\n", ((u2-u1)*100)/(t2-t1);}' /proc/stat`,
    `free | awk '/Mem:/ { if ($2 > 0) printf "MEM_USAGE %.1f\\n", ($3 * 100) / $2 }'`,
    'free -h',
    'df -h /',
    'lscpu | head -20'
  ].join('\n')

  return withActiveShellClient(event.sender, config, (client) => execCommand(client, command))
})

ipcMain.handle('sftp:list', async (event, config, targetPath = '/') => {
  return withActiveShellClient(event.sender, config, (client) => listRemoteDirectory(client, targetPath))
})

ipcMain.handle('sftp:realpath', async (event, config, targetPath = '.') => {
  return withActiveShellClient(event.sender, config, (client) => resolveRemoteDirectoryPath(client, targetPath))
})

ipcMain.handle('sftp:privileged-list', async (event, config, targetPath = '/', privilege = {}) => {
  return listPrivilegedRemoteDirectory(event.sender, config, targetPath, privilege)
})

ipcMain.handle('sftp:search-files', async (event, config, query = '', privilege = {}, executionId = '') => {
  return searchRemoteFiles(event.sender, config, query, privilege, executionId)
})

ipcMain.handle('sftp:upload', async (event, config, targetDirectory = '/', options = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showOpenDialog(window, {
    title: 'Select file to upload',
    properties: ['openFile']
  })

  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true, message: 'Upload canceled' }
  }

  const localPath = picked.filePaths[0]
  const remotePath = options.targetIsFile
    ? String(targetDirectory || '').trim()
    : joinRemotePath(targetDirectory, basename(localPath))
  if (!remotePath || !remotePath.startsWith('/') || remotePath.endsWith('/')) {
    return { ok: false, message: 'Enter a valid absolute remote file path' }
  }
  const transferId = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const total = statSync(localPath).size
  emitTransferProgress({
    id: transferId,
    total,
    webContents: event.sender
  }, {
    id: transferId,
    type: 'upload',
    name: basename(localPath),
    localPath,
    remotePath,
    total,
    transferred: 0,
    status: 'running'
  })
  const progress = {
    id: transferId,
    type: 'upload',
    name: basename(localPath),
    localPath,
    remotePath,
    total,
    webContents: event.sender
  }
  prepareFileTransferSession(progress, null)
  let result = await uploadWithReconnect(event.sender, config, progress, (client) => (
    uploadRemoteFile(client, localPath, remotePath, progress)
  ))
  result = settlePendingFileTransfer(progress, result)
  if (result.canceled && result.partialRemotePath) {
    void cleanupCanceledRemoteUpload(config, result.partialRemotePath)
  }
  return result
})

ipcMain.handle('sftp:privileged-upload', async (event, config, targetDirectory = '/', privilege = {}) => {
  return uploadPrivilegedRemoteFile(event.sender, config, targetDirectory, privilege)
})

ipcMain.handle('sftp:privileged-upload-path', async (event, config, localPath, targetDirectory = '/', privilege = {}) => {
  return uploadPrivilegedRemotePath(event.sender, config, localPath, targetDirectory, privilege)
})

ipcMain.handle('sftp:upload-path', async (event, config, localPath, remotePath, workflowSessionId = '') => {
  if (!localPath || !remotePath) return { ok: false, message: 'Local path and remote path are required' }
  let stats
  try {
    stats = statSync(localPath)
  } catch (error) {
    const message = error.code === 'ENOENT'
      ? `Local path not found: ${localPath}`
      : error.message
    return { ok: false, message }
  }
  const targetRemotePath = !stats.isDirectory() && String(remotePath).endsWith('/')
    ? posix.join(remotePath, basename(localPath))
    : remotePath
  const transferId = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const total = stats.isDirectory() ? getLocalPathSize(localPath) : stats.size
  emitTransferProgress({
    id: transferId,
    total,
    webContents: event.sender
  }, {
    id: transferId,
    type: 'upload',
    name: basename(localPath),
    localPath,
    remotePath: targetRemotePath,
    total,
    transferred: 0,
    status: 'running'
  })
  const progress = {
    id: transferId,
    type: 'upload',
    name: basename(localPath),
    localPath,
    remotePath: targetRemotePath,
    total,
    webContents: event.sender
  }
  prepareFileTransferSession(progress, null)
  let result = await uploadWithReconnect(event.sender, config, progress, (client) => (
    stats.isDirectory()
      ? uploadRemoteDirectory(client, localPath, targetRemotePath, progress)
      : uploadRemoteFile(client, localPath, targetRemotePath, progress)
  ), workflowSessionId)
  result = settlePendingFileTransfer(progress, result)
  if (result.canceled && result.partialRemotePath) {
    void cleanupCanceledRemoteUpload(config, result.partialRemotePath)
  }
  return result
})

ipcMain.handle('sftp:download', async (event, config, remotePath) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showSaveDialog(window, {
    title: 'Save remote file',
    defaultPath: posix.basename(remotePath)
  })

  if (picked.canceled || !picked.filePath) {
    return { ok: false, canceled: true, message: 'Download canceled' }
  }

  const transferId = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return withActiveShellClient(event.sender, config, (client, connection) => downloadRemoteFile(client, remotePath, picked.filePath, {
    id: transferId,
    type: 'download',
    name: posix.basename(remotePath),
    localPath: picked.filePath,
    remotePath,
    webContents: event.sender,
    sharedConnection: connection.shared
  }))
})

ipcMain.handle('sftp:privileged-download', async (event, config, remotePath, privilege = {}) => {
  return downloadPrivilegedRemoteFile(event.sender, config, remotePath, privilege)
})

ipcMain.handle('sftp:download-files', async (event, config, remotePaths = [], privilege = null) => {
  const paths = [...new Set((Array.isArray(remotePaths) ? remotePaths : [])
    .map((remotePath) => String(remotePath || '').trim())
    .filter(Boolean))]
  if (!paths.length) return { ok: false, message: 'Select one or more remote files' }

  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showOpenDialog(window, {
    title: 'Select download folder',
    properties: ['openDirectory', 'createDirectory']
  })
  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true, message: 'Download canceled' }
  }

  const targetDirectory = picked.filePaths[0]
  const reservedPaths = new Set()
  const results = []
  for (const remotePath of paths) {
    const localPath = makeUniqueLocalDownloadPath(targetDirectory, posix.basename(remotePath), reservedPaths)
    const result = privilege
      ? await downloadPrivilegedRemotePath(event.sender, config, remotePath, localPath, privilege)
      : await withActiveShellClient(event.sender, config, (client, connection) => downloadRemoteFile(client, remotePath, localPath, {
          id: `download-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: 'download',
          name: posix.basename(remotePath),
          localPath,
          remotePath,
          webContents: event.sender,
          sharedConnection: connection.shared
        }))
    results.push({ ...result, remotePath, localPath })
  }

  const completed = results.filter((result) => result.ok).length
  const canceledCount = results.filter((result) => result.canceled).length
  return {
    ok: completed === results.length,
    partial: completed > 0 && completed < results.length,
    completed,
    failed: results.length - completed - canceledCount,
    canceledCount,
    targetDirectory,
    results,
    message: completed === results.length ? 'Downloads completed' : `${completed}/${results.length} downloads completed`
  }
})

ipcMain.handle('sftp:download-path', async (event, config, remotePath, localPath, workflowSessionId = '') => {
  if (!remotePath || !localPath) return { ok: false, message: 'Remote path and local path are required' }
  mkdirSync(dirname(localPath), { recursive: true })
  const transferId = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return withPreferredSshClient(event.sender, config, workflowSessionId, (client, connection) => downloadRemoteFile(client, remotePath, localPath, {
    id: transferId,
    type: 'download',
    name: posix.basename(remotePath),
    localPath,
    remotePath,
    webContents: event.sender,
    sharedConnection: connection.shared
  }))
})

ipcMain.handle('sftp:transfer-cancel', async (event, transferId) => {
  const session = fileTransferSessions.get(String(transferId || ''))
  if (!session || session.webContentsId !== event.sender.id) {
    return { ok: false, message: 'The transfer is no longer running' }
  }
  if (session.canceled) return { ok: true, message: 'Cancel already requested' }
  session.canceled = true
  emitTransferProgress(session.progress, {
    transferred: session.transferred,
    status: 'cancelled',
    message: 'Transfer canceled by user'
  })
  session.cancelTransfer?.()
  try {
    session.sftp?.end()
  } catch {
    // The SSH connection below is also closed as a fallback.
  }
  try {
    if (!session.sharedConnection) session.client?.end()
  } catch {
    // The transfer callback will still settle the task.
  }
  return { ok: true, message: 'Transfer canceled' }
})

ipcMain.handle('sftp:read-file', async (event, config, remotePath) => {
  return withActiveShellClient(event.sender, config, (client) => readRemoteTextFile(client, remotePath))
})

ipcMain.handle('sftp:privileged-read-file', async (event, config, remotePath, privilege = {}) => {
  return readPrivilegedRemoteTextFile(event.sender, config, remotePath, privilege)
})

ipcMain.handle('sftp:write-file', async (event, config, remotePath, content) => {
  return withActiveShellClient(event.sender, config, (client) => writeRemoteTextFile(client, remotePath, content))
})

ipcMain.handle('sftp:create-file', async (event, config, parentPath, name) => {
  try {
    const targetPath = buildNewRemoteItemPath(parentPath, name)
    return withActiveShellClient(event.sender, config, (client) => createRemoteFile(client, targetPath))
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:create-directory', async (event, config, parentPath, name) => {
  try {
    const targetPath = buildNewRemoteItemPath(parentPath, name)
    return withActiveShellClient(event.sender, config, (client) => createRemoteDirectory(client, targetPath))
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:rename', async (event, config, sourcePath, newName) => {
  try {
    const paths = buildRenamedRemoteItemPaths(sourcePath, newName)
    return withActiveShellClient(event.sender, config, (client) => renameRemoteItem(client, paths.sourcePath, paths.targetPath))
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:privileged-write-file', async (event, config, remotePath, content, privilege = {}) => {
  return writePrivilegedRemoteTextFile(event.sender, config, remotePath, content, privilege)
})

ipcMain.handle('sftp:privileged-create-file', async (event, config, parentPath, name, privilege = {}) => {
  try {
    const targetPath = buildNewRemoteItemPath(parentPath, name)
    return createPrivilegedRemoteItem(event.sender, config, targetPath, 'file', privilege)
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:privileged-create-directory', async (event, config, parentPath, name, privilege = {}) => {
  try {
    const targetPath = buildNewRemoteItemPath(parentPath, name)
    return createPrivilegedRemoteItem(event.sender, config, targetPath, 'dir', privilege)
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:privileged-rename', async (event, config, sourcePath, newName, privilege = {}) => {
  try {
    const paths = buildRenamedRemoteItemPaths(sourcePath, newName)
    return renamePrivilegedRemoteItem(event.sender, config, paths.sourcePath, paths.targetPath, privilege)
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:copy-file-backup', async (event, config, remotePath, privilege = {}) => {
  return copyRemoteFileBackup(event.sender, config, remotePath, privilege)
})

ipcMain.handle('sftp:write-binary-file', async (event, config, remotePath, contentBase64) => {
  return withActiveShellClient(event.sender, config, (client) => writeRemoteBufferFile(client, remotePath, Buffer.from(contentBase64 || '', 'base64')))
})

ipcMain.handle('sftp:delete', async (event, config, remotePath, type) => {
  const deleteId = `delete-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const progress = {
    id: deleteId,
    type: 'delete',
    name: posix.basename(remotePath) || remotePath,
    remotePath,
    total: 1,
    transferred: 0,
    status: 'running',
    webContents: event.sender
  }
  emitTransferProgress(progress, { transferred: 0, total: 1, status: 'running', currentPath: remotePath })
  return withActiveShellClient(event.sender, config, (client, connection) => {
    progress.sharedConnection = connection.shared
    return deleteRemoteItem(client, remotePath, type, progress)
  })
})

ipcMain.handle('sftp:privileged-delete', async (event, config, remotePath, type, privilege = {}) => {
  return deletePrivilegedRemoteItem(event.sender, config, remotePath, type, privilege)
})

ipcMain.handle('db:test', async (_event, config) => {
  return withDatabase(config, async () => ({ ok: true, message: 'Database connected' }))
})

ipcMain.handle('db:create-options', async (_event, config) => {
  if (!supportsDatabaseCreation(config?.engine)) {
    return { ok: false, message: 'Database creation is not supported for this database engine.' }
  }
  const connectionConfig = databaseCreationConnectionConfig(config)
  return withDatabase(connectionConfig, async (connection) => {
    if (!['mysql', 'mariadb'].includes(config.engine)) {
      return { ok: true, charsets: [], collations: [] }
    }
    const [[serverDefaults]] = await connection.query(`
      select @@character_set_server as defaultCharset,
             @@collation_server as defaultCollation
    `)
    const [charsetRows] = await connection.query(`
      select CHARACTER_SET_NAME as name,
             DEFAULT_COLLATE_NAME as defaultCollation,
             DESCRIPTION as description
      from information_schema.CHARACTER_SETS
      order by CHARACTER_SET_NAME
    `)
    const [collationRows] = await connection.query(`
      select COLLATION_NAME as name,
             CHARACTER_SET_NAME as charset,
             IS_DEFAULT as isDefault
      from information_schema.COLLATIONS
      order by CHARACTER_SET_NAME, COLLATION_NAME
    `)
    return {
      ok: true,
      defaultCharset: serverDefaults?.defaultCharset || '',
      defaultCollation: serverDefaults?.defaultCollation || '',
      charsets: charsetRows.map((row) => ({
        name: row.name,
        defaultCollation: row.defaultCollation,
        description: row.description || ''
      })),
      collations: collationRows.map((row) => ({
        name: row.name,
        charset: row.charset,
        isDefault: String(row.isDefault || '').toLocaleLowerCase() === 'yes'
      }))
    }
  })
})

ipcMain.handle('db:create-database', async (_event, config, request = {}) => {
  if (!supportsDatabaseCreation(config?.engine)) {
    return { ok: false, message: 'Database creation is supported for MySQL, PostgreSQL and SQL Server.' }
  }
  let sql
  try {
    sql = buildCreateDatabaseSql(config, request)
  } catch (error) {
    return { ok: false, message: error.message }
  }
  const connectionConfig = databaseCreationConnectionConfig(config)
  return withDatabase(connectionConfig, async (connection) => {
    if (config.engine === 'postgres') {
      await connection.query(sql)
    } else if (config.engine === 'sqlserver') {
      await connection.request().query(sql)
    } else {
      await connection.query(sql)
    }
    return {
      ok: true,
      database: String(request.name || '').trim(),
      sql,
      message: `Database created: ${String(request.name || '').trim()}`
    }
  })
})

ipcMain.handle('db:inspect', async (_event, config) => {
  return withDatabase(config, async (connection) => {
    if (config.engine === 'postgres') {
      const result = await connection.query(`
        select table_schema, table_name
        from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name
      `)
      return { ok: true, tables: result.rows }
    }

    if (config.engine === 'sqlserver') {
      const result = await connection.request().query(`
        select TABLE_SCHEMA as table_schema, TABLE_NAME as table_name
        from INFORMATION_SCHEMA.TABLES
        where TABLE_TYPE = 'BASE TABLE'
        order by TABLE_SCHEMA, TABLE_NAME
      `)
      return { ok: true, tables: result.recordset }
    }

    if (config.engine === 'dm') {
      const currentSchemaResult = await executeOracleLike(connection, config.engine, 'select USER as current_schema from dual')
      const tableResult = await executeOracleLike(connection, config.engine, `
        select OWNER as table_schema, TABLE_NAME as table_name
        from ALL_TABLES
        where OWNER not in ('SYS', 'SYSTEM', 'SYSAUDITOR', 'SYSSSO', 'CTISYS', 'MDSYS', 'ORDSYS', 'XDB')
        order by OWNER, TABLE_NAME
      `)
      const currentSchemaRow = currentSchemaResult.rows?.[0] || {}
      const currentSchema = currentSchemaRow.current_schema
        || currentSchemaRow.CURRENT_SCHEMA
        || String(config.username || '').toUpperCase()
      const schemas = [...new Set([
        currentSchema,
        ...(tableResult.rows || []).map((table) => table.table_schema || table.TABLE_SCHEMA)
      ].filter(Boolean))]
      return { ok: true, tables: tableResult.rows, schemas, currentSchema }
    }

    if (config.engine === 'oracle') {
      const result = await executeOracleLike(connection, config.engine, `
        select OWNER as table_schema, TABLE_NAME as table_name
        from ALL_TABLES
        where OWNER not in ('SYS', 'SYSTEM', 'SYSAUDITOR', 'SYSSSO', 'CTISYS', 'MDSYS', 'ORDSYS', 'XDB')
        order by OWNER, TABLE_NAME
      `)
      return { ok: true, tables: result.rows }
    }

    const [rows] = await connection.query(`
      select table_schema, table_name
      from information_schema.tables
      where table_schema = database()
        and table_type = 'BASE TABLE'
      order by table_schema, table_name
    `)
    return { ok: true, tables: rows }
  })
})

ipcMain.handle('db:columns', async (_event, config, table) => {
  return withDatabase(config, async (connection) => {
    const columns = await inspectDatabaseColumnMetadata({
      connection,
      config,
      table,
      mssql,
      executeOracleLike
    })
    return { ok: true, columns }
  })
})

ipcMain.handle('db:set-column-comment', async (_event, config, table, column) => {
  return withDatabase(config, async (connection) => {
    await setDatabaseColumnComment({
      connection,
      config,
      table,
      column,
      mssql,
      executeOracleLike
    })
    return { ok: true }
  })
})

ipcMain.handle('db:privileges', async (_event, config) => {
  return withDatabase(config, async (connection) => {
    if (config.engine === 'postgres') {
      const userResult = await connection.query('select current_user as user, current_database() as database')
      const privilegeResult = await connection.query(`
        select
          has_database_privilege(current_database(), 'CREATE') as can_create,
          has_schema_privilege(current_schema(), 'CREATE') as can_schema_create
      `)
      const row = privilegeResult.rows[0] || {}
      return {
        ok: true,
        user: userResult.rows[0]?.user || config.username,
        database: userResult.rows[0]?.database || config.database,
        grants: [],
        privileges: {
          select: null,
          insert: null,
          update: null,
          delete: null,
          create: Boolean(row.can_create || row.can_schema_create),
          alter: null,
          drop: null
        }
      }
    }

    if (config.engine === 'sqlserver') {
      const result = await connection.request().query('select SYSTEM_USER as [user], DB_NAME() as [database]')
      return {
        ok: true,
        user: result.recordset[0]?.user || config.username,
        database: result.recordset[0]?.database || config.database,
        grants: [],
        privileges: {
          select: null,
          insert: null,
          update: null,
          delete: null,
          create: null,
          alter: null,
          drop: null
        }
      }
    }

    if (isOracleLikeEngine(config.engine)) {
      const userResult = await executeOracleLike(connection, config.engine, 'select USER as "user" from dual')
      const privilegeResult = await executeOracleLike(connection, config.engine, 'select PRIVILEGE from SESSION_PRIVS')
      const grants = (privilegeResult.rows || []).map((row) => row.PRIVILEGE || row.privilege).filter(Boolean)
      return {
        ok: true,
        user: userResult.rows[0]?.user || userResult.rows[0]?.USER || config.username,
        database: config.database,
        grants,
        privileges: parseTextPrivileges(grants)
      }
    }

    const [userRows] = await connection.query('select current_user() as user, database() as db')
    const [grantRows] = await connection.query('show grants')
    const grants = grantRows.map((row) => Object.values(row)[0]).filter(Boolean)
    return {
      ok: true,
      user: userRows[0]?.user || config.username,
      database: userRows[0]?.db || config.database,
      grants,
      privileges: parseMysqlPrivileges(grants)
    }
  })
})

function maskSqlForReadOnlyAnalysis(sql) {
  const source = String(sql || '')
  let output = ''
  let index = 0
  let state = 'plain'
  let dollarTag = ''
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'plain'
        output += '\n'
      } else output += ' '
      index += 1
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  '
        index += 2
        state = 'plain'
      } else {
        output += char === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }
    if (state === 'single-quote') {
      if (char === "'" && next === "'") {
        output += '  '
        index += 2
      } else if (char === "'") {
        output += ' '
        index += 1
        state = 'plain'
      } else {
        output += char === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }
    if (state === 'double-quote' || state === 'backtick' || state === 'bracket') {
      const closing = state === 'double-quote' ? '"' : state === 'backtick' ? '`' : ']'
      if (char === closing && next === closing) {
        output += '  '
        index += 2
      } else if (char === closing) {
        output += ' '
        index += 1
        state = 'plain'
      } else {
        output += char === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }
    if (state === 'dollar-quote') {
      if (source.startsWith(dollarTag, index)) {
        output += ' '.repeat(dollarTag.length)
        index += dollarTag.length
        state = 'plain'
      } else {
        output += char === '\n' ? '\n' : ' '
        index += 1
      }
      continue
    }
    if (char === '-' && next === '-') {
      output += '  '
      index += 2
      state = 'line-comment'
      continue
    }
    if (char === '/' && next === '*') {
      output += '  '
      index += 2
      state = 'block-comment'
      continue
    }
    if (char === "'") state = 'single-quote'
    else if (char === '"') state = 'double-quote'
    else if (char === '`') state = 'backtick'
    else if (char === '[') state = 'bracket'
    else if (char === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
      if (match) {
        dollarTag = match[0]
        state = 'dollar-quote'
        output += ' '.repeat(dollarTag.length)
        index += dollarTag.length
        continue
      }
    }
    output += state === 'plain' ? char : ' '
    index += 1
  }
  return output
}

function analyzeReadOnlyDatabaseQuery(sql) {
  const source = String(sql || '').trim()
  if (!source) return { ok: false, reason: 'SQL is required.' }
  const masked = maskSqlForReadOnlyAnalysis(source)
  const executableStatements = masked.split(';').filter((part) => part.trim())
  if (executableStatements.length !== 1) {
    return { ok: false, reason: '分页和 Excel 导出仅支持单条只读查询。' }
  }
  const firstKeyword = executableStatements[0].match(/[A-Za-z]+/)?.[0]?.toUpperCase()
  if (!['SELECT', 'WITH'].includes(firstKeyword)) {
    return { ok: false, reason: '仅 SELECT 或 WITH 只读查询支持分页和 Excel 导出。' }
  }
  const forbidden = /\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|INTO|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|CALL|EXEC|EXECUTE|DO|COPY|LOAD|LOCK|UNLOCK|SET|USE|COMMIT|ROLLBACK|SAVEPOINT|BEGIN|DECLARE|VACUUM)\b/i
  if (forbidden.test(executableStatements[0])) {
    return { ok: false, reason: '查询包含可能修改数据或会话状态的语句，不能分页或导出。' }
  }
  return {
    ok: true,
    sql: source.replace(/;\s*$/, '').trim(),
    masked: executableStatements[0]
  }
}

function hasTopLevelSqlServerOrderBy(maskedSql) {
  let depth = 0
  const tokens = []
  const expression = /[A-Za-z_][A-Za-z0-9_]*|[()]/g
  let match
  while ((match = expression.exec(maskedSql))) {
    if (match[0] === '(') depth += 1
    else if (match[0] === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) tokens.push(match[0].toUpperCase())
  }
  return tokens.some((token, index) => token === 'ORDER' && tokens[index + 1] === 'BY')
}

function buildPagedDatabaseQuery(config, analysis, page, pageSize) {
  const safePage = Math.max(1, Math.floor(Number(page) || 1))
  const safePageSize = Math.max(1, Math.min(5000, Math.floor(Number(pageSize) || 100)))
  const offset = (safePage - 1) * safePageSize
  const fetchSize = safePageSize + 1
  const engine = String(config.engine || '').toLowerCase()
  if (engine === 'sqlserver') {
    if (/\b(?:OFFSET|FETCH)\b/i.test(analysis.masked)) {
      throw new Error('SQL Server 分页查询不能包含已有的 OFFSET/FETCH，请移除后重试。')
    }
    if (/\bTOP\s*(?:\(|\d)/i.test(analysis.masked)) {
      throw new Error('SQL Server 分页查询不能同时使用 TOP，请移除 TOP 后重试。')
    }
    const orderBy = hasTopLevelSqlServerOrderBy(analysis.masked) ? '' : ' ORDER BY (SELECT NULL)'
    return `${analysis.sql}${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${fetchSize} ROWS ONLY`
  }
  if (isOracleLikeEngine(engine)) {
    return `SELECT * FROM (${analysis.sql}) ops_flow_query OFFSET ${offset} ROWS FETCH NEXT ${fetchSize} ROWS ONLY`
  }
  return `SELECT * FROM (${analysis.sql}) AS ops_flow_query LIMIT ${fetchSize} OFFSET ${offset}`
}

async function executeDatabaseQueryPage(connection, config, analysis, page, pageSize) {
  const query = buildPagedDatabaseQuery(config, analysis, page, pageSize)
  const engine = String(config.engine || '').toLowerCase()
  let rows = []
  let columns = []
  if (engine === 'postgres') {
    const result = await connection.query(query)
    rows = result.rows || []
    columns = (result.fields || []).map((field) => field.name)
  } else if (engine === 'sqlserver') {
    const result = await connection.request().query(query)
    rows = result.recordset || []
    columns = Object.keys(result.recordset?.columns || {})
  } else if (isOracleLikeEngine(engine)) {
    const result = await executeOracleLike(connection, engine, query)
    rows = result.rows || []
    columns = (result.metaData || []).map((field) => field.name)
  } else {
    const [resultRows, fields] = await connection.query(query)
    rows = Array.isArray(resultRows) ? resultRows : []
    columns = (fields || []).map((field) => field.name)
  }
  const safePageSize = Math.max(1, Math.min(5000, Math.floor(Number(pageSize) || 100)))
  return {
    rows: rows.slice(0, safePageSize),
    columns: columns.length ? columns : Object.keys(rows[0] || {}),
    hasMore: rows.length > safePageSize
  }
}

ipcMain.handle('db:exec', async (_event, config, sql, options = {}) => {
  const analysis = analyzeReadOnlyDatabaseQuery(sql)
  if (analysis.ok && options.paginate !== false) {
    const page = Math.max(1, Math.floor(Number(options.page) || 1))
    const pageSize = Math.max(20, Math.min(500, Math.floor(Number(options.pageSize) || 100)))
    return withDatabase(config, async (connection) => {
      const result = await executeDatabaseQueryPage(connection, config, analysis, page, pageSize)
      return {
        ok: true,
        query: true,
        rows: result.rows,
        columns: result.columns,
        rowCount: result.rows.length,
        page,
        pageSize,
        hasMore: result.hasMore
      }
    })
  }
  return withDatabase(config, async (connection) => {
    if (config.engine === 'postgres') {
      const result = await connection.query(sql)
      return { ok: true, rows: result.rows, rowCount: result.rowCount }
    }

    if (config.engine === 'sqlserver') {
      const result = await connection.request().query(sql)
      return { ok: true, rows: result.recordset || [], rowCount: result.rowsAffected?.reduce((sum, count) => sum + count, 0) }
    }

    if (isOracleLikeEngine(config.engine)) {
      const result = await executeOracleLike(connection, config.engine, sql, [], { autoCommit: true })
      return { ok: true, rows: result.rows || [], rowCount: result.rowsAffected }
    }

    const [rows] = await connection.query(sql)
    return { ok: true, rows }
  })
})

ipcMain.handle('db:exec-script', async (event, config, sql, options = {}) => {
  const statements = splitDatabaseScript(sql, config.engine)
  if (!statements.length) return { ok: false, message: 'The SQL file contains no executable statements' }
  const startedAt = Date.now()
  const task = {
    webContents: event.sender,
    id: options.taskId || `sql-file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'sql-file',
    name: options.fileName || 'SQL file',
    localPath: options.filePath || '',
    remotePath: `${config.name || config.engine || 'database'} / ${config.database || ''}`,
    total: statements.length,
    startedAt
  }
  const session = {
    task,
    webContentsId: event.sender.id,
    cancelRequested: false,
    completedStatements: 0
  }
  databaseScriptSessions.set(task.id, session)
  emitTransferProgress(task, { transferred: 0, status: 'running', message: `Prepared ${statements.length} SQL batch(es)` })
  let result
  try {
    result = await withDatabase(config, async (connection) => executeDatabaseScriptBatches(connection, config, statements, task, options, session))
  } catch (error) {
    result = { ok: false, completedStatements: session.completedStatements, message: error.message }
  } finally {
    databaseScriptSessions.delete(task.id)
  }
  const durationSeconds = elapsedSecondsSince(startedAt)
  const finalMessage = appendElapsedSeconds(
    result.ok ? `${statements.length} SQL batch(es) completed` : result.message,
    durationSeconds
  )
  emitTransferProgress(task, {
    transferred: result.ok ? statements.length : Number(result.completedStatements || 0),
    status: result.ok ? 'done' : result.canceled && !result.rollbackFailed ? 'cancelled' : 'failed',
    message: finalMessage
  })
  return {
    ...result,
    script: true,
    statementCount: statements.length,
    durationSeconds,
    message: finalMessage
  }
})

ipcMain.handle('db:exec-script-file', async (event, config, options = {}) => {
  const filePath = String(options.filePath || '')
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return { ok: false, message: 'The selected SQL script no longer exists.' }
  }
  if (!/\.(?:sql|sql\.gz|gz)$/i.test(filePath)) {
    return { ok: false, message: 'Select an .sql or .sql.gz file.' }
  }
  const fileSize = Math.max(1, statSync(filePath).size)
  const checksumFileExists = existsSync(`${filePath}.sha256`)
  const streamPassCount = checksumFileExists ? 3 : 2
  const startedAt = Date.now()
  const task = {
    webContents: event.sender,
    id: options.taskId || `sql-file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'sql-file',
    name: options.fileName || basename(filePath),
    localPath: filePath,
    remotePath: `${config.name || config.engine || 'database'} / ${config.database || ''}`,
    total: fileSize * streamPassCount,
    startedAt
  }
  const session = {
    task,
    webContentsId: event.sender.id,
    cancelRequested: false,
    completedStatements: 0,
    completedDataRows: 0,
    totalDataRows: 0,
    phase: checksumFileExists ? 'checksum' : 'scanning',
    progressTransferred: 0
  }
  let statementCount = 0
  let dataRowCount = 0
  let result
  const createPhaseProgress = (offset, messageFactory) => {
    let lastBytes = 0
    let lastAt = 0
    return (processedBytes, _totalBytes, force = false) => {
      const bytes = Math.max(0, Math.min(fileSize, Number(processedBytes || 0)))
      const now = Date.now()
      if (!force && bytes < fileSize && bytes - lastBytes < 1024 * 1024 && now - lastAt < 200) return
      lastBytes = bytes
      lastAt = now
      session.progressTransferred = offset + bytes
      emitTransferProgress(task, {
        transferred: session.progressTransferred,
        status: 'running',
        message: messageFactory(bytes)
      })
    }
  }
  const checksumProgress = createPhaseProgress(0, (bytes) => `Verifying SHA-256 checksum (${formatPercent(bytes, fileSize)})`)
  const scanOffset = checksumFileExists ? fileSize : 0
  const scanProgress = createPhaseProgress(scanOffset, (bytes) => (
    `Scanning SQL script (${formatPercent(bytes, fileSize)}); ${statementCount} batch(es), ${dataRowCount} data row(s) found`
  ))
  const executionOffset = scanOffset + fileSize
  const executionProgress = createPhaseProgress(executionOffset, (bytes) => (
    `Reading SQL for execution (${formatPercent(bytes, fileSize)}); ${session.completedStatements}/${statementCount || '?'} batch(es), ${session.completedDataRows}/${dataRowCount || 0} data row(s) completed`
  ))
  databaseScriptSessions.set(task.id, session)
  emitTransferProgress(task, {
    transferred: 0,
    status: 'running',
    message: checksumFileExists
      ? 'Verifying the optional SHA-256 checksum'
      : 'Scanning the SQL script without loading it into memory'
  })
  try {
    await verifyOptionalSha256Sidecar(filePath, {
      isCanceled: () => session.cancelRequested,
      onProgress: checksumProgress
    })
    session.phase = 'scanning'
    for await (const batch of streamDatabaseScriptExecutionBatches(filePath, config.engine, {
      isCanceled: () => session.cancelRequested,
      onProgress: scanProgress
    })) {
      if (!batch.sql) continue
      if (!statementCount) {
        session.opsFlowBackupSourceDatabase = detectOpsFlowBackupSourceDatabase(batch.sql)
        session.opsFlowBackup = isOpsFlowLogicalBackup(batch.sql)
      }
      if (session.cancelRequested) {
        result = { ok: false, canceled: true, completedStatements: 0, message: 'SQL script execution canceled before it started' }
        break
      }
      statementCount += 1
      dataRowCount += Number(batch.dataRows || 0)
    }
    if (!result && !statementCount) {
      result = { ok: false, message: 'The SQL file contains no executable statements' }
    }
    if (!result) {
      session.totalDataRows = dataRowCount
      scanProgress(fileSize, fileSize, true)
      emitTransferProgress(task, {
        transferred: executionOffset,
        status: 'running',
        message: `Prepared ${statementCount} SQL batch(es) and ${dataRowCount} data row(s); starting streaming execution`
      })
      session.progressTransferred = executionOffset
      session.phase = 'executing'
      result = await withDatabase(config, async (connection) => (
        executeDatabaseScriptFileBatches(connection, config, filePath, statementCount, task, {
          ...options,
          onFileProgress: executionProgress
        }, session)
      ))
    }
  } catch (error) {
    result = isSqlScriptCanceledError(error) || session.cancelRequested
      ? { ok: false, canceled: true, completedStatements: session.completedStatements, message: 'SQL script execution stopped' }
      : { ok: false, completedStatements: session.completedStatements, message: error.message }
  } finally {
    databaseScriptSessions.delete(task.id)
  }
  const durationSeconds = elapsedSecondsSince(startedAt)
  const finalMessage = appendElapsedSeconds(
    result.ok
      ? `${statementCount} SQL batch(es) and ${session.completedDataRows} data row(s) completed`
      : result.message,
    durationSeconds
  )
  emitTransferProgress(task, {
    transferred: result.ok ? task.total : session.progressTransferred,
    status: result.ok ? 'done' : result.canceled && !result.rollbackFailed ? 'cancelled' : 'failed',
    message: finalMessage
  })
  return {
    ...result,
    script: true,
    streamed: true,
    statementCount,
    totalDataRows: dataRowCount,
    completedDataRows: session.completedDataRows,
    durationSeconds,
    message: finalMessage
  }
})

ipcMain.handle('db:cancel-script', async (event, taskId) => {
  const session = databaseScriptSessions.get(String(taskId || ''))
  if (!session || session.webContentsId !== event.sender.id) {
    return { ok: false, message: 'SQL script is not running' }
  }
  if (session.cancelRequested) {
    return { ok: true, message: 'Stop already requested' }
  }
  session.cancelRequested = true
  const message = session.phase === 'checksum'
    ? 'Stop requested; ending checksum verification'
    : session.phase === 'scanning'
      ? 'Stop requested; ending SQL script scan'
      : 'Stop requested; waiting for the current SQL batch before rollback'
  emitTransferProgress(session.task, {
    transferred: session.progressTransferred,
    status: 'running',
    message
  })
  return { ok: true, message: 'Stop requested' }
})

function normalizeExcelQueryCell(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const text = String(value)
  return text.length > 32767 ? `${text.slice(0, 32764)}...` : text
}

function queryExportFileName(config) {
  return `${safeFileName(config.database || config.name || 'query')}-query-${backupTimestamp()}.xlsx`
}

async function exportDatabaseQueryToExcel(connection, config, analysis, filePath, task, session, options = {}) {
  const batchSize = Math.max(200, Math.min(5000, Math.floor(Number(options.batchSize) || 2000)))
  const maximumDataRows = 1048575
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: false
  })
  session.outputCreated = true
  const worksheet = workbook.addWorksheet('Query Result', {
    views: [{ state: 'frozen', ySplit: 1 }]
  })
  let columns = []
  let page = 1
  let exportedRows = 0
  try {
    while (true) {
      if (session.cancelRequested) throw Object.assign(new Error('查询结果导出已取消。'), { canceled: true })
      const result = await executeDatabaseQueryPage(connection, config, analysis, page, batchSize)
      if (!columns.length) {
        columns = result.columns.length ? result.columns : Object.keys(result.rows[0] || {})
        if (columns.length) {
          worksheet.columns = columns.map((name) => ({ key: name, width: Math.min(42, Math.max(12, String(name).length + 3)) }))
          const header = worksheet.addRow(columns)
          header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
          header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF147D73' } }
          header.commit()
        }
      }
      for (const row of result.rows) {
        if (session.cancelRequested) throw Object.assign(new Error('查询结果导出已取消。'), { canceled: true })
        if (exportedRows >= maximumDataRows) {
          throw new Error('查询结果超过 Excel 单工作表上限 1,048,575 行，请增加查询条件后分批导出。')
        }
        const values = columns.map((column) => normalizeExcelQueryCell(row?.[column]))
        worksheet.addRow(values).commit()
        exportedRows += 1
      }
      session.exportedRows = exportedRows
      emitTransferProgress(task, {
        transferred: exportedRows,
        total: 0,
        indeterminate: true,
        status: 'running',
        message: `已导出 ${exportedRows.toLocaleString('zh-CN')} 行…`
      })
      if (!result.hasMore) break
      page += 1
    }
    worksheet.commit()
    await workbook.commit()
    return { ok: true, path: filePath, rowCount: exportedRows }
  } catch (error) {
    try {
      worksheet.commit()
      await workbook.commit()
    } catch {
      // Ignore writer shutdown errors; the incomplete workbook is removed below.
    }
    try {
      if (existsSync(filePath)) rmSync(filePath, { force: true })
    } catch {
      // The writer can briefly retain a Windows file handle while shutting down.
    }
    return { ok: false, canceled: Boolean(error.canceled), rowCount: exportedRows, message: error.message }
  }
}

ipcMain.handle('db:export-query', async (event, config, sql, options = {}) => {
  const analysis = analyzeReadOnlyDatabaseQuery(sql)
  if (!analysis.ok) return { ok: false, message: analysis.reason }
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showSaveDialog(window, {
    title: '导出查询结果到 Excel',
    defaultPath: queryExportFileName(config),
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
  })
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true, message: '已取消导出。' }
  const filePath = /\.xlsx$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.xlsx`
  const task = {
    webContents: event.sender,
    id: String(options.taskId || `database-query-export-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: 'database-query-export',
    name: basename(filePath),
    localPath: filePath,
    remotePath: `${config.name || config.engine || 'database'} / ${config.database || ''}`,
    total: 0,
    startedAt: Date.now()
  }
  const session = {
    task,
    webContentsId: event.sender.id,
    cancelRequested: false,
    exportedRows: 0,
    outputCreated: false
  }
  databaseQueryExportSessions.set(task.id, session)
  emitTransferProgress(task, {
    transferred: 0,
    total: 0,
    indeterminate: true,
    status: 'running',
    message: '正在准备全量查询结果导出…'
  })
  let result
  try {
    result = await withDatabase(config, async (connection) => (
      exportDatabaseQueryToExcel(connection, config, analysis, filePath, task, session, options)
    ))
  } finally {
    databaseQueryExportSessions.delete(task.id)
  }
  if (!result.ok && session.outputCreated) {
    try {
      if (existsSync(filePath)) rmSync(filePath, { force: true })
    } catch {
      // The incomplete file will be reported as failed if Windows still holds it.
    }
  }
  emitTransferProgress(task, {
    transferred: Number(result.rowCount || session.exportedRows || 0),
    total: Number(result.rowCount || session.exportedRows || 0),
    indeterminate: false,
    status: result.ok ? 'done' : result.canceled ? 'cancelled' : 'failed',
    message: result.ok
      ? `Excel 导出完成，共 ${Number(result.rowCount || 0).toLocaleString('zh-CN')} 行`
      : result.message
  })
  return result
})

ipcMain.handle('db:cancel-query-export', async (event, taskId) => {
  const session = databaseQueryExportSessions.get(String(taskId || ''))
  if (!session || session.webContentsId !== event.sender.id) {
    return { ok: false, message: '查询结果导出任务未运行。' }
  }
  session.cancelRequested = true
  emitTransferProgress(session.task, {
    transferred: session.exportedRows,
    total: 0,
    indeterminate: true,
    status: 'running',
    message: '已请求取消，当前数据库批次结束后停止…'
  })
  return { ok: true, message: '已请求取消查询结果导出。' }
})

ipcMain.handle('db:export', async (event, config, tables = [], format = 'sql') => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  if (!tables.length) return { ok: false, message: 'No tables selected' }

  if (format === 'csv') {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Select export folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true, message: 'Export canceled' }
    const targetDir = picked.filePaths[0]
    mkdirSync(targetDir, { recursive: true })
    return withDatabase(config, async (connection) => exportTablesAsCsv(connection, config, tables, targetDir))
  }

  const picked = await dialog.showSaveDialog(window, {
    title: 'Export SQL',
    defaultPath: `${config.database || 'database'}-${Date.now()}.sql`,
    filters: [{ name: 'SQL', extensions: ['sql'] }]
  })
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true, message: 'Export canceled' }
  return withDatabase(config, async (connection) => exportTablesAsSql(connection, config, tables, picked.filePath))
})

ipcMain.handle('db:backup', async (event, config, options = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const operationId = String(options.operationId || `database-backup-${Date.now()}`)
  const safeDatabaseName = safeFileName(config.database || config.username || 'database')
  const backupFormat = options.format === 'sql-gzip' ? 'sql-gzip' : 'sql'
  const extension = backupFormat === 'sql-gzip' ? 'sql.gz' : 'sql'
  const picked = await dialog.showSaveDialog(window, {
    title: '保存数据库逻辑备份',
    defaultPath: `${safeDatabaseName}-${backupTimestamp()}.${extension}`,
    filters: backupFormat === 'sql-gzip'
      ? [{ name: 'Compressed SQL logical backup', extensions: ['sql.gz', 'gz'] }]
      : [{ name: 'SQL logical backup', extensions: ['sql'] }]
  })
  if (picked.canceled || !picked.filePath) {
    return { ok: false, canceled: true, operationId, message: 'Backup canceled' }
  }
  const outputFilePath = backupFormat === 'sql-gzip'
    ? (/\.sql\.gz$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.sql.gz`)
    : (/\.sql$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.sql`)

  const session = {
    operationId,
    canceled: false,
    content: options.content || 'structure-data',
    sender: event.sender,
    startedAt: Date.now()
  }
  databaseBackupSessions.set(operationId, session)
  sendDatabaseBackupProgress(session, {
    stage: 'preparing',
    status: 'running',
    message: '正在检查数据库和备份范围…'
  })

  try {
    const result = await withDatabase(config, async (connection) => {
      const result = await createBuiltInDatabaseBackup(connection, config, {
        ...options,
        operationId,
        filePath: outputFilePath
      }, session)
      return { ...result, operationId }
    })
    if (!result.ok && !result.canceled && !session.terminalProgressSent) {
      sendDatabaseBackupProgress(session, {
        stage: 'error',
        status: 'failed',
        message: result.message || 'Database backup failed'
      })
    }
    return {
      ...result,
      operationId,
      durationSeconds: elapsedSecondsSince(session.startedAt)
    }
  } finally {
    databaseBackupSessions.delete(operationId)
  }
})

ipcMain.handle('db:backup-cancel', async (_event, operationId) => {
  const session = databaseBackupSessions.get(String(operationId || ''))
  if (!session) return { ok: false, message: 'Database backup is not running' }
  session.canceled = true
  sendDatabaseBackupProgress(session, {
    stage: 'canceling',
    status: 'running',
    message: '正在停止备份，当前批次完成后退出…'
  })
  return { ok: true, message: 'Backup cancellation requested' }
})

ipcMain.handle('redis:test', async (_event, config) => {
  return withRedis(config, async (client) => {
    await client.ping()
    return { ok: true, message: 'Redis connected' }
  })
})

ipcMain.handle('redis:inspect', async (_event, config) => {
  return withRedis(config, async (client) => {
    const info = await client.info()
    const dbSize = await client.dbSize()
    return { ok: true, info, dbSize }
  })
})

ipcMain.handle('redis:databases', async (_event, config) => {
  return withRedis(config, async (client) => {
    const info = await client.info('keyspace')
    const databases = parseRedisDatabases(info)
    return { ok: true, databases }
  })
})

ipcMain.handle('redis:keys', async (_event, config, database = 0, pattern = '*') => {
  return withRedis({ ...config, database }, async (client) => {
    const keys = []
    let cursor = '0'
    do {
      const result = await client.scan(cursor, { MATCH: pattern || '*', COUNT: 200 })
      cursor = String(result.cursor)
      keys.push(...result.keys)
    } while (cursor !== '0' && keys.length < 1000)
    return { ok: true, keys: keys.slice(0, 1000).sort(), truncated: keys.length >= 1000 }
  })
})

ipcMain.handle('redis:key', async (_event, config, database = 0, key) => {
  return withRedis({ ...config, database }, async (client) => {
    const type = await client.type(key)
    const ttl = await client.ttl(key)
    const value = await readRedisValue(client, key, type)
    return { ok: true, key, type, ttl, value }
  })
})

ipcMain.handle('redis:key-delete', async (_event, config, database = 0, key) => {
  return withRedis({ ...config, database }, async (client) => {
    const deleted = await client.del(key)
    return { ok: true, deleted }
  })
})

ipcMain.handle('redis:flushdb', async (_event, config, database = 0) => {
  return withRedis({ ...config, database }, async (client) => {
    await client.flushDb()
    return { ok: true }
  })
})

ipcMain.handle('redis:exec', async (_event, config, commandLine) => {
  return withRedis(config, async (client) => {
    const args = splitCommand(commandLine)
    const command = args.shift()
    if (!command) return { ok: false, message: 'Empty Redis command' }
    const result = await client.sendCommand([command, ...args])
    return { ok: true, result }
  })
})

ipcMain.handle('redis:backup', async (event, config, database = 0, options = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const operationId = String(options.operationId || `redis-backup-${Date.now()}`)
  const safeConnectionName = safeFileName(config.name || config.host || 'redis')
  const picked = await dialog.showSaveDialog(window, {
    title: '保存 Redis 逻辑备份',
    defaultPath: `${safeConnectionName}-db${Number(database || 0)}-${backupTimestamp()}.opsredis`,
    filters: [{ name: 'Ops Flow Redis backup', extensions: ['opsredis'] }]
  })
  if (picked.canceled || !picked.filePath) {
    return { ok: false, canceled: true, operationId, message: 'Backup canceled' }
  }
  const outputFilePath = /\.opsredis$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.opsredis`
  const session = { operationId, canceled: false, sender: event.sender }
  redisBackupSessions.set(operationId, session)
  sendRedisBackupProgress(session, {
    status: 'running',
    stage: 'preparing',
    message: `正在准备备份 Redis db${Number(database || 0)}…`
  })
  try {
    const result = await withRedis({ ...config, database: Number(database || 0) }, async (client) => (
      createBuiltInRedisBackup(client, config, Number(database || 0), outputFilePath, session)
    ))
    if (!result.ok && !result.canceled && !session.terminalProgressSent) {
      sendRedisBackupProgress(session, {
        status: 'failed',
        stage: 'error',
        message: result.message || 'Redis backup failed'
      })
    }
    return { ...result, operationId }
  } finally {
    redisBackupSessions.delete(operationId)
  }
})

ipcMain.handle('redis:backup-cancel', async (_event, operationId) => {
  const session = redisBackupSessions.get(String(operationId || ''))
  if (!session) return { ok: false, message: 'Redis backup is not running' }
  session.canceled = true
  sendRedisBackupProgress(session, {
    status: 'running',
    stage: 'canceling',
    message: '正在停止 Redis 备份，当前键处理完成后退出…'
  })
  return { ok: true, message: 'Redis backup cancellation requested' }
})

ipcMain.handle('redis:select-backup', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showOpenDialog(window, {
    title: '选择 Redis 逻辑备份',
    properties: ['openFile'],
    filters: [
      { name: 'Ops Flow Redis backup', extensions: ['opsredis'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true, message: 'Restore canceled' }
  }
  try {
    const details = await inspectRedisBackupFile(picked.filePaths[0])
    return { ok: true, ...details }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('redis:restore', async (event, config, database = 0, options = {}) => {
  const operationId = String(options.operationId || `redis-restore-${Date.now()}`)
  const filePath = String(options.filePath || '')
  const conflict = ['skip', 'replace', 'error'].includes(options.conflict) ? options.conflict : 'skip'
  const session = { operationId, canceled: false, sender: event.sender }
  redisRestoreSessions.set(operationId, session)
  sendRedisRestoreProgress(session, {
    status: 'running',
    stage: 'validating',
    message: '正在校验 Redis 备份文件…'
  })
  try {
    const details = await inspectRedisBackupFile(filePath)
    const result = await withRedis({ ...config, database: Number(database || 0) }, async (client) => (
      restoreBuiltInRedisBackup(client, Number(database || 0), details, conflict, session)
    ))
    if (!result.ok && !result.canceled && !session.terminalProgressSent) {
      sendRedisRestoreProgress(session, {
        status: 'failed',
        stage: 'error',
        message: result.message || 'Redis restore failed'
      })
    }
    return { ...result, operationId }
  } catch (error) {
    if (!session.terminalProgressSent) {
      sendRedisRestoreProgress(session, {
        status: 'failed',
        stage: 'error',
        message: error.message
      })
    }
    return { ok: false, operationId, message: error.message }
  } finally {
    redisRestoreSessions.delete(operationId)
  }
})

ipcMain.handle('redis:restore-cancel', async (_event, operationId) => {
  const session = redisRestoreSessions.get(String(operationId || ''))
  if (!session) return { ok: false, message: 'Redis restore is not running' }
  session.canceled = true
  sendRedisRestoreProgress(session, {
    status: 'running',
    stage: 'canceling',
    message: '正在停止 Redis 恢复，当前键处理完成后退出…'
  })
  return { ok: true, message: 'Redis restore cancellation requested' }
})

function withSshClient(config, task) {
  return new Promise((resolve) => {
    const client = new Client()
    let settled = false
    let ready = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    client
      .on('ready', async () => {
        ready = true
        try {
          const result = await task(client)
          finish(result)
        } catch (error) {
          finish({ ok: false, message: error.message })
        } finally {
          client.end()
        }
      })
      .on('error', (error) => {
        finish({ ok: false, message: error.message, code: error.code || '' })
      })
      .on('close', () => {
        if (!settled) {
          finish({ ok: false, message: ready ? 'SSH connection closed during the remote operation' : 'SSH connection closed before authentication completed' })
        }
      })
    connectSshClient(client, config).catch((error) => {
      finish({ ok: false, message: error.message, code: error.code || '' })
    })
  })
}

function normalizeManagedSshTunnel(tunnel = {}) {
  const id = String(tunnel.id || '').trim()
  const localPort = Number(tunnel.localPort)
  const targetHost = String(tunnel.targetHost || '').trim()
  const targetPort = Number(tunnel.targetPort)
  if (!id) throw new Error('Tunnel ID is missing')
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error('Local port must be between 1 and 65535')
  }
  if (!targetHost || targetHost.length > 253 || /[\u0000\r\n]/.test(targetHost)) {
    throw new Error('Destination host is invalid')
  }
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('Destination port must be between 1 and 65535')
  }
  return {
    id,
    name: String(tunnel.name || '').trim() || `${targetHost}:${targetPort}`,
    sshServerId: String(tunnel.sshServerId || '').trim(),
    localHost: '127.0.0.1',
    localPort,
    targetHost,
    targetPort
  }
}

function managedSshTunnelStatus(session) {
  return {
    id: session.id,
    status: session.status,
    message: session.message || '',
    localHost: session.localHost,
    localPort: session.localPort,
    targetHost: session.targetHost,
    targetPort: session.targetPort
  }
}

function notifyManagedSshTunnel(session) {
  if (!session.webContents || session.webContents.isDestroyed()) return
  session.webContents.send('ssh-tunnel:status', managedSshTunnelStatus(session))
}

function stopManagedSshTunnel(tunnelId, notify = true) {
  const session = sshTunnelSessions.get(String(tunnelId || ''))
  if (!session) return false
  session.closing = true
  sshTunnelSessions.delete(session.id)
  for (const socket of session.sockets) socket.destroy()
  session.sockets.clear()
  for (const stream of session.streams) stream.destroy()
  session.streams.clear()
  if (session.server) {
    try {
      session.server.close()
    } catch {
      // The listener may still be between creation and the listen callback.
    }
  }
  session.client?.end()
  session.finish?.({ ok: true, id: session.id, status: 'stopped', message: '' })
  if (notify) {
    session.status = 'stopped'
    session.message = ''
    notifyManagedSshTunnel(session)
  }
  return true
}

function listenForManagedSshTunnel(session) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      session.sockets.add(socket)
      socket.setNoDelay(true)
      socket.pause()
      let sshStream = null
      const closePair = () => {
        session.sockets.delete(socket)
        if (sshStream) session.streams.delete(sshStream)
        if (!socket.destroyed) socket.destroy()
        if (sshStream && !sshStream.destroyed) sshStream.destroy()
      }

      socket.on('error', closePair)
      socket.on('close', closePair)
      session.client.forwardOut(
        '127.0.0.1',
        Number(socket.remotePort || 0),
        session.targetHost,
        session.targetPort,
        (error, stream) => {
          if (error || session.closing) {
            closePair()
            return
          }
          sshStream = stream
          session.streams.add(stream)
          stream.on('error', closePair)
          stream.on('close', closePair)
          socket.pipe(stream).pipe(socket)
          socket.resume()
        }
      )
    })

    session.server = server
    const onStartupError = (error) => reject(error)
    server.once('error', onStartupError)
    server.listen(session.localPort, session.localHost, () => {
      server.removeListener('error', onStartupError)
      resolve()
    })
  })
}

function startManagedSshTunnel(webContents, tunnel, sshConfig) {
  return new Promise((resolve) => {
    let normalized
    try {
      normalized = normalizeManagedSshTunnel(tunnel)
      if (!sshConfig?.host || !sshConfig?.username) throw new Error('Saved SSH server is missing or incomplete')
    } catch (error) {
      resolve({ ok: false, status: 'error', message: error.message })
      return
    }

    const existing = sshTunnelSessions.get(normalized.id)
    if (existing?.status === 'running' || existing?.status === 'connecting') {
      resolve({ ok: true, ...managedSshTunnelStatus(existing) })
      return
    }
    if (existing) stopManagedSshTunnel(normalized.id, false)

    const session = {
      ...normalized,
      status: 'connecting',
      message: 'Connecting to SSH server…',
      webContents,
      client: new Client(),
      server: null,
      sockets: new Set(),
      streams: new Set(),
      closing: false,
      settled: false
    }
    sshTunnelSessions.set(session.id, session)
    notifyManagedSshTunnel(session)

    const finish = (result) => {
      if (session.settled) return
      session.settled = true
      resolve(result)
    }
    session.finish = finish
    const fail = (error) => {
      if (session.closing || sshTunnelSessions.get(session.id) !== session) return
      const rawMessage = error?.message || String(error || 'Tunnel failed')
      const message = error?.code === 'EADDRINUSE'
        ? `Local port 127.0.0.1:${session.localPort} is already in use`
        : rawMessage
      session.status = 'error'
      session.message = message
      notifyManagedSshTunnel(session)
      finish({ ok: false, ...managedSshTunnelStatus(session) })
      stopManagedSshTunnel(session.id, false)
    }

    session.client
      .once('ready', async () => {
        try {
          await listenForManagedSshTunnel(session)
          if (session.closing) {
            if (session.server?.listening) session.server.close()
            return
          }
          session.server.on('error', fail)
          session.status = 'running'
          session.message = ''
          notifyManagedSshTunnel(session)
          finish({ ok: true, ...managedSshTunnelStatus(session) })
        } catch (error) {
          fail(error)
        }
      })
      .on('error', fail)
      .on('close', () => {
        if (!session.closing) fail(new Error('SSH connection closed; the local tunnel has stopped'))
      })

    connectSshClient(session.client, sshConfig).catch(fail)
  })
}

function activeShellSessionFor(webContents, config) {
  if (!webContents || webContents.isDestroyed()) return null
  const sessionId = shellSessionsByWebContents.get(webContents.id)
  const session = sessionId ? shellSessions.get(sessionId) : null
  if (!session?.client || !session?.stream) return null
  const requestedServerId = String(config?.id || '')
  if (!requestedServerId || session.serverId !== requestedServerId) return null
  return session
}

function workflowSshSessionFor(webContents, config, sessionId = '') {
  const normalizedSessionId = String(sessionId || '')
  if (!normalizedSessionId || !webContents || webContents.isDestroyed()) return null
  const session = workflowSshSessions.get(normalizedSessionId)
  if (!session || session.closed || session.webContentsId !== webContents.id) return null
  const requestedServerId = String(config?.id || '')
  if (requestedServerId && session.serverId && session.serverId !== requestedServerId) return null
  return session
}

function startWorkflowSshSession(webContents, config, requestedSessionId = '') {
  const sessionId = String(requestedSessionId || `workflow-ssh-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const existing = workflowSshSessionFor(webContents, config, sessionId)
  if (existing) return Promise.resolve({ ok: true, sessionId, reused: true, sharedTerminal: !existing.ownsClient })
  if (workflowSshSessions.has(sessionId)) {
    return Promise.resolve({ ok: false, message: 'Workflow SSH session id is already in use' })
  }

  const activeShell = activeShellSessionFor(webContents, config)
  if (activeShell) {
    workflowSshSessions.set(sessionId, {
      id: sessionId,
      client: activeShell.client,
      webContentsId: webContents.id,
      serverId: String(config?.id || ''),
      ownsClient: false,
      closed: false
    })
    return Promise.resolve({ ok: true, sessionId, reused: true, sharedTerminal: true })
  }

  return new Promise((resolve) => {
    const client = new Client()
    const session = {
      id: sessionId,
      client,
      webContentsId: webContents.id,
      serverId: String(config?.id || ''),
      ownsClient: true,
      closed: false
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const cleanup = () => {
      session.closed = true
      if (workflowSshSessions.get(sessionId) === session) workflowSshSessions.delete(sessionId)
    }

    client
      .once('ready', () => {
        client.setNoDelay(true)
        workflowSshSessions.set(sessionId, session)
        webContents.once('destroyed', () => closeWorkflowSshSession(sessionId))
        finish({ ok: true, sessionId, reused: false, sharedTerminal: false })
      })
      .once('error', (error) => {
        cleanup()
        finish({ ok: false, message: error.message })
      })
      .once('close', () => {
        cleanup()
        finish({ ok: false, message: 'SSH transport closed before the workflow session was ready' })
      })

    connectSshClient(client, config).catch((error) => {
      cleanup()
      finish({ ok: false, message: error.message })
    })
  })
}

function closeWorkflowSshSession(sessionId) {
  const normalizedSessionId = String(sessionId || '')
  const session = workflowSshSessions.get(normalizedSessionId)
  if (!session) return
  session.closed = true
  workflowSshSessions.delete(normalizedSessionId)
  if (!session.ownsClient) return
  try {
    session.client?.end()
  } catch {
    // The transport may already have been closed by the server.
  }
}

async function withPreferredSshClient(webContents, config, workflowSessionId, task) {
  const workflowSession = workflowSshSessionFor(webContents, config, workflowSessionId)
  if (workflowSession) return task(workflowSession.client, { shared: true, sessionId: workflowSession.id, workflow: true })
  return withActiveShellClient(webContents, config, task)
}

async function withActiveShellClient(webContents, config, task) {
  const session = activeShellSessionFor(webContents, config)
  if (!session) {
    return withSshClient(config, (client) => task(client, { shared: false }))
  }
  try {
    return await task(session.client, { shared: true, sessionId: session.id })
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

async function uploadWithReconnect(webContents, config, progress, upload, workflowSessionId = '') {
  let result = await withPreferredSshClient(webContents, config, workflowSessionId, (client, connection) => {
    progress.sharedConnection = connection.shared
    return upload(client)
  })
  if (!shouldRetryUploadConnection(result)) return result

  emitTransferProgress(progress, {
    transferred: 0,
    status: 'running',
    message: 'SFTP connection interrupted before transfer; reconnecting once'
  })
  progress.sharedConnection = false
  result = await withSshClient(config, (client) => upload(client))
  return { ...result, retried: true }
}

function shouldRetryUploadConnection(result = {}) {
  if (result.ok || result.canceled || Number(result.transferred || 0) > 0) return false
  return /(?:ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|connection (?:was )?closed|connection lost|no response from server|channel open failure|unable to open channel|not connected|write EOF)/i.test(String(result.message || ''))
}

async function connectSshClient(client, config, shouldAbort = () => false) {
  const prepared = await prepareSshConnection(config)
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    prepared.cleanup()
  }
  if (shouldAbort()) {
    cleanup()
    throw new Error('SSH connection canceled')
  }
  client.once('close', cleanup)
  client.once('error', cleanup)
  try {
    client.connect(prepared.connection)
    client.setNoDelay(true)
  } catch (error) {
    cleanup()
    throw error
  }
}

async function prepareSshConnection(config, visitedServerIds = new Set()) {
  const connection = buildSshConnection(config)
  const jumpServerId = String(config?.jumpServerId || '').trim()
  if (!jumpServerId) return { connection, cleanup: () => {} }

  const currentServerId = String(config?.id || '').trim()
  const nextVisitedServerIds = new Set(visitedServerIds)
  if (currentServerId) {
    if (nextVisitedServerIds.has(currentServerId)) {
      throw new Error(`SSH jump chain contains a cycle at server "${config.name || currentServerId}".`)
    }
    nextVisitedServerIds.add(currentServerId)
  }
  if (nextVisitedServerIds.has(jumpServerId)) {
    throw new Error('SSH jump chain contains a cycle. Edit the server and choose a different jump server.')
  }
  if (nextVisitedServerIds.size >= 8) {
    throw new Error('SSH jump chain is too deep. At most 8 saved servers are allowed in one chain.')
  }

  const jumpConfig = resolveSavedSshServer(jumpServerId)
  if (!jumpConfig) {
    throw new Error('The configured SSH jump server is missing. Edit this server and select an available jump server.')
  }

  const upstream = await openPreparedSshClient(jumpConfig, nextVisitedServerIds)
  try {
    const socket = await openSshForwardStream(
      upstream.client,
      String(config.host || '').trim(),
      Number(config.port || 22)
    )
    let cleanedUp = false
    return {
      connection: { ...connection, sock: socket },
      cleanup: () => {
        if (cleanedUp) return
        cleanedUp = true
        if (!socket.destroyed) socket.destroy()
        upstream.close()
      }
    }
  } catch (error) {
    upstream.close()
    throw new Error(`SSH jump server "${jumpConfig.name || jumpConfig.host}" cannot reach ${config.host}:${Number(config.port || 22)}: ${error.message}`)
  }
}

function resolveSavedSshServer(serverId) {
  const servers = readStoreValue('servers')
  return Array.isArray(servers) ? servers.find((server) => String(server?.id || '') === serverId) || null : null
}

async function openPreparedSshClient(config, visitedServerIds) {
  const prepared = await prepareSshConnection(config, visitedServerIds)
  const client = new Client()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      client.end()
    } catch {
      // The upstream client may already be closed after a forwarding failure.
    }
    prepared.cleanup()
  }

  try {
    await new Promise((resolve, reject) => {
      let authenticated = false
      const fail = (error) => {
        if (authenticated) return
        reject(error instanceof Error ? error : new Error(String(error || 'SSH jump connection failed')))
      }
      client
        .once('ready', () => {
          authenticated = true
          resolve()
        })
        .once('error', fail)
        .once('close', () => fail(new Error('SSH jump connection closed before authentication completed')))
        .connect(prepared.connection)
      client.setNoDelay(true)
    })
    // Keep a listener installed so a later transport error cannot become an
    // unhandled EventEmitter error while the downstream connection is active.
    client.on('error', () => {})
    return { client, close }
  } catch (error) {
    close()
    throw new Error(`SSH jump server "${config.name || config.host}" connection failed: ${error.message}`)
  }
}

function openSshForwardStream(client, targetHost, targetPort, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!targetHost) {
      reject(new Error('target host is required'))
      return
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      reject(new Error('target SSH port must be between 1 and 65535'))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`opening the SSH forwarding channel timed out after ${Math.ceil(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
      if (settled) {
        if (stream && !stream.destroyed) stream.destroy()
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stream)
    })
  })
}

function buildSshConnection(config) {
  const requestedReadyTimeout = Number(config.readyTimeout || 30000)
  const connection = {
    host: config.host,
    port: Number(config.port || 22),
    username: config.username,
    readyTimeout: Math.max(5000, Math.min(60000, Number.isFinite(requestedReadyTimeout) ? requestedReadyTimeout : 30000)),
    keepaliveInterval: 10000,
    keepaliveCountMax: 6
  }

  if (config.privateKey) {
    connection.privateKey = config.privateKey
    if (config.passphrase) connection.passphrase = config.passphrase
  } else {
    connection.password = config.password
  }

  return connection
}

function execCommand(client, command, options = {}) {
  return new Promise((resolve) => {
    const { timeoutMs = 0, ...execOptions } = options || {}
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    client.exec(command, execOptions, (error, stream) => {
      if (error) {
        finish({ ok: false, message: error.message, stdout: '', stderr: '' })
        return
      }

      let stdout = ''
      let stderr = ''

      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => {
          try {
            stream.close()
          } catch {
            // Resolving the timeout is sufficient if the channel already closed.
          }
          finish({ ok: false, timedOut: true, message: `Remote command timed out after ${timeoutMs} ms`, stdout, stderr })
        }, Number(timeoutMs))
      }

      stream
        .on('close', (code) => {
          finish({
            ok: code === 0,
            code,
            stdout,
            stderr,
            message: code === 0 ? 'Command succeeded' : `Command exited with ${code}`
          })
        })
        .on('data', (data) => {
          stdout += data.toString()
        })

      stream.stderr.on('data', (data) => {
        stderr += data.toString()
      })
    })
  })
}

function execStreamingCommand(webContents, config, command, requestedExecutionId, privilege = { mode: 'normal', password: '' }, workflowSessionId = '') {
  return new Promise((resolve) => {
    const executionId = requestedExecutionId || `ssh-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const privilegeMode = ['sudo', 'su'].includes(privilege?.mode) ? privilege.mode : 'normal'
    const cachedPrivilege = workflowPrivilegeCredentials.get(workflowPrivilegeKey(config, privilegeMode))
    const privilegePassword = String(privilege?.password || cachedPrivilege?.password || '')
    const privilegePromptToken = privilegeMode !== 'normal' && privilegePassword
      ? `__OPS_PRIVILEGE_READY_${executionId.replace(/[^a-zA-Z0-9]/g, '_')}__`
      : ''
    const preparedCommand = buildStreamingPrivilegeCommand(command, privilegeMode, privilegePromptToken, Boolean(privilegePassword))
    const reusableSession = workflowSshSessionFor(webContents, config, workflowSessionId)
      || activeShellSessionFor(webContents, config)
    const client = reusableSession?.client || new Client()
    const ownsClient = !reusableSession
    let stream = null
    let stdout = ''
    let stderr = ''
    let settled = false
    let canceled = false
    let cancelTimer = null
    let privilegePasswordSent = false
    let privilegePromptSeen = false
    let privilegeOutputBuffer = ''
    let privilegePromptTimer = null
    const maxCapturedOutputLength = 2 * 1024 * 1024
    const appendCapturedOutput = (current, chunk) => {
      const next = `${current}${chunk}`
      return next.length > maxCapturedOutputLength ? next.slice(-maxCapturedOutputLength) : next
    }

    const send = (streamName, data) => {
      if (!webContents.isDestroyed()) {
        webContents.send('ssh:exec:data', {
          executionId,
          stream: streamName,
          data: String(data || '')
        })
      }
    }

    const sendPrivilegePassword = () => {
      if (privilegePasswordSent) return
      privilegePasswordSent = true
      if (privilegePromptTimer) clearTimeout(privilegePromptTimer)
      privilegePromptTimer = null
      try {
        stream?.write(`${privilegePassword}\n`)
      } catch {
        // The command close handler will report a failed privilege switch.
      }
    }

    const sendVisibleData = (streamName, data) => {
      const text = String(data || '')
      if (!privilegePromptToken || privilegePasswordSent) {
        send(streamName, text)
        return
      }

      let combined = `${privilegeOutputBuffer}${text}`
      privilegeOutputBuffer = ''
      if (!privilegePromptSeen) {
        const tokenIndex = combined.indexOf(privilegePromptToken)
        if (tokenIndex < 0) {
          const retainedLength = Math.min(privilegePromptToken.length - 1, combined.length)
          const visibleLength = combined.length - retainedLength
          if (visibleLength > 0) send(streamName, combined.slice(0, visibleLength))
          privilegeOutputBuffer = combined.slice(visibleLength)
          return
        }
        privilegePromptSeen = true
        combined = `${combined.slice(0, tokenIndex)}${combined.slice(tokenIndex + privilegePromptToken.length)}`
          .replace(/^\r?\n/, '')
        if (privilegeMode !== 'su') sendPrivilegePassword()
        else {
          privilegePromptTimer = setTimeout(sendPrivilegePassword, 1500)
        }
      }

      if (privilegeMode === 'su' && /password\s*:/i.test(combined)) sendPrivilegePassword()
      if (privilegePasswordSent) {
        if (combined) send(streamName, combined)
        return
      }

      const retainedLength = Math.min(64, combined.length)
      const visibleLength = combined.length - retainedLength
      if (visibleLength > 0) send(streamName, combined.slice(0, visibleLength))
      privilegeOutputBuffer = combined.slice(visibleLength)
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (cancelTimer) clearTimeout(cancelTimer)
      if (privilegePromptTimer) clearTimeout(privilegePromptTimer)
      sshExecSessions.delete(executionId)
      client.removeListener('error', handleSharedClientError)
      client.removeListener('close', handleSharedClientClose)
      if (ownsClient) {
        try {
          client.end()
        } catch {
          // The SSH client may already be closed after a remote exit.
        }
      }
      resolve({ executionId, ...result })
    }

    const cancel = () => {
      if (settled || canceled) return
      canceled = true
      if (stream) {
        try {
          stream.write('\x03')
        } catch {
          // Fall through to closing the SSH channel below.
        }
        try {
          stream.signal('INT')
        } catch {
          // Some SSH servers do not support channel signals.
        }
      }
      cancelTimer = setTimeout(() => {
        try {
          stream?.close()
        } catch {
          // Closing the client below is the final fallback.
        }
        finish({ ok: false, canceled: true, code: null, stdout, stderr, message: 'Command canceled' })
      }, 600)
    }

    sshExecSessions.set(executionId, { cancel })

    const openCommandChannel = () => {
        if (canceled) {
          finish({ ok: false, canceled: true, code: null, stdout, stderr, message: 'Command canceled' })
          return
        }
        client.exec(wrapWorkflowCommand(preparedCommand), { pty: true }, (error, channel) => {
          if (error) {
            finish({ ok: false, canceled, code: null, stdout, stderr, message: canceled ? 'Command canceled' : error.message })
            return
          }
          stream = channel
          if (canceled) cancel()

          stream
            .on('close', (code) => {
              finish(canceled
                ? { ok: false, canceled: true, code, stdout, stderr, message: 'Command canceled' }
                : {
                    ok: code === 0,
                    canceled: false,
                    code,
                    stdout,
                    stderr,
                    message: code === 0 ? 'Command succeeded' : `Command exited with ${code}`
                  })
            })
            .on('data', (data) => {
              const text = data.toString()
              stdout = appendCapturedOutput(stdout, text)
              sendVisibleData('stdout', text)
            })

          stream.stderr?.on('data', (data) => {
            const text = data.toString()
            stderr = appendCapturedOutput(stderr, text)
            sendVisibleData('stderr', text)
          })
        })
    }

    function handleSharedClientError(error) {
      finish({
        ok: false,
        canceled,
        code: null,
        stdout,
        stderr,
        message: canceled ? 'Command canceled' : error.message
      })
    }

    function handleSharedClientClose() {
      finish({
        ok: false,
        canceled,
        code: null,
        stdout,
        stderr,
        message: canceled ? 'Command canceled' : 'SSH transport closed during command execution'
      })
    }

    if (reusableSession) {
      client.once('error', handleSharedClientError)
      client.once('close', handleSharedClientClose)
      openCommandChannel()
    } else {
      client
        .on('ready', openCommandChannel)
        .on('error', (error) => {
          finish({
            ok: false,
            canceled,
            code: null,
            stdout,
            stderr,
            message: canceled ? 'Command canceled' : error.message
          })
        })
      connectSshClient(client, config, () => settled || canceled).catch((error) => {
        finish({
          ok: false,
          canceled,
          code: null,
          stdout,
          stderr,
          message: canceled ? 'Command canceled' : error.message
        })
      })
    }
  })
}

function buildStreamingPrivilegeCommand(command, mode = 'normal', promptToken = '', hasPassword = false) {
  if (mode === 'sudo') {
    const innerCommand = `bash -c ${shellQuote(command)} </dev/null`
    if (!hasPassword) return `sudo -n ${innerCommand}`
    return [
      'stty -echo',
      `printf '%s\\n' ${shellQuote(promptToken)}`,
      'IFS= read -r __ops_privilege_password',
      'stty echo',
      `if ! printf '%s\\n' "$__ops_privilege_password" | sudo -S -p '' -v; then unset __ops_privilege_password; exit 1; fi`,
      'unset __ops_privilege_password',
      `sudo -n ${innerCommand}`
    ].join('\n')
  }

  if (mode === 'su') {
    const rootCommand = `bash -c ${shellQuote(command)} </dev/null`
    if (!hasPassword) return `LC_ALL=C su root -c ${shellQuote(rootCommand)}`
    return [
      'stty -echo',
      `printf '%s\\n' ${shellQuote(promptToken)}`,
      `LC_ALL=C su root -c ${shellQuote(rootCommand)}`,
      '__ops_privilege_status=$?',
      'stty echo',
      'exit $__ops_privilege_status'
    ].join('\n')
  }

  return command
}

function workflowPrivilegeKey(config = {}, mode = 'normal') {
  return [config.jumpServerId || 'direct', config.host || '', Number(config.port || 22), config.username || '', mode].join(':')
}

function formatPrivilegeFailure(result = {}, mode = 'sudo') {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
    .replace(/__OPS_PRIVILEGE_READY_[A-Z0-9_]+__/gi, '')
    .replace(/\r/g, '')
    .trim()

  if (/not in the sudoers|not allowed to run sudo|may not run sudo|is not allowed to execute/i.test(output)) {
    return '当前 SSH 用户没有 sudo 权限，请选择 su root，或先在服务器上配置 sudoers。'
  }
  if (/sudo:\s*(command not found|not found)|sudo is not installed/i.test(output)) {
    return '服务器未安装 sudo，请选择 su root 并输入 root 密码。'
  }
  if (/sudo.*must be owned by uid 0|setuid bit set|effective uid is not 0|no valid sudoers sources found/i.test(output)) {
    return '服务器的 sudo 权限配置已损坏（所有者或 setuid 位不正确）。自动检测需要使用 su root，请输入 root 密码，或先在服务器上修复 sudo。'
  }
  if (/sorry, try again|incorrect password|authentication failure|authentication failed/i.test(output)) {
    return mode === 'su'
      ? 'su 验证失败：root 密码不正确。'
      : 'sudo 验证失败：请输入当前 SSH 用户的 sudo 密码，不是 root 密码。'
  }
  if (/a password is required|no password was provided/i.test(output)) {
    return mode === 'su'
      ? 'su 需要 root 密码。'
      : 'sudo 需要当前 SSH 用户的密码。'
  }

  const details = output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' · ')
  return details || `${mode} 提权验证失败，请检查密码和服务器权限配置。`
}

function privilegeFailureSuggestsSu(result = {}) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
  return /not in the sudoers|not allowed to run sudo|may not run sudo|is not allowed to execute|sudo:\s*(command not found|not found)|sudo is not installed|sudo.*must be owned by uid 0|setuid bit set|effective uid is not 0|no valid sudoers sources found/i.test(output)
}

function startShellSession(webContents, config, size = {}) {
  return new Promise((resolve) => {
    const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const client = new Client()
    let settled = false
    let closeNotified = false

    const send = (channel, payload = {}) => {
      if (!webContents.isDestroyed()) {
        webContents.send(channel, { sessionId, ...payload })
      }
    }

    const finish = (result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    const notifyClose = (message, cause = 'transport') => {
      if (closeNotified) return
      closeNotified = true
      send('ssh:shell:close', {
        message: message || 'Terminal session closed.',
        cause
      })
    }

    const cleanup = () => {
      if (shellSessionsByWebContents.get(webContents.id) === sessionId) {
        shellSessionsByWebContents.delete(webContents.id)
      }
      shellSessions.delete(sessionId)
    }

    client
      .on('ready', () => {
        client.setNoDelay(true)
        client.shell(
          {
            term: 'xterm-256color',
            cols: Number(size.cols || 100),
            rows: Number(size.rows || 30)
          },
          (error, stream) => {
            if (error) {
              cleanup()
              client.end()
              finish({ ok: false, message: error.message })
              return
            }

            // Do not let the initial prompt race ahead of the IPC response that
            // gives the renderer its session id. This is especially important
            // while automatically reopening a dropped interactive shell.
            stream.pause()

            shellSessions.set(sessionId, {
              id: sessionId,
              client,
              stream,
              webContentsId: webContents.id,
              serverId: String(config?.id || '')
            })
            shellSessionsByWebContents.set(webContents.id, sessionId)
            webContents.once('destroyed', () => closeShellSession(sessionId))

            stream
              .on('data', (data) => {
                const text = data.toString('utf8')
                send('ssh:shell:data', { data: text })
              })
              .on('close', () => {
                notifyClose('Terminal channel closed. It may have reached the server shell idle timeout.', 'channel')
                cleanup()
                client.end()
              })
              .on('error', (streamError) => {
                send('ssh:shell:error', { message: streamError.message })
                notifyClose(streamError.message, 'channel')
                cleanup()
                client.end()
              })
              .stderr?.on('data', (data) => send('ssh:shell:data', { data: data.toString('utf8') }))

            finish({ ok: true, sessionId })
            setImmediate(() => {
              if (!stream.destroyed) stream.resume()
            })
          }
        )
      })
      .on('error', (error) => {
        cleanup()
        send('ssh:shell:error', { message: error.message })
        notifyClose(error.message, 'error')
        finish({ ok: false, message: error.message })
      })
      .on('close', () => {
        notifyClose('SSH transport closed.', 'transport')
        cleanup()
      })
    connectSshClient(client, config).catch((error) => {
      cleanup()
      send('ssh:shell:error', { message: error.message })
      notifyClose(error.message, 'error')
      finish({ ok: false, message: error.message })
    })
  })
}

function closeShellSession(sessionId) {
  const session = shellSessions.get(sessionId)
  if (!session) return
  shellSessions.delete(sessionId)
  if (shellSessionsByWebContents.get(session.webContentsId) === sessionId) {
    shellSessionsByWebContents.delete(session.webContentsId)
  }
  session.stream?.end()
  session.client?.end()
}

function captureShellInput(session, data) {
  const submitted = []
  const state = session.inputCapture || { value: '', valid: true, lastWasCarriageReturn: false }
  const input = String(data || '')
    .replaceAll('\u001b[200~', '')
    .replaceAll('\u001b[201~', '')
  for (const character of input) {
    if (character === '\n' && state.lastWasCarriageReturn) {
      state.lastWasCarriageReturn = false
      continue
    }
    state.lastWasCarriageReturn = false
    if (character === '\r' || character === '\n') {
      if (state.valid && state.value.trim()) submitted.push(state.value.trim())
      state.value = ''
      state.valid = true
      state.lastWasCarriageReturn = character === '\r'
      continue
    }
    if (character === '\u0003') {
      state.value = ''
      state.valid = true
      continue
    }
    if (character === '\u0015') {
      state.value = ''
      continue
    }
    if (character === '\u007f' || character === '\b') {
      state.value = [...state.value].slice(0, -1).join('')
      continue
    }
    if (character.charCodeAt(0) < 32 || character === '\u007f') {
      state.valid = false
      continue
    }
    if (state.valid) state.value += character
  }
  session.inputCapture = state
  return submitted
}

function pasteClipboardToShell(webContents) {
  const sessionId = shellSessionsByWebContents.get(webContents.id)
  const session = shellSessions.get(sessionId)
  const text = clipboard.readText()
  if (!session?.stream || !text) return
  const submittedCommands = captureShellInput(session, text)
  session.stream.write(text)
  submittedCommands.forEach((command) => {
    if (!webContents.isDestroyed()) webContents.send('ssh:shell:command', { sessionId, command })
  })
}

function normalizePrivilegedRemotePath(remotePath, { allowRoot = true } = {}) {
  const rawPath = String(remotePath || '/')
  if (rawPath.includes('\0')) throw new Error('Remote path contains an invalid null character')
  const normalized = posix.normalize(rawPath.startsWith('/') ? rawPath : `/${rawPath}`)
  if (!allowRoot && normalized === '/') throw new Error('This privileged operation is not allowed on the root directory')
  return normalized
}

function makePrivilegedStagePath(label = 'file') {
  const safeLabel = String(label || 'file').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'file'
  return `/tmp/.ops-flow-${safeLabel}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function privilegedCommandMessage(result = {}) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
    .replace(/__OPS_[A-Z0-9_]+__/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return output.slice(-4).join(' · ') || result.message || 'Privileged file operation failed'
}

async function runPrivilegedFileCommand(webContents, config, command, privilege = {}, label = 'file') {
  const executionId = `privileged-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const result = await execStreamingCommand(webContents, config, command, executionId, privilege)
  return result.ok ? result : { ...result, message: privilegedCommandMessage(result) }
}

function unlinkRemoteStage(client, remotePath) {
  return new Promise((resolve) => {
    client.sftp((error, sftp) => {
      if (error) {
        resolve(false)
        return
      }
      sftp.unlink(remotePath, () => resolve(true))
    })
  })
}

async function cleanupPrivilegedStage(webContents, config, stagePath, privilege) {
  if (!stagePath) return
  await runPrivilegedFileCommand(webContents, config, `rm -f -- ${shellQuote(stagePath)}`, privilege, 'cleanup')
  await withSshClient(config, (client) => unlinkRemoteStage(client, stagePath))
}

async function listPrivilegedRemoteDirectory(webContents, config, targetPath, privilege) {
  let normalizedPath
  try {
    normalizedPath = normalizePrivilegedRemotePath(targetPath)
  } catch (error) {
    return { ok: false, message: error.message, path: targetPath, items: [] }
  }

  const beginMarker = '__OPS_PRIVILEGED_LIST_BEGIN__'
  const endMarker = '__OPS_PRIVILEGED_LIST_END__'
  const command = [
    'set -e',
    `target=${shellQuote(normalizedPath)}`,
    '[ -d "$target" ] || { echo "Directory not found or is not a directory: $target" >&2; exit 2; }',
    `printf '%s\\n' ${shellQuote(beginMarker)}`,
    'while IFS= read -r -d "" entry; do',
    '  entry_name=${entry##*/}',
    '  name_b64=$(printf "%s" "$entry_name" | base64 | tr -d "\\r\\n")',
    '  if [ -d "$entry" ]; then entry_type=dir; else entry_type=file; fi',
    '  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$name_b64" "$entry_type" "$(stat -c %s -- "$entry")" "$(stat -c %A -- "$entry")" "$(stat -c %U:%G -- "$entry")" "$(stat -c %Y -- "$entry")"',
    'done < <(find "$target" -mindepth 1 -maxdepth 1 -print0)',
    `printf '%s\\n' ${shellQuote(endMarker)}`
  ].join('\n')
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, 'list')
  if (!result.ok) return { ok: false, message: result.message, path: normalizedPath, items: [] }

  const output = String(result.stdout || '').replace(/\r/g, '')
  const begin = output.indexOf(beginMarker)
  const end = output.indexOf(endMarker, begin + beginMarker.length)
  if (begin < 0 || end < 0) {
    return { ok: false, message: 'The privileged directory listing returned an invalid response', path: normalizedPath, items: [] }
  }
  const body = output.slice(begin + beginMarker.length, end).trim()
  const items = body ? body.split('\n').map((line) => {
    const [encodedName, type, size, permissions, owner, modified] = line.split('\t')
    if (!encodedName || !type) return null
    let name = ''
    try {
      name = Buffer.from(encodedName, 'base64').toString('utf8')
    } catch {
      return null
    }
    return {
      name,
      type: type === 'dir' ? 'dir' : 'file',
      size: formatBytes(Number(size || 0)),
      owner: owner || '-',
      modified: formatRemoteTime(Number(modified || 0)),
      permissions: permissions || '-'
    }
  }).filter(Boolean).sort((left, right) => {
    if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name)
  }) : []

  return { ok: true, privileged: true, path: normalizedPath, items }
}

async function searchRemoteFiles(webContents, config, query, privilege = {}, requestedExecutionId = '') {
  const needle = String(query || '').trim()
  if (needle.length < 2) {
    return { ok: false, items: [], message: 'Enter at least 2 characters for a global search' }
  }
  if (needle.length > 160 || /[\0\r\n]/.test(needle)) {
    return { ok: false, items: [], message: 'The global search text is invalid or too long' }
  }

  const escapedNeedle = needle.replace(/([\\*?\[\]])/g, '\\$1')
  const pattern = `*${escapedNeedle}*`
  const resultPath = makePrivilegedStagePath('search-result')
  const errorPath = makePrivilegedStagePath('search-error')
  const beginMarker = '__OPS_SEARCH_BEGIN__'
  const metaMarker = '__OPS_SEARCH_META__'
  const endMarker = '__OPS_SEARCH_END__'
  const executionId = requestedExecutionId || `remote-search-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const command = [
    'set +e',
    'export LC_ALL=C',
    `result_file=${shellQuote(resultPath)}`,
    `error_file=${shellQuote(errorPath)}`,
    'rm -f -- "$result_file" "$error_file"',
    `search_pattern=${shellQuote(pattern)}`,
    'if command -v timeout >/dev/null 2>&1; then',
    '  timeout 25s find / \\( -path /proc -o -path /sys -o -path /dev -o -path /run \\) -prune -o -mindepth 1 -iname "$search_pattern" -printf "%y\\t%s\\t%M\\t%u:%g\\t%TY-%Tm-%Td %TH:%TM\\t%p\\n" 2>"$error_file" | head -n 501 >"$result_file"',
    '  find_status=${PIPESTATUS[0]}',
    'else',
    '  find / \\( -path /proc -o -path /sys -o -path /dev -o -path /run \\) -prune -o -mindepth 1 -iname "$search_pattern" -printf "%y\\t%s\\t%M\\t%u:%g\\t%TY-%Tm-%Td %TH:%TM\\t%p\\n" 2>"$error_file" | head -n 501 >"$result_file"',
    '  find_status=${PIPESTATUS[0]}',
    'fi',
    'result_count=$(wc -l <"$result_file" 2>/dev/null || printf 0)',
    'permission_count=$(grep -ci "Permission denied" "$error_file" 2>/dev/null || true)',
    'other_error_count=$(grep -v "Permission denied" "$error_file" 2>/dev/null | grep -c . || true)',
    'timed_out=0; [ "$find_status" -eq 124 ] && timed_out=1',
    'truncated=0; [ "$result_count" -gt 500 ] && truncated=1',
    `printf '%s\\n' ${shellQuote(beginMarker)}`,
    'head -n 500 "$result_file" 2>/dev/null',
    `printf '${metaMarker}%s|%s|%s|%s\\n' "$permission_count" "$other_error_count" "$timed_out" "$truncated"`,
    `printf '%s\\n' ${shellQuote(endMarker)}`,
    'rm -f -- "$result_file" "$error_file"',
    'exit 0'
  ].join('\n')

  const result = await execStreamingCommand(webContents, config, command, executionId, privilege)
  if (!result.ok) {
    return { ok: false, canceled: Boolean(result.canceled), executionId, items: [], message: result.message || 'Global search failed' }
  }

  const output = String(result.stdout || '').replace(/\r/g, '')
  const begin = output.indexOf(beginMarker)
  const end = output.indexOf(endMarker, begin + beginMarker.length)
  if (begin < 0 || end < 0) {
    return { ok: false, executionId, items: [], message: 'The global search returned an invalid response' }
  }
  const body = output.slice(begin + beginMarker.length, end).trim()
  const lines = body ? body.split('\n').filter(Boolean) : []
  const metaLine = lines.find((line) => line.startsWith(metaMarker)) || ''
  const [permissionDeniedCount, otherErrorCount, timedOut, truncated] = metaLine
    .slice(metaMarker.length)
    .split('|')
    .map((value) => Number(value || 0))
  const items = lines.filter((line) => !line.startsWith(metaMarker)).map((line) => {
    const [type, size, permissions, owner, modified, ...pathParts] = line.split('\t')
    const remotePath = pathParts.join('\t')
    if (!remotePath) return null
    return {
      name: posix.basename(remotePath) || remotePath,
      path: remotePath,
      type: type === 'd' ? 'dir' : 'file',
      size: formatBytes(Number(size || 0)),
      permissions: permissions || '-',
      owner: owner || '-',
      modified: modified || '-'
    }
  }).filter(Boolean)

  return {
    ok: true,
    executionId,
    query: needle,
    items,
    permissionDeniedCount,
    otherErrorCount,
    timedOut: Boolean(timedOut),
    truncated: Boolean(truncated),
    privileged: ['sudo', 'su'].includes(privilege?.mode)
  }
}

async function preparePrivilegedReadableStage(webContents, config, remotePath, privilege, maxBytes = 0) {
  const normalizedPath = normalizePrivilegedRemotePath(remotePath, { allowRoot: false })
  const stagePath = makePrivilegedStagePath('read')
  const user = String(config.username || '')
  const command = [
    'set -e',
    `source_file=${shellQuote(normalizedPath)}`,
    `stage_file=${shellQuote(stagePath)}`,
    `login_user=${shellQuote(user)}`,
    '[ -f "$source_file" ] || { echo "Remote file not found or is not a regular file: $source_file" >&2; exit 2; }',
    'file_size=$(stat -c %s -- "$source_file")',
    maxBytes ? `[ "$file_size" -le ${Number(maxBytes)} ] || { echo "File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Download it instead." >&2; exit 3; }` : '',
    'cp -- "$source_file" "$stage_file"',
    'chown "$(id -u "$login_user")":"$(id -g "$login_user")" "$stage_file"',
    'chmod 600 "$stage_file"',
    'printf "__OPS_STAGE_SIZE__%s\\n" "$file_size"'
  ].filter(Boolean).join('\n')
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, 'stage-read')
  if (!result.ok) {
    await cleanupPrivilegedStage(webContents, config, stagePath, privilege)
    return { ok: false, message: result.message }
  }
  const sizeMatch = String(result.stdout || '').match(/__OPS_STAGE_SIZE__(\d+)/)
  return { ok: true, stagePath, sourcePath: normalizedPath, size: Number(sizeMatch?.[1] || 0) }
}

async function readPrivilegedRemoteTextFile(webContents, config, remotePath, privilege) {
  let staged
  try {
    staged = await preparePrivilegedReadableStage(webContents, config, remotePath, privilege, 2 * 1024 * 1024)
    if (!staged.ok) return staged
    const result = await withSshClient(config, (client) => readRemoteTextFile(client, staged.stagePath))
    return result.ok
      ? { ...result, privileged: true, path: staged.sourcePath, size: staged.size || result.size }
      : result
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    if (staged?.stagePath) await cleanupPrivilegedStage(webContents, config, staged.stagePath, privilege)
  }
}

async function commitPrivilegedStagedFile(webContents, config, stagePath, remotePath, privilege) {
  const normalizedPath = normalizePrivilegedRemotePath(remotePath, { allowRoot: false })
  const command = [
    'set -e',
    `source_file=${shellQuote(stagePath)}`,
    `requested_target=${shellQuote(normalizedPath)}`,
    'if [ -L "$requested_target" ]; then target_file=$(readlink -f -- "$requested_target"); else target_file="$requested_target"; fi',
    '[ -n "$target_file" ] || { echo "Cannot resolve target file: $requested_target" >&2; exit 2; }',
    'target_dir=$(dirname -- "$target_file")',
    '[ -d "$target_dir" ] || { echo "Target directory does not exist: $target_dir" >&2; exit 2; }',
    'candidate="$target_file.ops-flow-new.$$"',
    'backup_file=""',
    'had_target=0',
    'cleanup_ops_file() { rm -f -- "$source_file" "$candidate"; }',
    'trap cleanup_ops_file EXIT',
    'if [ -e "$target_file" ]; then',
    '  had_target=1',
    '  backup_file="$target_file.ops-flow-backup-$(date +%Y%m%d-%H%M%S)-$$"',
    '  cp -a -- "$target_file" "$backup_file"',
    'fi',
    'cp -- "$source_file" "$candidate"',
    'if [ "$had_target" -eq 1 ]; then',
    '  chown --reference="$target_file" "$candidate" 2>/dev/null || true',
    '  chmod --reference="$target_file" "$candidate"',
    'else',
    '  chown root:root "$candidate" 2>/dev/null || true',
    '  chmod 0644 "$candidate"',
    'fi',
    'mv -f -- "$candidate" "$target_file"',
    'command -v restorecon >/dev/null 2>&1 && restorecon "$target_file" >/dev/null 2>&1 || true',
    'sync "$target_file" 2>/dev/null || true',
    'case "$target_file" in',
    '  */nginx/*|*/nginx.conf)',
    '    nginx_root="${target_file%%/nginx/*}/nginx"',
    '    validation_status=0',
    '    validation_output=""',
    '    if [ -x "$nginx_root/sbin/nginx" ] && [ -f "$nginx_root/conf/nginx.conf" ]; then',
    '      validation_output=$("$nginx_root/sbin/nginx" -t -p "$nginx_root/" -c "$nginx_root/conf/nginx.conf" 2>&1) || validation_status=$?',
    '    elif command -v nginx >/dev/null 2>&1; then',
    '      validation_output=$(nginx -t 2>&1) || validation_status=$?',
    '    fi',
    '    if [ "$validation_status" -ne 0 ]; then',
    '        if [ "$had_target" -eq 1 ]; then cp -a -- "$backup_file" "$target_file"; else rm -f -- "$target_file"; fi',
    '        printf "%s\\n" "$validation_output" >&2',
    '        echo "Nginx validation failed; the original file was restored." >&2',
    '        exit 3',
    '    fi',
    '    ;;',
    'esac',
    'printf "__OPS_BACKUP__%s\\n" "$backup_file"'
  ].join('\n')
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, 'commit-file')
  const backupMatch = String(result.stdout || '').match(/__OPS_BACKUP__(.*)/)
  return result.ok
    ? { ok: true, privileged: true, path: normalizedPath, backupPath: backupMatch?.[1]?.trim() || '', message: 'Privileged file saved' }
    : { ok: false, message: result.message, path: normalizedPath }
}

async function writePrivilegedRemoteTextFile(webContents, config, remotePath, content, privilege) {
  const stagePath = makePrivilegedStagePath('write')
  try {
    const staged = await withSshClient(config, (client) => writeRemoteBufferFile(client, stagePath, Buffer.from(String(content || ''), 'utf8')))
    if (!staged.ok) return staged
    const result = await commitPrivilegedStagedFile(webContents, config, stagePath, remotePath, privilege)
    return { ...result, size: Buffer.byteLength(String(content || ''), 'utf8') }
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    await cleanupPrivilegedStage(webContents, config, stagePath, privilege)
  }
}

async function createPrivilegedRemoteItem(webContents, config, remotePath, type, privilege) {
  const normalizedPath = normalizePrivilegedRemotePath(remotePath, { allowRoot: false })
  const command = [
    'set -e',
    `target_path=${shellQuote(normalizedPath)}`,
    '[ ! -e "$target_path" ] && [ ! -L "$target_path" ] || { echo "Target already exists: $target_path" >&2; exit 2; }',
    type === 'dir'
      ? 'mkdir -m 0755 -- "$target_path"'
      : '(umask 022; set -C; : > "$target_path")'
  ].join('\n')
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, `create-${type}`)
  return result.ok
    ? {
        ok: true,
        privileged: ['sudo', 'su'].includes(privilege?.mode),
        path: normalizedPath,
        name: posix.basename(normalizedPath),
        type,
        message: type === 'dir' ? 'Directory created' : 'File created'
      }
    : { ok: false, path: normalizedPath, message: result.message }
}

async function renamePrivilegedRemoteItem(webContents, config, sourcePath, targetPath, privilege) {
  const normalizedSource = normalizePrivilegedRemotePath(sourcePath, { allowRoot: false })
  const normalizedTarget = normalizePrivilegedRemotePath(targetPath, { allowRoot: false })
  const command = [
    'set -e',
    `source_path=${shellQuote(normalizedSource)}`,
    `target_path=${shellQuote(normalizedTarget)}`,
    '[ -e "$source_path" ] || [ -L "$source_path" ] || { echo "Source does not exist: $source_path" >&2; exit 2; }',
    '[ ! -e "$target_path" ] && [ ! -L "$target_path" ] || { echo "Target already exists: $target_path" >&2; exit 3; }',
    'mv -- "$source_path" "$target_path"'
  ].join('\n')
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, 'rename')
  return result.ok
    ? {
        ok: true,
        privileged: ['sudo', 'su'].includes(privilege?.mode),
        sourcePath: normalizedSource,
        path: normalizedTarget,
        name: posix.basename(normalizedTarget),
        message: 'Item renamed'
      }
    : { ok: false, sourcePath: normalizedSource, path: normalizedTarget, message: result.message }
}

async function copyRemoteFileBackup(webContents, config, remotePath, privilege = {}) {
  let normalizedPath
  try {
    normalizedPath = normalizePrivilegedRemotePath(remotePath, { allowRoot: false })
  } catch (error) {
    return { ok: false, message: error.message }
  }
  const marker = '__OPS_COPY_PATH__'
  const command = [
    'set -e',
    `source_file=${shellQuote(normalizedPath)}`,
    '[ -f "$source_file" ] || { echo "Remote file not found or is not a regular file: $source_file" >&2; exit 2; }',
    'stamp=$(date +%Y%m%d-%H%M%S)',
    'backup_file="$source_file-$stamp"',
    'suffix=1',
    'while [ -e "$backup_file" ]; do backup_file="$source_file-$stamp-$suffix"; suffix=$((suffix + 1)); done',
    'cp -aL -- "$source_file" "$backup_file"',
    `printf '${marker}%s\\n' "$(printf '%s' "$backup_file" | base64 | tr -d '\\r\\n')"`
  ].join('\n')
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, 'copy-backup')
  if (!result.ok) return { ok: false, path: normalizedPath, message: result.message }
  const match = String(result.stdout || '').match(new RegExp(`${marker}([^\\r\\n]+)`))
  if (!match?.[1]) return { ok: false, path: normalizedPath, message: 'The backup copy returned an invalid path' }
  const backupPath = Buffer.from(match[1], 'base64').toString('utf8')
  return {
    ok: true,
    path: normalizedPath,
    backupPath,
    name: posix.basename(backupPath),
    privileged: ['sudo', 'su'].includes(privilege?.mode),
    message: 'Backup copy created'
  }
}

function uploadLocalFileToStage(client, localPath, stagePath, progress) {
  return new Promise((resolve) => {
    const session = prepareFileTransferSession(progress, client)
    if (session) session.currentRemotePath = stagePath
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      const finalResult = session?.canceled
        ? canceledFileTransferResult(progress, session, { partialRemotePath: stagePath })
        : result
      if (session?.canceled) emitTransferProgress(progress, { transferred: session.transferred, status: 'cancelled', message: finalResult.message })
      finishFileTransferSession(progress, session)
      resolve(finalResult)
    }
    if (session) session.cancelTransfer = () => finish(canceledFileTransferResult(progress, session, { partialRemotePath: stagePath }))
    if (session?.canceled) {
      finish(canceledFileTransferResult(progress, session, { partialRemotePath: stagePath }))
      return
    }
    client.sftp((error, sftp) => {
      if (session) session.sftp = sftp || null
      if (session?.canceled) {
        finish(canceledFileTransferResult(progress, session, { partialRemotePath: stagePath }))
        return
      }
      if (error) {
        finish({ ok: false, message: error.message })
        return
      }
      sftp.fastPut(localPath, stagePath, {
        step: (transferred) => {
          if (session) session.transferred = transferred
          if (!session?.canceled) emitTransferProgress(progress, { transferred, status: 'running' })
        }
      }, (putError) => {
        if (session?.canceled) finish(canceledFileTransferResult(progress, session, { partialRemotePath: stagePath }))
        else finish(putError ? { ok: false, message: putError.message, transferred: session?.transferred || 0 } : { ok: true })
      })
    })
  })
}

async function uploadPrivilegedRemoteFile(webContents, config, targetDirectory, privilege) {
  const window = BrowserWindow.fromWebContents(webContents) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showOpenDialog(window, { title: 'Select file to upload', properties: ['openFile'] })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true, message: 'Upload canceled' }

  return uploadPrivilegedRemotePath(webContents, config, picked.filePaths[0], targetDirectory, privilege)
}

async function uploadPrivilegedRemotePath(webContents, config, localPath, targetDirectory, privilege) {
  if (!localPath) return { ok: false, message: 'Local file path is required' }

  let stats
  try {
    stats = statSync(localPath)
  } catch (error) {
    return { ok: false, message: error.code === 'ENOENT' ? `Local path not found: ${localPath}` : error.message }
  }
  if (!stats.isFile()) return { ok: false, message: 'Privileged batch upload currently supports files only' }

  let normalizedDirectory
  try {
    normalizedDirectory = normalizePrivilegedRemotePath(targetDirectory)
  } catch (error) {
    return { ok: false, message: error.message }
  }
  const remotePath = posix.join(normalizedDirectory, basename(localPath))
  const stagePath = makePrivilegedStagePath('upload')
  const total = stats.size
  const progress = {
    id: `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'upload',
    name: basename(localPath),
    localPath,
    remotePath,
    total,
    webContents
  }
  emitTransferProgress(progress, { transferred: 0, status: 'running', message: 'Uploading privileged file' })
  prepareFileTransferSession(progress, null)
  try {
    let staged = await withSshClient(config, (client) => uploadLocalFileToStage(client, localPath, stagePath, progress))
    staged = settlePendingFileTransfer(progress, staged)
    if (!staged.ok) {
      emitTransferProgress(progress, staged.canceled
        ? { status: 'cancelled', message: staged.message }
        : { status: 'failed', message: staged.message })
      return { ...staged, localPath, remotePath }
    }
    const committed = await commitPrivilegedStagedFile(webContents, config, stagePath, remotePath, privilege)
    emitTransferProgress(progress, committed.ok
      ? { transferred: total, status: 'done', message: 'Privileged upload completed' }
      : { status: 'failed', message: committed.message })
    return { ...committed, localPath, remotePath }
  } catch (error) {
    emitTransferProgress(progress, { status: 'failed', message: error.message })
    return { ok: false, message: error.message, localPath, remotePath }
  } finally {
    await cleanupPrivilegedStage(webContents, config, stagePath, privilege)
  }
}

async function downloadPrivilegedRemoteFile(webContents, config, remotePath, privilege) {
  const window = BrowserWindow.fromWebContents(webContents) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showSaveDialog(window, { title: 'Save privileged remote file', defaultPath: posix.basename(remotePath) })
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true, message: 'Download canceled' }

  return downloadPrivilegedRemotePath(webContents, config, remotePath, picked.filePath, privilege)
}

async function downloadPrivilegedRemotePath(webContents, config, remotePath, localPath, privilege) {
  let staged
  try {
    staged = await preparePrivilegedReadableStage(webContents, config, remotePath, privilege)
    if (!staged.ok) return staged
    const progress = {
      id: `download-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: 'download',
      name: posix.basename(staged.sourcePath),
      localPath,
      remotePath: staged.sourcePath,
      webContents
    }
    const result = await withSshClient(config, (client) => downloadRemoteFile(client, staged.stagePath, localPath, progress))
    return result.ok
      ? { ...result, privileged: true, remotePath: staged.sourcePath, localPath }
      : result
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    if (staged?.stagePath) await cleanupPrivilegedStage(webContents, config, staged.stagePath, privilege)
  }
}

function makeUniqueLocalDownloadPath(targetDirectory, fileName, reservedPaths = new Set()) {
  const safeName = String(fileName || 'download').replace(/[<>:"/\\|?*]/g, '_') || 'download'
  const extensionIndex = safeName.lastIndexOf('.')
  const hasExtension = extensionIndex > 0
  const stem = hasExtension ? safeName.slice(0, extensionIndex) : safeName
  const extension = hasExtension ? safeName.slice(extensionIndex) : ''
  let candidate = join(targetDirectory, safeName)
  let suffix = 2
  while (reservedPaths.has(candidate.toLocaleLowerCase()) || existsSync(candidate)) {
    candidate = join(targetDirectory, `${stem} (${suffix})${extension}`)
    suffix += 1
  }
  reservedPaths.add(candidate.toLocaleLowerCase())
  return candidate
}

async function deletePrivilegedRemoteItem(webContents, config, remotePath, type, privilege) {
  let normalizedPath
  try {
    normalizedPath = normalizePrivilegedRemotePath(remotePath, { allowRoot: false })
  } catch (error) {
    return { ok: false, message: error.message }
  }
  const progress = {
    id: `delete-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'delete',
    name: posix.basename(normalizedPath),
    remotePath: normalizedPath,
    total: 1,
    webContents
  }
  emitTransferProgress(progress, { transferred: 0, status: 'running', currentPath: normalizedPath })
  const quotedPath = shellQuote(normalizedPath)
  const command = type === 'dir'
    ? `test -d ${quotedPath} && rm -rf -- ${quotedPath} && test ! -e ${quotedPath} && test ! -L ${quotedPath}`
    : `(test -e ${quotedPath} || test -L ${quotedPath}) && rm -f -- ${quotedPath} && test ! -e ${quotedPath} && test ! -L ${quotedPath}`
  const result = await runPrivilegedFileCommand(webContents, config, command, privilege, 'delete')
  emitTransferProgress(progress, result.ok
    ? { transferred: 1, status: 'done', currentPath: normalizedPath }
    : { status: 'failed', message: result.message, currentPath: normalizedPath })
  return result.ok
    ? { ok: true, privileged: true, path: normalizedPath, deletedCount: 1, message: 'Privileged delete completed' }
    : { ok: false, path: normalizedPath, message: result.message }
}

function listRemoteDirectory(client, targetPath) {
  return new Promise((resolve) => {
    let settled = false
    let sftpSession = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sftpSession?.end()
      } catch {
        // The parent SSH client is closed by withSshClient.
      }
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, message: `Remote directory read timed out: ${targetPath}`, path: targetPath, items: [] })
    }, 20000)
    client.sftp((error, sftp) => {
      if (error) {
        finish({ ok: false, message: error.message, path: targetPath, items: [] })
        return
      }
      sftpSession = sftp

      sftp.readdir(targetPath, async (readError, list) => {
        if (readError) {
          finish({ ok: false, message: readError.message, path: targetPath, items: [] })
          return
        }

        try {
          sftp.end()
        } catch {
          // Continue with owner lookup even if the SFTP channel already ended.
        }
        sftpSession = null
        const visibleItems = list.filter((item) => item.filename !== '.' && item.filename !== '..')
        const hasEmbeddedOwners = visibleItems.every((item) => {
          const parts = item.longname?.trim().split(/\s+/) || []
          return Boolean(
            parts[2]
            && parts[3]
            && !/^\d+$/.test(parts[2])
            && !/^\d+$/.test(parts[3])
          )
        })
        const owners = hasEmbeddedOwners ? {} : await getRemoteOwners(client, targetPath)
        if (settled) return
        const items = visibleItems
          .map((item) => ({
            name: item.filename,
            type: item.attrs?.isDirectory?.() ? 'dir' : 'file',
            size: formatBytes(item.attrs?.size || 0),
            owner: owners[item.filename] || formatRemoteOwner(item),
            modified: formatRemoteTime(item.attrs?.mtime),
            permissions: item.longname?.split(/\s+/)[0] || ''
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
            return a.name.localeCompare(b.name)
          })

        finish({ ok: true, path: targetPath, items })
      })
    })
  })
}

function resolveRemoteDirectoryPath(client, targetPath = '.') {
  return new Promise((resolve) => {
    let settled = false
    let sftpSession = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sftpSession?.end()
      } catch {
        // Ignore channel cleanup failures; the parent SSH connection remains active.
      }
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, path: targetPath, message: `Remote path resolution timed out: ${targetPath}` })
    }, 10000)
    client.sftp((error, sftp) => {
      if (error) {
        finish({ ok: false, path: targetPath, message: error.message })
        return
      }
      sftpSession = sftp
      sftp.realpath(targetPath || '.', (realpathError, resolvedPath) => {
        if (realpathError) {
          finish({ ok: false, path: targetPath, message: realpathError.message })
          return
        }
        const path = resolvedPath || targetPath
        sftp.stat(path, (statError, attrs) => {
          if (statError) {
            finish({ ok: false, path, message: statError.message })
            return
          }
          if (!attrs?.isDirectory?.()) {
            finish({ ok: false, path, message: `Remote path is not a directory: ${path}` })
            return
          }
          finish({ ok: true, path })
        })
      })
    })
  })
}

async function getRemoteOwners(client, targetPath) {
  const quotedPath = shellQuote(targetPath || '/')
  const command = `find ${quotedPath} -maxdepth 1 -mindepth 1 -printf '%f\\t%u:%g\\n' 2>/dev/null`
  const result = await execCommand(client, command, { timeoutMs: 8000 })
  if (!result.ok || !result.stdout) return {}

  return result.stdout.split(/\r?\n/).reduce((owners, line) => {
    const [name, owner] = line.split('\t')
    if (name && owner) owners[name] = owner
    return owners
  }, {})
}

function uploadRemoteFile(client, localPath, remotePath, progress = null) {
  return new Promise((resolve) => {
    const session = prepareFileTransferSession(progress, client)
    if (session) session.currentRemotePath = remotePath
    let settled = false
    const finish = (result, patch = null) => {
      if (settled) return
      settled = true
      const canceled = session?.canceled
      const finalResult = canceled ? canceledFileTransferResult(progress, session, { partialRemotePath: remotePath }) : result
      if (patch && !canceled) emitTransferProgress(progress, patch)
      if (canceled) emitTransferProgress(progress, { transferred: session.transferred, status: 'cancelled', message: finalResult.message })
      finishFileTransferSession(progress, session)
      resolve(finalResult)
    }
    if (session) session.cancelTransfer = () => finish(canceledFileTransferResult(progress, session, { partialRemotePath: remotePath }))
    if (session?.canceled) {
      finish(canceledFileTransferResult(progress, session, { partialRemotePath: remotePath }))
      return
    }
    client.sftp(async (error, sftp) => {
      if (session) session.sftp = sftp || null
      if (session?.canceled) {
        finish(canceledFileTransferResult(progress, session, { partialRemotePath: remotePath }))
        return
      }
      if (error) {
        finish({ ok: false, message: error.message }, { status: 'failed', message: error.message })
        return
      }

      try {
        const remoteDirectory = posix.dirname(remotePath)
        if (remoteDirectory && remoteDirectory !== '.' && remoteDirectory !== '/') {
          await ensureRemoteDirectory(sftp, remoteDirectory)
        }
      } catch (mkdirError) {
        const message = `Cannot create remote directory ${posix.dirname(remotePath)}: ${mkdirError.message}`
        finish({ ok: false, message, localPath, remotePath }, { status: 'failed', message })
        return
      }

      sftp.fastPut(localPath, remotePath, {
        step: (transferred) => {
          if (session) session.transferred = transferred
          if (!session?.canceled) emitTransferProgress(progress, { transferred, status: 'running' })
        }
      }, (putError) => {
        if (session?.canceled) {
          finish(canceledFileTransferResult(progress, session, { partialRemotePath: remotePath }))
          return
        }
        if (putError) {
          finish({ ok: false, message: putError.message, localPath, remotePath, transferred: session?.transferred || 0 }, { status: 'failed', message: putError.message })
          return
        }
        finish(
          { ok: true, message: 'Upload completed', localPath, remotePath },
          { transferred: progress?.total || 0, status: 'done' }
        )
      })
    })
  })
}

function uploadRemoteDirectory(client, localPath, remotePath, progress = null) {
  return new Promise((resolve) => {
    const session = prepareFileTransferSession(progress, client)
    let settled = false
    const finish = (result, patch = null) => {
      if (settled) return
      settled = true
      const canceled = session?.canceled
      const finalResult = canceled ? canceledFileTransferResult(progress, session) : result
      if (patch && !canceled) emitTransferProgress(progress, patch)
      if (canceled) emitTransferProgress(progress, { transferred: session.transferred, status: 'cancelled', message: finalResult.message })
      finishFileTransferSession(progress, session)
      resolve(finalResult)
    }
    if (session) session.cancelTransfer = () => finish(canceledFileTransferResult(progress, session))
    if (session?.canceled) {
      finish(canceledFileTransferResult(progress, session))
      return
    }
    client.sftp(async (error, sftp) => {
      if (session) session.sftp = sftp || null
      if (session?.canceled) {
        finish(canceledFileTransferResult(progress, session))
        return
      }
      if (error) {
        finish({ ok: false, message: error.message }, { status: 'failed', message: error.message })
        return
      }

      try {
        let transferredTotal = 0
        await ensureRemoteDirectory(sftp, remotePath)
        const uploadEntry = async (localEntry, remoteEntry) => {
          if (session?.canceled) throw new Error('Transfer canceled by user')
          const stats = statSync(localEntry)
          if (stats.isDirectory()) {
            await ensureRemoteDirectory(sftp, remoteEntry)
            for (const child of readdirSync(localEntry)) {
              await uploadEntry(join(localEntry, child), posix.join(remoteEntry, child))
            }
            return
          }
          if (session) session.currentRemotePath = remoteEntry
          await uploadFileWithSftp(sftp, localEntry, remoteEntry, {
            ...progress,
            session,
            onStep: (transferred) => {
              if (session) session.transferred = transferredTotal + transferred
              if (!session?.canceled) emitTransferProgress(progress, { transferred: transferredTotal + transferred, status: 'running' })
            }
          })
          transferredTotal += stats.size
          if (session) session.transferred = transferredTotal
          emitTransferProgress(progress, { transferred: transferredTotal, status: 'running' })
        }

        for (const child of readdirSync(localPath)) {
          await uploadEntry(join(localPath, child), posix.join(remotePath, child))
        }
        finish(
          { ok: true, message: 'Directory upload completed', localPath, remotePath },
          { transferred: progress?.total || transferredTotal, status: 'done' }
        )
      } catch (uploadError) {
        if (session?.canceled) finish(canceledFileTransferResult(progress, session))
        else finish({ ok: false, message: uploadError.message, localPath, remotePath, transferred: session?.transferred || 0 }, { status: 'failed', message: uploadError.message })
      }
    })
  })
}

function closeSftpChannel(sftp) {
  if (!sftp) return
  try {
    sftp.end()
  } catch {
    // The SSH transport may already be closed after a network failure.
  }
}

function uploadFileWithSftp(sftp, localPath, remotePath, progress = null) {
  return new Promise((resolve, reject) => {
    if (progress?.session?.canceled) {
      reject(new Error('Transfer canceled by user'))
      return
    }
    sftp.fastPut(localPath, remotePath, {
      step: (transferred) => {
        if (!progress?.session?.canceled) progress?.onStep?.(transferred)
      }
    }, (error) => {
      if (progress?.session?.canceled) reject(new Error('Transfer canceled by user'))
      else if (error) reject(error)
      else resolve()
    })
  })
}

function ensureRemoteDirectory(sftp, remotePath) {
  const parts = String(remotePath || '/').split('/').filter(Boolean)
  let current = remotePath.startsWith('/') ? '/' : ''
  return parts.reduce((promise, part) => promise.then(() => new Promise((resolve, reject) => {
    current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part
    sftp.mkdir(current, (error) => {
      if (!error || error.code === 4) {
        resolve()
        return
      }
      sftp.stat(current, (statError, attrs) => {
        if (!statError && attrs?.isDirectory()) resolve()
        else reject(error)
      })
    })
  })), Promise.resolve())
}

function getLocalPathSize(localPath) {
  const stats = statSync(localPath)
  if (!stats.isDirectory()) return stats.size
  return readdirSync(localPath).reduce((total, child) => total + getLocalPathSize(join(localPath, child)), 0)
}

function emitTransferProgress(progress, patch) {
  if (!progress?.webContents || progress.webContents.isDestroyed()) return
  const status = patch?.status
  const isTerminal = ['done', 'failed', 'cancelled', 'canceled'].includes(status)
  if (status === 'running' && progress.type === 'upload' && progress.id) {
    const now = Date.now()
    const lastEmittedAt = fileTransferProgressEmitTimes.get(progress.id) || 0
    if (now - lastEmittedAt < 160) return
    fileTransferProgressEmitTimes.set(progress.id, now)
  } else if (isTerminal && progress.type === 'upload' && progress.id) {
    fileTransferProgressEmitTimes.delete(progress.id)
  }
  const payload = {
    id: progress.id,
    type: progress.type,
    name: progress.name,
    localPath: progress.localPath,
    remotePath: progress.remotePath,
    total: progress.total,
    ...(progress.startedAt ? { elapsedSeconds: elapsedSecondsSince(progress.startedAt) } : {}),
    ...patch
  }
  progress.webContents.send('sftp:transfer-progress', payload)
  if (payload.type === 'upload') {
    progress.webContents.send('sftp:upload-progress', payload)
  }
}

function prepareFileTransferSession(progress, client, sftp = null) {
  if (!progress?.id || !progress?.webContents) return null
  let session = fileTransferSessions.get(progress.id)
  if (!session) {
    session = {
      id: progress.id,
      webContentsId: progress.webContents.id,
      progress,
      canceled: false,
      transferred: 0,
      client: null,
      sftp: null,
      sharedConnection: false,
      currentRemotePath: '',
      cancelTransfer: null
    }
    fileTransferSessions.set(progress.id, session)
  }
  session.progress = progress
  session.client = client || session.client
  session.sftp = sftp || session.sftp
  session.sharedConnection = Boolean(progress?.sharedConnection)
  return session
}

function finishFileTransferSession(progress, session) {
  if (!progress?.id || !session) return
  if (fileTransferSessions.get(progress.id) === session) fileTransferSessions.delete(progress.id)
  session.cancelTransfer = null
  closeSftpChannel(session.sftp)
  session.sftp = null
  session.client = null
  session.sharedConnection = false
}

function settlePendingFileTransfer(progress, result = {}) {
  const session = progress?.id ? fileTransferSessions.get(progress.id) : null
  if (!session) return result
  const finalResult = session.canceled
    ? canceledFileTransferResult(progress, session)
    : result
  emitTransferProgress(progress, session.canceled
    ? { transferred: session.transferred, status: 'cancelled', message: finalResult.message }
    : { transferred: session.transferred, status: 'failed', message: finalResult.message || 'Transfer failed' })
  finishFileTransferSession(progress, session)
  return finalResult
}

function canceledFileTransferResult(progress, session, extra = {}) {
  return {
    ok: false,
    canceled: true,
    message: 'Transfer canceled by user',
    localPath: progress?.localPath,
    remotePath: progress?.remotePath,
    partialRemotePath: session?.currentRemotePath || progress?.remotePath,
    ...extra
  }
}

function removeCanceledLocalDownload(localPath) {
  if (!localPath) return
  const remove = (attempt = 0) => {
    try {
      rmSync(localPath, { force: true })
    } catch {
      if (attempt < 3) setTimeout(() => remove(attempt + 1), 300 * (attempt + 1))
    }
  }
  remove()
}

function downloadRemoteFile(client, remotePath, localPath, progress = null) {
  return new Promise((resolve) => {
    const session = prepareFileTransferSession(progress, client)
    if (session) session.currentRemotePath = remotePath
    let settled = false
    const finish = (result, patch = null) => {
      if (settled) return
      settled = true
      const canceled = session?.canceled
      const finalResult = canceled ? canceledFileTransferResult(progress, session) : result
      if (patch && !canceled) emitTransferProgress(progress, patch)
      if (canceled) {
        removeCanceledLocalDownload(localPath)
        emitTransferProgress(progress, { transferred: session.transferred, status: 'cancelled', message: finalResult.message })
      }
      finishFileTransferSession(progress, session)
      resolve(finalResult)
    }
    if (session) session.cancelTransfer = () => finish(canceledFileTransferResult(progress, session))
    if (session?.canceled) {
      finish(canceledFileTransferResult(progress, session))
      return
    }
    client.sftp((error, sftp) => {
      if (session) session.sftp = sftp || null
      if (session?.canceled) {
        sftp?.end()
        finish(canceledFileTransferResult(progress, session))
        return
      }
      if (error) {
        finish({ ok: false, message: error.message }, { status: 'failed', message: error.message })
        return
      }

      sftp.stat(remotePath, (statError, attrs) => {
        if (session?.canceled) {
          finish(canceledFileTransferResult(progress, session))
          return
        }
        if (statError) {
          finish({ ok: false, message: statError.message, localPath, remotePath }, { status: 'failed', message: statError.message })
          return
        }
        const total = Number(attrs?.size || 0)
        const transferProgress = { ...progress, total }
        emitTransferProgress(transferProgress, {
          transferred: 0,
          total,
          status: 'running'
        })

        sftp.fastGet(remotePath, localPath, {
          step: (transferred) => {
            if (session) session.transferred = transferred
            if (!session?.canceled) emitTransferProgress(transferProgress, { transferred, status: 'running' })
          }
        }, (getError) => {
          if (session?.canceled) {
            finish(canceledFileTransferResult(transferProgress, session))
            return
          }
          if (getError) {
            finish({ ok: false, message: getError.message, localPath, remotePath }, { status: 'failed', message: getError.message })
            return
          }
          finish(
            { ok: true, message: 'Download completed', localPath, remotePath },
            { transferred: total, status: 'done' }
          )
        })
      })
    })
  })
}

async function cleanupCanceledRemoteUpload(config, remotePath) {
  if (!remotePath) return
  try {
    await withSshClient(config, (client) => new Promise((resolve) => {
      client.sftp((error, sftp) => {
        if (error) {
          resolve({ ok: false })
          return
        }
        sftp.unlink(remotePath, () => resolve({ ok: true }))
      })
    }))
  } catch {
    // Cancellation has already succeeded even if best-effort cleanup cannot reconnect.
  }
}

function readRemoteTextFile(client, remotePath) {
  const maxBytes = 2 * 1024 * 1024
  return new Promise((resolve) => {
    let settled = false
    let sftpSession = null
    const finish = (result) => {
      if (settled) return
      settled = true
      closeSftpChannel(sftpSession)
      resolve(result)
    }
    client.sftp((error, sftp) => {
      if (error) {
        finish({ ok: false, message: error.message })
        return
      }
      sftpSession = sftp

      sftp.stat(remotePath, (statError, attrs) => {
        if (statError) {
          finish({ ok: false, message: statError.message })
          return
        }
        if (attrs?.size > maxBytes) {
          finish({ ok: false, message: 'File is larger than 2 MB. Download it instead.' })
          return
        }

        const chunks = []
        const stream = sftp.createReadStream(remotePath)
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('error', (streamError) => finish({ ok: false, message: streamError.message }))
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.includes(0)) {
            finish({ ok: false, message: 'Binary file preview is not supported.' })
            return
          }
          finish({ ok: true, path: remotePath, content: buffer.toString('utf8'), size: attrs?.size || buffer.length })
        })
      })
    })
  })
}

function writeRemoteTextFile(client, remotePath, content) {
  return writeRemoteBufferFile(client, remotePath, Buffer.from(content, 'utf8'))
}

function createRemoteFile(client, remotePath) {
  return new Promise((resolve) => {
    let sftpSession = null
    const finish = (result) => {
      closeSftpChannel(sftpSession)
      resolve(result)
    }
    client.sftp((error, sftp) => {
      if (error) {
        finish({ ok: false, message: error.message, path: remotePath })
        return
      }
      sftpSession = sftp
      sftp.open(remotePath, 'wx', 0o644, (openError, handle) => {
        if (openError) {
          finish({ ok: false, message: openError.message, path: remotePath })
          return
        }
        sftp.close(handle, (closeError) => {
          finish(closeError
            ? { ok: false, message: closeError.message, path: remotePath }
            : { ok: true, message: 'File created', path: remotePath, name: posix.basename(remotePath), type: 'file', size: 0 })
        })
      })
    })
  })
}

function createRemoteDirectory(client, remotePath) {
  return new Promise((resolve) => {
    let settled = false
    let sftpSession = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sftpSession?.end()
      } catch {
        // The parent SSH client is closed by withSshClient.
      }
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, message: `Create directory timed out: ${remotePath}`, path: remotePath })
    }, 15000)
    client.sftp((error, sftp) => {
      if (error) {
        finish({ ok: false, message: error.message, path: remotePath })
        return
      }
      sftpSession = sftp
      sftp.mkdir(remotePath, { mode: 0o755 }, (mkdirError) => {
        finish(mkdirError
          ? { ok: false, message: mkdirError.message, path: remotePath }
          : { ok: true, message: 'Directory created', path: remotePath, name: posix.basename(remotePath), type: 'dir' })
      })
    })
  })
}

function renameRemoteItem(client, sourcePath, targetPath) {
  return new Promise((resolve) => {
    let sftpSession = null
    const finish = (result) => {
      closeSftpChannel(sftpSession)
      resolve(result)
    }
    client.sftp((error, sftp) => {
      if (error) {
        finish({ ok: false, message: error.message, sourcePath, path: targetPath })
        return
      }
      sftpSession = sftp
      sftp.lstat(targetPath, (targetError) => {
        if (!targetError) {
          finish({ ok: false, message: `Target already exists: ${targetPath}`, sourcePath, path: targetPath })
          return
        }
        if (!isRemotePathMissingError(targetError)) {
          finish({ ok: false, message: targetError.message, sourcePath, path: targetPath })
          return
        }
        sftp.rename(sourcePath, targetPath, (renameError) => {
          finish(renameError
            ? { ok: false, message: renameError.message, sourcePath, path: targetPath }
            : {
                ok: true,
                message: 'Item renamed',
                sourcePath,
                path: targetPath,
                name: posix.basename(targetPath)
              })
        })
      })
    })
  })
}

function isRemotePathMissingError(error) {
  return error?.code === 2 || error?.code === 'ENOENT' || /no such file|not found/i.test(String(error?.message || ''))
}

function writeRemoteBufferFile(client, remotePath, buffer) {
  return new Promise((resolve) => {
    client.sftp((error, sftp) => {
      if (error) {
        resolve({ ok: false, message: error.message })
        return
      }

      let settled = false
      const done = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        closeSftpChannel(sftp)
        resolve(result)
      }
      const timer = setTimeout(() => {
        done({ ok: false, message: 'Save timed out. Check file permissions or network connection.', path: remotePath })
      }, 120000)

      sftp.open(remotePath, 'w', (openError, handle) => {
        if (openError) {
          done({ ok: false, message: openError.message, path: remotePath })
          return
        }

        const chunkSize = 64 * 1024
        const writeNext = (position = 0) => {
          if (position >= buffer.length) {
            sftp.close(handle, (closeError) => {
              if (closeError) {
                done({ ok: false, message: closeError.message, path: remotePath })
                return
              }
              done({ ok: true, message: 'File saved', path: remotePath, size: buffer.length })
            })
            return
          }

          const length = Math.min(chunkSize, buffer.length - position)
          sftp.write(handle, buffer, position, length, position, (writeError) => {
            if (writeError) {
              sftp.close(handle, () => done({ ok: false, message: writeError.message, path: remotePath }))
              return
            }
            writeNext(position + length)
          })
        }

        writeNext()
      })
    })
  })
}

function deleteRemoteItem(client, remotePath, type, progress = null) {
  return new Promise((resolve) => {
    client.sftp((error, sftp) => {
      if (error) {
        emitTransferProgress(progress, { status: 'failed', message: error.message })
        resolve({ ok: false, message: error.message })
        return
      }

      deleteRemoteItemWithProgress(sftp, remotePath, type, progress)
        .then((result) => resolve(result))
        .catch((deleteError) => {
          emitTransferProgress(progress, { status: 'failed', message: deleteError.message, currentPath: remotePath })
          resolve({ ok: false, message: deleteError.message, path: remotePath })
        })
        .finally(() => closeSftpChannel(sftp))
    })
  })
}

async function deleteRemoteItemWithProgress(sftp, remotePath, type, progress) {
  if (type !== 'dir') {
    await sftpUnlink(sftp, remotePath)
    await verifySftpPathDeleted(sftp, remotePath)
    emitTransferProgress(progress, { transferred: 1, total: 1, status: 'done', currentPath: remotePath })
    return { ok: true, message: 'Deleted', path: remotePath, deletedCount: 1 }
  }

  const entries = await collectRemoteDeleteEntries(sftp, remotePath)
  const total = Math.max(entries.length, 1)
  let deleted = 0
  emitTransferProgress(progress, { transferred: 0, total, status: 'running', currentPath: remotePath })

  for (const entry of entries) {
    if (entry.type === 'dir') {
      await sftpRmdir(sftp, entry.path)
    } else {
      await sftpUnlink(sftp, entry.path)
    }
    deleted += 1
    emitTransferProgress(progress, {
      transferred: deleted,
      total,
      status: 'running',
      currentPath: entry.path
    })
  }

  await verifySftpPathDeleted(sftp, remotePath)
  emitTransferProgress(progress, { transferred: deleted, total, status: 'done', currentPath: remotePath })

  return { ok: true, message: 'Deleted', path: remotePath, deletedCount: deleted }
}

function verifySftpPathDeleted(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error) => {
      if (error && isRemotePathMissingError(error)) {
        resolve()
        return
      }
      if (error) {
        reject(error)
        return
      }
      reject(new Error(`Delete verification failed; remote path still exists: ${remotePath}`))
    })
  })
}

async function collectRemoteDeleteEntries(sftp, remotePath) {
  const entries = []

  async function walk(currentPath) {
    const items = await sftpReaddir(sftp, currentPath)
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue
      const childPath = joinRemotePath(currentPath, item.filename)
      if (item.attrs?.isDirectory?.()) {
        await walk(childPath)
      } else {
        entries.push({ path: childPath, type: 'file' })
      }
    }
    entries.push({ path: currentPath, type: 'dir' })
  }

  await walk(remotePath)
  return entries
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, items) => {
      if (error) reject(error)
      else resolve(items || [])
    })
  })
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function sftpRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function wrapInteractiveCommand(command) {
  return `bash -ilc ${shellQuote(command)}`
}

function wrapWorkflowCommand(command) {
  return `bash -c ${shellQuote(command)}`
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function decodeSqlFile(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'UTF-8 BOM', content: buffer.subarray(3).toString('utf8') }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'UTF-16 LE', content: new TextDecoder('utf-16le').decode(buffer.subarray(2)) }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'UTF-16 BE', content: new TextDecoder('utf-16be').decode(buffer.subarray(2)) }
  }
  try {
    return { encoding: 'UTF-8', content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    try {
      return { encoding: 'GB18030', content: new TextDecoder('gb18030', { fatal: true }).decode(buffer) }
    } catch {
      return { encoding: 'UTF-8 (replacement characters)', content: buffer.toString('utf8') }
    }
  }
}

function splitDatabaseScript(sql, engine = 'mysql') {
  const source = String(sql || '').replace(/^\uFEFF/, '')
  if (engine === 'sqlserver') return splitSqlServerScript(source)
  if (isOracleLikeEngine(engine)) return splitOracleLikeScript(source)
  return splitDelimitedSql(source, {
    dynamicDelimiter: engine === 'mysql' || engine === 'mariadb',
    postgresDollarQuotes: engine === 'postgres',
    hashComments: engine === 'mysql' || engine === 'mariadb'
  })
}

function splitDelimitedSql(source, options = {}) {
  const statements = []
  let buffer = ''
  let delimiter = ';'
  let quote = ''
  let dollarQuote = ''
  let lineComment = false
  let blockComment = false
  let lineStart = true

  const pushStatement = () => {
    const statement = buffer.trim()
    if (statement && hasExecutableSql(statement, options.hashComments)) statements.push(statement)
    buffer = ''
  }

  for (let index = 0; index < source.length;) {
    if (!quote && !dollarQuote && !lineComment && !blockComment && lineStart && options.dynamicDelimiter) {
      const lineEnd = source.indexOf('\n', index)
      const end = lineEnd < 0 ? source.length : lineEnd
      const line = source.slice(index, end)
      const delimiterMatch = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i)
      if (delimiterMatch) {
        delimiter = delimiterMatch[1]
        index = lineEnd < 0 ? source.length : lineEnd + 1
        lineStart = true
        continue
      }
    }

    const char = source[index]
    const next = source[index + 1] || ''

    if (lineComment) {
      buffer += char
      index += 1
      if (char === '\n') {
        lineComment = false
        lineStart = true
      }
      continue
    }
    if (blockComment) {
      buffer += char
      if (char === '*' && next === '/') {
        buffer += next
        index += 2
        blockComment = false
      } else {
        index += 1
      }
      lineStart = char === '\n'
      continue
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        buffer += dollarQuote
        index += dollarQuote.length
        dollarQuote = ''
      } else {
        buffer += char
        index += 1
      }
      lineStart = char === '\n'
      continue
    }
    if (quote) {
      buffer += char
      if (char === quote) {
        if (next === quote) {
          buffer += next
          index += 2
          continue
        }
        quote = ''
      } else if (char === '\\' && next) {
        buffer += next
        index += 2
        continue
      }
      index += 1
      lineStart = char === '\n'
      continue
    }

    if (char === '-' && next === '-') {
      buffer += '--'
      index += 2
      lineComment = true
      lineStart = false
      continue
    }
    if (options.hashComments && char === '#') {
      buffer += char
      index += 1
      lineComment = true
      lineStart = false
      continue
    }
    if (char === '/' && next === '*') {
      buffer += '/*'
      index += 2
      blockComment = true
      lineStart = false
      continue
    }
    if (options.postgresDollarQuotes && char === '$') {
      const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (match) {
        dollarQuote = match[0]
        buffer += dollarQuote
        index += dollarQuote.length
        lineStart = false
        continue
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      buffer += char
      index += 1
      lineStart = false
      continue
    }
    if (delimiter && source.startsWith(delimiter, index)) {
      pushStatement()
      index += delimiter.length
      lineStart = false
      continue
    }

    buffer += char
    index += 1
    lineStart = char === '\n' || (lineStart && /[\t\r ]/.test(char))
  }
  pushStatement()
  return statements
}

function splitSqlServerScript(source) {
  const statements = []
  let batch = []
  const pushBatch = (repeat = 1) => {
    const sql = batch.join('\n').trim()
    batch = []
    if (!sql || !hasExecutableSql(sql)) return
    const count = Math.min(100, Math.max(1, Number(repeat || 1)))
    for (let index = 0; index < count; index += 1) statements.push(sql)
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i)
    if (match) pushBatch(match[1])
    else batch.push(line)
  }
  pushBatch()
  return statements
}

function splitOracleLikeScript(source) {
  const statements = []
  let plainLines = []
  let blockLines = []
  let inBlock = false
  const flushPlain = () => {
    statements.push(...splitDelimitedSql(plainLines.join('\n')))
    plainLines = []
  }
  const flushBlock = () => {
    const sql = blockLines.join('\n').trim()
    if (sql && hasExecutableSql(sql)) statements.push(sql)
    blockLines = []
    inBlock = false
  }
  for (const line of source.split(/\r?\n/)) {
    if (inBlock) {
      if (/^\s*\/\s*$/.test(line)) flushBlock()
      else blockLines.push(line)
      continue
    }
    if (/^\s*(?:CREATE(?:\s+OR\s+REPLACE)?\s+(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE(?:\s+BODY)?)|DECLARE\b|BEGIN\b)/i.test(line)) {
      flushPlain()
      inBlock = true
      blockLines.push(line)
      continue
    }
    if (/^\s*\/\s*$/.test(line)) flushPlain()
    else plainLines.push(line)
  }
  if (inBlock) flushBlock()
  flushPlain()
  return statements
}

function hasExecutableSql(statement, hashComments = false) {
  let text = String(statement || '')
  if (text.length > 1024 * 1024) return hasExecutableSqlWithoutCopies(text, hashComments)
  text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '')
  if (hashComments) text = text.replace(/^\s*#.*$/gm, '')
  return Boolean(text.trim())
}

function hasExecutableSqlWithoutCopies(text, hashComments = false) {
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length;) {
    const char = text[index]
    const next = text[index + 1] || ''
    if (lineComment) {
      if (char === '\n') lineComment = false
      index += 1
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (char === '-' && next === '-') {
      lineComment = true
      index += 2
      continue
    }
    if (hashComments && char === '#') {
      lineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index += 2
      continue
    }
    if (!/\s/.test(char)) return true
    index += 1
  }
  return false
}

function createSqlScriptCanceledError() {
  const error = new Error('SQL script execution stopped')
  error.code = 'SQL_SCRIPT_CANCELED'
  return error
}

function isSqlScriptCanceledError(error) {
  return error?.code === 'SQL_SCRIPT_CANCELED'
}

function yieldToMainProcess() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise))
}

function formatPercent(value, total) {
  if (!total) return '0%'
  return `${Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(total)) * 100)))}%`
}

function elapsedSecondsSince(startedAt) {
  const elapsed = Math.max(0, Date.now() - Number(startedAt || Date.now()))
  return Math.round(elapsed / 100) / 10
}

function formatElapsedSeconds(seconds) {
  return Number(seconds || 0).toFixed(1).replace(/\.0$/, '')
}

function appendElapsedSeconds(message, seconds) {
  return `${message} · 耗时 ${formatElapsedSeconds(seconds)} 秒`
}

function detectOpsFlowBackupSourceDatabase(statement) {
  const text = String(statement || '')
  if (!/^\s*-- Ops Flow built-in logical database backup\s*$/im.test(text)) return ''
  return text.match(/^\s*-- Database:\s*(.+?)\s*$/im)?.[1]?.trim() || ''
}

function isOpsFlowLogicalBackup(statement) {
  return /^\s*-- Ops Flow built-in logical database backup\s*$/im.test(String(statement || ''))
}

function retargetOpsFlowMysqlBackupStatement(statement, config, sourceDatabase = '') {
  if (!['mysql', 'mariadb'].includes(config.engine) || !sourceDatabase) return statement
  const escapedSource = String(sourceDatabase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/`/g, '``')
  return String(statement).replace(new RegExp(`\\\`${escapedSource}\\\`\\.`, 'gi'), '')
}

const DATABASE_INSERT_BATCH_MAX_ROWS = 500
const DATABASE_INSERT_BATCH_MAX_BYTES = 512 * 1024

function supportsExtendedInsertBatches(engine) {
  return ['mysql', 'mariadb', 'postgres', 'sqlserver'].includes(engine)
}

function splitExtendedInsertValueTuples(source) {
  const text = String(source || '')
  const tuples = []
  let index = 0
  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1
  }
  skipWhitespace()
  while (index < text.length) {
    if (text[index] !== '(') return null
    const start = index
    let depth = 0
    let quote = ''
    for (; index < text.length; index += 1) {
      const char = text[index]
      const next = text[index + 1] || ''
      if (quote) {
        if (char === quote) {
          if (next === quote) {
            index += 1
            continue
          }
          quote = ''
        } else if (char === '\\' && next) {
          index += 1
        }
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        continue
      }
      if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          index += 1
          tuples.push(text.slice(start, index))
          break
        }
        if (depth < 0) return null
      }
    }
    if (depth !== 0 || quote) return null
    skipWhitespace()
    if (index >= text.length) break
    if (text[index] !== ',') return null
    index += 1
    skipWhitespace()
  }
  return tuples.length ? tuples : null
}

function parseOpsFlowExtendedInsert(statement) {
  const text = String(statement || '').trim()
  const insertIndex = text.search(/\bINSERT\s+INTO\b/i)
  if (insertIndex < 0) return null
  const leading = text.slice(0, insertIndex)
  if (leading.split(/\r?\n/).some((line) => line.trim() && !/^\s*(?:--|#)/.test(line))) return null
  const insert = text.slice(insertIndex).trim()
  const valuesPattern = /\bVALUES\b/ig
  let match
  while ((match = valuesPattern.exec(insert))) {
    const prefix = insert.slice(0, match.index).trimEnd()
    if (!/^INSERT\s+INTO[\s\S]+\)\s*(?:OVERRIDING\s+SYSTEM\s+VALUE)?\s*$/i.test(prefix)) continue
    const tuples = splitExtendedInsertValueTuples(insert.slice(match.index + match[0].length))
    if (!tuples) continue
    return {
      leading,
      prefix: `${prefix} VALUES`,
      signature: prefix.replace(/\s+/g, ' ').trim().toLowerCase(),
      tuples
    }
  }
  return null
}

function buildOptimizedInsertBatch(parsed) {
  return `${parsed.leading || ''}${parsed.prefix} ${parsed.tuples.join(',\n')}`
}

function optimizedInsertBatchBytes(parsed) {
  return Buffer.byteLength(buildOptimizedInsertBatch(parsed), 'utf8')
}

async function* streamDatabaseScriptExecutionBatches(filePath, engine = 'mysql', options = {}) {
  let firstStatement = true
  let opsFlowBackup = false
  let pending = null
  for await (const statement of streamDatabaseScriptStatements(filePath, engine, options)) {
    if (firstStatement) {
      firstStatement = false
      opsFlowBackup = isOpsFlowLogicalBackup(statement)
    }
    const parsed = opsFlowBackup && supportsExtendedInsertBatches(engine)
      ? parseOpsFlowExtendedInsert(statement)
      : null
    if (!parsed) {
      if (pending) {
        yield {
          sql: buildOptimizedInsertBatch(pending),
          dataRows: pending.tuples.length,
          optimized: pending.optimized
        }
        pending = null
      }
      yield { sql: statement, dataRows: 0, optimized: false }
      continue
    }

    const candidateRows = pending ? pending.tuples.length + parsed.tuples.length : 0
    const candidateBytes = pending
      ? pending.byteLength + 2 + Buffer.byteLength(parsed.tuples.join(',\n'), 'utf8')
      : 0
    if (
      pending &&
      !parsed.leading.trim() &&
      pending.signature === parsed.signature &&
      candidateRows <= DATABASE_INSERT_BATCH_MAX_ROWS &&
      candidateBytes <= DATABASE_INSERT_BATCH_MAX_BYTES
    ) {
      pending.tuples.push(...parsed.tuples)
      pending.byteLength = candidateBytes
      pending.optimized = true
      continue
    }
    if (pending) {
      yield {
        sql: buildOptimizedInsertBatch(pending),
        dataRows: pending.tuples.length,
        optimized: pending.optimized
      }
    }
    pending = {
      ...parsed,
      byteLength: optimizedInsertBatchBytes(parsed),
      optimized: parsed.tuples.length === 1
    }
  }
  if (pending) {
    yield {
      sql: buildOptimizedInsertBatch(pending),
      dataRows: pending.tuples.length,
      optimized: pending.optimized
    }
  }
}

async function* readSqlScriptLines(filePath, options = {}) {
  const source = createReadStream(filePath)
  const input = /\.gz$/i.test(filePath) ? source.pipe(createGunzip()) : source
  if (input !== source) {
    source.once('error', (error) => input.destroy(error))
  }
  const reader = createInterface({ input, crlfDelay: Infinity })
  const sourceSize = Math.max(1, statSync(filePath).size)
  let processedBytes = 0
  source.on('data', (chunk) => {
    processedBytes += chunk.length
    options.onProgress?.(processedBytes, sourceSize)
    if (options.isCanceled?.()) source.destroy(createSqlScriptCanceledError())
  })
  let firstLine = true
  try {
    for await (let line of reader) {
      if (options.isCanceled?.()) throw createSqlScriptCanceledError()
      if (firstLine) line = line.replace(/^\uFEFF/, '')
      firstLine = false
      yield line
    }
    options.onProgress?.(sourceSize, sourceSize, true)
  } finally {
    reader.close()
    if (!source.destroyed) source.destroy()
  }
}

function createStreamingDelimitedSqlParser(options = {}) {
  let bufferParts = []
  let bufferHasContent = false
  let delimiter = ';'
  let quote = ''
  let dollarQuote = ''
  let lineComment = false
  let blockComment = false

  const appendBuffer = (value) => {
    if (!value) return
    bufferParts.push(value)
    if (!bufferHasContent && /\S/.test(value)) bufferHasContent = true
  }

  const pushStatement = (statements) => {
    const statement = bufferParts.join('').trim()
    if (statement && hasExecutableSql(statement, options.hashComments)) statements.push(statement)
    bufferParts = []
    bufferHasContent = false
  }

  const feedLine = async (line) => {
    const statements = []
    if (!quote && !dollarQuote && !lineComment && !blockComment && options.dynamicDelimiter && !bufferHasContent) {
      const delimiterMatch = String(line).match(/^\s*DELIMITER\s+(\S+)\s*$/i)
      if (delimiterMatch) {
        delimiter = delimiterMatch[1]
        return statements
      }
    }

    const source = String(line)
    let segmentStart = 0
    for (let index = 0; index <= source.length;) {
      if (index > 0 && index % (64 * 1024) === 0) {
        if (options.isCanceled?.()) throw createSqlScriptCanceledError()
        await yieldToMainProcess()
      }
      const char = index === source.length ? '\n' : source[index]
      const next = index + 1 < source.length ? source[index + 1] : ''
      if (lineComment) {
        index += 1
        if (char === '\n') lineComment = false
        continue
      }
      if (blockComment) {
        if (char === '*' && next === '/') {
          index += 2
          blockComment = false
        } else {
          index += 1
        }
        continue
      }
      if (dollarQuote) {
        if (source.startsWith(dollarQuote, index)) {
          index += dollarQuote.length
          dollarQuote = ''
        } else {
          index += 1
        }
        continue
      }
      if (quote) {
        if (char === quote) {
          if (next === quote) {
            index += 2
            continue
          }
          quote = ''
        } else if (char === '\\' && next) {
          index += 2
          continue
        }
        index += 1
        continue
      }
      if (char === '-' && next === '-') {
        index += 2
        lineComment = true
        continue
      }
      if (options.hashComments && char === '#') {
        index += 1
        lineComment = true
        continue
      }
      if (char === '/' && next === '*') {
        index += 2
        blockComment = true
        continue
      }
      if (options.postgresDollarQuotes && char === '$') {
        const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
        if (match) {
          dollarQuote = match[0]
          index += dollarQuote.length
          continue
        }
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        index += 1
        continue
      }
      if (delimiter && (delimiter.length === 1 ? char === delimiter : source.startsWith(delimiter, index))) {
        appendBuffer(source.slice(segmentStart, index))
        pushStatement(statements)
        index += delimiter.length
        segmentStart = index
        continue
      }
      index += 1
    }
    appendBuffer(source.slice(segmentStart))
    appendBuffer('\n')
    return statements
  }

  return {
    feedLine,
    finish() {
      const statements = []
      pushStatement(statements)
      return statements
    },
    isNeutral() {
      return !quote && !dollarQuote && !lineComment && !blockComment
    },
    hasBufferedSql() {
      return bufferHasContent
    }
  }
}

async function* streamDatabaseScriptStatements(filePath, engine = 'mysql', options = {}) {
  if (engine === 'sqlserver') {
    let batch = []
    for await (const line of readSqlScriptLines(filePath, options)) {
      if (options.isCanceled?.()) throw createSqlScriptCanceledError()
      const match = line.match(/^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i)
      if (!match) {
        batch.push(line)
        continue
      }
      const sql = batch.join('\n').trim()
      batch = []
      if (!sql || !hasExecutableSql(sql)) continue
      const repeat = Math.min(100, Math.max(1, Number(match[1] || 1)))
      for (let index = 0; index < repeat; index += 1) yield sql
    }
    const sql = batch.join('\n').trim()
    if (sql && hasExecutableSql(sql)) yield sql
    return
  }

  if (isOracleLikeEngine(engine)) {
    let parser = createStreamingDelimitedSqlParser(options)
    let block = []
    let inBlock = false
    for await (const line of readSqlScriptLines(filePath, options)) {
      if (options.isCanceled?.()) throw createSqlScriptCanceledError()
      if (inBlock) {
        if (/^\s*\/\s*$/.test(line)) {
          const sql = block.join('\n').trim()
          if (sql && hasExecutableSql(sql)) yield sql
          block = []
          inBlock = false
        } else {
          block.push(line)
        }
        continue
      }
      if (parser.isNeutral() && /^\s*(?:CREATE(?:\s+OR\s+REPLACE)?\s+(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE(?:\s+BODY)?)|DECLARE\b|BEGIN\b)/i.test(line)) {
        for (const statement of parser.finish()) yield statement
        parser = createStreamingDelimitedSqlParser(options)
        inBlock = true
        block.push(line)
        continue
      }
      if (/^\s*\/\s*$/.test(line) && parser.isNeutral()) {
        for (const statement of parser.finish()) yield statement
        parser = createStreamingDelimitedSqlParser(options)
        continue
      }
      for (const statement of await parser.feedLine(line)) yield statement
    }
    if (inBlock) {
      const sql = block.join('\n').trim()
      if (sql && hasExecutableSql(sql)) yield sql
    }
    for (const statement of parser.finish()) yield statement
    return
  }

  const parser = createStreamingDelimitedSqlParser({
    ...options,
    dynamicDelimiter: engine === 'mysql' || engine === 'mariadb',
    postgresDollarQuotes: engine === 'postgres',
    hashComments: engine === 'mysql' || engine === 'mariadb'
  })
  for await (const line of readSqlScriptLines(filePath, options)) {
    if (options.isCanceled?.()) throw createSqlScriptCanceledError()
    for (const statement of await parser.feedLine(line)) yield statement
  }
  for (const statement of parser.finish()) yield statement
}

async function executeDatabaseScriptFileBatches(connection, config, filePath, statementCount, task, options = {}, session = {}) {
  let lastResult = { rows: [], rowCount: 0 }
  let affectedRows = 0
  let completedStatements = 0
  let transaction = null
  if (options.rollbackOnError) {
    transaction = await beginDatabaseScriptTransaction(connection, config)
    emitTransferProgress(task, {
      transferred: session.progressTransferred,
      status: 'running',
      message: 'Transaction started; errors or a stop request will trigger rollback'
    })
  }

  try {
    for await (const batch of streamDatabaseScriptExecutionBatches(filePath, config.engine, {
      isCanceled: () => session.cancelRequested,
      onProgress: options.onFileProgress
    })) {
      if (session.cancelRequested) {
        return stopDatabaseScript(connection, config, transaction, task, completedStatements, session.progressTransferred, session)
      }
      const statementNumber = completedStatements + 1
      const dataRows = Number(batch.dataRows || 0)
      const rowStart = dataRows ? session.completedDataRows + 1 : 0
      const rowEnd = dataRows ? session.completedDataRows + dataRows : 0
      session.currentDataRowStart = rowStart
      session.currentDataRowEnd = rowEnd
      const rowProgress = dataRows
        ? ` · data rows ${rowStart}-${rowEnd}/${session.totalDataRows}`
        : ''
      emitTransferProgress(task, {
        transferred: session.progressTransferred,
        status: 'running',
        message: `Executing SQL batch ${statementNumber}/${statementCount}${rowProgress}`
      })
      const executableStatement = retargetOpsFlowMysqlBackupStatement(batch.sql, config, session.opsFlowBackupSourceDatabase)
      lastResult = await executeDatabaseBatch(connection, config, executableStatement, transaction)
      const implicitCommit = recordDatabaseScriptStatement(session, config, executableStatement)
      if (transaction && implicitCommit) {
        transaction = await beginDatabaseScriptTransaction(connection, config)
      }
      if (typeof lastResult.rowCount === 'number') affectedRows += lastResult.rowCount
      completedStatements = statementNumber
      session.completedStatements = completedStatements
      session.completedDataRows += dataRows
      emitTransferProgress(task, {
        transferred: session.progressTransferred,
        status: 'running',
        message: `Completed SQL batch ${completedStatements}/${statementCount} · ${session.completedDataRows}/${session.totalDataRows} data row(s)`
      })
    }
  } catch (error) {
    if (isSqlScriptCanceledError(error) || session.cancelRequested) {
      return stopDatabaseScript(connection, config, transaction, task, completedStatements, session.progressTransferred, session)
    }
    const failedStatement = completedStatements + 1
    const failedRows = session.currentDataRowStart
      ? ` (data rows ${session.currentDataRowStart}-${session.currentDataRowEnd}/${session.totalDataRows})`
      : ''
    if (transaction) {
      try {
        await rollbackDatabaseScriptTransaction(connection, config, transaction)
        return {
          ok: false,
          rolledBack: true,
          partialRollback: databaseScriptRollbackIsPartial(session),
          completedStatements,
          failedStatement,
          message: `SQL batch ${failedStatement}/${statementCount}${failedRows} failed: ${error.message}; ${databaseScriptRollbackMessage(config, session)}`
        }
      } catch (rollbackError) {
        return {
          ok: false,
          rollbackFailed: true,
          completedStatements,
          failedStatement,
          message: `SQL batch ${failedStatement}/${statementCount}${failedRows} failed: ${error.message}; rollback failed: ${rollbackError.message}`
        }
      }
    }
    return {
      ok: false,
      completedStatements,
      failedStatement,
      message: `SQL batch ${failedStatement}/${statementCount}${failedRows} failed: ${error.message}`
    }
  }

  if (session.cancelRequested) {
    return stopDatabaseScript(connection, config, transaction, task, completedStatements, session.progressTransferred, session)
  }
  if (transaction) {
    try {
      await commitDatabaseScriptTransaction(connection, config, transaction)
    } catch (error) {
      try {
        await rollbackDatabaseScriptTransaction(connection, config, transaction)
        return {
          ok: false,
          rolledBack: true,
          partialRollback: databaseScriptRollbackIsPartial(session),
          completedStatements,
          message: `Transaction commit failed: ${error.message}; ${databaseScriptRollbackMessage(config, session)}`
        }
      } catch (rollbackError) {
        return {
          ok: false,
          rollbackFailed: true,
          completedStatements,
          message: `Transaction commit failed: ${error.message}; rollback failed: ${rollbackError.message}`
        }
      }
    }
  }
  return {
    ok: true,
    rows: lastResult.rows ?? [],
    rowCount: affectedRows,
    completedStatements,
    completedDataRows: session.completedDataRows,
    message: `${completedStatements} SQL batch(es) and ${session.completedDataRows} data row(s) completed`
  }
}

async function executeDatabaseScriptBatches(connection, config, statements, task, options = {}, session = {}) {
  let lastResult = { rows: [], rowCount: 0 }
  let affectedRows = 0
  let transaction = null
  if (options.rollbackOnError) {
    transaction = await beginDatabaseScriptTransaction(connection, config)
    emitTransferProgress(task, {
      transferred: 0,
      status: 'running',
      message: 'Transaction started; errors or a stop request will trigger rollback'
    })
  }

  for (let index = 0; index < statements.length; index += 1) {
    if (session.cancelRequested) {
      return stopDatabaseScript(connection, config, transaction, task, index, index, session)
    }
    emitTransferProgress(task, {
      transferred: index,
      status: 'running',
      message: `Executing SQL batch ${index + 1}/${statements.length}`
    })
    try {
      lastResult = await executeDatabaseBatch(connection, config, statements[index], transaction)
      const implicitCommit = recordDatabaseScriptStatement(session, config, statements[index])
      if (transaction && implicitCommit) {
        transaction = await beginDatabaseScriptTransaction(connection, config)
      }
      if (typeof lastResult.rowCount === 'number') affectedRows += lastResult.rowCount
      session.completedStatements = index + 1
      emitTransferProgress(task, {
        transferred: index + 1,
        status: 'running',
        message: `Completed SQL batch ${index + 1}/${statements.length}`
      })
    } catch (error) {
      if (transaction) {
        emitTransferProgress(task, {
          transferred: index,
          status: 'running',
          message: `SQL batch ${index + 1} failed; rolling back the transaction`
        })
        try {
          await rollbackDatabaseScriptTransaction(connection, config, transaction)
          return {
            ok: false,
            rolledBack: true,
            partialRollback: databaseScriptRollbackIsPartial(session),
            completedStatements: index,
            failedStatement: index + 1,
            message: `SQL batch ${index + 1}/${statements.length} failed: ${error.message}; ${databaseScriptRollbackMessage(config, session)}`
          }
        } catch (rollbackError) {
          return {
            ok: false,
            rollbackFailed: true,
            completedStatements: index,
            failedStatement: index + 1,
            message: `SQL batch ${index + 1}/${statements.length} failed: ${error.message}; rollback failed: ${rollbackError.message}`
          }
        }
      }
      return {
        ok: false,
        completedStatements: index,
        failedStatement: index + 1,
        message: `SQL batch ${index + 1}/${statements.length} failed: ${error.message}`
      }
    }
  }

  if (session.cancelRequested) {
    return stopDatabaseScript(connection, config, transaction, task, statements.length, statements.length, session)
  }
  if (transaction) {
    emitTransferProgress(task, {
      transferred: statements.length,
      status: 'running',
      message: 'All SQL batches completed; committing the transaction'
    })
    try {
      await commitDatabaseScriptTransaction(connection, config, transaction)
    } catch (error) {
      try {
        await rollbackDatabaseScriptTransaction(connection, config, transaction)
        return {
          ok: false,
          rolledBack: true,
          partialRollback: databaseScriptRollbackIsPartial(session),
          completedStatements: statements.length,
          message: `Transaction commit failed: ${error.message}; ${databaseScriptRollbackMessage(config, session)}`
        }
      } catch (rollbackError) {
        return {
          ok: false,
          rollbackFailed: true,
          completedStatements: statements.length,
          message: `Transaction commit failed: ${error.message}; rollback failed: ${rollbackError.message}`
        }
      }
    }
  }
  return {
    ok: true,
    rows: lastResult.rows ?? [],
    rowCount: affectedRows,
    completedStatements: statements.length,
    message: `${statements.length} SQL batch(es) completed`
  }
}

async function stopDatabaseScript(connection, config, transaction, task, completedStatements, progressTransferred = completedStatements, session = {}) {
  if (!transaction) {
    return {
      ok: false,
      canceled: true,
      completedStatements,
      message: 'Stopped by user after the current SQL batch; rollback was not enabled'
    }
  }
  emitTransferProgress(task, {
    transferred: progressTransferred,
    status: 'running',
    message: 'Stop accepted; rolling back the transaction'
  })
  try {
    await rollbackDatabaseScriptTransaction(connection, config, transaction)
    return {
      ok: false,
      canceled: true,
      rolledBack: true,
      partialRollback: databaseScriptRollbackIsPartial(session),
      completedStatements,
      message: `Stopped by user; ${databaseScriptRollbackMessage(config, session)}`
    }
  } catch (error) {
    return {
      ok: false,
      canceled: true,
      rollbackFailed: true,
      completedStatements,
      message: `Stopped by user; rollback failed: ${error.message}`
    }
  }
}

function databaseScriptBatchHasImplicitCommit(config, sql) {
  if (!['mysql', 'mariadb', 'oracle', 'dm'].includes(config.engine)) return false
  const statement = String(sql || '').replace(/^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/))+\s*/i, '')
  return /^(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|ANALYZE|OPTIMIZE|REPAIR)\b/i.test(statement)
}

function databaseScriptBatchChangesData(sql) {
  const statement = String(sql || '').replace(/^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/))+\s*/i, '')
  return /^(?:INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/i.test(statement)
}

function recordDatabaseScriptStatement(session, config, sql) {
  if (databaseScriptBatchHasImplicitCommit(config, sql)) {
    session.irreversibleDdlStatements = Number(session.irreversibleDdlStatements || 0) + 1
    session.dataCommittedByDdl = Number(session.dataCommittedByDdl || 0) + Number(session.pendingDmlStatements || 0)
    session.pendingDmlStatements = 0
    return true
  }
  if (databaseScriptBatchChangesData(sql)) {
    session.pendingDmlStatements = Number(session.pendingDmlStatements || 0) + 1
  }
  return false
}

function databaseScriptRollbackIsPartial(session = {}) {
  return Number(session.irreversibleDdlStatements || 0) > 0 || Number(session.dataCommittedByDdl || 0) > 0
}

function databaseScriptRollbackMessage(config, session = {}) {
  const ddlCount = Number(session.irreversibleDdlStatements || 0)
  const committedDataCount = Number(session.dataCommittedByDdl || 0)
  if (!ddlCount && !committedDataCount) return 'transactional changes rolled back'
  const engine = String(config.engine || 'database').toUpperCase()
  const details = [`transactional changes since the last DDL were rolled back`, `${ddlCount} DDL batch(es) were already committed by ${engine} and cannot be rolled back`]
  if (committedDataCount) details.push(`${committedDataCount} earlier data batch(es) may also have been committed by DDL`)
  return details.join('; ')
}

async function beginDatabaseScriptTransaction(connection, config) {
  if (config.engine === 'postgres') {
    await connection.query('BEGIN')
    return { engine: 'postgres' }
  }
  if (config.engine === 'sqlserver') {
    const transaction = new mssql.Transaction(connection)
    await transaction.begin()
    return { engine: 'sqlserver', transaction }
  }
  if (isOracleLikeEngine(config.engine)) {
    return { engine: config.engine }
  }
  await connection.beginTransaction()
  return { engine: config.engine || 'mysql' }
}

async function commitDatabaseScriptTransaction(connection, config, transaction) {
  if (transaction.engine === 'postgres') {
    await connection.query('COMMIT')
    return
  }
  if (transaction.engine === 'sqlserver') {
    await transaction.transaction.commit()
    return
  }
  if (isOracleLikeEngine(config.engine)) {
    await connection.commit()
    return
  }
  await connection.commit()
}

async function rollbackDatabaseScriptTransaction(connection, config, transaction) {
  if (transaction.engine === 'postgres') {
    await connection.query('ROLLBACK')
    return
  }
  if (transaction.engine === 'sqlserver') {
    await transaction.transaction.rollback()
    return
  }
  if (isOracleLikeEngine(config.engine)) {
    await connection.rollback()
    return
  }
  await connection.rollback()
}

async function executeDatabaseBatch(connection, config, sql, transaction = null) {
  if (config.engine === 'postgres') {
    const result = await connection.query(sql)
    const last = Array.isArray(result) ? result[result.length - 1] : result
    return { rows: last?.rows || [], rowCount: Number(last?.rowCount || 0) }
  }
  if (config.engine === 'sqlserver') {
    const request = transaction?.transaction ? new mssql.Request(transaction.transaction) : connection.request()
    const result = await request.query(sql)
    return { rows: result.recordset || [], rowCount: result.rowsAffected?.reduce((sum, count) => sum + count, 0) || 0 }
  }
  if (isOracleLikeEngine(config.engine)) {
    const result = await executeOracleLike(connection, config.engine, sql, [], { autoCommit: !transaction })
    return { rows: result.rows || [], rowCount: Number(result.rowsAffected || 0) }
  }
  const [rows] = await connection.query(sql)
  if (Array.isArray(rows)) return { rows, rowCount: rows.length }
  return { rows, rowCount: Number(rows?.affectedRows || 0) }
}

function joinRemotePath(directory, filename) {
  if (!directory || directory === '/') return `/${filename}`
  return `${directory.replace(/\/+$/g, '')}/${filename}`
}

function buildNewRemoteItemPath(parentPath, name) {
  const value = String(name || '').trim()
  if (!value || value === '.' || value === '..' || /[\/\\\0]/.test(value)) {
    throw new Error('Enter a valid name without / or \\')
  }
  if (Buffer.byteLength(value, 'utf8') > 255) throw new Error('The name is longer than 255 bytes')
  return joinRemotePath(String(parentPath || '/'), value)
}

function buildRenamedRemoteItemPaths(sourcePath, newName) {
  const normalizedSource = normalizePrivilegedRemotePath(sourcePath, { allowRoot: false })
  const targetPath = buildNewRemoteItemPath(posix.dirname(normalizedSource), newName)
  if (targetPath === normalizedSource) throw new Error('Enter a different name')
  return { sourcePath: normalizedSource, targetPath }
}

function formatBytes(size) {
  if (!size) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(size)
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

function formatRemoteTime(seconds) {
  if (!seconds) return '-'
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

function formatRemoteOwner(item) {
  const parts = item.longname?.trim().split(/\s+/) || []
  if (parts.length >= 4) return `${parts[2]}:${parts[3]}`
  const uid = item.attrs?.uid ?? '-'
  const gid = item.attrs?.gid ?? '-'
  return `${uid}:${gid}`
}

async function withDatabase(config, task) {
  if (config.connectionMode === 'ssh') {
    return withDatabaseViaSsh(config, task)
  }

  try {
    return await withDatabaseConnection(config, task)
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

function supportsDatabaseCreation(engine) {
  return ['mysql', 'mariadb', 'postgres', 'sqlserver'].includes(String(engine || ''))
}

function databaseCreationConnectionConfig(config = {}) {
  if (config.engine === 'postgres') {
    return { ...config, database: config.database || 'postgres' }
  }
  if (config.engine === 'sqlserver') {
    return { ...config, database: 'master' }
  }
  return { ...config, database: config.database || undefined }
}

function validateCreateDatabaseName(engine, input) {
  const name = String(input || '').trim()
  if (!name) throw new Error('Database name is required.')
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Database name contains unsupported control characters.')
  const maxLength = engine === 'postgres' ? 63 : engine === 'sqlserver' ? 128 : 64
  if ([...name].length > maxLength) {
    throw new Error(`Database name cannot exceed ${maxLength} characters for this database engine.`)
  }
  return name
}

function buildCreateDatabaseSql(config, request = {}) {
  const engine = String(config.engine || '')
  const name = validateCreateDatabaseName(engine, request.name)
  if (['mysql', 'mariadb'].includes(engine)) {
    const charset = String(request.charset || '').trim()
    const collation = String(request.collation || '').trim()
    if (charset && !/^[A-Za-z0-9_]+$/.test(charset)) throw new Error('Invalid database character set.')
    if (collation && !/^[A-Za-z0-9_]+$/.test(collation)) throw new Error('Invalid database collation.')
    return [
      `CREATE DATABASE \`${name.replace(/`/g, '``')}\``,
      charset ? `CHARACTER SET ${charset}` : '',
      collation ? `COLLATE ${collation}` : ''
    ].filter(Boolean).join(' ') + ';'
  }
  if (engine === 'postgres') {
    return `CREATE DATABASE "${name.replace(/"/g, '""')}";`
  }
  if (engine === 'sqlserver') {
    return `CREATE DATABASE [${name.replace(/]/g, ']]')}];`
  }
  throw new Error('Database creation is not supported for this database engine.')
}

function withDatabaseViaSsh(config, task) {
  if (!config.sshConfig) {
    return { ok: false, message: 'SSH configuration is missing. Edit the connection and select an available SSH jump server, or use Direct connection.' }
  }

  return withSshClient(config.sshConfig, async (sshClient) => {
    const socketPath = String(config.socketPath || '').trim()
    const useUnixSocket = config.engine === 'mysql' && config.sshTransport === 'socket'
    if (useUnixSocket) {
      if (!socketPath.startsWith('/')) {
        return { ok: false, message: 'MySQL Unix socket path must be an absolute remote path, for example /tmp/mysql2.sock.' }
      }
      let stream = null
      try {
        stream = await openSshUnixSocket(sshClient, socketPath)
        return await withDatabaseConnection({
          ...config,
          host: 'localhost',
          stream
        }, task)
      } finally {
        if (stream && !stream.destroyed) stream.destroy()
      }
    }

    let tunnel = null
    try {
      tunnel = await createSshTunnelServer(sshClient, config.host, Number(config.port || defaultDatabasePort(config.engine)))
      return await withDatabaseConnection({
        ...config,
        host: '127.0.0.1',
        port: tunnel.port
      }, task)
    } finally {
      tunnel?.close()
    }
  })
}

async function withDatabaseConnection(config, task) {
  if (config.engine === 'postgres') {
    const client = new pg.Client({
      host: config.host,
      port: Number(config.port || 5432),
      user: config.username,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 12000
    })
    await withTimeout(client.connect(), 15000, 'Database connection timed out')
    try {
      return await task(client)
    } finally {
      await client.end()
    }
  }

  if (config.engine === 'sqlserver') {
    const pool = new mssql.ConnectionPool({
      server: config.host,
      port: Number(config.port || 1433),
      user: config.username,
      password: config.password,
      database: config.database,
      connectionTimeout: 12000,
      requestTimeout: 30000,
      options: {
        encrypt: Boolean(config.encrypt),
        trustServerCertificate: true
      }
    })
    await withTimeout(pool.connect(), 15000, 'Database connection timed out')
    try {
      return await task(pool)
    } finally {
      await pool.close()
    }
  }

  if (config.engine === 'oracle') {
    const connection = await withTimeout(
      oracledb.getConnection({
        user: config.username,
        password: config.password,
        connectString: buildOracleConnectString(config)
      }),
      15000,
      'Database connection timed out'
    )
    try {
      return await task(connection)
    } finally {
      await connection.close()
    }
  }

  if (config.engine === 'dm') {
    const legacyMode = Boolean(store.get(DAMENG_LEGACY_MODE_STORE_KEY, false))
    const driverStatus = getDamengDriverStatus()
    const dmdb = legacyMode ? null : await loadDmdbDriver()
    let connection
    try {
      connection = legacyMode
        ? await createDamengLegacyConnection(config)
        : await withTimeout(
            dmdb.getConnection({
              user: config.username,
              password: config.password,
              connectString: `${config.host}:${Number(config.port || 5236)}`
            }),
            15000,
            'Database connection timed out'
          )
    } catch (error) {
      if (/\[6071\]|消息加密失败|Unknown cipher/i.test(String(error?.message || error))) {
        const version = driverStatus.version || 'unknown'
        if (legacyMode) {
          throw new Error(`Dameng legacy compatibility mode was active, but dmdb ${version} still could not negotiate a usable cipher: ${error.message}`)
        }
        throw new Error(`Dameng server and dmdb ${version} negotiated a legacy cipher that is unavailable in this OpenSSL 3 runtime. Enable isolated legacy Dameng compatibility under Settings > General, or upgrade the server to a supported AES cipher. Do not disable login encryption.`)
      }
      throw error
    }
    try {
      return await task(connection)
    } finally {
      await connection.close()
    }
  }

  const connection = await withTimeout(
    mysql.createConnection({
      host: config.host,
      port: Number(config.port || 3306),
      ...(config.stream ? { stream: config.stream } : {}),
      user: config.username,
      password: config.password,
      database: config.database,
      multipleStatements: true,
      connectTimeout: 12000
    }),
    15000,
    'Database connection timed out'
  )
  try {
    return await task(connection)
  } finally {
    await connection.end()
  }
}

function openSshUnixSocket(sshClient, socketPath) {
  return new Promise((resolve, reject) => {
    if (typeof sshClient.openssh_forwardOutStreamLocal !== 'function') {
      reject(new Error('The SSH client does not support OpenSSH Unix socket forwarding.'))
      return
    }
    sshClient.openssh_forwardOutStreamLocal(socketPath, (error, stream) => {
      if (error) {
        reject(new Error(`Unable to open remote MySQL Unix socket ${socketPath}: ${error.message}`))
        return
      }
      resolve(stream)
    })
  })
}

function sendDatabaseBackupProgress(session, details = {}) {
  if (!session?.operationId || session.sender?.isDestroyed?.()) return
  const terminal = ['done', 'failed', 'canceled'].includes(details.status)
  if (terminal) session.terminalProgressSent = true
  const elapsedSeconds = elapsedSecondsSince(session.startedAt)
  session.sender.send('database:backup-progress', {
    operationId: session.operationId,
    content: session.content,
    timestamp: Date.now(),
    ...details,
    elapsedSeconds,
    message: terminal && details.message
      ? appendElapsedSeconds(details.message, elapsedSeconds)
      : details.message
  })
}

function sendRedisBackupProgress(session, details = {}) {
  if (!session?.operationId || session.sender?.isDestroyed?.()) return
  if (['done', 'failed', 'canceled'].includes(details.status)) session.terminalProgressSent = true
  session.sender.send('redis:backup-progress', {
    operationId: session.operationId,
    timestamp: Date.now(),
    ...details
  })
}

function sendRedisRestoreProgress(session, details = {}) {
  if (!session?.operationId || session.sender?.isDestroyed?.()) return
  if (['done', 'failed', 'canceled'].includes(details.status)) session.terminalProgressSent = true
  session.sender.send('redis:restore-progress', {
    operationId: session.operationId,
    timestamp: Date.now(),
    ...details
  })
}

function normalizeDatabaseBackupOptions(config, options = {}) {
  const content = ['structure', 'data', 'structure-data'].includes(options.content)
    ? options.content
    : 'structure-data'
  const format = options.format === 'sql-gzip' ? 'sql-gzip' : 'sql'
  const scope = ['database', 'schema', 'selected'].includes(options.scope)
    ? options.scope
    : 'database'
  const tables = Array.isArray(options.tables)
    ? options.tables
        .map((table) => ({
          schema: String(table?.schema || '').trim(),
          name: String(table?.name || '').trim()
        }))
        .filter((table) => table.schema && table.name)
    : []
  const fallbackSchema = isOracleLikeEngine(config.engine)
    ? String(config.username || '').trim().toUpperCase()
    : config.engine === 'postgres'
      ? 'public'
      : config.engine === 'sqlserver'
        ? 'dbo'
        : String(config.database || '').trim()
  return {
    content,
    format,
    scope,
    schema: String(options.schema || fallbackSchema).trim(),
    tables,
    pageSize: 500
  }
}

async function listDatabaseBackupTables(connection, config, options) {
  if (options.scope === 'selected') {
    if (!options.tables.length) throw new Error('没有选择需要备份的数据表。')
    return deduplicateBackupTables(options.tables)
  }

  const schema = options.scope === 'schema' ? options.schema : ''
  if (config.engine === 'postgres') {
    const params = []
    let schemaFilter = ''
    if (schema) {
      params.push(schema)
      schemaFilter = `and table_schema = $${params.length}`
    }
    const result = await connection.query(`
      select table_schema, table_name
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('pg_catalog', 'information_schema')
        ${schemaFilter}
      order by table_schema, table_name
    `, params)
    return normalizeBackupTableRows(result.rows)
  }

  if (config.engine === 'sqlserver') {
    const request = connection.request()
    let schemaFilter = ''
    if (schema) {
      request.input('schema', mssql.NVarChar, schema)
      schemaFilter = 'and TABLE_SCHEMA = @schema'
    }
    const result = await request.query(`
      select TABLE_SCHEMA as table_schema, TABLE_NAME as table_name
      from INFORMATION_SCHEMA.TABLES
      where TABLE_TYPE = 'BASE TABLE'
        ${schemaFilter}
      order by TABLE_SCHEMA, TABLE_NAME
    `)
    return normalizeBackupTableRows(result.recordset)
  }

  if (isOracleLikeEngine(config.engine)) {
    const binds = {}
    let schemaFilter = `
      and OWNER not in (
        'SYS', 'SYSTEM', 'SYSAUDITOR', 'SYSSSO', 'CTISYS', 'MDSYS',
        'ORDSYS', 'XDB', 'DBSNMP', 'OUTLN'
      )
    `
    if (schema) {
      binds.schema = schema.toUpperCase()
      schemaFilter = 'and OWNER = :schema'
    }
    const result = await executeOracleLike(connection, config.engine, `
      select OWNER as table_schema, TABLE_NAME as table_name
      from ALL_TABLES
      where 1 = 1
        ${schemaFilter}
      order by OWNER, TABLE_NAME
    `, binds)
    return normalizeBackupTableRows(result.rows)
  }

  const params = []
  let schemaFilter = ''
  if (schema) {
    params.push(schema)
    schemaFilter = 'and table_schema = ?'
  } else {
    params.push(config.database)
    schemaFilter = 'and table_schema = ?'
  }
  const [rows] = await connection.query(`
    select table_schema, table_name
    from information_schema.tables
    where table_type = 'BASE TABLE'
      and table_schema not in ('mysql', 'performance_schema', 'sys', 'information_schema')
      ${schemaFilter}
    order by table_schema, table_name
  `, params)
  return normalizeBackupTableRows(rows)
}

function normalizeBackupTableRows(rows = []) {
  return deduplicateBackupTables(rows.map((row) => ({
    schema: String(row.table_schema || row.TABLE_SCHEMA || row.schema || row.OWNER || '').trim(),
    name: String(row.table_name || row.TABLE_NAME || row.name || '').trim()
  })))
}

function deduplicateBackupTables(tables = []) {
  const seen = new Set()
  const output = []
  for (const table of tables) {
    if (!table.schema || !table.name) continue
    const key = `${table.schema}\u0000${table.name}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(table)
  }
  return output
}

async function beginDatabaseBackupSnapshot(connection, config, includeData) {
  if (!includeData) return { active: false, warning: '' }
  try {
    if (config.engine === 'postgres') {
      await connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      return { active: true, engine: 'postgres', warning: '' }
    }
    if (['mysql', 'mariadb'].includes(config.engine)) {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
      return { active: true, engine: config.engine, warning: '' }
    }
    if (isOracleLikeEngine(config.engine)) {
      await executeOracleLike(connection, config.engine, 'SET TRANSACTION READ ONLY')
      return { active: true, engine: config.engine, warning: '' }
    }
    return {
      active: false,
      warning: '当前 SQL Server 内置逻辑备份无法锁定跨表一致快照，请避免在备份过程中修改数据。'
    }
  } catch (error) {
    return {
      active: false,
      warning: `无法建立只读一致性快照：${error.message}。请避免在备份过程中修改数据。`
    }
  }
}

async function endDatabaseBackupSnapshot(connection, config, snapshot) {
  if (!snapshot?.active) return
  if (config.engine === 'postgres') {
    await connection.query('ROLLBACK')
    return
  }
  if (isOracleLikeEngine(config.engine)) {
    await connection.rollback()
    return
  }
  await connection.rollback()
}

async function writeDatabaseBackupChunk(stream, state, chunk) {
  if (state.streamError) throw state.streamError
  if (stream.destroyed) throw new Error('The backup output stream closed unexpectedly.')
  const text = String(chunk || '')
  if (!text) return
  state.bytes += Buffer.byteLength(text, 'utf8')
  if (!stream.write(text, 'utf8')) await once(stream, 'drain')
  if (state.streamError) throw state.streamError
}

function calculateLocalFileSha256(filePath, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    const totalBytes = Math.max(1, statSync(filePath).size)
    let processedBytes = 0
    input.on('data', (chunk) => {
      if (options.isCanceled?.()) {
        input.destroy(createSqlScriptCanceledError())
        return
      }
      hash.update(chunk)
      processedBytes += chunk.length
      options.onProgress?.(processedBytes, totalBytes)
    })
    input.once('error', rejectPromise)
    input.once('end', () => {
      options.onProgress?.(totalBytes, totalBytes, true)
      resolvePromise(hash.digest('hex'))
    })
  })
}

async function verifyOptionalSha256Sidecar(filePath, options = {}) {
  const checksumFile = `${filePath}.sha256`
  if (!existsSync(checksumFile)) return { checksum: '', checksumStatus: 'missing' }
  const checksum = await calculateLocalFileSha256(filePath, options)
  const expected = String(readFileSync(checksumFile, 'utf8')).match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase()
  if (!expected) throw new Error('The SHA-256 checksum file is invalid.')
  if (expected !== checksum.toLowerCase()) {
    throw new Error('The SHA-256 checksum does not match. The backup may be damaged or modified.')
  }
  return { checksum, checksumStatus: 'verified' }
}

function assertDatabaseBackupActive(session) {
  if (!session?.canceled) return
  const error = new Error('Backup canceled')
  error.code = 'OPS_FLOW_BACKUP_CANCELED'
  throw error
}

async function createBuiltInDatabaseBackup(connection, config, rawOptions, session) {
  const options = normalizeDatabaseBackupOptions(config, rawOptions)
  const includeStructure = options.content !== 'data'
  const includeData = options.content !== 'structure'
  const tables = await listDatabaseBackupTables(connection, config, options)
  if (!tables.length) throw new Error('当前备份范围内没有可导出的数据表。')

  const filePath = String(rawOptions.filePath || '')
  const partialPath = `${filePath}.${process.pid}.${Date.now()}.partial`
  const parentDirectory = dirname(filePath)
  if (!existsSync(parentDirectory)) mkdirSync(parentDirectory, { recursive: true })
  rmSync(partialPath, { force: true })

  const destinationStream = createWriteStream(partialPath, { mode: 0o600 })
  const stream = options.format === 'sql-gzip'
    ? createGzip({ level: 9 })
    : destinationStream
  const state = {
    bytes: 0,
    rows: 0,
    streamError: null,
    currentTable: '',
    currentTableIndex: 0,
    phase: ''
  }
  const rememberStreamError = (error) => {
    state.streamError = error
  }
  destinationStream.on('error', rememberStreamError)
  if (stream !== destinationStream) {
    stream.on('error', (error) => {
      rememberStreamError(error)
      destinationStream.destroy(error)
    })
    stream.pipe(destinationStream)
  }
  let snapshot = null
  let completed = false

  try {
    snapshot = await beginDatabaseBackupSnapshot(connection, config, includeData)
    sendDatabaseBackupProgress(session, {
      stage: 'preparing',
      status: 'running',
      tableCount: tables.length,
      tableIndex: 0,
      rows: 0,
      bytes: 0,
      warning: snapshot.warning,
      message: `准备导出 ${tables.length} 张表…`
    })

    const header = [
      '-- Ops Flow built-in logical database backup',
      `-- Created: ${new Date().toISOString()}`,
      `-- Engine: ${config.engine || 'mysql'}`,
      `-- Database: ${config.database || '-'}`,
      `-- Scope: ${options.scope}${options.schema ? ` (${options.schema})` : ''}`,
      `-- Content: ${options.content}`,
      `-- Format: ${options.format}`,
      '-- Restore this file only to a compatible database engine and review it before production use.',
      snapshot.warning ? `-- Warning: ${snapshot.warning}` : '-- Snapshot: read-only consistent snapshot requested',
      ''
    ].join('\n')
    await writeDatabaseBackupChunk(stream, state, `${header}\n`)
    if (['mysql', 'mariadb'].includes(config.engine)) {
      await writeDatabaseBackupChunk(stream, state, 'SET FOREIGN_KEY_CHECKS=0;\n\n')
    } else if (config.engine === 'sqlserver') {
      await writeDatabaseBackupChunk(stream, state, 'SET NOCOUNT ON;\n\n')
    }

    if (includeStructure) {
      for (let index = 0; index < tables.length; index += 1) {
        assertDatabaseBackupActive(session)
        const table = tables[index]
        state.currentTable = `${table.schema}.${table.name}`
        state.currentTableIndex = index + 1
        state.phase = '导出表结构'
        sendDatabaseBackupProgress(session, {
          stage: 'structure',
          status: 'running',
          tableCount: tables.length,
          tableIndex: index + 1,
          table: `${table.schema}.${table.name}`,
          rows: state.rows,
          bytes: state.bytes,
          message: `正在导出表结构：${table.schema}.${table.name}`
        })
        const ddl = await buildDatabaseBackupCreateTableSql(connection, config, table)
        await writeDatabaseBackupChunk(stream, state, `-- Structure: ${table.schema}.${table.name}\n${ddl.trim()}\n\n`)
      }
    }

    if (includeData) {
      for (let index = 0; index < tables.length; index += 1) {
        assertDatabaseBackupActive(session)
        const table = tables[index]
        state.currentTable = `${table.schema}.${table.name}`
        state.currentTableIndex = index + 1
        state.phase = '导出表数据'
        const orderColumns = await getDatabaseBackupOrderColumns(connection, config, table)
        const insertOptions = await getDatabaseBackupInsertOptions(connection, config, table)
        let offset = 0
        let tableRows = 0
        await writeDatabaseBackupChunk(stream, state, `-- Data: ${table.schema}.${table.name}\n`)
        if (insertOptions.identityInsert) {
          await writeDatabaseBackupChunk(stream, state, `SET IDENTITY_INSERT ${quoteSqlServerTable(table)} ON;\n`)
        }
        while (true) {
          assertDatabaseBackupActive(session)
          const rows = await selectDatabaseBackupPage(
            connection,
            config,
            table,
            offset,
            options.pageSize,
            orderColumns
          )
          for (const batch of buildBackupInsertSqlBatches(config, table, rows, insertOptions)) {
            await writeDatabaseBackupChunk(stream, state, `${batch}\n`)
          }
          offset += rows.length
          tableRows += rows.length
          state.rows += rows.length
          sendDatabaseBackupProgress(session, {
            stage: 'data',
            status: 'running',
            tableCount: tables.length,
            tableIndex: index + 1,
            table: `${table.schema}.${table.name}`,
            tableRows,
            rows: state.rows,
            bytes: state.bytes,
            message: `正在导出数据：${table.schema}.${table.name}（${tableRows} 行）`
          })
          if (rows.length < options.pageSize) break
        }
        if (insertOptions.identityInsert) {
          await writeDatabaseBackupChunk(stream, state, `SET IDENTITY_INSERT ${quoteSqlServerTable(table)} OFF;\n`)
        }
        await writeDatabaseBackupChunk(stream, state, '\n')
      }
    }

    if (includeStructure) {
      state.currentTable = ''
      state.currentTableIndex = tables.length
      state.phase = '导出数据库对象'
      sendDatabaseBackupProgress(session, {
        stage: 'objects',
        status: 'running',
        tableCount: tables.length,
        tableIndex: tables.length,
        rows: state.rows,
        bytes: state.bytes,
        message: '正在导出索引、外键、视图、触发器和存储程序…'
      })
      const objects = await buildDatabaseBackupAdditionalObjects(connection, config, options, tables)
      for (const object of objects) {
        assertDatabaseBackupActive(session)
        await writeDatabaseBackupChunk(stream, state, `-- ${object.label}\n${object.sql.trim()}\n\n`)
      }
    }

    if (['mysql', 'mariadb'].includes(config.engine)) {
      await writeDatabaseBackupChunk(stream, state, 'SET FOREIGN_KEY_CHECKS=1;\n')
    }
    await writeDatabaseBackupChunk(stream, state, `\n-- Backup completed: ${new Date().toISOString()}\n`)
    stream.end()
    await finished(destinationStream)
    if (state.streamError) throw state.streamError
    if (existsSync(filePath)) rmSync(filePath, { force: true })
    renameSync(partialPath, filePath)
    completed = true
    const checksum = await calculateLocalFileSha256(filePath)
    const finalBytes = statSync(filePath).size
    let checksumWarning = ''
    try {
      writeFileAtomically(`${filePath}.sha256`, `${checksum}  ${basename(filePath)}\n`)
    } catch (error) {
      checksumWarning = `备份文件已生成，但校验文件写入失败：${error.message}`
    }
    const finalWarning = [snapshot.warning, checksumWarning].filter(Boolean).join(' ')
    sendDatabaseBackupProgress(session, {
      stage: 'done',
      status: 'done',
      tableCount: tables.length,
      tableIndex: tables.length,
      rows: state.rows,
      bytes: finalBytes,
      path: filePath,
      checksum,
      warning: finalWarning,
      message: `备份完成：${tables.length} 张表，${state.rows} 行`
    })
    return {
      ok: true,
      path: filePath,
      tables: tables.length,
      rows: state.rows,
      bytes: finalBytes,
      checksum,
      objects: includeStructure ? true : false,
      warning: finalWarning
    }
  } catch (error) {
    if (!stream.destroyed) stream.destroy()
    if (!destinationStream.destroyed) destinationStream.destroy()
    rmSync(partialPath, { force: true })
    const canceled = error.code === 'OPS_FLOW_BACKUP_CANCELED'
    const failureMessage = state.currentTable
      ? `${state.phase}失败（${state.currentTable}）：${error.message}`
      : error.message
    sendDatabaseBackupProgress(session, {
      stage: canceled ? 'canceled' : 'error',
      status: canceled ? 'canceled' : 'failed',
      tableCount: tables.length,
      tableIndex: state.currentTableIndex,
      table: state.currentTable,
      rows: state.rows,
      bytes: state.bytes,
      message: canceled ? '备份已取消，残缺文件已删除。' : failureMessage
    })
    return {
      ok: false,
      canceled,
      message: canceled ? 'Backup canceled' : failureMessage
    }
  } finally {
    try {
      await endDatabaseBackupSnapshot(connection, config, snapshot)
    } catch {
      // The export is already complete or failed; closing the connection also releases the read-only transaction.
    }
    if (!completed) rmSync(partialPath, { force: true })
  }
}

function assertRedisBackupActive(session) {
  if (!session?.canceled) return
  const error = new Error('Redis backup canceled')
  error.code = 'OPS_FLOW_REDIS_BACKUP_CANCELED'
  throw error
}

async function createBuiltInRedisBackup(client, config, database, filePath, session) {
  const partialPath = `${filePath}.${process.pid}.${Date.now()}.partial`
  const parentDirectory = dirname(filePath)
  if (!existsSync(parentDirectory)) mkdirSync(parentDirectory, { recursive: true })
  rmSync(partialPath, { force: true })

  const stream = createWriteStream(partialPath, { encoding: 'utf8', mode: 0o600 })
  const state = { bytes: 0, rows: 0, streamError: null }
  stream.on('error', (error) => {
    state.streamError = error
  })
  let completed = false

  try {
    const [estimatedKeys, serverInfo] = await Promise.all([
      client.dbSize(),
      client.info('server')
    ])
    const redisVersion = String(serverInfo || '').match(/^redis_version:([^\r\n]+)/m)?.[1]?.trim() || 'unknown'
    const header = {
      kind: 'header',
      format: 'ops-flow-redis-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      database,
      redisVersion,
      source: String(config.name || config.host || 'redis'),
      encoding: 'redis-dump-base64'
    }
    await writeDatabaseBackupChunk(stream, state, `${JSON.stringify(header)}\n`)

    let cursor = '0'
    do {
      assertRedisBackupActive(session)
      const scan = await client.scan(cursor, { MATCH: '*', COUNT: 200 })
      cursor = String(scan.cursor)
      for (const key of scan.keys || []) {
        assertRedisBackupActive(session)
        const dump = await client.sendCommand(['DUMP', key], { returnBuffers: true })
        if (dump === null || dump === undefined) continue
        const pttl = Number(await client.sendCommand(['PTTL', key]))
        const record = {
          kind: 'key',
          key: Buffer.from(String(key), 'utf8').toString('base64'),
          dump: Buffer.from(dump).toString('base64'),
          pttl: Number.isFinite(pttl) ? pttl : -1,
          expiresAt: Number.isFinite(pttl) && pttl > 0 ? Date.now() + pttl : null
        }
        await writeDatabaseBackupChunk(stream, state, `${JSON.stringify(record)}\n`)
        state.rows += 1
      }
      sendRedisBackupProgress(session, {
        status: 'running',
        stage: 'data',
        keys: state.rows,
        totalKeys: Number(estimatedKeys || 0),
        bytes: state.bytes,
        message: `正在备份 Redis db${database}：${state.rows} 个键`
      })
    } while (cursor !== '0')

    await writeDatabaseBackupChunk(stream, state, `${JSON.stringify({
      kind: 'footer',
      completedAt: new Date().toISOString(),
      keys: state.rows
    })}\n`)
    stream.end()
    if (state.streamError) throw state.streamError
    if (!stream.writableFinished) await once(stream, 'finish')
    if (state.streamError) throw state.streamError
    if (existsSync(filePath)) rmSync(filePath, { force: true })
    renameSync(partialPath, filePath)
    completed = true
    const checksum = await calculateLocalFileSha256(filePath)
    const finalBytes = statSync(filePath).size
    let checksumWarning = ''
    try {
      writeFileAtomically(`${filePath}.sha256`, `${checksum}  ${basename(filePath)}\n`)
    } catch (error) {
      checksumWarning = `Redis 备份已生成，但校验文件写入失败：${error.message}`
    }
    sendRedisBackupProgress(session, {
      status: 'done',
      stage: 'done',
      keys: state.rows,
      totalKeys: Number(estimatedKeys || 0),
      bytes: finalBytes,
      path: filePath,
      checksum,
      warning: checksumWarning,
      message: `Redis db${database} 备份完成：${state.rows} 个键`
    })
    return {
      ok: true,
      path: filePath,
      keys: state.rows,
      bytes: finalBytes,
      checksum,
      warning: checksumWarning
    }
  } catch (error) {
    if (!stream.destroyed) stream.destroy()
    rmSync(partialPath, { force: true })
    const canceled = error.code === 'OPS_FLOW_REDIS_BACKUP_CANCELED'
    sendRedisBackupProgress(session, {
      status: canceled ? 'canceled' : 'failed',
      stage: canceled ? 'canceled' : 'error',
      keys: state.rows,
      bytes: state.bytes,
      message: canceled ? 'Redis 备份已取消，残缺文件已删除。' : error.message
    })
    return {
      ok: false,
      canceled,
      message: canceled ? 'Backup canceled' : error.message
    }
  } finally {
    if (!completed) rmSync(partialPath, { force: true })
  }
}

function decodeRedisBackupBase64(value, label, allowEmpty = false) {
  const source = String(value || '')
  if ((!source && !allowEmpty) || (source && (!/^[A-Za-z0-9+/]+={0,2}$/.test(source) || source.length % 4 !== 0))) {
    throw new Error(`Invalid ${label} data in the Redis backup.`)
  }
  return Buffer.from(source, 'base64')
}

async function readRedisBackupRecords(filePath, onRecord) {
  const input = createReadStream(filePath)
  const reader = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  for await (const line of reader) {
    lineNumber += 1
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid Redis backup JSON on line ${lineNumber}: ${error.message}`)
    }
    await onRecord(record, lineNumber)
  }
}

async function inspectRedisBackupFile(filePath) {
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error('The selected Redis backup no longer exists.')
  }
  let header = null
  let footer = null
  let keys = 0
  await readRedisBackupRecords(filePath, async (record, lineNumber) => {
    if (!header) {
      if (record?.kind !== 'header' || record?.format !== 'ops-flow-redis-backup' || Number(record?.version) !== 1) {
        throw new Error('This is not a supported Ops Flow Redis backup.')
      }
      header = record
      return
    }
    if (record?.kind === 'key') {
      decodeRedisBackupBase64(record.key, `key on line ${lineNumber}`, true)
      decodeRedisBackupBase64(record.dump, `DUMP payload on line ${lineNumber}`)
      keys += 1
      return
    }
    if (record?.kind === 'footer') {
      footer = record
      return
    }
    throw new Error(`Unsupported Redis backup record on line ${lineNumber}.`)
  })
  if (!header) throw new Error('The Redis backup is empty.')
  if (!footer) throw new Error('The Redis backup is incomplete: footer is missing.')
  if (Number(footer.keys) !== keys) {
    throw new Error(`The Redis backup is incomplete: expected ${Number(footer.keys)} key(s), found ${keys}.`)
  }
  const checksum = await calculateLocalFileSha256(filePath)
  let checksumStatus = 'missing'
  const checksumFile = `${filePath}.sha256`
  if (existsSync(checksumFile)) {
    const expected = String(readFileSync(checksumFile, 'utf8')).match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase()
    if (!expected) throw new Error('The Redis backup checksum file is invalid.')
    if (expected !== checksum.toLowerCase()) throw new Error('The Redis backup checksum does not match. The file may be damaged or modified.')
    checksumStatus = 'verified'
  }
  return {
    path: filePath,
    name: basename(filePath),
    size: statSync(filePath).size,
    sizeLabel: formatBytes(statSync(filePath).size),
    header,
    footer,
    keys,
    checksum,
    checksumStatus
  }
}

function assertRedisRestoreActive(session) {
  if (!session?.canceled) return
  const error = new Error('Redis restore canceled')
  error.code = 'OPS_FLOW_REDIS_RESTORE_CANCELED'
  throw error
}

async function restoreBuiltInRedisBackup(client, database, details, conflict, session) {
  const state = { processed: 0, restored: 0, skipped: 0, expired: 0 }
  try {
    await readRedisBackupRecords(details.path, async (record) => {
      if (record.kind !== 'key') return
      assertRedisRestoreActive(session)
      const key = decodeRedisBackupBase64(record.key, 'key', true)
      const dump = decodeRedisBackupBase64(record.dump, 'DUMP payload')
      let ttl = -1
      if (Number.isFinite(Number(record.expiresAt)) && Number(record.expiresAt) > 0) {
        ttl = Math.ceil(Number(record.expiresAt) - Date.now())
      } else if (Number.isFinite(Number(record.pttl)) && Number(record.pttl) > 0) {
        ttl = Math.ceil(Number(record.pttl))
      }
      state.processed += 1
      if (ttl === 0 || (Number(record.expiresAt) > 0 && ttl < 1)) {
        state.expired += 1
      } else {
        if (conflict === 'skip') {
          const exists = Number(await client.sendCommand(['EXISTS', key]))
          if (exists > 0) {
            state.skipped += 1
            sendRedisRestoreProgress(session, {
              status: 'running',
              stage: 'data',
              keys: state.processed,
              totalKeys: details.keys,
              restored: state.restored,
              skipped: state.skipped,
              expired: state.expired,
              message: `正在恢复 Redis db${database}：${state.processed}/${details.keys}`
            })
            return
          }
        }
        const args = ['RESTORE', key, String(ttl > 0 ? ttl : 0), dump]
        if (conflict === 'replace') args.push('REPLACE')
        await client.sendCommand(args)
        state.restored += 1
      }
      sendRedisRestoreProgress(session, {
        status: 'running',
        stage: 'data',
        keys: state.processed,
        totalKeys: details.keys,
        restored: state.restored,
        skipped: state.skipped,
        expired: state.expired,
        message: `正在恢复 Redis db${database}：${state.processed}/${details.keys}`
      })
    })
    assertRedisRestoreActive(session)
    sendRedisRestoreProgress(session, {
      status: 'done',
      stage: 'done',
      keys: state.processed,
      totalKeys: details.keys,
      restored: state.restored,
      skipped: state.skipped,
      expired: state.expired,
      message: `Redis db${database} 恢复完成：写入 ${state.restored} 个键`
    })
    return { ok: true, ...state, checksumStatus: details.checksumStatus }
  } catch (error) {
    const canceled = error.code === 'OPS_FLOW_REDIS_RESTORE_CANCELED'
    sendRedisRestoreProgress(session, {
      status: canceled ? 'canceled' : 'failed',
      stage: canceled ? 'canceled' : 'error',
      keys: state.processed,
      totalKeys: details.keys,
      restored: state.restored,
      skipped: state.skipped,
      expired: state.expired,
      message: canceled ? 'Redis 恢复已取消。已写入的键不会自动回滚。' : error.message
    })
    return { ok: false, canceled, ...state, message: canceled ? 'Redis restore canceled' : error.message }
  }
}

function databaseBackupRowValue(row, ...names) {
  for (const name of names) {
    if (row?.[name] !== undefined && row?.[name] !== null) return row[name]
    const found = Object.keys(row || {}).find((key) => key.toLowerCase() === String(name).toLowerCase())
    if (found && row[found] !== undefined && row[found] !== null) return row[found]
  }
  return undefined
}

function databaseBackupSchema(config, options, tables) {
  return String(options.schema || tables[0]?.schema || config.database || config.username || '').trim()
}

function sanitizeMysqlCreateDdl(ddl, sourceSchema = '') {
  let result = String(ddl || '').replace(/\bDEFINER\s*=\s*(?:`[^`]*`|'[^']*'|[^\s]+)@(?:`[^`]*`|'[^']*'|[^\s]+)\s*/i, '')
  if (sourceSchema) {
    const escapedSchema = String(sourceSchema).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/`/g, '``')
    result = result.replace(new RegExp(`\\\`${escapedSchema}\\\`\\.`, 'gi'), '')
  }
  return result
}

async function buildDatabaseBackupAdditionalObjects(connection, config, options, tables) {
  if (['mysql', 'mariadb'].includes(config.engine)) {
    return buildMysqlBackupAdditionalObjects(connection, config, options, tables)
  }
  if (options.scope === 'database' && ['postgres', 'sqlserver', 'oracle', 'dm'].includes(config.engine)) {
    const groups = new Map()
    for (const table of tables) {
      if (!groups.has(table.schema)) groups.set(table.schema, [])
      groups.get(table.schema).push(table)
    }
    const objects = []
    for (const [schema, schemaTables] of groups) {
      const schemaOptions = { ...options, scope: 'schema', schema }
      if (config.engine === 'postgres') {
        objects.push(...await buildPostgresBackupAdditionalObjects(connection, schemaOptions, schemaTables))
      } else if (config.engine === 'sqlserver') {
        objects.push(...await buildSqlServerBackupAdditionalObjects(connection, schemaOptions, schemaTables))
      } else {
        objects.push(...await buildOracleLikeBackupAdditionalObjects(connection, config, schemaOptions, schemaTables))
      }
    }
    return objects
  }
  if (config.engine === 'postgres') {
    return buildPostgresBackupAdditionalObjects(connection, options, tables)
  }
  if (config.engine === 'sqlserver') {
    return buildSqlServerBackupAdditionalObjects(connection, options, tables)
  }
  if (isOracleLikeEngine(config.engine)) {
    return buildOracleLikeBackupAdditionalObjects(connection, config, options, tables)
  }
  return []
}

async function buildMysqlBackupAdditionalObjects(connection, config, options, tables) {
  const objects = []
  const schema = databaseBackupSchema(config, options, tables)
  const selectedNames = new Set(tables.map((table) => table.name))

  if (options.scope !== 'selected') {
    const [routineRows] = await connection.query(`
      select ROUTINE_NAME as routine_name, ROUTINE_TYPE as routine_type
      from information_schema.ROUTINES
      where ROUTINE_SCHEMA = ?
      order by ROUTINE_TYPE, ROUTINE_NAME
    `, [schema])
    for (const row of routineRows) {
      const name = databaseBackupRowValue(row, 'routine_name')
      const type = String(databaseBackupRowValue(row, 'routine_type') || '').toUpperCase()
      const [createRows] = await connection.query(`SHOW CREATE ${type} ${quoteDatabaseIdentifier({ engine: 'mysql' }, schema)}.${quoteDatabaseIdentifier({ engine: 'mysql' }, name)}`)
      const ddl = Object.entries(createRows[0] || {}).find(([key]) => /^Create /i.test(key))?.[1]
      if (ddl) objects.push({ label: `${type}: ${schema}.${name}`, sql: `DELIMITER $$\n${sanitizeMysqlCreateDdl(ddl, schema)}$$\nDELIMITER ;` })
    }

    const [viewRows] = await connection.query(`
      select TABLE_NAME as view_name
      from information_schema.VIEWS
      where TABLE_SCHEMA = ?
      order by TABLE_NAME
    `, [schema])
    for (const row of viewRows) {
      const name = databaseBackupRowValue(row, 'view_name')
      const [createRows] = await connection.query(`SHOW CREATE VIEW ${quoteDatabaseIdentifier({ engine: 'mysql' }, schema)}.${quoteDatabaseIdentifier({ engine: 'mysql' }, name)}`)
      const ddl = databaseBackupRowValue(createRows[0], 'Create View')
      if (ddl) objects.push({ label: `View: ${schema}.${name}`, sql: `${sanitizeMysqlCreateDdl(ddl, schema)};` })
    }
  }

  const [triggerRows] = await connection.query(`
    select TRIGGER_NAME as trigger_name, EVENT_OBJECT_TABLE as table_name
    from information_schema.TRIGGERS
    where TRIGGER_SCHEMA = ?
    order by TRIGGER_NAME
  `, [schema])
  for (const row of triggerRows) {
    const tableName = String(databaseBackupRowValue(row, 'table_name') || '')
    if (!selectedNames.has(tableName)) continue
    const name = databaseBackupRowValue(row, 'trigger_name')
    const [createRows] = await connection.query(`SHOW CREATE TRIGGER ${quoteDatabaseIdentifier({ engine: 'mysql' }, schema)}.${quoteDatabaseIdentifier({ engine: 'mysql' }, name)}`)
    const ddl = databaseBackupRowValue(createRows[0], 'SQL Original Statement', 'Create Trigger')
    if (ddl) objects.push({ label: `Trigger: ${schema}.${name}`, sql: `DELIMITER $$\n${sanitizeMysqlCreateDdl(ddl, schema)}$$\nDELIMITER ;` })
  }
  return objects
}

async function buildPostgresBackupAdditionalObjects(connection, options, tables) {
  const objects = []
  for (const table of tables) {
    const constraints = await connection.query(`
      select c.conname as constraint_name, pg_get_constraintdef(c.oid, true) as definition
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = $1 and r.relname = $2 and c.contype in ('f', 'u', 'c', 'x')
      order by c.conname
    `, [table.schema, table.name])
    for (const row of constraints.rows) {
      objects.push({
        label: `Constraint: ${table.schema}.${row.constraint_name}`,
        sql: `ALTER TABLE ${quotePostgresTable(table)} ADD CONSTRAINT ${quoteDatabaseIdentifier({ engine: 'postgres' }, row.constraint_name)} ${row.definition};`
      })
    }
    const indexes = await connection.query(`
      select i.indexname, i.indexdef
      from pg_indexes i
      where i.schemaname = $1 and i.tablename = $2
        and not exists (
          select 1
          from pg_class idx
          join pg_constraint c on c.conindid = idx.oid
          where idx.relname = i.indexname
        )
      order by i.indexname
    `, [table.schema, table.name])
    for (const row of indexes.rows) {
      objects.push({ label: `Index: ${table.schema}.${row.indexname}`, sql: `${String(row.indexdef || '').replace(/;+\s*$/, '')};` })
    }
  }

  if (options.scope !== 'selected') {
    const schema = databaseBackupSchema({}, options, tables)
    const routines = await connection.query(`
      select p.oid, p.proname, pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1
      order by p.proname, p.oid
    `, [schema])
    for (const row of routines.rows) {
      objects.push({ label: `Routine: ${schema}.${row.proname}`, sql: String(row.definition || '').trim() })
    }
    const views = await connection.query(`
      select viewname, definition
      from pg_views
      where schemaname = $1
      order by viewname
    `, [schema])
    for (const row of views.rows) {
      objects.push({
        label: `View: ${schema}.${row.viewname}`,
        sql: `CREATE OR REPLACE VIEW ${quotePostgresTable({ schema, name: row.viewname })} AS\n${String(row.definition || '').replace(/;+\s*$/, '')};`
      })
    }
  }

  for (const table of tables) {
    const triggers = await connection.query(`
      select t.tgname as trigger_name, pg_get_triggerdef(t.oid, true) as definition
      from pg_trigger t
      join pg_class r on r.oid = t.tgrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = $1 and r.relname = $2 and not t.tgisinternal
      order by t.tgname
    `, [table.schema, table.name])
    for (const row of triggers.rows) {
      objects.push({ label: `Trigger: ${table.schema}.${row.trigger_name}`, sql: `${String(row.definition || '').replace(/;+\s*$/, '')};` })
    }
  }
  return objects
}

function groupSqlServerMetadataRows(rows, keyName) {
  const groups = new Map()
  for (const row of rows || []) {
    const key = String(databaseBackupRowValue(row, keyName) || '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return groups
}

async function buildSqlServerBackupAdditionalObjects(connection, options, tables) {
  const objects = []
  for (const table of tables) {
    const request = connection.request()
    request.input('schema', mssql.NVarChar, table.schema)
    request.input('name', mssql.NVarChar, table.name)
    const indexResult = await request.query(`
      select
        i.name as index_name, i.is_unique, i.type_desc, i.filter_definition,
        c.name as column_name, ic.is_descending_key, ic.is_included_column,
        ic.key_ordinal, ic.index_column_id
      from sys.indexes i
      join sys.tables t on t.object_id = i.object_id
      join sys.schemas s on s.schema_id = t.schema_id
      join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
      join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
      where s.name = @schema and t.name = @name
        and i.is_primary_key = 0 and i.is_hypothetical = 0 and i.name is not null
      order by i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id
    `)
    for (const [indexName, rows] of groupSqlServerMetadataRows(indexResult.recordset, 'index_name')) {
      const first = rows[0]
      const keyColumns = rows
        .filter((row) => !databaseBackupRowValue(row, 'is_included_column'))
        .map((row) => `${quoteSqlServerIdentifier(databaseBackupRowValue(row, 'column_name'))}${databaseBackupRowValue(row, 'is_descending_key') ? ' DESC' : ' ASC'}`)
      const included = rows
        .filter((row) => databaseBackupRowValue(row, 'is_included_column'))
        .map((row) => quoteSqlServerIdentifier(databaseBackupRowValue(row, 'column_name')))
      if (!keyColumns.length) continue
      const type = String(databaseBackupRowValue(first, 'type_desc') || '').toUpperCase().startsWith('CLUSTERED')
        ? 'CLUSTERED '
        : 'NONCLUSTERED '
      const unique = databaseBackupRowValue(first, 'is_unique') ? 'UNIQUE ' : ''
      const includeSql = included.length ? ` INCLUDE (${included.join(', ')})` : ''
      const filter = databaseBackupRowValue(first, 'filter_definition')
      objects.push({
        label: `Index: ${table.schema}.${indexName}`,
        sql: `CREATE ${unique}${type}INDEX ${quoteSqlServerIdentifier(indexName)} ON ${quoteSqlServerTable(table)} (${keyColumns.join(', ')})${includeSql}${filter ? ` WHERE ${filter}` : ''};`
      })
    }

    const fkRequest = connection.request()
    fkRequest.input('schema', mssql.NVarChar, table.schema)
    fkRequest.input('name', mssql.NVarChar, table.name)
    const fkResult = await fkRequest.query(`
      select
        fk.name as fk_name, pc.name as parent_column, rs.name as referenced_schema,
        rt.name as referenced_table, rc.name as referenced_column,
        fk.delete_referential_action_desc as delete_action,
        fk.update_referential_action_desc as update_action,
        fkc.constraint_column_id
      from sys.foreign_keys fk
      join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
      join sys.tables pt on pt.object_id = fk.parent_object_id
      join sys.schemas ps on ps.schema_id = pt.schema_id
      join sys.columns pc on pc.object_id = pt.object_id and pc.column_id = fkc.parent_column_id
      join sys.tables rt on rt.object_id = fk.referenced_object_id
      join sys.schemas rs on rs.schema_id = rt.schema_id
      join sys.columns rc on rc.object_id = rt.object_id and rc.column_id = fkc.referenced_column_id
      where ps.name = @schema and pt.name = @name
      order by fk.name, fkc.constraint_column_id
    `)
    for (const [fkName, rows] of groupSqlServerMetadataRows(fkResult.recordset, 'fk_name')) {
      const first = rows[0]
      const parentColumns = rows.map((row) => quoteSqlServerIdentifier(databaseBackupRowValue(row, 'parent_column')))
      const referencedColumns = rows.map((row) => quoteSqlServerIdentifier(databaseBackupRowValue(row, 'referenced_column')))
      const referencedTable = quoteSqlServerTable({
        schema: databaseBackupRowValue(first, 'referenced_schema'),
        name: databaseBackupRowValue(first, 'referenced_table')
      })
      const deleteAction = String(databaseBackupRowValue(first, 'delete_action') || 'NO_ACTION').replace(/_/g, ' ')
      const updateAction = String(databaseBackupRowValue(first, 'update_action') || 'NO_ACTION').replace(/_/g, ' ')
      objects.push({
        label: `Foreign key: ${table.schema}.${fkName}`,
        sql: `ALTER TABLE ${quoteSqlServerTable(table)} ADD CONSTRAINT ${quoteSqlServerIdentifier(fkName)} FOREIGN KEY (${parentColumns.join(', ')}) REFERENCES ${referencedTable} (${referencedColumns.join(', ')}) ON DELETE ${deleteAction} ON UPDATE ${updateAction};`
      })
    }

    const checkRequest = connection.request()
    checkRequest.input('schema', mssql.NVarChar, table.schema)
    checkRequest.input('name', mssql.NVarChar, table.name)
    const checkResult = await checkRequest.query(`
      select cc.name as constraint_name, cc.definition
      from sys.check_constraints cc
      join sys.tables t on t.object_id = cc.parent_object_id
      join sys.schemas s on s.schema_id = t.schema_id
      where s.name = @schema and t.name = @name
      order by cc.name
    `)
    for (const row of checkResult.recordset || []) {
      objects.push({
        label: `Check constraint: ${table.schema}.${row.constraint_name}`,
        sql: `ALTER TABLE ${quoteSqlServerTable(table)} ADD CONSTRAINT ${quoteSqlServerIdentifier(row.constraint_name)} CHECK ${row.definition};`
      })
    }
  }

  const schema = databaseBackupSchema({}, options, tables)
  if (options.scope !== 'selected') {
    const moduleRequest = connection.request()
    moduleRequest.input('schema', mssql.NVarChar, schema)
    const modules = await moduleRequest.query(`
      select o.name as object_name, o.type_desc, m.definition
      from sys.objects o
      join sys.schemas s on s.schema_id = o.schema_id
      join sys.sql_modules m on m.object_id = o.object_id
      where s.name = @schema
        and o.type in ('P', 'FN', 'IF', 'TF', 'V')
      order by case when o.type in ('P', 'FN', 'IF', 'TF') then 0 else 1 end, o.name
    `)
    for (const row of modules.recordset || []) {
      objects.push({
        label: `${row.type_desc}: ${schema}.${row.object_name}`,
        sql: `${String(row.definition || '').trim()}\nGO`
      })
    }
  }
  for (const table of tables) {
    const triggerRequest = connection.request()
    triggerRequest.input('schema', mssql.NVarChar, table.schema)
    triggerRequest.input('name', mssql.NVarChar, table.name)
    const triggers = await triggerRequest.query(`
      select tr.name as trigger_name, m.definition
      from sys.triggers tr
      join sys.tables t on t.object_id = tr.parent_id
      join sys.schemas s on s.schema_id = t.schema_id
      join sys.sql_modules m on m.object_id = tr.object_id
      where s.name = @schema and t.name = @name
      order by tr.name
    `)
    for (const row of triggers.recordset || []) {
      objects.push({ label: `Trigger: ${table.schema}.${row.trigger_name}`, sql: `${String(row.definition || '').trim()}\nGO` })
    }
  }
  return objects
}

async function readOracleLikeMetadataDdl(connection, config, objectType, objectName, owner) {
  const lengthResult = await executeOracleLike(connection, config.engine, `
    select DBMS_LOB.GETLENGTH(DBMS_METADATA.GET_DDL(:objectType, :objectName, :owner)) as ddl_length
    from dual
  `, { objectType, objectName, owner })
  const total = Number(databaseBackupRowValue(lengthResult.rows?.[0], 'ddl_length') || 0)
  if (!total) throw new Error(`Unable to read ${objectType} metadata for ${owner}.${objectName}.`)
  let ddl = ''
  for (let offset = 1; offset <= total; offset += 30000) {
    const chunkResult = await executeOracleLike(connection, config.engine, `
      select DBMS_LOB.SUBSTR(DBMS_METADATA.GET_DDL(:objectType, :objectName, :owner), 30000, :ddlOffset) as ddl_chunk
      from dual
    `, { objectType, objectName, owner, ddlOffset: offset })
    ddl += String(databaseBackupRowValue(chunkResult.rows?.[0], 'ddl_chunk') || '')
  }
  return ddl.trim()
}

async function buildOracleLikeBackupAdditionalObjects(connection, config, options, tables) {
  const objects = []
  const owner = databaseBackupSchema(config, options, tables).toUpperCase()
  const selectedNames = new Set(tables.map((table) => String(table.name).toUpperCase()))
  const indexResult = await executeOracleLike(connection, config.engine, `
    select i.INDEX_NAME as object_name
    from ALL_INDEXES i
    where i.OWNER = :owner
      and i.TABLE_NAME in (${tables.map((_table, index) => `:table${index}`).join(', ')})
      and not exists (
        select 1 from ALL_CONSTRAINTS c
        where c.OWNER = i.OWNER and c.INDEX_NAME = i.INDEX_NAME
      )
    order by i.INDEX_NAME
  `, Object.fromEntries([['owner', owner], ...tables.map((table, index) => [`table${index}`, String(table.name).toUpperCase()])]))
  for (const row of indexResult.rows || []) {
    const name = databaseBackupRowValue(row, 'object_name')
    const ddl = await readOracleLikeMetadataDdl(connection, config, 'INDEX', name, owner)
    objects.push({ label: `Index: ${owner}.${name}`, sql: `${ddl.replace(/;+\s*$/, '')};` })
  }

  const constraintResult = await executeOracleLike(connection, config.engine, `
    select CONSTRAINT_NAME as object_name, CONSTRAINT_TYPE as constraint_type
    from ALL_CONSTRAINTS
    where OWNER = :owner
      and TABLE_NAME in (${tables.map((_table, index) => `:table${index}`).join(', ')})
      and (
        CONSTRAINT_TYPE in ('R', 'U')
        or (CONSTRAINT_TYPE = 'C' and GENERATED = 'USER NAME')
      )
    order by CONSTRAINT_NAME
  `, Object.fromEntries([['owner', owner], ...tables.map((table, index) => [`table${index}`, String(table.name).toUpperCase()])]))
  for (const row of constraintResult.rows || []) {
    const name = databaseBackupRowValue(row, 'object_name')
    const constraintType = String(databaseBackupRowValue(row, 'constraint_type') || '')
    const metadataType = constraintType === 'R' ? 'REF_CONSTRAINT' : 'CONSTRAINT'
    const ddl = await readOracleLikeMetadataDdl(connection, config, metadataType, name, owner)
    objects.push({
      label: `${constraintType === 'R' ? 'Foreign key' : 'Constraint'}: ${owner}.${name}`,
      sql: `${ddl.replace(/;+\s*$/, '')};`
    })
  }

  if (options.scope !== 'selected') {
    const routineResult = await executeOracleLike(connection, config.engine, `
      select OBJECT_NAME as object_name, OBJECT_TYPE as object_type
      from ALL_OBJECTS
      where OWNER = :owner
        and OBJECT_TYPE in ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY')
      order by case OBJECT_TYPE when 'PACKAGE' then 0 when 'PACKAGE BODY' then 1 else 2 end, OBJECT_NAME
    `, { owner })
    for (const row of routineResult.rows || []) {
      const name = databaseBackupRowValue(row, 'object_name')
      const displayType = String(databaseBackupRowValue(row, 'object_type') || '')
      const metadataType = displayType.replace(' ', '_')
      const ddl = await readOracleLikeMetadataDdl(connection, config, metadataType, name, owner)
      objects.push({ label: `${displayType}: ${owner}.${name}`, sql: `${ddl.replace(/\/?\s*$/, '')}\n/` })
    }
    const viewResult = await executeOracleLike(connection, config.engine, `
      select VIEW_NAME as object_name
      from ALL_VIEWS
      where OWNER = :owner
      order by VIEW_NAME
    `, { owner })
    for (const row of viewResult.rows || []) {
      const name = databaseBackupRowValue(row, 'object_name')
      const ddl = await readOracleLikeMetadataDdl(connection, config, 'VIEW', name, owner)
      objects.push({ label: `View: ${owner}.${name}`, sql: `${ddl.replace(/;+\s*$/, '')};` })
    }
  }

  const triggerResult = await executeOracleLike(connection, config.engine, `
    select TRIGGER_NAME as object_name, TABLE_NAME as table_name
    from ALL_TRIGGERS
    where OWNER = :owner
    order by TRIGGER_NAME
  `, { owner })
  for (const row of triggerResult.rows || []) {
    if (options.scope === 'selected' && !selectedNames.has(String(databaseBackupRowValue(row, 'table_name') || '').toUpperCase())) continue
    const name = databaseBackupRowValue(row, 'object_name')
    const ddl = await readOracleLikeMetadataDdl(connection, config, 'TRIGGER', name, owner)
    objects.push({ label: `Trigger: ${owner}.${name}`, sql: `${ddl.replace(/\/?\s*$/, '')}\n/` })
  }
  return objects
}

async function buildDatabaseBackupCreateTableSql(connection, config, table) {
  if (config.engine === 'postgres') return buildPostgresCreateTableSql(connection, table)
  if (config.engine === 'sqlserver') return buildSqlServerCreateTableSql(connection, table)
  if (isOracleLikeEngine(config.engine)) return buildOracleLikeCreateTableSql(connection, config, table)
  const [createRows] = await connection.query(`SHOW CREATE TABLE ${quoteMysqlTable(table)}`)
  const ddl = createRows[0]?.['Create Table'] || createRows[0]?.['Create View'] || ''
  if (!ddl) throw new Error(`无法读取表结构：${table.schema}.${table.name}`)
  return `${ddl};`
}

async function getDatabasePrimaryKeyColumns(connection, config, table) {
  let columns = []
  try {
    if (config.engine === 'postgres') {
      const result = await connection.query(`
        select kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on tc.constraint_name = kcu.constraint_name
         and tc.constraint_schema = kcu.constraint_schema
        where tc.constraint_type = 'PRIMARY KEY'
          and tc.table_schema = $1
          and tc.table_name = $2
        order by kcu.ordinal_position
      `, [table.schema, table.name])
      columns = result.rows.map((row) => row.column_name)
    } else if (config.engine === 'sqlserver') {
      const request = connection.request()
      request.input('schema', mssql.NVarChar, table.schema)
      request.input('name', mssql.NVarChar, table.name)
      const result = await request.query(`
        select kcu.COLUMN_NAME as column_name
        from INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        join INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          on tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         and tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        where tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          and tc.TABLE_SCHEMA = @schema
          and tc.TABLE_NAME = @name
        order by kcu.ORDINAL_POSITION
      `)
      columns = (result.recordset || []).map((row) => row.column_name || row.COLUMN_NAME)
    } else if (isOracleLikeEngine(config.engine)) {
      const result = await executeOracleLike(connection, config.engine, `
        select cols.COLUMN_NAME as column_name
        from ALL_CONSTRAINTS cons
        join ALL_CONS_COLUMNS cols
          on cons.OWNER = cols.OWNER
         and cons.CONSTRAINT_NAME = cols.CONSTRAINT_NAME
        where cons.CONSTRAINT_TYPE = 'P'
          and cons.OWNER = :schema
          and cons.TABLE_NAME = :name
        order by cols.POSITION
      `, { schema: table.schema, name: table.name })
      columns = (result.rows || []).map((row) => row.column_name || row.COLUMN_NAME)
    } else {
      const [rows] = await connection.query(`
        select COLUMN_NAME as column_name
        from information_schema.KEY_COLUMN_USAGE
        where CONSTRAINT_NAME = 'PRIMARY'
          and TABLE_SCHEMA = ?
          and TABLE_NAME = ?
        order by ORDINAL_POSITION
      `, [table.schema, table.name])
      columns = rows.map((row) => row.column_name || row.COLUMN_NAME)
    }
  } catch {
    columns = []
  }

  return columns.map((column) => String(column || '').trim()).filter(Boolean)
}

async function getDatabaseBackupOrderColumns(connection, config, table) {
  const primaryKeyColumns = await getDatabasePrimaryKeyColumns(connection, config, table)
  if (primaryKeyColumns.length) return primaryKeyColumns

  const fallbackColumns = await getTableColumns(connection, config, table)
  const firstColumn = fallbackColumns
    .map((column) => String(
      typeof column === 'string'
        ? column
        : column?.name || column?.column_name || column?.COLUMN_NAME || ''
    ).trim())
    .find(Boolean)
  return firstColumn ? [firstColumn] : []
}

async function getDatabaseBackupInsertOptions(connection, config, table) {
  if (config.engine === 'postgres') {
    const result = await connection.query(`
      select 1
      from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_identity = 'YES'
      limit 1
    `, [table.schema, table.name])
    return { overridingSystemValue: result.rows.length > 0, identityInsert: false }
  }
  if (config.engine === 'sqlserver') {
    const request = connection.request()
    request.input('schema', mssql.NVarChar, table.schema)
    request.input('name', mssql.NVarChar, table.name)
    const result = await request.query(`
      select top 1 1 as has_identity
      from sys.identity_columns c
      join sys.tables t on t.object_id = c.object_id
      join sys.schemas s on s.schema_id = t.schema_id
      where s.name = @schema and t.name = @name
    `)
    return { overridingSystemValue: false, identityInsert: Boolean(result.recordset?.length) }
  }
  return { overridingSystemValue: false, identityInsert: false }
}

async function selectDatabaseBackupPage(connection, config, table, offset, limit, orderColumns = []) {
  const orderSql = orderColumns.length
    ? orderColumns.map((column) => quoteDatabaseIdentifier(config, column)).join(', ')
    : ''
  if (config.engine === 'postgres') {
    const result = await connection.query(
      `select * from ${quotePostgresTable(table)}${orderSql ? ` order by ${orderSql}` : ''} offset $1 limit $2`,
      [offset, limit]
    )
    return result.rows
  }
  if (config.engine === 'sqlserver') {
    const request = connection.request()
    request.input('offset', mssql.Int, offset)
    request.input('limit', mssql.Int, limit)
    const result = await request.query(`
      select * from ${quoteSqlServerTable(table)}
      order by ${orderSql || '(select null)'}
      offset @offset rows fetch next @limit rows only
    `)
    return result.recordset || []
  }
  if (isOracleLikeEngine(config.engine)) {
    const result = await executeOracleLike(
      connection,
      config.engine,
      `select * from ${quoteOracleLikeTable(table)}${orderSql ? ` order by ${orderSql}` : ''} offset :offset rows fetch next :limit rows only`,
      { offset, limit }
    )
    return result.rows || []
  }
  const [rows] = await connection.query(
    `select * from ${quoteMysqlTable(table)}${orderSql ? ` order by ${orderSql}` : ''} limit ? offset ?`,
    [limit, offset]
  )
  return rows
}

function buildBackupInsertSql(config, table, row, options = {}) {
  const columns = Object.keys(row)
  const tableName = quotePortableBackupTable(config, table)
  const columnSql = columns.map((column) => quoteDatabaseIdentifier(config, column)).join(', ')
  const values = columns.map((column) => databaseBackupSqlLiteral(config, row[column])).join(', ')
  const override = options.overridingSystemValue ? ' OVERRIDING SYSTEM VALUE' : ''
  return `INSERT INTO ${tableName} (${columnSql})${override} VALUES (${values});`
}

function buildBackupInsertSqlBatches(config, table, rows, options = {}) {
  if (!rows.length) return []
  if (!supportsExtendedInsertBatches(config.engine)) {
    return rows.map((row) => buildBackupInsertSql(config, table, row, options))
  }
  const columns = Object.keys(rows[0])
  const columnSignature = columns.join('\u0000')
  if (!columns.length || rows.some((row) => Object.keys(row).join('\u0000') !== columnSignature)) {
    return rows.map((row) => buildBackupInsertSql(config, table, row, options))
  }
  const tableName = quotePortableBackupTable(config, table)
  const columnSql = columns.map((column) => quoteDatabaseIdentifier(config, column)).join(', ')
  const override = options.overridingSystemValue ? ' OVERRIDING SYSTEM VALUE' : ''
  const prefix = `INSERT INTO ${tableName} (${columnSql})${override} VALUES`
  const batches = []
  let tuples = []
  let batchBytes = 0
  const baseBytes = Buffer.byteLength(`${prefix} ;`, 'utf8')
  const flush = () => {
    if (!tuples.length) return
    batches.push(`${prefix} ${tuples.join(',\n')};`)
    tuples = []
    batchBytes = 0
  }
  for (const row of rows) {
    const tuple = `(${columns.map((column) => databaseBackupSqlLiteral(config, row[column])).join(', ')})`
    const tupleBytes = Buffer.byteLength(tuple, 'utf8')
    const candidateBytes = (tuples.length ? batchBytes + 2 : baseBytes) + tupleBytes
    if (
      tuples.length &&
      (tuples.length >= DATABASE_INSERT_BATCH_MAX_ROWS || candidateBytes > DATABASE_INSERT_BATCH_MAX_BYTES)
    ) {
      flush()
    }
    tuples.push(tuple)
    batchBytes = (tuples.length === 1 ? baseBytes : batchBytes + 2) + tupleBytes
  }
  flush()
  return batches
}

function databaseBackupSqlLiteral(config, value) {
  if (value === null || typeof value === 'undefined') return 'NULL'
  if (value instanceof Date) {
    const timestamp = value.toISOString().replace('T', ' ').replace('Z', '')
    return isOracleLikeEngine(config.engine) ? `TIMESTAMP '${timestamp}'` : `'${timestamp}'`
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex')
    if (config.engine === 'postgres') return `decode('${hex}', 'hex')`
    if (config.engine === 'sqlserver') return `0x${hex}`
    if (isOracleLikeEngine(config.engine)) return `HEXTORAW('${hex}')`
    return `X'${hex}'`
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') {
    if (config.engine === 'postgres') return value ? 'TRUE' : 'FALSE'
    return value ? '1' : '0'
  }
  let normalized
  try {
    normalized = typeof value === 'object' ? JSON.stringify(value) : String(value)
  } catch {
    normalized = String(value)
  }
  if (normalized === undefined) normalized = String(value)
  return `'${normalized.replace(/'/g, "''")}'`
}

async function exportTablesAsSql(connection, config, tables, filePath) {
  const parts = [`-- Ops Flow export`, `-- ${new Date().toISOString()}`, '']
  for (const table of tables) {
    if (config.engine === 'postgres') {
      parts.push(await buildPostgresCreateTableSql(connection, table))
    } else if (isOracleLikeEngine(config.engine)) {
      parts.push(await buildOracleLikeCreateTableSql(connection, config, table))
    } else if (config.engine === 'sqlserver') {
      parts.push(await buildSqlServerCreateTableSql(connection, table))
    } else {
      const [createRows] = await connection.query(`SHOW CREATE TABLE ${quoteMysqlTable(table)}`)
      parts.push(`${createRows[0]?.['Create Table'] || ''};`)
    }
    const rows = await selectExportRows(connection, config, table)
    for (const row of rows) {
      parts.push(buildInsertSql(config, table, row))
    }
    parts.push('')
  }
  writeFileSync(filePath, parts.join('\n'), 'utf8')
  return { ok: true, path: filePath, tables: tables.length }
}

async function exportTablesAsCsv(connection, config, tables, targetDir) {
  for (const table of tables) {
    const rows = await selectExportRows(connection, config, table)
    const columns = rows.length ? Object.keys(rows[0]) : await getTableColumns(connection, config, table)
    const lines = [columns.map(csvEscape).join(',')]
    for (const row of rows) {
      lines.push(columns.map((column) => csvEscape(row[column])).join(','))
    }
    writeFileSync(join(targetDir, `${safeFileName(table.schema)}.${safeFileName(table.name)}.csv`), `\ufeff${lines.join('\n')}`, 'utf8')
  }
  return { ok: true, path: targetDir, tables: tables.length }
}

async function selectExportRows(connection, config, table) {
  if (config.engine === 'postgres') {
    const result = await connection.query(`select * from ${quotePostgresTable(table)} limit 5000`)
    return result.rows
  }
  if (config.engine === 'sqlserver') {
    const result = await connection.request().query(`select top 5000 * from ${quoteSqlServerTable(table)}`)
    return result.recordset || []
  }
  if (isOracleLikeEngine(config.engine)) {
    const result = await executeOracleLike(connection, config.engine, `select * from ${quoteOracleLikeTable(table)} fetch first 5000 rows only`)
    return result.rows || []
  }
  const [rows] = await connection.query(`select * from ${quoteMysqlTable(table)} limit 5000`)
  return rows
}

async function getTableColumns(connection, config, table) {
  if (config.engine === 'postgres') {
    const result = await connection.query(
      `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
      [table.schema, table.name]
    )
    return result.rows.map((row) => row?.column_name || row?.COLUMN_NAME).filter(Boolean)
  }
  if (config.engine === 'sqlserver') {
    const request = connection.request()
    request.input('schema', mssql.NVarChar, table.schema)
    request.input('name', mssql.NVarChar, table.name)
    const result = await request.query(`
      select COLUMN_NAME as column_name
      from INFORMATION_SCHEMA.COLUMNS
      where TABLE_SCHEMA = @schema and TABLE_NAME = @name
      order by ORDINAL_POSITION
    `)
    return result.recordset.map((row) => row?.column_name || row?.COLUMN_NAME).filter(Boolean)
  }
  if (isOracleLikeEngine(config.engine)) {
    const result = await executeOracleLike(connection, config.engine, `
      select COLUMN_NAME as column_name
      from ALL_TAB_COLUMNS
      where OWNER = :schema and TABLE_NAME = :name
      order by COLUMN_ID
    `, { schema: table.schema, name: table.name })
    return result.rows.map((row) => row?.column_name || row?.COLUMN_NAME).filter(Boolean)
  }
  const [rows] = await connection.query(
    `select column_name from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
    [table.schema, table.name]
  )
  return rows.map((row) => row?.column_name || row?.COLUMN_NAME).filter(Boolean)
}

async function buildPostgresCreateTableSql(connection, table) {
  const result = await connection.query(
    `
      select
        column_name,
        data_type,
        udt_name,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        datetime_precision,
        is_nullable,
        column_default,
        is_identity,
        identity_generation
      from information_schema.columns
      where table_schema = $1 and table_name = $2
      order by ordinal_position
    `,
    [table.schema, table.name]
  )
  const primaryKeyColumns = await getDatabasePrimaryKeyColumns(connection, { engine: 'postgres' }, table)
  const columns = result.rows.map((column) => {
    const nullable = column.is_nullable === 'NO' ? ' NOT NULL' : ''
    const defaultValue = column.column_default ? ` DEFAULT ${column.column_default}` : ''
    const identity = column.is_identity === 'YES'
      ? ` GENERATED ${column.identity_generation || 'BY DEFAULT'} AS IDENTITY`
      : ''
    return `  ${quoteDatabaseIdentifier({ engine: 'postgres' }, column.column_name)} ${formatPostgresColumnType(column)}${identity}${defaultValue}${nullable}`
  })
  if (primaryKeyColumns.length) {
    columns.push(`  PRIMARY KEY (${primaryKeyColumns.map((column) => quoteDatabaseIdentifier({ engine: 'postgres' }, column)).join(', ')})`)
  }
  return `CREATE TABLE IF NOT EXISTS ${quotePostgresTable(table)} (\n${columns.join(',\n')}\n);`
}

async function buildSqlServerCreateTableSql(connection, table) {
  const request = connection.request()
  request.input('schema', mssql.NVarChar, table.schema)
  request.input('name', mssql.NVarChar, table.name)
  const result = await request.query(`
      select
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        CHARACTER_MAXIMUM_LENGTH as character_maximum_length,
        NUMERIC_PRECISION as numeric_precision,
        NUMERIC_SCALE as numeric_scale,
        DATETIME_PRECISION as datetime_precision,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        COLUMNPROPERTY(OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(@name)), COLUMN_NAME, 'IsIdentity') as is_identity,
        IDENT_SEED(QUOTENAME(@schema) + '.' + QUOTENAME(@name)) as identity_seed,
        IDENT_INCR(QUOTENAME(@schema) + '.' + QUOTENAME(@name)) as identity_increment
      from INFORMATION_SCHEMA.COLUMNS
      where TABLE_SCHEMA = @schema and TABLE_NAME = @name
      order by ORDINAL_POSITION
    `)
  const primaryKeyColumns = await getDatabasePrimaryKeyColumns(connection, { engine: 'sqlserver' }, table)
  const columns = result.recordset.map((column) => {
    const nullable = column.is_nullable === 'NO' ? ' NOT NULL' : ''
    const defaultValue = column.column_default ? ` DEFAULT ${column.column_default}` : ''
    const identity = Number(column.is_identity || 0) === 1
      ? ` IDENTITY(${Number(column.identity_seed || 1)},${Number(column.identity_increment || 1)})`
      : ''
    return `  ${quoteSqlServerIdentifier(column.column_name)} ${formatSqlServerColumnType(column)}${identity}${defaultValue}${nullable}`
  })
  if (primaryKeyColumns.length) {
    columns.push(`  PRIMARY KEY (${primaryKeyColumns.map(quoteSqlServerIdentifier).join(', ')})`)
  }
  return `CREATE TABLE ${quoteSqlServerTable(table)} (\n${columns.join(',\n')}\n);`
}

async function buildOracleLikeCreateTableSql(connection, config, table) {
  const result = await executeOracleLike(connection, config.engine, `
      select
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        DATA_LENGTH as data_length,
        CHAR_LENGTH as char_length,
        DATA_PRECISION as data_precision,
        DATA_SCALE as data_scale,
        NULLABLE as is_nullable,
        DATA_DEFAULT as column_default
      from ALL_TAB_COLUMNS
      where OWNER = :schema and TABLE_NAME = :name
      order by COLUMN_ID
    `, { schema: table.schema, name: table.name })
  const primaryKeyColumns = await getDatabasePrimaryKeyColumns(connection, config, table)
  const columns = result.rows.map((column) => {
    const name = column.column_name || column.COLUMN_NAME
    const type = column.data_type || column.DATA_TYPE
    const nullable = (column.is_nullable || column.IS_NULLABLE) === 'N' ? ' NOT NULL' : ''
    const rawDefault = column.column_default ?? column.COLUMN_DEFAULT
    const defaultValue = rawDefault ? ` DEFAULT ${String(rawDefault).trim()}` : ''
    return `  ${quoteOracleLikeIdentifier(name)} ${formatOracleLikeColumnType(column, type)}${defaultValue}${nullable}`
  })
  if (primaryKeyColumns.length) {
    columns.push(`  PRIMARY KEY (${primaryKeyColumns.map(quoteOracleLikeIdentifier).join(', ')})`)
  }
  return `CREATE TABLE ${quoteOracleLikeTable(table)} (\n${columns.join(',\n')}\n);`
}

function formatPostgresColumnType(column) {
  const type = column.data_type === 'USER-DEFINED' ? column.udt_name : column.data_type
  if (['character varying', 'character', 'bit varying', 'bit'].includes(type) && column.character_maximum_length) {
    return `${type}(${column.character_maximum_length})`
  }
  if (['numeric', 'decimal'].includes(type) && column.numeric_precision) {
    return column.numeric_scale === null || column.numeric_scale === undefined
      ? `${type}(${column.numeric_precision})`
      : `${type}(${column.numeric_precision},${column.numeric_scale})`
  }
  return type
}

function formatSqlServerColumnType(column) {
  const type = String(column.data_type || '')
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(type)) {
    const length = Number(column.character_maximum_length)
    return `${type}(${length === -1 ? 'max' : length})`
  }
  if (['decimal', 'numeric'].includes(type) && column.numeric_precision !== null) {
    return `${type}(${column.numeric_precision},${column.numeric_scale || 0})`
  }
  if (['datetime2', 'datetimeoffset', 'time'].includes(type) && column.datetime_precision !== null) {
    return `${type}(${column.datetime_precision})`
  }
  return type
}

function formatOracleLikeColumnType(column, rawType) {
  const type = String(rawType || '')
  const charLength = Number(column.char_length ?? column.CHAR_LENGTH)
  const dataLength = Number(column.data_length ?? column.DATA_LENGTH)
  const precisionValue = column.data_precision ?? column.DATA_PRECISION
  const scaleValue = column.data_scale ?? column.DATA_SCALE
  if (['CHAR', 'NCHAR', 'VARCHAR', 'VARCHAR2', 'NVARCHAR2'].includes(type)) {
    const length = charLength > 0 ? charLength : dataLength
    return length > 0 ? `${type}(${length})` : type
  }
  if (['NUMBER', 'DECIMAL', 'NUMERIC'].includes(type) && precisionValue !== null && precisionValue !== undefined) {
    return scaleValue === null || scaleValue === undefined
      ? `${type}(${precisionValue})`
      : `${type}(${precisionValue},${scaleValue})`
  }
  if (['RAW', 'BINARY', 'VARBINARY'].includes(type) && dataLength > 0) return `${type}(${dataLength})`
  return type
}

function buildInsertSql(config, table, row) {
  const columns = Object.keys(row)
  const tableName = quotePortableBackupTable(config, table)
  const columnSql = columns.map((column) => quoteDatabaseIdentifier(config, column)).join(', ')
  const values = columns.map((column) => sqlLiteral(row[column])).join(', ')
  return `INSERT INTO ${tableName} (${columnSql}) VALUES (${values});`
}

function quoteTable(config, table) {
  if (config.engine === 'postgres') return quotePostgresTable(table)
  if (config.engine === 'sqlserver') return quoteSqlServerTable(table)
  if (isOracleLikeEngine(config.engine)) return quoteOracleLikeTable(table)
  return quoteMysqlTable(table)
}

function quotePortableBackupTable(config, table) {
  if (['mysql', 'mariadb'].includes(config.engine)) {
    return `\`${String(table.name).replace(/`/g, '``')}\``
  }
  return quoteTable(config, table)
}

function quoteMysqlTable(table) {
  return `\`${String(table.schema).replace(/`/g, '``')}\`.\`${String(table.name).replace(/`/g, '``')}\``
}

function quotePostgresTable(table) {
  return `"${String(table.schema).replace(/"/g, '""')}"."${String(table.name).replace(/"/g, '""')}"`
}

function quoteSqlServerTable(table) {
  return `${quoteSqlServerIdentifier(table.schema)}.${quoteSqlServerIdentifier(table.name)}`
}

function quoteOracleLikeTable(table) {
  return `${quoteOracleLikeIdentifier(table.schema)}.${quoteOracleLikeIdentifier(table.name)}`
}

function quoteDatabaseIdentifier(config, identifier) {
  if (config.engine === 'postgres') return `"${String(identifier).replace(/"/g, '""')}"`
  if (config.engine === 'sqlserver') return quoteSqlServerIdentifier(identifier)
  if (isOracleLikeEngine(config.engine)) return quoteOracleLikeIdentifier(identifier)
  return `\`${String(identifier).replace(/`/g, '``')}\``
}

function quoteSqlServerIdentifier(identifier) {
  return `[${String(identifier).replace(/]/g, ']]')}]`
}

function quoteOracleLikeIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function sqlLiteral(value) {
  if (value === null || typeof value === 'undefined') return 'NULL'
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replace(/'/g, "''")}'`
}

function csvEscape(value) {
  if (value === null || typeof value === 'undefined') return ''
  const text = value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? value.toString('hex') : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function safeFileName(value) {
  return String(value || 'table').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function defaultDatabasePort(engine) {
  if (engine === 'postgres') return 5432
  if (engine === 'sqlserver') return 1433
  if (engine === 'oracle') return 1521
  if (engine === 'dm') return 5236
  return 3306
}

function parseMysqlPrivileges(grants = []) {
  const text = grants.join('\n').toUpperCase()
  const hasAll = /ALL PRIVILEGES|GRANT ALL/.test(text)
  const has = (name) => hasAll || new RegExp(`\\b${name}\\b`).test(text)
  return {
    select: has('SELECT'),
    insert: has('INSERT'),
    update: has('UPDATE'),
    delete: has('DELETE'),
    create: has('CREATE'),
    alter: has('ALTER'),
    drop: has('DROP')
  }
}

function parseTextPrivileges(grants = []) {
  const text = grants.join('\n').toUpperCase()
  const hasAny = (names) => names.some((name) => new RegExp(`\\b${name}\\b`).test(text))
  return {
    select: hasAny(['SELECT ANY TABLE', 'SELECT']),
    insert: hasAny(['INSERT ANY TABLE', 'INSERT']),
    update: hasAny(['UPDATE ANY TABLE', 'UPDATE']),
    delete: hasAny(['DELETE ANY TABLE', 'DELETE']),
    create: hasAny(['CREATE TABLE', 'CREATE ANY TABLE', 'CREATE']),
    alter: hasAny(['ALTER ANY TABLE', 'ALTER']),
    drop: hasAny(['DROP ANY TABLE', 'DROP'])
  }
}

function isOracleLikeEngine(engine) {
  return engine === 'oracle' || engine === 'dm'
}

function buildOracleConnectString(config) {
  const host = config.host || '127.0.0.1'
  const port = Number(config.port || 1521)
  const service = config.database || 'ORCL'
  return `${host}:${port}/${service}`
}

async function executeOracleLike(connection, engine, sql, binds = [], options = {}) {
  const outFormat = engine === 'dm' && connection?.outFormatObject !== undefined
    ? connection.outFormatObject
    : engine === 'dm'
      ? (await loadDmdbDriver()).OUT_FORMAT_OBJECT
      : oracledb.OUT_FORMAT_OBJECT
  const result = await connection.execute(sql, binds, {
    outFormat,
    ...options
  })
  return {
    ...result,
    rows: result.rows || []
  }
}

function resetDmdbDriverCache() {
  dmdbDriverPromise = null
  dmdbDriverLoadedPath = ''
}

function inspectDamengDriverPath(inputPath) {
  const selectedPath = resolve(String(inputPath || '').trim())
  const candidates = [
    selectedPath,
    join(selectedPath, 'dmdb'),
    join(selectedPath, 'node_modules', 'dmdb')
  ]
  const driverPath = candidates.find((candidate) => (
    existsSync(join(candidate, 'package.json'))
    && existsSync(join(candidate, 'index.js'))
    && existsSync(join(candidate, 'LICENSE'))
  ))
  if (!driverPath) {
    throw new Error('No dmdb package was found. Select node_modules/dmdb, its node_modules parent, or a project directory containing node_modules/dmdb.')
  }

  let metadata
  try {
    metadata = JSON.parse(readFileSync(join(driverPath, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read dmdb package metadata: ${error.message}`)
  }
  if (metadata.name !== 'dmdb') {
    throw new Error(`The selected package is "${metadata.name || 'unknown'}", not dmdb.`)
  }
  const author = typeof metadata.author === 'string' ? metadata.author : metadata.author?.name || ''
  if (!/dameng/i.test(author)) {
    throw new Error(`The selected dmdb package does not identify Dameng as its author (${author || 'author missing'}).`)
  }

  const mainFile = resolve(driverPath, String(metadata.main || 'index.js'))
  const relativeMainFile = relative(resolve(driverPath), mainFile)
  if (relativeMainFile.startsWith('..') || isAbsolute(relativeMainFile)) {
    throw new Error('The dmdb package entry point is outside the selected package directory.')
  }
  if (!existsSync(mainFile)) {
    throw new Error(`The dmdb entry point does not exist: ${mainFile}`)
  }

  return {
    path: resolve(driverPath),
    version: String(metadata.version || 'unknown'),
    mainFile
  }
}

function getDamengDriverStatus() {
  const configuredPath = String(store.get(DAMENG_DRIVER_STORE_KEY, '') || '').trim()
  const compatibility = {
    legacyMode: Boolean(store.get(DAMENG_LEGACY_MODE_STORE_KEY, false)),
    legacyRuntime: findDamengLegacyNodeRuntime()
  }
  if (!configuredPath) return { configured: false, path: '', version: '', error: '', ...compatibility }
  try {
    return { configured: true, ...inspectDamengDriverPath(configuredPath), error: '', ...compatibility }
  } catch (error) {
    return { configured: false, path: configuredPath, version: '', error: error.message, ...compatibility }
  }
}

const damengLegacyRuntimeCache = new Map()

function inspectDamengLegacyNodeRuntime(inputPath) {
  const runtimePath = resolve(String(inputPath || '').trim())
  if (!existsSync(runtimePath) || !statSync(runtimePath).isFile()) {
    return {
      configured: false,
      compatible: false,
      path: runtimePath,
      version: '',
      opensslVersion: '',
      execArgv: [],
      error: `Node.js runtime does not exist: ${runtimePath}`
    }
  }
  const cachedStatus = damengLegacyRuntimeCache.get(runtimePath)
  if (cachedStatus?.compatible) return cachedStatus

  const checkScript = "const crypto=require('crypto');process.stdout.write(JSON.stringify({version:process.version,opensslVersion:process.versions.openssl||'',legacyCipher:crypto.getCiphers().includes('des-cfb')}))"
  const runCheck = (execArgv) => {
    const checked = spawnSync(runtimePath, [...execArgv, '-e', checkScript], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    if (checked.error || checked.status !== 0) {
      return {
        ok: false,
        detail: String(checked.error?.message || checked.stderr || `exit code ${checked.status}`).trim()
      }
    }
    try {
      return { ok: true, details: JSON.parse(String(checked.stdout || '').trim()) }
    } catch {
      return { ok: false, detail: 'The runtime returned an invalid compatibility check result.' }
    }
  }

  let execArgv = []
  let checked = runCheck(execArgv)
  if (!checked.ok || !checked.details.legacyCipher) {
    execArgv = ['--openssl-legacy-provider']
    checked = runCheck(execArgv)
  }

  let status
  if (!checked.ok) {
    status = {
      configured: true,
      compatible: false,
      path: runtimePath,
      version: '',
      opensslVersion: '',
      execArgv: [],
      error: `The selected Node.js runtime cannot start isolated legacy cryptography: ${checked.detail}`
    }
  } else {
    const details = checked.details
    status = {
      configured: true,
      compatible: Boolean(details.legacyCipher),
      path: runtimePath,
      version: String(details.version || ''),
      opensslVersion: String(details.opensslVersion || ''),
      execArgv,
      error: details.legacyCipher
        ? ''
        : 'This Node.js runtime does not provide the legacy cipher required by the selected Dameng driver.'
    }
  }
  if (status.compatible) damengLegacyRuntimeCache.set(runtimePath, status)
  else damengLegacyRuntimeCache.delete(runtimePath)
  return status
}

function findDamengLegacyNodeRuntime() {
  const configuredPath = String(store.get(DAMENG_LEGACY_NODE_STORE_KEY, '') || '').trim()
  if (configuredPath) return { ...inspectDamengLegacyNodeRuntime(configuredPath), source: 'selected' }

  const executableName = process.platform === 'win32' ? 'node.exe' : 'node'
  const pathCandidates = String(process.env.PATH || '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => join(entry, executableName))
  const conventionalCandidates = process.platform === 'win32'
    ? [
        process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : ''
      ]
    : ['/usr/local/bin/node', '/usr/bin/node']
  const candidates = [...new Set([...pathCandidates, ...conventionalCandidates].filter(Boolean))]

  let lastError = ''
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const status = inspectDamengLegacyNodeRuntime(candidate)
    if (status.compatible) return { ...status, source: 'detected' }
    lastError = status.error
  }
  return {
    configured: false,
    compatible: false,
    path: '',
    version: '',
    opensslVersion: '',
    execArgv: [],
    source: 'missing',
    error: lastError || 'No compatible Node.js runtime was found. Install an official Node.js LTS release or select node.exe manually.'
  }
}

function reviveDamengWorkerError(value) {
  const error = new Error(String(value?.message || 'The isolated Dameng worker failed.'))
  error.name = String(value?.name || 'Error')
  if (value?.stack) error.stack = String(value.stack)
  if (value?.code !== undefined) error.code = value.code
  if (value?.errorNum !== undefined) error.errorNum = value.errorNum
  return error
}

const DAMENG_IPC_TYPE_KEY = '__opsFlowDamengIpcType'

function encodeDamengIpcValue(value, ancestors = new WeakSet()) {
  if (value === undefined) return { [DAMENG_IPC_TYPE_KEY]: 'undefined' }
  if (typeof value === 'bigint') return { [DAMENG_IPC_TYPE_KEY]: 'bigint', value: value.toString() }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { [DAMENG_IPC_TYPE_KEY]: 'number', value: String(value) }
  }
  if (value === null || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return { [DAMENG_IPC_TYPE_KEY]: 'buffer', value: value.toString('base64') }
  if (value instanceof Date) return { [DAMENG_IPC_TYPE_KEY]: 'date', value: value.toISOString() }
  if (ArrayBuffer.isView(value)) {
    return { [DAMENG_IPC_TYPE_KEY]: 'buffer', value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return { [DAMENG_IPC_TYPE_KEY]: 'circular' }
    ancestors.add(value)
    try {
      return value.map((item) => encodeDamengIpcValue(item, ancestors))
    } finally {
      ancestors.delete(value)
    }
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype && prototype !== Object.prototype) {
    const constructorName = String(value.constructor?.name || 'Value')
    try {
      const text = String(value)
      if (text && text !== '[object Object]' && text !== `[object ${constructorName}]`) {
        return { [DAMENG_IPC_TYPE_KEY]: 'text', value: text }
      }
    } catch {
      // Fall through to a safe type placeholder.
    }
    return { [DAMENG_IPC_TYPE_KEY]: 'text', value: `[${constructorName}]` }
  }
  if (ancestors.has(value)) return { [DAMENG_IPC_TYPE_KEY]: 'circular' }

  ancestors.add(value)
  try {
    const output = {}
    for (const [key, child] of Object.entries(value)) {
      output[key] = encodeDamengIpcValue(child, ancestors)
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

function decodeDamengIpcValue(value) {
  if (Array.isArray(value)) return value.map(decodeDamengIpcValue)
  if (!value || typeof value !== 'object') return value
  const type = value[DAMENG_IPC_TYPE_KEY]
  if (type === 'undefined') return undefined
  if (type === 'bigint') return BigInt(value.value)
  if (type === 'number') return Number(value.value)
  if (type === 'buffer') return Buffer.from(String(value.value || ''), 'base64')
  if (type === 'date') return new Date(value.value)
  if (type === 'text') return String(value.value || '')
  if (type === 'circular') return '[Circular]'
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeDamengIpcValue(child)]))
}

function createDamengLegacyWorkerProxy(runtime) {
  const workerPath = app.isPackaged
    ? join(process.resourcesPath, 'damengLegacyWorker.cjs')
    : join(app.getAppPath(), 'src', 'main', 'damengLegacyWorker.cjs')
  if (!existsSync(workerPath)) {
    throw new Error(`The isolated Dameng compatibility worker is missing: ${workerPath}`)
  }

  const workerEnvironment = { ...process.env }
  delete workerEnvironment.ELECTRON_RUN_AS_NODE
  delete workerEnvironment.NODE_OPTIONS
  const child = fork(workerPath, [], {
    execPath: runtime.path,
    execArgv: Array.isArray(runtime.execArgv) ? runtime.execArgv : [],
    cwd: dirname(workerPath),
    env: workerEnvironment,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
    windowsHide: true
  })
  let sequence = 0
  let settled = false
  let proxy
  const pending = new Map()

  const failPending = (error) => {
    if (settled) return
    settled = true
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const terminate = () => {
    failPending(new Error('The isolated Dameng worker was stopped.'))
    if (!child.killed) child.kill()
  }
  const send = (command, payload = {}) => new Promise((resolveRequest, rejectRequest) => {
    if (settled || !child.connected) {
      rejectRequest(new Error('The isolated Dameng worker is not available.'))
      return
    }
    const id = `dm-${Date.now()}-${++sequence}`
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
    child.send(encodeDamengIpcValue({ id, command, ...payload }), (error) => {
      if (!error) return
      pending.delete(id)
      rejectRequest(error)
    })
  })

  child.on('message', (message) => {
    message = decodeDamengIpcValue(message)
    if (message?.fatal) {
      failPending(reviveDamengWorkerError(message.error))
      return
    }
    const request = pending.get(String(message?.id || ''))
    if (!request) return
    pending.delete(String(message.id))
    if (message.ok) request.resolve(message.result)
    else request.reject(reviveDamengWorkerError(message.error))
  })
  child.on('error', (error) => failPending(error))
  child.on('exit', (code, signal) => {
    damengLegacyWorkers.delete(proxy)
    failPending(new Error(`The isolated Dameng worker exited unexpectedly (${signal || code || 0}).`))
  })

  proxy = {
    outFormatObject: undefined,
    async connect(driverPath, config) {
      const result = await send('connect', {
        driverPath,
        connection: {
          host: config.host,
          port: Number(config.port || 5236),
          username: config.username,
          password: config.password
        }
      })
      proxy.outFormatObject = result.outFormatObject
      return result
    },
    execute(sql, binds, options) {
      return send('execute', { sql, binds, options })
    },
    probe(driverPath) {
      return send('probe', { driverPath })
    },
    commit() {
      return send('commit')
    },
    rollback() {
      return send('rollback')
    },
    async close() {
      if (settled) return
      try {
        await withTimeout(send('close'), 5000, 'Timed out while closing the isolated Dameng worker')
      } finally {
        terminate()
        damengLegacyWorkers.delete(proxy)
      }
    },
    terminate
  }
  damengLegacyWorkers.add(proxy)
  return proxy
}

async function createDamengLegacyConnection(config) {
  const status = getDamengDriverStatus()
  if (!status.configured) {
    throw new Error(status.error || 'Configure the official external dmdb driver before using Dameng.')
  }
  if (!status.legacyRuntime?.compatible) {
    throw new Error(status.legacyRuntime?.error || 'No compatible Node.js runtime is available for isolated Dameng compatibility mode.')
  }
  const proxy = createDamengLegacyWorkerProxy(status.legacyRuntime)
  try {
    await withTimeout(
      proxy.connect(status.path, config),
      15000,
      'Database connection timed out in isolated Dameng compatibility mode'
    )
    return proxy
  } catch (error) {
    proxy.terminate()
    damengLegacyWorkers.delete(proxy)
    throw error
  }
}

async function verifyDamengLegacyWorker(existingStatus = null) {
  const status = existingStatus || getDamengDriverStatus()
  if (!status.configured) {
    throw new Error(status.error || 'Configure the official external dmdb driver before using Dameng compatibility mode.')
  }
  if (!status.legacyRuntime?.compatible) {
    throw new Error(status.legacyRuntime?.error || 'No compatible Node.js runtime is available for isolated Dameng compatibility mode.')
  }
  const proxy = createDamengLegacyWorkerProxy(status.legacyRuntime)
  try {
    await withTimeout(
      proxy.probe(status.path),
      10000,
      'Timed out while loading dmdb in the isolated Dameng compatibility worker'
    )
  } finally {
    await proxy.close().catch(() => proxy.terminate())
    damengLegacyWorkers.delete(proxy)
  }
}

async function loadDmdbDriver() {
  const status = getDamengDriverStatus()
  if (!status.configured) {
    throw new Error(status.error || 'Dameng requires an external official dmdb driver. Open Settings > General, select a locally installed dmdb package, and accept the vendor license.')
  }
  if (dmdbDriverPromise && dmdbDriverLoadedPath === status.path) return dmdbDriverPromise

  dmdbDriverLoadedPath = status.path
  dmdbDriverPromise = Promise.resolve().then(() => {
    const externalRequire = createRequire(join(status.path, 'package.json'))
    const module = withTemporaryExternalModulePath(dirname(status.path), () => externalRequire(status.path))
    const driver = module?.default || module
    if (!driver || typeof driver.getConnection !== 'function') {
      throw new Error('The selected dmdb package does not expose getConnection().')
    }
    return driver
  }).catch((error) => {
    resetDmdbDriverCache()
    const driverError = new Error(`Unable to load the external dmdb driver: ${error.message}`)
    driverError.cause = error
    throw driverError
  })
  return dmdbDriverPromise
}

function withTemporaryExternalModulePath(searchPath, task) {
  const previousNodePath = process.env.NODE_PATH
  const previousGlobalPaths = [...Module.globalPaths]
  process.env.NODE_PATH = [searchPath, previousNodePath].filter(Boolean).join(delimiter)
  Module._initPaths()
  try {
    return task()
  } finally {
    if (previousNodePath === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = previousNodePath
    Module.globalPaths.splice(0, Module.globalPaths.length, ...previousGlobalPaths)
  }
}

async function withRedis(config, task) {
  if (config.connectionMode === 'ssh') {
    return withRedisViaSsh(config, task)
  }

  return withRedisConnection(config, task)
}

async function withRedisViaSsh(config, task) {
  if (!config.sshConfig) {
    return { ok: false, message: 'SSH configuration is missing. Edit the connection and select an available SSH jump server, or use Direct connection.' }
  }

  return withSshClient(config.sshConfig, async (sshClient) => {
    let tunnel = null
    try {
      tunnel = await createSshTunnelServer(sshClient, config.host, Number(config.port || 6379))
      return await withRedisConnection({
        ...config,
        host: '127.0.0.1',
        port: tunnel.port
      }, task)
    } finally {
      tunnel?.close()
    }
  })
}

function createSshTunnelServer(sshClient, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sockets = new Set()
    const server = createServer((socket) => {
      sockets.add(socket)
      let sshStream = null
      const closeSshStream = () => {
        if (sshStream && !sshStream.destroyed) sshStream.destroy()
      }

      // Tunnel failures must be reported through the database client instead of
      // becoming an unhandled EventEmitter error in Electron's main process.
      socket.on('error', closeSshStream)
      socket.on('close', () => {
        sockets.delete(socket)
        closeSshStream()
      })

      sshClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
        if (error) {
          socket.destroy()
          return
        }

        sshStream = stream
        stream.on('error', () => {
          if (!socket.destroyed) socket.destroy()
        })
        stream.on('close', () => {
          if (!socket.destroyed) socket.destroy()
        })
        socket.pipe(stream).pipe(socket)
      })
    })

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: address.port,
        close: () => {
          for (const socket of sockets) socket.destroy()
          server.close()
        }
      })
    })
  })
}

async function withRedisConnection(config, task) {
  const protocol = config.tls ? 'rediss' : 'redis'
  const auth = config.password ? `:${encodeURIComponent(config.password)}@` : ''
  const database = config.database ? `/${config.database}` : ''
  const url = `${protocol}://${auth}${config.host}:${Number(config.port || 6379)}${database}`
  const client = createRedisClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: false
    }
  })
  client.on('error', () => {})

  try {
    await withTimeout(client.connect(), 6000, `Redis connection timed out: ${config.host}:${Number(config.port || 6379)}`)
    return await task(client)
  } catch (error) {
    return { ok: false, message: error.message }
  } finally {
    if (client.isOpen) {
      try {
        await withTimeout(client.quit(), 1500, 'Redis disconnect timed out')
      } catch {
        client.destroy()
      }
    }
  }
}

function parseRedisDatabases(info = '') {
  const found = new Map()
  for (const line of info.split(/\r?\n/)) {
    const match = line.match(/^db(\d+):keys=(\d+),expires=(\d+),avg_ttl=(\d+)/)
    if (match) {
      found.set(Number(match[1]), {
        index: Number(match[1]),
        keys: Number(match[2]),
        expires: Number(match[3]),
        avgTtl: Number(match[4])
      })
    }
  }

  return Array.from({ length: 16 }, (_item, index) => found.get(index) || {
    index,
    keys: 0,
    expires: 0,
    avgTtl: 0
  })
}

async function readRedisValue(client, key, type) {
  if (type === 'string') {
    return await client.get(key)
  }
  if (type === 'hash') {
    return await client.hGetAll(key)
  }
  if (type === 'list') {
    return await client.lRange(key, 0, 199)
  }
  if (type === 'set') {
    return await client.sMembers(key)
  }
  if (type === 'zset') {
    return await client.zRangeWithScores(key, 0, 199)
  }
  if (type === 'stream') {
    return await client.xRange(key, '-', '+', { COUNT: 100 })
  }
  if (type === 'none') {
    return null
  }
  return await client.sendCommand(['DUMP', key])
}

function splitCommand(commandLine) {
  return commandLine.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) || []
}
