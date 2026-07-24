// SPDX-License-Identifier: MPL-2.0

import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, safeStorage, shell } from 'electron'
import { basename, dirname, join, posix } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import Store from 'electron-store'
import { Client } from 'ssh2'
import mysql from 'mysql2/promise'
import pg from 'pg'
import mssql from 'mssql'
import oracledb from 'oracledb'
import { createClient as createRedisClient } from 'redis'
import {
  containsCredentials,
  decryptConfigBackup,
  encryptConfigBackup,
  normalizeConfigSnapshot,
  sanitizeConfigObject,
  summarizeConfig
} from './configCrypto.mjs'

const shellSessions = new Map()
let dmdbDriverPromise = null
const shellSessionsByWebContents = new Map()
const sshExecSessions = new Map()
const workflowPrivilegeCredentials = new Map()
const databaseScriptSessions = new Map()
const fileTransferSessions = new Map()
const pendingConfigImports = new Map()

const PROTECTED_STORE_KEYS = new Set(['resources', 'servers', 'databases', 'redisStores', 'redis'])
const LOCAL_SECRET_MARKER = '__opsFlowProtectedSecretV1'
const MAX_CONFIG_BACKUP_BYTES = 25 * 1024 * 1024
const CONFIG_IMPORT_TTL_MS = 10 * 60 * 1000

const store = new Store({
  name: 'ops-flow',
  defaults: {
    resources: [],
    servers: [],
    databases: [],
    redisStores: [],
    redis: [],
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
  for (const key of ['resources', 'servers', 'databases', 'redisStores', 'redis', 'workflows']) {
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
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 740,
    title: 'Ops Flow',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
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
  databaseScriptSessions.clear()
  for (const session of fileTransferSessions.values()) {
    session.canceled = true
    session.sftp?.end()
    session.client?.end()
  }
  fileTransferSessions.clear()
})

ipcMain.handle('store:get', (_event, key) => readStoreValue(key))
ipcMain.handle('store:set', (_event, key, value) => {
  return writeStoreValue(key, value)
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
  const properties = options.directory
    ? ['openDirectory']
    : options.multiple
      ? ['openFile', 'multiSelections']
      : ['openFile']
  const picked = await dialog.showOpenDialog(window, {
    title: options.title || (options.directory ? 'Select local directory' : 'Select local file'),
    properties
  })
  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true, message: 'Selection canceled' }
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
    title: 'Select SQL file',
    properties: ['openFile'],
    filters: [
      { name: 'SQL files', extensions: ['sql'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true, message: 'Selection canceled' }
  const filePath = picked.filePaths[0]
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) return { ok: false, message: 'The selected path is not a file' }
    if (stats.size > 10 * 1024 * 1024) return { ok: false, message: 'SQL files loaded into the editor are limited to 10 MB' }
    const decoded = decodeSqlFile(readFileSync(filePath))
    return {
      ok: true,
      path: filePath,
      name: basename(filePath),
      size: stats.size,
      sizeLabel: formatBytes(stats.size),
      encoding: decoded.encoding,
      content: decoded.content
    }
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('ssh:test', async (_event, config) => {
  return withSshClient(config, async () => ({ ok: true, message: 'SSH connected' }))
})

ipcMain.handle('ssh:exec', async (_event, config, command) => {
  return withSshClient(config, (client) => execCommand(client, wrapInteractiveCommand(command), { pty: true }))
})

ipcMain.handle('ssh:exec-stream', async (event, config, command, executionId, privilege) => {
  return execStreamingCommand(event.sender, config, command, executionId, privilege)
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

ipcMain.handle('ssh:privilege-detect', async (event, config) => {
  return withSshClient(config, async (client) => {
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
      const verified = await execStreamingCommand(event.sender, config, 'true', executionId, { mode, password: cached.password })
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

ipcMain.handle('ssh:privilege-verify', async (event, config, privilege = {}) => {
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
  })
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

ipcMain.handle('ssh:shell:write', async (_event, sessionId, data) => {
  const session = shellSessions.get(sessionId)
  if (!session?.stream) return { ok: false, message: 'Terminal session is not connected' }
  session.stream.write(data)
  return { ok: true }
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

ipcMain.handle('ssh:inspect', async (_event, config) => {
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

  return withSshClient(config, (client) => execCommand(client, command))
})

ipcMain.handle('sftp:list', async (_event, config, targetPath = '/') => {
  return withSshClient(config, (client) => listRemoteDirectory(client, targetPath))
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
  let result = await withSshClient(config, (client) => uploadRemoteFile(client, localPath, remotePath, progress))
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

ipcMain.handle('sftp:upload-path', async (event, config, localPath, remotePath) => {
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
  let result = await withSshClient(config, (client) => (
    stats.isDirectory()
      ? uploadRemoteDirectory(client, localPath, targetRemotePath, progress)
      : uploadRemoteFile(client, localPath, targetRemotePath, progress)
  ))
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
  return withSshClient(config, (client) => downloadRemoteFile(client, remotePath, picked.filePath, {
    id: transferId,
    type: 'download',
    name: posix.basename(remotePath),
    localPath: picked.filePath,
    remotePath,
    webContents: event.sender
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
      : await withSshClient(config, (client) => downloadRemoteFile(client, remotePath, localPath, {
          id: `download-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: 'download',
          name: posix.basename(remotePath),
          localPath,
          remotePath,
          webContents: event.sender
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

ipcMain.handle('sftp:download-path', async (event, config, remotePath, localPath) => {
  if (!remotePath || !localPath) return { ok: false, message: 'Remote path and local path are required' }
  mkdirSync(dirname(localPath), { recursive: true })
  const transferId = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return withSshClient(config, (client) => downloadRemoteFile(client, remotePath, localPath, {
    id: transferId,
    type: 'download',
    name: posix.basename(remotePath),
    localPath,
    remotePath,
    webContents: event.sender
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
    session.client?.end()
  } catch {
    // The transfer callback will still settle the task.
  }
  return { ok: true, message: 'Transfer canceled' }
})

ipcMain.handle('sftp:read-file', async (_event, config, remotePath) => {
  return withSshClient(config, (client) => readRemoteTextFile(client, remotePath))
})

ipcMain.handle('sftp:privileged-read-file', async (event, config, remotePath, privilege = {}) => {
  return readPrivilegedRemoteTextFile(event.sender, config, remotePath, privilege)
})

ipcMain.handle('sftp:write-file', async (_event, config, remotePath, content) => {
  return withSshClient(config, (client) => writeRemoteTextFile(client, remotePath, content))
})

ipcMain.handle('sftp:create-file', async (_event, config, parentPath, name) => {
  try {
    const targetPath = buildNewRemoteItemPath(parentPath, name)
    return withSshClient(config, (client) => createRemoteFile(client, targetPath))
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:create-directory', async (_event, config, parentPath, name) => {
  try {
    const targetPath = buildNewRemoteItemPath(parentPath, name)
    return withSshClient(config, (client) => createRemoteDirectory(client, targetPath))
  } catch (error) {
    return { ok: false, message: error.message }
  }
})

ipcMain.handle('sftp:rename', async (_event, config, sourcePath, newName) => {
  try {
    const paths = buildRenamedRemoteItemPaths(sourcePath, newName)
    return withSshClient(config, (client) => renameRemoteItem(client, paths.sourcePath, paths.targetPath))
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

ipcMain.handle('sftp:write-binary-file', async (_event, config, remotePath, contentBase64) => {
  return withSshClient(config, (client) => writeRemoteBufferFile(client, remotePath, Buffer.from(contentBase64 || '', 'base64')))
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
  return withSshClient(config, (client) => deleteRemoteItem(client, remotePath, type, progress))
})

ipcMain.handle('sftp:privileged-delete', async (event, config, remotePath, type, privilege = {}) => {
  return deletePrivilegedRemoteItem(event.sender, config, remotePath, type, privilege)
})

ipcMain.handle('db:test', async (_event, config) => {
  return withDatabase(config, async () => ({ ok: true, message: 'Database connected' }))
})

ipcMain.handle('db:inspect', async (_event, config) => {
  return withDatabase(config, async (connection) => {
    if (config.engine === 'postgres') {
      const result = await connection.query(`
        select table_schema, table_name
        from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name
        limit 200
      `)
      return { ok: true, tables: result.rows }
    }

    if (config.engine === 'sqlserver') {
      const result = await connection.request().query(`
        select top 200 TABLE_SCHEMA as table_schema, TABLE_NAME as table_name
        from INFORMATION_SCHEMA.TABLES
        where TABLE_TYPE = 'BASE TABLE'
        order by TABLE_SCHEMA, TABLE_NAME
      `)
      return { ok: true, tables: result.recordset }
    }

    if (isOracleLikeEngine(config.engine)) {
      const result = await executeOracleLike(connection, config.engine, `
        select OWNER as table_schema, TABLE_NAME as table_name
        from ALL_TABLES
        where OWNER not in ('SYS', 'SYSTEM', 'SYSAUDITOR', 'SYSSSO', 'CTISYS', 'MDSYS', 'ORDSYS', 'XDB')
        order by OWNER, TABLE_NAME
        fetch first 200 rows only
      `)
      return { ok: true, tables: result.rows }
    }

    const [rows] = await connection.query(`
      select table_schema, table_name
      from information_schema.tables
      where table_schema not in ('mysql', 'performance_schema', 'sys', 'information_schema')
      order by table_schema, table_name
      limit 200
    `)
    return { ok: true, tables: rows }
  })
})

ipcMain.handle('db:columns', async (_event, config, table) => {
  return withDatabase(config, async (connection) => {
    if (config.engine === 'postgres') {
      const result = await connection.query(
        `
          select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = $1 and table_name = $2
          order by ordinal_position
        `,
        [table.schema, table.name]
      )
      return { ok: true, columns: result.rows }
    }

    if (config.engine === 'sqlserver') {
      const request = connection.request()
      request.input('schema', mssql.NVarChar, table.schema)
      request.input('name', mssql.NVarChar, table.name)
      const result = await request.query(`
        select
          COLUMN_NAME as column_name,
          DATA_TYPE as data_type,
          IS_NULLABLE as is_nullable,
          COLUMN_DEFAULT as column_default
        from INFORMATION_SCHEMA.COLUMNS
        where TABLE_SCHEMA = @schema and TABLE_NAME = @name
        order by ORDINAL_POSITION
      `)
      return { ok: true, columns: result.recordset }
    }

    if (isOracleLikeEngine(config.engine)) {
      const result = await executeOracleLike(
        connection,
        config.engine,
        `
          select
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            NULLABLE as is_nullable,
            DATA_DEFAULT as column_default
          from ALL_TAB_COLUMNS
          where OWNER = :schema and TABLE_NAME = :name
          order by COLUMN_ID
        `,
        { schema: table.schema, name: table.name }
      )
      return { ok: true, columns: result.rows }
    }

    const [rows] = await connection.query(
      `
        select column_name, column_type as data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = ? and table_name = ?
        order by ordinal_position
      `,
      [table.schema, table.name]
    )
    return { ok: true, columns: rows }
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

ipcMain.handle('db:exec', async (_event, config, sql) => {
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
  const task = {
    webContents: event.sender,
    id: options.taskId || `sql-file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'sql-file',
    name: options.fileName || 'SQL file',
    localPath: options.filePath || '',
    remotePath: `${config.name || config.engine || 'database'} / ${config.database || ''}`,
    total: statements.length
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
  emitTransferProgress(task, {
    transferred: result.ok ? statements.length : Number(result.completedStatements || 0),
    status: result.ok ? 'done' : result.canceled && !result.rollbackFailed ? 'cancelled' : 'failed',
    message: result.ok ? `${statements.length} SQL batch(es) completed` : result.message
  })
  return { ...result, script: true, statementCount: statements.length }
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
  emitTransferProgress(session.task, {
    transferred: session.completedStatements,
    status: 'running',
    message: 'Stop requested; waiting for the current SQL batch before rollback'
  })
  return { ok: true, message: 'Stop requested' }
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

function withSshClient(config, task) {
  return new Promise((resolve) => {
    const client = new Client()
    const connection = buildSshConnection(config)
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
      .connect(connection)
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

function execStreamingCommand(webContents, config, command, requestedExecutionId, privilege = { mode: 'normal', password: '' }) {
  return new Promise((resolve) => {
    const executionId = requestedExecutionId || `ssh-exec-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const privilegeMode = ['sudo', 'su'].includes(privilege?.mode) ? privilege.mode : 'normal'
    const cachedPrivilege = workflowPrivilegeCredentials.get(workflowPrivilegeKey(config, privilegeMode))
    const privilegePassword = String(privilege?.password || cachedPrivilege?.password || '')
    const privilegePromptToken = privilegeMode !== 'normal' && privilegePassword
      ? `__OPS_PRIVILEGE_READY_${executionId.replace(/[^a-zA-Z0-9]/g, '_')}__`
      : ''
    const preparedCommand = buildStreamingPrivilegeCommand(command, privilegeMode, privilegePromptToken, Boolean(privilegePassword))
    const client = new Client()
    let stream = null
    let stdout = ''
    let stderr = ''
    let settled = false
    let canceled = false
    let cancelTimer = null
    let privilegePasswordSent = false
    let privilegeOutputBuffer = ''
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

    const sendVisibleData = (streamName, data) => {
      const text = String(data || '')
      if (!privilegePromptToken || privilegePasswordSent) {
        send(streamName, text)
        return
      }

      const combined = `${privilegeOutputBuffer}${text}`
      const tokenIndex = combined.indexOf(privilegePromptToken)
      if (tokenIndex >= 0) {
        const visible = `${combined.slice(0, tokenIndex)}${combined.slice(tokenIndex + privilegePromptToken.length)}`
          .replace(/^\r?\n/, '')
        privilegeOutputBuffer = ''
        privilegePasswordSent = true
        try {
          stream?.write(`${privilegePassword}\n`)
        } catch {
          // The command close handler will report a failed privilege switch.
        }
        if (visible) send(streamName, visible)
        return
      }

      const retainedLength = Math.min(privilegePromptToken.length - 1, combined.length)
      const visibleLength = combined.length - retainedLength
      if (visibleLength > 0) send(streamName, combined.slice(0, visibleLength))
      privilegeOutputBuffer = combined.slice(visibleLength)
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (cancelTimer) clearTimeout(cancelTimer)
      sshExecSessions.delete(executionId)
      try {
        client.end()
      } catch {
        // The SSH client may already be closed after a remote exit.
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

    client
      .on('ready', () => {
        if (canceled) {
          finish({ ok: false, canceled: true, code: null, stdout, stderr, message: 'Command canceled' })
          return
        }
        client.exec(wrapInteractiveCommand(preparedCommand), { pty: true }, (error, channel) => {
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
      })
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
      .connect(buildSshConnection(config))
  })
}

function buildStreamingPrivilegeCommand(command, mode = 'normal', promptToken = '', hasPassword = false) {
  if (mode === 'sudo') {
    const innerCommand = `bash -lc ${shellQuote(command)} </dev/null`
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
    const rootCommand = `bash -lc ${shellQuote(command)} </dev/null`
    if (!hasPassword) return `LC_ALL=C su - root -c ${shellQuote(rootCommand)}`
    return [
      'stty -echo',
      `printf '%s\\n' ${shellQuote(promptToken)}`,
      `LC_ALL=C su - root -c ${shellQuote(rootCommand)}`,
      '__ops_privilege_status=$?',
      'stty echo',
      'exit $__ops_privilege_status'
    ].join('\n')
  }

  return command
}

function workflowPrivilegeKey(config = {}, mode = 'normal') {
  return [config.host || '', Number(config.port || 22), config.username || '', mode].join(':')
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

            shellSessions.set(sessionId, { client, stream, webContentsId: webContents.id })
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
              .stderr?.on('data', (data) => send('ssh:shell:data', { data: data.toString('utf8') }))

            finish({ ok: true, sessionId })
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
      .connect(buildSshConnection(config))
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

function pasteClipboardToShell(webContents) {
  const sessionId = shellSessionsByWebContents.get(webContents.id)
  const session = shellSessions.get(sessionId)
  const text = clipboard.readText()
  if (!session?.stream || !text) return
  session.stream.write(text)
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
        sftp?.end()
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
        else finish(putError ? { ok: false, message: putError.message } : { ok: true })
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
  const command = type === 'dir'
    ? `test -d ${shellQuote(normalizedPath)} && rm -rf -- ${shellQuote(normalizedPath)}`
    : `test -e ${shellQuote(normalizedPath)} && rm -f -- ${shellQuote(normalizedPath)}`
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
        const owners = await getRemoteOwners(client, targetPath)
        if (settled) return
        const items = list
          .filter((item) => item.filename !== '.' && item.filename !== '..')
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
        sftp?.end()
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
          finish({ ok: false, message: putError.message, localPath, remotePath }, { status: 'failed', message: putError.message })
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
        sftp?.end()
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
        else finish({ ok: false, message: uploadError.message, localPath, remotePath }, { status: 'failed', message: uploadError.message })
      }
    })
  })
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
  const payload = {
    id: progress.id,
    type: progress.type,
    name: progress.name,
    localPath: progress.localPath,
    remotePath: progress.remotePath,
    total: progress.total,
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
      currentRemotePath: '',
      cancelTransfer: null
    }
    fileTransferSessions.set(progress.id, session)
  }
  session.progress = progress
  session.client = client || session.client
  session.sftp = sftp || session.sftp
  return session
}

function finishFileTransferSession(progress, session) {
  if (!progress?.id || !session) return
  if (fileTransferSessions.get(progress.id) === session) fileTransferSessions.delete(progress.id)
  session.cancelTransfer = null
  session.sftp = null
  session.client = null
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
    client.sftp((error, sftp) => {
      if (error) {
        resolve({ ok: false, message: error.message })
        return
      }

      sftp.stat(remotePath, (statError, attrs) => {
        if (statError) {
          resolve({ ok: false, message: statError.message })
          return
        }
        if (attrs?.size > maxBytes) {
          resolve({ ok: false, message: 'File is larger than 2 MB. Download it instead.' })
          return
        }

        const chunks = []
        const stream = sftp.createReadStream(remotePath)
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('error', (streamError) => resolve({ ok: false, message: streamError.message }))
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks)
          if (buffer.includes(0)) {
            resolve({ ok: false, message: 'Binary file preview is not supported.' })
            return
          }
          resolve({ ok: true, path: remotePath, content: buffer.toString('utf8'), size: attrs?.size || buffer.length })
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
    client.sftp((error, sftp) => {
      if (error) {
        resolve({ ok: false, message: error.message, path: remotePath })
        return
      }
      sftp.open(remotePath, 'wx', 0o644, (openError, handle) => {
        if (openError) {
          resolve({ ok: false, message: openError.message, path: remotePath })
          return
        }
        sftp.close(handle, (closeError) => {
          resolve(closeError
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
    client.sftp((error, sftp) => {
      if (error) {
        resolve({ ok: false, message: error.message, sourcePath, path: targetPath })
        return
      }
      sftp.lstat(targetPath, (targetError) => {
        if (!targetError) {
          resolve({ ok: false, message: `Target already exists: ${targetPath}`, sourcePath, path: targetPath })
          return
        }
        if (!isRemotePathMissingError(targetError)) {
          resolve({ ok: false, message: targetError.message, sourcePath, path: targetPath })
          return
        }
        sftp.rename(sourcePath, targetPath, (renameError) => {
          resolve(renameError
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
    })
  })
}

async function deleteRemoteItemWithProgress(sftp, remotePath, type, progress) {
  if (type !== 'dir') {
    await sftpUnlink(sftp, remotePath)
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
      status: deleted === total ? 'done' : 'running',
      currentPath: entry.path
    })
  }

  return { ok: true, message: 'Deleted', path: remotePath, deletedCount: deleted }
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
  let text = String(statement || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '')
  if (hashComments) text = text.replace(/^\s*#.*$/gm, '')
  return Boolean(text.trim())
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
      return stopDatabaseScript(connection, config, transaction, task, index)
    }
    emitTransferProgress(task, {
      transferred: index,
      status: 'running',
      message: `Executing SQL batch ${index + 1}/${statements.length}`
    })
    try {
      lastResult = await executeDatabaseBatch(connection, config, statements[index], transaction)
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
            completedStatements: index,
            failedStatement: index + 1,
            message: `SQL batch ${index + 1}/${statements.length} failed: ${error.message}; transaction rolled back`
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
    return stopDatabaseScript(connection, config, transaction, task, statements.length)
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
          completedStatements: statements.length,
          message: `Transaction commit failed: ${error.message}; transaction rolled back`
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

async function stopDatabaseScript(connection, config, transaction, task, completedStatements) {
  if (!transaction) {
    return {
      ok: false,
      canceled: true,
      completedStatements,
      message: 'Stopped by user after the current SQL batch; rollback was not enabled'
    }
  }
  emitTransferProgress(task, {
    transferred: completedStatements,
    status: 'running',
    message: 'Stop accepted; rolling back the transaction'
  })
  try {
    await rollbackDatabaseScriptTransaction(connection, config, transaction)
    return {
      ok: false,
      canceled: true,
      rolledBack: true,
      completedStatements,
      message: 'Stopped by user; transaction rolled back'
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

function withDatabaseViaSsh(config, task) {
  return withSshClient(config.sshConfig, async (sshClient) => {
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
    const dmdb = await loadDmdbDriver()
    const connection = await withTimeout(
      dmdb.getConnection({
        user: config.username,
        password: config.password,
        connectString: `${config.host}:${Number(config.port || 5236)}`
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

  const connection = await withTimeout(
    mysql.createConnection({
      host: config.host,
      port: Number(config.port || 3306),
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
    return result.rows.map((row) => row.column_name)
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
    return result.recordset.map((row) => row.column_name)
  }
  if (isOracleLikeEngine(config.engine)) {
    const result = await executeOracleLike(connection, config.engine, `
      select COLUMN_NAME as column_name
      from ALL_TAB_COLUMNS
      where OWNER = :schema and TABLE_NAME = :name
      order by COLUMN_ID
    `, { schema: table.schema, name: table.name })
    return result.rows.map((row) => row.column_name || row.COLUMN_NAME)
  }
  const [rows] = await connection.query(
    `select column_name from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
    [table.schema, table.name]
  )
  return rows.map((row) => row.column_name)
}

async function buildPostgresCreateTableSql(connection, table) {
  const result = await connection.query(
    `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
    [table.schema, table.name]
  )
  const columns = result.rows.map((column) => {
    const nullable = column.is_nullable === 'NO' ? ' NOT NULL' : ''
    const defaultValue = column.column_default ? ` DEFAULT ${column.column_default}` : ''
    return `  "${column.column_name}" ${column.data_type}${defaultValue}${nullable}`
  })
  return `CREATE TABLE IF NOT EXISTS ${quotePostgresTable(table)} (\n${columns.join(',\n')}\n);`
}

async function buildSqlServerCreateTableSql(connection, table) {
  const request = connection.request()
  request.input('schema', mssql.NVarChar, table.schema)
  request.input('name', mssql.NVarChar, table.name)
  const result = await request.query(`
    select COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default
    from INFORMATION_SCHEMA.COLUMNS
    where TABLE_SCHEMA = @schema and TABLE_NAME = @name
    order by ORDINAL_POSITION
  `)
  const columns = result.recordset.map((column) => {
    const nullable = column.is_nullable === 'NO' ? ' NOT NULL' : ''
    const defaultValue = column.column_default ? ` DEFAULT ${column.column_default}` : ''
    return `  ${quoteSqlServerIdentifier(column.column_name)} ${column.data_type}${defaultValue}${nullable}`
  })
  return `CREATE TABLE ${quoteSqlServerTable(table)} (\n${columns.join(',\n')}\n);`
}

async function buildOracleLikeCreateTableSql(connection, config, table) {
  const result = await executeOracleLike(connection, config.engine, `
    select COLUMN_NAME as column_name, DATA_TYPE as data_type, NULLABLE as is_nullable, DATA_DEFAULT as column_default
    from ALL_TAB_COLUMNS
    where OWNER = :schema and TABLE_NAME = :name
    order by COLUMN_ID
  `, { schema: table.schema, name: table.name })
  const columns = result.rows.map((column) => {
    const name = column.column_name || column.COLUMN_NAME
    const type = column.data_type || column.DATA_TYPE
    const nullable = (column.is_nullable || column.IS_NULLABLE) === 'N' ? ' NOT NULL' : ''
    const rawDefault = column.column_default ?? column.COLUMN_DEFAULT
    const defaultValue = rawDefault ? ` DEFAULT ${String(rawDefault).trim()}` : ''
    return `  ${quoteOracleLikeIdentifier(name)} ${type}${defaultValue}${nullable}`
  })
  return `CREATE TABLE ${quoteOracleLikeTable(table)} (\n${columns.join(',\n')}\n);`
}

function buildInsertSql(config, table, row) {
  const columns = Object.keys(row)
  const tableName = quoteTable(config, table)
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
  const driver = engine === 'dm' ? await loadDmdbDriver() : oracledb
  const result = await connection.execute(sql, binds, {
    outFormat: driver.OUT_FORMAT_OBJECT,
    ...options
  })
  return {
    ...result,
    rows: result.rows || []
  }
}

async function loadDmdbDriver() {
  if (!dmdbDriverPromise) {
    dmdbDriverPromise = import('dmdb')
      .then((module) => module.default || module)
      .catch((error) => {
        dmdbDriverPromise = null
        const message = 'Dameng database support requires the vendor dmdb driver. It is not bundled with the public Ops Flow Plus distribution; install and license it separately before building a DM-enabled package.'
        const driverError = new Error(message)
        driverError.cause = error
        throw driverError
      })
  }
  return dmdbDriverPromise
}

async function withRedis(config, task) {
  if (config.connectionMode === 'ssh') {
    return withRedisViaSsh(config, task)
  }

  return withRedisConnection(config, task)
}

async function withRedisViaSsh(config, task) {
  if (!config.sshConfig) {
    return { ok: false, message: 'SSH configuration is missing. Connect the server first, or use Direct connection.' }
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
      socket.on('close', () => sockets.delete(socket))
      sshClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
        if (error) {
          socket.destroy(error)
          return
        }
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
