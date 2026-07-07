import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('opsFlow', {
  getStore: (key) => ipcRenderer.invoke('store:get', key),
  setStore: (key, value) => ipcRenderer.invoke('store:set', key, value),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  testSsh: (config) => ipcRenderer.invoke('ssh:test', config),
  execSsh: (config, command) => ipcRenderer.invoke('ssh:exec', config, command),
  startSshShell: (config, size) => ipcRenderer.invoke('ssh:shell:start', config, size),
  writeSshShell: (sessionId, data) => ipcRenderer.invoke('ssh:shell:write', sessionId, data),
  resizeSshShell: (sessionId, size) => ipcRenderer.invoke('ssh:shell:resize', sessionId, size),
  stopSshShell: (sessionId) => ipcRenderer.invoke('ssh:shell:stop', sessionId),
  onSshShellData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh:shell:data', listener)
    return () => ipcRenderer.removeListener('ssh:shell:data', listener)
  },
  onSshShellClose: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh:shell:close', listener)
    return () => ipcRenderer.removeListener('ssh:shell:close', listener)
  },
  onSshShellError: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh:shell:error', listener)
    return () => ipcRenderer.removeListener('ssh:shell:error', listener)
  },
  onTerminalPasteRequest: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('terminal:paste-request', listener)
    return () => ipcRenderer.removeListener('terminal:paste-request', listener)
  },
  inspectServer: (config) => ipcRenderer.invoke('ssh:inspect', config),
  listRemoteDirectory: (config, path) => ipcRenderer.invoke('sftp:list', config, path),
  uploadRemoteFile: (config, path) => ipcRenderer.invoke('sftp:upload', config, path),
  uploadRemotePath: (config, localPath, remotePath) => ipcRenderer.invoke('sftp:upload-path', config, localPath, remotePath),
  onUploadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sftp:upload-progress', listener)
    return () => ipcRenderer.removeListener('sftp:upload-progress', listener)
  },
  onTransferProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('sftp:transfer-progress', listener)
    return () => ipcRenderer.removeListener('sftp:transfer-progress', listener)
  },
  downloadRemoteFile: (config, path) => ipcRenderer.invoke('sftp:download', config, path),
  downloadRemotePath: (config, remotePath, localPath) => ipcRenderer.invoke('sftp:download-path', config, remotePath, localPath),
  readRemoteFile: (config, path) => ipcRenderer.invoke('sftp:read-file', config, path),
  writeRemoteFile: (config, path, content) => ipcRenderer.invoke('sftp:write-file', config, path, content),
  writeRemoteBinaryFile: (config, path, contentBase64) => ipcRenderer.invoke('sftp:write-binary-file', config, path, contentBase64),
  deleteRemoteItem: (config, path, type) => ipcRenderer.invoke('sftp:delete', config, path, type),
  testDatabase: (config) => ipcRenderer.invoke('db:test', config),
  inspectDatabase: (config) => ipcRenderer.invoke('db:inspect', config),
  inspectDatabaseColumns: (config, table) => ipcRenderer.invoke('db:columns', config, table),
  inspectDatabasePrivileges: (config) => ipcRenderer.invoke('db:privileges', config),
  execDatabase: (config, sql) => ipcRenderer.invoke('db:exec', config, sql),
  exportDatabaseTables: (config, tables, format) => ipcRenderer.invoke('db:export', config, tables, format),
  testRedis: (config) => ipcRenderer.invoke('redis:test', config),
  inspectRedis: (config) => ipcRenderer.invoke('redis:inspect', config),
  inspectRedisDatabases: (config) => ipcRenderer.invoke('redis:databases', config),
  listRedisKeys: (config, database, pattern) => ipcRenderer.invoke('redis:keys', config, database, pattern),
  readRedisKey: (config, database, key) => ipcRenderer.invoke('redis:key', config, database, key),
  deleteRedisKey: (config, database, key) => ipcRenderer.invoke('redis:key-delete', config, database, key),
  flushRedisDatabase: (config, database) => ipcRenderer.invoke('redis:flushdb', config, database),
  execRedis: (config, command) => ipcRenderer.invoke('redis:exec', config, command)
})
