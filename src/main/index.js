import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard } from 'electron'
import { basename, dirname, join, posix } from 'node:path'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import Store from 'electron-store'
import { Client } from 'ssh2'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { createClient as createRedisClient } from 'redis'

const shellSessions = new Map()
const shellSessionsByWebContents = new Map()

const store = new Store({
  name: 'ops-flow',
  defaults: {
    resources: [],
    servers: [],
    databases: [],
    redisStores: [],
    redis: []
  }
})

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

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer:load-failed] ${errorCode} ${errorDescription} ${validatedURL}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer:gone] ${details.reason}`)
  })

  if (process.env.OPS_FLOW_DEBUG_RENDERER === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('store:get', (_event, key) => store.get(key))
ipcMain.handle('store:set', (_event, key, value) => {
  store.set(key, value)
  return value
})

ipcMain.handle('clipboard:read-text', () => clipboard.readText())
ipcMain.handle('clipboard:write-text', (_event, text) => {
  clipboard.writeText(String(text ?? ''))
  return { ok: true }
})

ipcMain.handle('ssh:test', async (_event, config) => {
  return withSshClient(config, async () => ({ ok: true, message: 'SSH connected' }))
})

ipcMain.handle('ssh:exec', async (_event, config, command) => {
  return withSshClient(config, (client) => execCommand(client, wrapInteractiveCommand(command), { pty: true }))
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

ipcMain.handle('sftp:upload', async (event, config, targetDirectory = '/') => {
  const window = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
  const picked = await dialog.showOpenDialog(window, {
    title: 'Select file to upload',
    properties: ['openFile']
  })

  if (picked.canceled || !picked.filePaths.length) {
    return { ok: false, canceled: true, message: 'Upload canceled' }
  }

  const localPath = picked.filePaths[0]
  const remotePath = joinRemotePath(targetDirectory, basename(localPath))
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
  return withSshClient(config, (client) => uploadRemoteFile(client, localPath, remotePath, {
    id: transferId,
    type: 'upload',
    name: basename(localPath),
    localPath,
    remotePath,
    total,
    webContents: event.sender
  }))
})

ipcMain.handle('sftp:upload-path', async (event, config, localPath, remotePath) => {
  if (!localPath || !remotePath) return { ok: false, message: 'Local path and remote path are required' }
  let stats
  try {
    stats = statSync(localPath)
  } catch (error) {
    return { ok: false, message: error.message }
  }
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
  return withSshClient(config, (client) => (
    stats.isDirectory()
      ? uploadRemoteDirectory(client, localPath, remotePath, progress)
      : uploadRemoteFile(client, localPath, remotePath, progress)
  ))
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

ipcMain.handle('sftp:read-file', async (_event, config, remotePath) => {
  return withSshClient(config, (client) => readRemoteTextFile(client, remotePath))
})

ipcMain.handle('sftp:write-file', async (_event, config, remotePath, content) => {
  return withSshClient(config, (client) => writeRemoteTextFile(client, remotePath, content))
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

    const [rows] = await connection.query(sql)
    return { ok: true, rows }
  })
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

    client
      .on('ready', async () => {
        try {
          const result = await task(client)
          resolve(result)
        } catch (error) {
          resolve({ ok: false, message: error.message })
        } finally {
          client.end()
        }
      })
      .on('error', (error) => {
        resolve({ ok: false, message: error.message })
      })
      .connect(connection)
  })
}

function buildSshConnection(config) {
  const connection = {
    host: config.host,
    port: Number(config.port || 22),
    username: config.username,
    readyTimeout: 30000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3
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
    const { timeoutMs = 0, ...sshOptions } = options
    let settled = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    client.exec(command, sshOptions, (error, stream) => {
      if (error) {
        finish({ ok: false, message: error.message, stdout: '', stderr: '' })
        return
      }

      let stdout = ''
      let stderr = ''

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          stream.close()
          finish({ ok: false, code: -1, stdout, stderr, message: `Command timed out after ${Math.round(timeoutMs / 1000)}s` })
        }, timeoutMs)
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

function startShellSession(webContents, config, size = {}) {
  return new Promise((resolve) => {
    const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const client = new Client()
    let settled = false

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

    const cleanup = () => {
      const sessionIds = shellSessionsByWebContents.get(webContents.id)
      if (sessionIds) {
        sessionIds.delete(sessionId)
        if (!sessionIds.size) shellSessionsByWebContents.delete(webContents.id)
      } else if (shellSessionsByWebContents.get(webContents.id) === sessionId) {
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
            const sessionIds = shellSessionsByWebContents.get(webContents.id) || new Set()
            sessionIds.add(sessionId)
            shellSessionsByWebContents.set(webContents.id, sessionIds)
            webContents.once('destroyed', () => closeShellSession(sessionId))

            stream
              .on('data', (data) => {
                const text = data.toString('utf8')
                send('ssh:shell:data', { data: text })
              })
              .on('close', () => {
                send('ssh:shell:close', {
                  message: 'Connection closed. Idle timeout or remote host disconnected.'
                })
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
        finish({ ok: false, message: error.message })
      })
      .on('close', () => {
        send('ssh:shell:close', {
          message: 'Connection closed. Idle timeout or remote host disconnected.'
        })
        cleanup()
      })
      .connect(buildSshConnection(config))
  })
}

function closeShellSession(sessionId) {
  const session = shellSessions.get(sessionId)
  if (!session) return
  shellSessions.delete(sessionId)
  const sessionIds = shellSessionsByWebContents.get(session.webContentsId)
  if (sessionIds) {
    sessionIds.delete(sessionId)
    if (!sessionIds.size) shellSessionsByWebContents.delete(session.webContentsId)
  } else if (shellSessionsByWebContents.get(session.webContentsId) === sessionId) {
    shellSessionsByWebContents.delete(session.webContentsId)
  }
  session.stream?.end()
  session.client?.end()
}

function pasteClipboardToShell(webContents) {
  const value = shellSessionsByWebContents.get(webContents.id)
  const sessionId = value instanceof Set ? Array.from(value).at(-1) : value
  const session = shellSessions.get(sessionId)
  const text = clipboard.readText()
  if (!session?.stream || !text) return
  session.stream.write(text)
}

function listRemoteDirectory(client, targetPath) {
  return new Promise((resolve) => {
    client.sftp((error, sftp) => {
      if (error) {
        resolve({ ok: false, message: error.message, path: targetPath, items: [] })
        return
      }

      sftp.readdir(targetPath, async (readError, list) => {
        if (readError) {
          resolve({ ok: false, message: readError.message, path: targetPath, items: [] })
          return
        }

        const owners = await getRemoteOwners(client, targetPath)
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

        resolve({ ok: true, path: targetPath, items })
      })
    })
  })
}

async function getRemoteOwners(client, targetPath) {
  const quotedPath = shellQuote(targetPath || '/')
  const command = `find ${quotedPath} -maxdepth 1 -mindepth 1 -printf '%f\\t%u:%g\\n' 2>/dev/null`
  const result = await execCommand(client, command)
  if (!result.ok || !result.stdout) return {}

  return result.stdout.split(/\r?\n/).reduce((owners, line) => {
    const [name, owner] = line.split('\t')
    if (name && owner) owners[name] = owner
    return owners
  }, {})
}

function uploadRemoteFile(client, localPath, remotePath, progress = null) {
  return new Promise((resolve) => {
    client.sftp((error, sftp) => {
      if (error) {
        emitTransferProgress(progress, { status: 'failed', message: error.message })
        resolve({ ok: false, message: error.message })
        return
      }

      sftp.fastPut(localPath, remotePath, {
        step: (transferred) => {
          emitTransferProgress(progress, { transferred, status: 'running' })
        }
      }, (putError) => {
        if (putError) {
          emitTransferProgress(progress, { status: 'failed', message: putError.message })
          resolve({ ok: false, message: putError.message, localPath, remotePath })
          return
        }
        emitTransferProgress(progress, { transferred: progress?.total || 0, status: 'done' })
        resolve({ ok: true, message: 'Upload completed', localPath, remotePath })
      })
    })
  })
}

function uploadRemoteDirectory(client, localPath, remotePath, progress = null) {
  return new Promise((resolve) => {
    client.sftp(async (error, sftp) => {
      if (error) {
        emitTransferProgress(progress, { status: 'failed', message: error.message })
        resolve({ ok: false, message: error.message })
        return
      }

      try {
        let transferredTotal = 0
        await ensureRemoteDirectory(sftp, remotePath)
        const uploadEntry = async (localEntry, remoteEntry) => {
          const stats = statSync(localEntry)
          if (stats.isDirectory()) {
            await ensureRemoteDirectory(sftp, remoteEntry)
            for (const child of readdirSync(localEntry)) {
              await uploadEntry(join(localEntry, child), posix.join(remoteEntry, child))
            }
            return
          }
          await uploadFileWithSftp(sftp, localEntry, remoteEntry, {
            ...progress,
            onStep: (transferred) => {
              emitTransferProgress(progress, { transferred: transferredTotal + transferred, status: 'running' })
            }
          })
          transferredTotal += stats.size
          emitTransferProgress(progress, { transferred: transferredTotal, status: 'running' })
        }

        for (const child of readdirSync(localPath)) {
          await uploadEntry(join(localPath, child), posix.join(remotePath, child))
        }
        emitTransferProgress(progress, { transferred: progress?.total || transferredTotal, status: 'done' })
        resolve({ ok: true, message: 'Directory upload completed', localPath, remotePath })
      } catch (uploadError) {
        emitTransferProgress(progress, { status: 'failed', message: uploadError.message })
        resolve({ ok: false, message: uploadError.message, localPath, remotePath })
      }
    })
  })
}

function uploadFileWithSftp(sftp, localPath, remotePath, progress = null) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (transferred) => progress?.onStep?.(transferred)
    }, (error) => {
      if (error) reject(error)
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

function downloadRemoteFile(client, remotePath, localPath, progress = null) {
  return new Promise((resolve) => {
    client.sftp((error, sftp) => {
      if (error) {
        emitTransferProgress(progress, { status: 'failed', message: error.message })
        resolve({ ok: false, message: error.message })
        return
      }

      sftp.stat(remotePath, (statError, attrs) => {
        if (statError) {
          emitTransferProgress(progress, { status: 'failed', message: statError.message })
          resolve({ ok: false, message: statError.message, localPath, remotePath })
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
            emitTransferProgress(transferProgress, { transferred, status: 'running' })
          }
        }, (getError) => {
          if (getError) {
            emitTransferProgress(transferProgress, { status: 'failed', message: getError.message })
            resolve({ ok: false, message: getError.message, localPath, remotePath })
            return
          }
          emitTransferProgress(transferProgress, { transferred: total, status: 'done' })
          resolve({ ok: true, message: 'Download completed', localPath, remotePath })
        })
      })
    })
  })
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

function joinRemotePath(directory, filename) {
  if (!directory || directory === '/') return `/${filename}`
  return `${directory.replace(/\/+$/g, '')}/${filename}`
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
    const stream = await withTimeout(
      openSshForward(sshClient, config.host, Number(config.port || defaultDatabasePort(config.engine))),
      12000,
      'SSH tunnel timed out while opening database channel'
    )
    return withDatabaseConnection({ ...config, stream }, task)
  })
}

function openSshForward(client, host, port) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stream)
    })
  })
}

async function withDatabaseConnection(config, task) {
  if (config.engine === 'postgres') {
    const client = new pg.Client({
      host: config.stream ? undefined : config.host,
      port: config.stream ? undefined : Number(config.port || 5432),
      stream: config.stream,
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

  const connection = await withTimeout(
    mysql.createConnection({
      host: config.host,
      port: Number(config.port || 3306),
      stream: config.stream,
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

function buildInsertSql(config, table, row) {
  const columns = Object.keys(row)
  const tableName = config.engine === 'postgres' ? quotePostgresTable(table) : quoteMysqlTable(table)
  const columnSql = columns.map((column) => config.engine === 'postgres' ? `"${column.replace(/"/g, '""')}"` : `\`${column.replace(/`/g, '``')}\``).join(', ')
  const values = columns.map((column) => sqlLiteral(row[column])).join(', ')
  return `INSERT INTO ${tableName} (${columnSql}) VALUES (${values});`
}

function quoteMysqlTable(table) {
  return `\`${String(table.schema).replace(/`/g, '``')}\`.\`${String(table.name).replace(/`/g, '``')}\``
}

function quotePostgresTable(table) {
  return `"${String(table.schema).replace(/"/g, '""')}"."${String(table.name).replace(/"/g, '""')}"`
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
  return engine === 'postgres' ? 5432 : 3306
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
