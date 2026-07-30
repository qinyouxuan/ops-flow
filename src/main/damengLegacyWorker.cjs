// SPDX-License-Identifier: MPL-2.0

const Module = require('module')
const path = require('path')

let connection = null
let closing = false
const DAMENG_IPC_TYPE_KEY = '__opsFlowDamengIpcType'

function encodeIpcValue(value, ancestors) {
  const parents = ancestors || new WeakSet()
  if (value === undefined) {
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'undefined'
    return marker
  }
  if (typeof value === 'bigint') {
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'bigint'
    marker.value = value.toString()
    return marker
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'number'
    marker.value = String(value)
    return marker
  }
  if (value === null || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) {
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'buffer'
    marker.value = value.toString('base64')
    return marker
  }
  if (value instanceof Date) {
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'date'
    marker.value = value.toISOString()
    return marker
  }
  if (Array.isArray(value)) {
    if (parents.has(value)) {
      const marker = {}
      marker[DAMENG_IPC_TYPE_KEY] = 'circular'
      return marker
    }
    parents.add(value)
    try {
      return value.map(function (item) {
        return encodeIpcValue(item, parents)
      })
    } finally {
      parents.delete(value)
    }
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype && prototype !== Object.prototype) {
    const constructorName = String((value.constructor && value.constructor.name) || 'Value')
    try {
      const text = String(value)
      if (text && text !== '[object Object]' && text !== '[object ' + constructorName + ']') {
        const marker = {}
        marker[DAMENG_IPC_TYPE_KEY] = 'text'
        marker.value = text
        return marker
      }
    } catch (_error) {
      // Fall through to a safe type placeholder.
    }
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'text'
    marker.value = '[' + constructorName + ']'
    return marker
  }
  if (parents.has(value)) {
    const marker = {}
    marker[DAMENG_IPC_TYPE_KEY] = 'circular'
    return marker
  }

  parents.add(value)
  try {
    const output = {}
    Object.keys(value).forEach(function (key) {
      output[key] = encodeIpcValue(value[key], parents)
    })
    return output
  } finally {
    parents.delete(value)
  }
}

function decodeIpcValue(value) {
  if (Array.isArray(value)) return value.map(decodeIpcValue)
  if (!value || typeof value !== 'object') return value
  const type = value[DAMENG_IPC_TYPE_KEY]
  if (type === 'undefined') return undefined
  if (type === 'bigint') return BigInt(value.value)
  if (type === 'number') return Number(value.value)
  if (type === 'buffer') return Buffer.from(String(value.value || ''), 'base64')
  if (type === 'date') return new Date(value.value)
  if (type === 'text') return String(value.value || '')
  if (type === 'circular') return '[Circular]'
  const output = {}
  Object.keys(value).forEach(function (key) {
    output[key] = decodeIpcValue(value[key])
  })
  return output
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map(function (row) {
    if (!row || Array.isArray(row) || Object.getPrototypeOf(row) === Object.prototype) return row
    const output = {}
    Object.keys(row).forEach(function (key) {
      output[key] = row[key]
    })
    return output
  })
}

function serializeError(error) {
  return {
    name: String((error && error.name) || 'Error'),
    message: String((error && error.message) || error || 'Unknown Dameng worker error'),
    stack: error && typeof error.stack === 'string' ? error.stack : '',
    code: error && error.code,
    errorNum: error && error.errorNum
  }
}

function sendResponse(id, payload) {
  if (!process.connected) return
  if (process.send) process.send(encodeIpcValue(Object.assign({ id: id }, payload)))
}

function loadExternalDriver(driverPath) {
  const packagePath = path.resolve(String(driverPath || ''))
  const previousNodePath = process.env.NODE_PATH
  const previousGlobalPaths = Module.globalPaths.slice()
  process.env.NODE_PATH = [path.dirname(packagePath), previousNodePath].filter(Boolean).join(path.delimiter)
  Module._initPaths()
  try {
    const externalRequire = Module.createRequire(path.join(packagePath, 'package.json'))
    const loaded = externalRequire(packagePath)
    const driver = loaded && loaded.default ? loaded.default : loaded
    if (!driver || typeof driver.getConnection !== 'function') {
      throw new Error('The selected dmdb package does not expose getConnection().')
    }
    return driver
  } finally {
    if (previousNodePath === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = previousNodePath
    Module.globalPaths.splice.apply(Module.globalPaths, [0, Module.globalPaths.length].concat(previousGlobalPaths))
  }
}

async function closeConnection() {
  if (closing) return
  closing = true
  try {
    if (connection && typeof connection.close === 'function') await connection.close()
  } finally {
    connection = null
  }
}

async function handleRequest(message) {
  const id = String((message && message.id) || '')
  try {
    if (message && message.command === 'connect') {
      if (connection) throw new Error('Dameng worker is already connected.')
      const driver = loadExternalDriver(message.driverPath)
      const target = message.connection || {}
      connection = await driver.getConnection({
        user: target.username,
        password: target.password,
        connectString: String(target.host || '') + ':' + Number(target.port || 5236)
      })
      sendResponse(id, {
        ok: true,
        result: {
          outFormatObject: driver.OUT_FORMAT_OBJECT,
          nodeVersion: process.version,
          opensslVersion: process.versions.openssl || ''
        }
      })
      return
    }

    if (message && message.command === 'probe') {
      const driver = loadExternalDriver(message.driverPath)
      sendResponse(id, {
        ok: true,
        result: {
          outFormatObject: driver.OUT_FORMAT_OBJECT,
          nodeVersion: process.version,
          opensslVersion: process.versions.openssl || ''
        }
      })
      return
    }

    if (message && message.command === 'close') {
      await closeConnection()
      sendResponse(id, { ok: true, result: null })
      setImmediate(function () {
        if (process.disconnect) process.disconnect()
      })
      return
    }

    if (!connection) throw new Error('Dameng worker is not connected.')

    if (message && message.command === 'execute') {
      const result = await connection.execute(
        message.sql,
        message.binds === undefined ? [] : message.binds,
        message.options === undefined ? {} : message.options
      )
      sendResponse(id, {
        ok: true,
        result: {
          rows: normalizeRows(result && result.rows),
          rowsAffected: result && result.rowsAffected,
          outBinds: result && result.outBinds,
          metaData: result && result.metaData,
          lastRowid: result && result.lastRowid
        }
      })
      return
    }

    if (message && message.command === 'commit') {
      await connection.commit()
      sendResponse(id, { ok: true, result: null })
      return
    }

    if (message && message.command === 'rollback') {
      await connection.rollback()
      sendResponse(id, { ok: true, result: null })
      return
    }

    throw new Error('Unsupported Dameng worker command: ' + ((message && message.command) || ''))
  } catch (error) {
    sendResponse(id, { ok: false, error: serializeError(error) })
  }
}

process.on('message', function (message) {
  handleRequest(decodeIpcValue(message))
})

process.on('disconnect', function () {
  closeConnection().finally(function () {
    process.exit(0)
  })
})

process.on('SIGTERM', function () {
  closeConnection().finally(function () {
    process.exit(0)
  })
})

process.on('uncaughtException', function (error) {
  if (process.connected && process.send) process.send(encodeIpcValue({ fatal: true, error: serializeError(error) }))
  closeConnection().finally(function () {
    process.exit(1)
  })
})

process.on('unhandledRejection', function (error) {
  if (process.connected && process.send) process.send(encodeIpcValue({ fatal: true, error: serializeError(error) }))
  closeConnection().finally(function () {
    process.exit(1)
  })
})

module.exports = {
  decodeIpcValue: decodeIpcValue,
  encodeIpcValue: encodeIpcValue,
  normalizeRows: normalizeRows
}
