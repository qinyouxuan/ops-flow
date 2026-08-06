// SPDX-License-Identifier: MPL-2.0

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export const CONFIG_BACKUP_FORMAT = 'ops-flow-encrypted-backup'
export const CONFIG_BACKUP_VERSION = 1

const SCRYPT_COST = 32768
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELISM = 1
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
const MAX_CONFIG_DEPTH = 80
const MAX_CONFIG_NODES = 250000
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const BACKUP_AAD = Buffer.from(`${CONFIG_BACKUP_FORMAT}:v${CONFIG_BACKUP_VERSION}`, 'utf8')

export function isSensitiveConfigKey(key) {
  return /(?:password|passphrase|privatekey|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret)$/i.test(String(key || ''))
}

export function transformSensitiveValues(value, transform, key = '', depth = 0) {
  if (depth > MAX_CONFIG_DEPTH) throw new Error('Configuration nesting is too deep.')
  if (Array.isArray(value)) {
    return value.map((item) => transformSensitiveValues(item, transform, '', depth + 1))
  }
  if (!value || typeof value !== 'object') {
    if (isSensitiveConfigKey(key) && typeof value === 'string' && value) return transform(value, key)
    return value
  }

  const output = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(childKey)) continue
    output[childKey] = transformSensitiveValues(childValue, transform, childKey, depth + 1)
  }
  return output
}

export function containsCredentials(value, key = '', depth = 0) {
  if (depth > MAX_CONFIG_DEPTH) return false
  if (Array.isArray(value)) return value.some((item) => containsCredentials(item, '', depth + 1))
  if (!value || typeof value !== 'object') {
    return isSensitiveConfigKey(key) && typeof value === 'string' && value.length > 0
  }
  return Object.entries(value).some(([childKey, childValue]) => (
    !BLOCKED_KEYS.has(childKey) && containsCredentials(childValue, childKey, depth + 1)
  ))
}

export function stripCredentials(value) {
  return transformSensitiveValues(value, () => '')
}

export function normalizeConfigSnapshot(source, { includeCredentials = false, includeHistory = false } = {}) {
  const safe = sanitizeConfigObject(source)
  if (!includeHistory) {
    delete safe.transferTasks
    delete safe.remotePathHistory
  }
  return includeCredentials ? safe : stripCredentials(safe)
}

export function sanitizeConfigObject(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Configuration root must be an object.')
  }
  const counter = { value: 0 }
  return sanitizeConfigValue(source, 0, counter)
}

function sanitizeConfigValue(value, depth, counter) {
  counter.value += 1
  if (counter.value > MAX_CONFIG_NODES) throw new Error('Configuration contains too many values.')
  if (depth > MAX_CONFIG_DEPTH) throw new Error('Configuration nesting is too deep.')
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => sanitizeConfigValue(item, depth + 1, counter))
  if (typeof value !== 'object') return null

  const output = {}
  for (const [key, childValue] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) continue
    output[key] = sanitizeConfigValue(childValue, depth + 1, counter)
  }
  return output
}

export function encryptConfigBackup(config, password, metadata = {}) {
  const normalizedPassword = requirePassword(password)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(normalizedPassword, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(BACKUP_AAD)

  const body = Buffer.from(JSON.stringify({
    format: CONFIG_BACKUP_FORMAT,
    version: CONFIG_BACKUP_VERSION,
    createdAt: metadata.createdAt || new Date().toISOString(),
    appVersion: String(metadata.appVersion || ''),
    includeCredentials: Boolean(metadata.includeCredentials),
    includeHistory: Boolean(metadata.includeHistory),
    config: sanitizeConfigObject(config)
  }), 'utf8')
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()])
  const authTag = cipher.getAuthTag()

  return JSON.stringify({
    format: CONFIG_BACKUP_FORMAT,
    version: CONFIG_BACKUP_VERSION,
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELISM
    },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64')
    },
    payload: encrypted.toString('base64')
  }, null, 2)
}

export function decryptConfigBackup(text, password) {
  try {
    const normalizedPassword = requirePassword(password)
    const envelope = JSON.parse(String(text || ''))
    validateEnvelope(envelope)
    const salt = decodeExactBase64(envelope.kdf.salt, 16, 'salt')
    const iv = decodeExactBase64(envelope.cipher.iv, 12, 'IV')
    const authTag = decodeExactBase64(envelope.cipher.authTag, 16, 'authentication tag')
    const encrypted = Buffer.from(envelope.payload, 'base64')
    if (!encrypted.length) throw new Error('Encrypted payload is empty.')

    const key = deriveKey(normalizedPassword, salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(BACKUP_AAD)
    decipher.setAuthTag(authTag)
    const body = Buffer.concat([decipher.update(encrypted), decipher.final()])
    const payload = JSON.parse(body.toString('utf8'))
    if (payload?.format !== CONFIG_BACKUP_FORMAT || payload?.version !== CONFIG_BACKUP_VERSION) {
      throw new Error('Encrypted payload metadata is invalid.')
    }
    return {
      ...payload,
      config: sanitizeConfigObject(payload.config)
    }
  } catch (error) {
    if (error?.code === 'CONFIG_PASSWORD_REQUIRED') throw error
    const safeError = new Error('无法解密配置文件。请检查密码是否正确，或确认文件未损坏。')
    safeError.code = 'CONFIG_DECRYPT_FAILED'
    throw safeError
  }
}

export function summarizeConfig(config) {
  const value = config || {}
  return {
    servers: arrayLength(value.servers),
    databases: arrayLength(value.databases),
    redisStores: arrayLength(value.redisStores || value.redis),
    sshTunnels: arrayLength(value.sshTunnels),
    workflows: arrayLength(value.workflows),
    backupRecoveryProfiles: arrayLength(value.backupRecoveryProfiles),
    deployConfigs: Array.isArray(value.deployConfigs)
      ? value.deployConfigs.length
      : value.deployConfigs && typeof value.deployConfigs === 'object'
        ? Object.keys(value.deployConfigs).length
        : 0,
    transferTasks: arrayLength(value.transferTasks),
    hasCredentials: containsCredentials(value)
  }
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Backup envelope is invalid.')
  if (envelope.format !== CONFIG_BACKUP_FORMAT || envelope.version !== CONFIG_BACKUP_VERSION) throw new Error('Backup version is unsupported.')
  if (envelope.kdf?.name !== 'scrypt' || envelope.kdf.N !== SCRYPT_COST || envelope.kdf.r !== SCRYPT_BLOCK_SIZE || envelope.kdf.p !== SCRYPT_PARALLELISM) {
    throw new Error('Backup key derivation settings are unsupported.')
  }
  if (envelope.cipher?.name !== 'aes-256-gcm') throw new Error('Backup cipher is unsupported.')
  if (typeof envelope.payload !== 'string' || envelope.payload.length > 50 * 1024 * 1024) throw new Error('Backup payload is invalid.')
}

function deriveKey(password, salt) {
  return scryptSync(password, salt, 32, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY
  })
}

function requirePassword(password) {
  const normalized = String(password || '')
  if (normalized.length < 8) {
    const error = new Error('加密密码至少需要 8 个字符。')
    error.code = 'CONFIG_PASSWORD_REQUIRED'
    throw error
  }
  return normalized
}

function decodeExactBase64(value, size, name) {
  if (typeof value !== 'string') throw new Error(`${name} is invalid.`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== size || decoded.toString('base64') !== value) throw new Error(`${name} is invalid.`)
  return decoded
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0
}
