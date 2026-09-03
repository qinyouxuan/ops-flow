// SPDX-License-Identifier: MPL-2.0

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('opsFlow', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getDamengDriverStatus: () => ipcRenderer.invoke('dameng-driver:status'),
  selectDamengDriver: () => ipcRenderer.invoke('dameng-driver:select'),
  clearDamengDriver: () => ipcRenderer.invoke('dameng-driver:clear'),
  selectDamengLegacyNode: () => ipcRenderer.invoke('dameng-driver:select-legacy-node'),
  clearDamengLegacyNode: () => ipcRenderer.invoke('dameng-driver:clear-legacy-node'),
  setDamengLegacyMode: (enabled) => ipcRenderer.invoke('dameng-driver:set-legacy-mode', enabled),
  getStore: (key) => ipcRenderer.invoke('store:get', key),
  setStore: (key, value) => ipcRenderer.invoke('store:set', key, value),
  getConfigSecurityStatus: () => ipcRenderer.invoke('config:security-status'),
  exportEncryptedConfig: (options) => ipcRenderer.invoke('config:export-encrypted', options),
  selectEncryptedConfigFile: () => ipcRenderer.invoke('config:select-import-file'),
  inspectEncryptedConfig: (request) => ipcRenderer.invoke('config:inspect-import', request),
  applyEncryptedConfig: (token, operationId) => ipcRenderer.invoke('config:apply-import', { token, operationId }),
  onConfigOperationProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('config:operation-progress', listener)
    return () => ipcRenderer.removeListener('config:operation-progress', listener)
  },
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  selectLocalPath: (options) => ipcRenderer.invoke('dialog:select-local-path', options),
  selectSqlFile: () => ipcRenderer.invoke('dialog:select-sql-file'),
  statLocalPath: (path) => ipcRenderer.invoke('fs:stat-local-path', path),
  testSsh: (config) => ipcRenderer.invoke('ssh:test', config),
  listSshTunnels: () => ipcRenderer.invoke('ssh-tunnel:list'),
  testSshTunnel: (tunnel, sshConfig) => ipcRenderer.invoke('ssh-tunnel:test', tunnel, sshConfig),
  startSshTunnel: (tunnel, sshConfig) => ipcRenderer.invoke('ssh-tunnel:start', tunnel, sshConfig),
  stopSshTunnel: (tunnelId) => ipcRenderer.invoke('ssh-tunnel:stop', tunnelId),
  onSshTunnelStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh-tunnel:status', listener)
    return () => ipcRenderer.removeListener('ssh-tunnel:status', listener)
  },
  execSsh: (config, command) => ipcRenderer.invoke('ssh:exec', config, command),
  execSshRaw: (config, command) => ipcRenderer.invoke('ssh:exec-raw', config, command),
  startWorkflowSshSession: (config, sessionId) => ipcRenderer.invoke('ssh:workflow-session:start', config, sessionId),
  stopWorkflowSshSession: (sessionId) => ipcRenderer.invoke('ssh:workflow-session:stop', sessionId),
  execSshStream: (config, command, executionId, privilege, workflowSessionId) => ipcRenderer.invoke('ssh:exec-stream', config, command, executionId, privilege, workflowSessionId),
  execSshPrivileged: (config, command, privilege) => ipcRenderer.invoke('ssh:exec-privileged', config, command, privilege),
  cancelSshExec: (executionId) => ipcRenderer.invoke('ssh:exec-cancel', executionId),
  detectSshPrivilege: (config, workflowSessionId) => ipcRenderer.invoke('ssh:privilege-detect', config, workflowSessionId),
  verifySshPrivilege: (config, privilege, workflowSessionId) => ipcRenderer.invoke('ssh:privilege-verify', config, privilege, workflowSessionId),
  forgetSshPrivilege: (config, mode) => ipcRenderer.invoke('ssh:privilege-forget', config, mode),
  onSshExecData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh:exec:data', listener)
    return () => ipcRenderer.removeListener('ssh:exec:data', listener)
  },
  startSshShell: (config, size) => ipcRenderer.invoke('ssh:shell:start', config, size),
  resumeSshShell: (sessionId) => ipcRenderer.invoke('ssh:shell:resume', sessionId),
  writeSshShell: (sessionId, data) => ipcRenderer.send('ssh:shell:write', sessionId, data),
  resizeSshShell: (sessionId, size) => ipcRenderer.invoke('ssh:shell:resize', sessionId, size),
  stopSshShell: (sessionId) => ipcRenderer.invoke('ssh:shell:stop', sessionId),
  onSshShellData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh:shell:data', listener)
    return () => ipcRenderer.removeListener('ssh:shell:data', listener)
  },
  onSshShellCommand: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ssh:shell:command', listener)
    return () => ipcRenderer.removeListener('ssh:shell:command', listener)
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
  resolveRemotePath: (config, targetPath) => ipcRenderer.invoke('sftp:realpath', config, targetPath),
  inspectServer: (config) => ipcRenderer.invoke('ssh:inspect', config),
  listRemoteDirectory: (config, path) => ipcRenderer.invoke('sftp:list', config, path),
  listPrivilegedRemoteDirectory: (config, path, privilege) => ipcRenderer.invoke('sftp:privileged-list', config, path, privilege),
  searchRemoteFiles: (config, query, privilege, executionId) => ipcRenderer.invoke('sftp:search-files', config, query, privilege, executionId),
  uploadRemoteFile: (config, path, options) => ipcRenderer.invoke('sftp:upload', config, path, options),
  uploadPrivilegedRemoteFile: (config, path, privilege) => ipcRenderer.invoke('sftp:privileged-upload', config, path, privilege),
  uploadPrivilegedRemotePath: (config, localPath, path, privilege) => ipcRenderer.invoke('sftp:privileged-upload-path', config, localPath, path, privilege),
  uploadRemotePath: (config, localPath, remotePath, workflowSessionId) => ipcRenderer.invoke('sftp:upload-path', config, localPath, remotePath, workflowSessionId),
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
  cancelFileTransfer: (transferId) => ipcRenderer.invoke('sftp:transfer-cancel', transferId),
  downloadRemoteFile: (config, path) => ipcRenderer.invoke('sftp:download', config, path),
  downloadPrivilegedRemoteFile: (config, path, privilege) => ipcRenderer.invoke('sftp:privileged-download', config, path, privilege),
  downloadRemoteFiles: (config, paths, privilege) => ipcRenderer.invoke('sftp:download-files', config, paths, privilege),
  downloadRemotePath: (config, remotePath, localPath, workflowSessionId) => ipcRenderer.invoke('sftp:download-path', config, remotePath, localPath, workflowSessionId),
  readRemoteFile: (config, path) => ipcRenderer.invoke('sftp:read-file', config, path),
  readPrivilegedRemoteFile: (config, path, privilege) => ipcRenderer.invoke('sftp:privileged-read-file', config, path, privilege),
  writeRemoteFile: (config, path, content, options) => ipcRenderer.invoke('sftp:write-file', config, path, content, options),
  writePrivilegedRemoteFile: (config, path, content, privilege, options) => ipcRenderer.invoke('sftp:privileged-write-file', config, path, content, privilege, options),
  createRemoteFile: (config, parentPath, name) => ipcRenderer.invoke('sftp:create-file', config, parentPath, name),
  createRemoteDirectory: (config, parentPath, name) => ipcRenderer.invoke('sftp:create-directory', config, parentPath, name),
  renameRemoteItem: (config, sourcePath, newName) => ipcRenderer.invoke('sftp:rename', config, sourcePath, newName),
  createPrivilegedRemoteFile: (config, parentPath, name, privilege) => ipcRenderer.invoke('sftp:privileged-create-file', config, parentPath, name, privilege),
  createPrivilegedRemoteDirectory: (config, parentPath, name, privilege) => ipcRenderer.invoke('sftp:privileged-create-directory', config, parentPath, name, privilege),
  renamePrivilegedRemoteItem: (config, sourcePath, newName, privilege) => ipcRenderer.invoke('sftp:privileged-rename', config, sourcePath, newName, privilege),
  copyRemoteFileBackup: (config, path, privilege) => ipcRenderer.invoke('sftp:copy-file-backup', config, path, privilege),
  writeRemoteBinaryFile: (config, path, contentBase64) => ipcRenderer.invoke('sftp:write-binary-file', config, path, contentBase64),
  deleteRemoteItem: (config, path, type) => ipcRenderer.invoke('sftp:delete', config, path, type),
  deletePrivilegedRemoteItem: (config, path, type, privilege) => ipcRenderer.invoke('sftp:privileged-delete', config, path, type, privilege),
  testDatabase: (config) => ipcRenderer.invoke('db:test', config),
  getDatabaseCreateOptions: (config) => ipcRenderer.invoke('db:create-options', config),
  createDatabase: (config, request) => ipcRenderer.invoke('db:create-database', config, request),
  inspectDatabase: (config) => ipcRenderer.invoke('db:inspect', config),
  inspectDatabaseColumns: (config, table) => ipcRenderer.invoke('db:columns', config, table),
  setDatabaseColumnComment: (config, table, column) => ipcRenderer.invoke('db:set-column-comment', config, table, column),
  inspectDatabasePrivileges: (config) => ipcRenderer.invoke('db:privileges', config),
  execDatabase: (config, sql, options) => ipcRenderer.invoke('db:exec', config, sql, options),
  execDatabaseScript: (config, sql, options) => ipcRenderer.invoke('db:exec-script', config, sql, options),
  execDatabaseScriptFile: (config, options) => ipcRenderer.invoke('db:exec-script-file', config, options),
  cancelDatabaseScript: (taskId) => ipcRenderer.invoke('db:cancel-script', taskId),
  exportDatabaseQuery: (config, sql, options) => ipcRenderer.invoke('db:export-query', config, sql, options),
  cancelDatabaseQueryExport: (taskId) => ipcRenderer.invoke('db:cancel-query-export', taskId),
  exportDatabaseTables: (config, tables, format) => ipcRenderer.invoke('db:export', config, tables, format),
  backupDatabase: (config, options) => ipcRenderer.invoke('db:backup', config, options),
  cancelDatabaseBackup: (operationId) => ipcRenderer.invoke('db:backup-cancel', operationId),
  onDatabaseBackupProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('database:backup-progress', listener)
    return () => ipcRenderer.removeListener('database:backup-progress', listener)
  },
  testRedis: (config) => ipcRenderer.invoke('redis:test', config),
  inspectRedis: (config) => ipcRenderer.invoke('redis:inspect', config),
  inspectRedisDatabases: (config) => ipcRenderer.invoke('redis:databases', config),
  listRedisKeys: (config, database, pattern) => ipcRenderer.invoke('redis:keys', config, database, pattern),
  readRedisKey: (config, database, key) => ipcRenderer.invoke('redis:key', config, database, key),
  deleteRedisKey: (config, database, key) => ipcRenderer.invoke('redis:key-delete', config, database, key),
  flushRedisDatabase: (config, database) => ipcRenderer.invoke('redis:flushdb', config, database),
  backupRedisDatabase: (config, database, options) => ipcRenderer.invoke('redis:backup', config, database, options),
  cancelRedisBackup: (operationId) => ipcRenderer.invoke('redis:backup-cancel', operationId),
  selectRedisBackup: () => ipcRenderer.invoke('redis:select-backup'),
  restoreRedisDatabase: (config, database, options) => ipcRenderer.invoke('redis:restore', config, database, options),
  cancelRedisRestore: (operationId) => ipcRenderer.invoke('redis:restore-cancel', operationId),
  onRedisBackupProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('redis:backup-progress', listener)
    return () => ipcRenderer.removeListener('redis:backup-progress', listener)
  },
  onRedisRestoreProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('redis:restore-progress', listener)
    return () => ipcRenderer.removeListener('redis:restore-progress', listener)
  },
  execRedis: (config, command) => ipcRenderer.invoke('redis:exec', config, command)
})
