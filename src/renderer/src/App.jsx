import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import {
  Activity,
  Boxes,
  Cable,
  CheckCircle2,
  CirclePlay,
  Database,
  Download,
  File,
  Folder,
  HardDrive,
  Power,
  PowerOff,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  SquarePen,
  SquareTerminal,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import './styles.css'

const emptyServer = {
  id: '',
  name: 'No server selected',
  hostname: '-',
  host: '-',
  port: 22,
  username: '-',
  env: '-',
  status: '-',
  load: '-',
  memory: '-',
  cpuUsage: null,
  memoryUsage: null,
  cpu: '-',
  arch: '-',
  os: '-',
  kernel: '-',
  uptime: '-'
}

const defaultCommand = `cd /opt/apps/demo
systemctl status demo-app
tail -n 80 logs/app.log`

const sqlTemplate = ''

const emptyServerForm = {
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  privateKey: '',
  passphrase: '',
  env: 'dev',
  authType: 'password'
}

const emptyDatabaseForm = {
  name: '',
  engine: 'mysql',
  connectionMode: 'ssh',
  host: '127.0.0.1',
  port: 3306,
  database: '',
  username: '',
  password: ''
}

const emptyRedisForm = {
  name: '',
  connectionMode: 'ssh',
  host: '127.0.0.1',
  port: 6379,
  password: '',
  database: 0,
  tls: false
}

const emptyColumnForm = {
  name: '',
  newName: '',
  type: 'varchar(255)',
  nullable: true,
  defaultValue: ''
}

const emptyTableForm = {
  name: '',
  newName: '',
  columns: [
    { id: 'column-1', name: 'id', type: 'int', nullable: false, defaultValue: '' }
  ]
}

function DesktopOnly() {
  return (
    <div className="desktop-only">
      <section>
        <div className="brand-mark"><Boxes size={24} /></div>
        <h1>Ops Flow runs in the desktop app</h1>
        <p>SSH, SFTP, database and Redis operations require the Electron preload bridge.</p>
        <code>npm.cmd run dev</code>
      </section>
    </div>
  )
}

export default function App() {
  if (!window.opsFlow) return <DesktopOnly />

  const [servers, setServers] = useState([])
  const [databases, setDatabases] = useState([])
  const [redisStores, setRedisStores] = useState([])
  const [selectedServerId, setSelectedServerId] = useState('')
  const [activeModule, setActiveModule] = useState('command')
  const [command, setCommand] = useState(defaultCommand)
  const [sqlScript, setSqlScript] = useState(sqlTemplate)
  const [remotePath, setRemotePath] = useState('/')
  const [remoteItems, setRemoteItems] = useState([])
  const [remoteSort, setRemoteSort] = useState({ key: 'name', direction: 'asc' })
  const [pendingRemoteFocusName, setPendingRemoteFocusName] = useState('')
  const [selectedRemoteItem, setSelectedRemoteItem] = useState(null)
  const [isRemoteLoading, setIsRemoteLoading] = useState(false)
  const [isFileTransferRunning, setIsFileTransferRunning] = useState(false)
  const [transferPanelOpen, setTransferPanelOpen] = useState(false)
  const [transferTasks, setTransferTasks] = useState([])
  const [previewFile, setPreviewFile] = useState(null)
  const [previewContent, setPreviewContent] = useState('')
  const [isPreviewSaving, setIsPreviewSaving] = useState(false)
  const [dryRun] = useState(false)
  const [isServerDialogOpen, setIsServerDialogOpen] = useState(false)
  const [serverForm, setServerForm] = useState(emptyServerForm)
  const [editingServerId, setEditingServerId] = useState('')
  const [serverNotice, setServerNotice] = useState(null)
  const [isDatabaseDialogOpen, setIsDatabaseDialogOpen] = useState(false)
  const [databaseForm, setDatabaseForm] = useState(emptyDatabaseForm)
  const [editingDatabaseId, setEditingDatabaseId] = useState('')
  const [isDatabaseTesting, setIsDatabaseTesting] = useState(false)
  const [databaseNotice, setDatabaseNotice] = useState(null)
  const [databasePrivileges, setDatabasePrivileges] = useState({})
  const [selectedRedisId, setSelectedRedisId] = useState('')
  const [selectedRedisDb, setSelectedRedisDb] = useState(0)
  const [redisDatabases, setRedisDatabases] = useState([])
  const [redisKeys, setRedisKeys] = useState([])
  const [redisKeyPattern, setRedisKeyPattern] = useState('*')
  const [selectedRedisKey, setSelectedRedisKey] = useState('')
  const [redisKeyDetail, setRedisKeyDetail] = useState(null)
  const [isRedisLoading, setIsRedisLoading] = useState(false)
  const [isRedisDialogOpen, setIsRedisDialogOpen] = useState(false)
  const [editingRedisId, setEditingRedisId] = useState('')
  const [redisForm, setRedisForm] = useState(emptyRedisForm)
  const [redisNotice, setRedisNotice] = useState(null)
  const [isRedisTesting, setIsRedisTesting] = useState(false)
  const [isPrivilegeLoading, setIsPrivilegeLoading] = useState(false)
  const [selectedDatabaseId, setSelectedDatabaseId] = useState('')
  const [selectedDbTable, setSelectedDbTable] = useState(null)
  const [selectedDbColumn, setSelectedDbColumn] = useState(null)
  const [tableColumns, setTableColumns] = useState([])
  const [isTableLoading, setIsTableLoading] = useState(false)
  const [tableDialog, setTableDialog] = useState(null)
  const [tableForm, setTableForm] = useState(emptyTableForm)
  const [columnDialog, setColumnDialog] = useState(null)
  const [columnForm, setColumnForm] = useState(emptyColumnForm)
  const [sqlResult, setSqlResult] = useState('')
  const [isTestingServer, setIsTestingServer] = useState(false)
  const [isCommandRunning, setIsCommandRunning] = useState(false)
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalOutput, setTerminalOutput] = useState([
    'Add a server, then click Connect to start the SSH terminal.',
    ''
  ].join('\n'))
  const [resourceHistory, setResourceHistory] = useState(() => makeInitialUsageHistory())
  const [toast, setToast] = useState(null)
  const terminalOutputRef = useRef(null)
  const terminalHostRef = useRef(null)
  const moduleTabsRef = useRef(null)
  const terminalRef = useRef(null)
  const fitAddonRef = useRef(null)
  const shellSessionRef = useRef(null)
  const shellServerIdRef = useRef('')
  const shellSessionsByServerRef = useRef({})
  const shellServerBySessionRef = useRef({})
  const shellBuffersByServerRef = useRef({})
  const intentionalShellCloseRef = useRef('')
  const activeModuleRef = useRef(activeModule)
  const redisAutoLoadKeyRef = useRef('')
  const transferPanelTimerRef = useRef(null)
  const toastTimerRef = useRef(null)
  const workspaceCacheRef = useRef({})
  const workspaceRestoringRef = useRef(false)
  const lastWorkspaceServerIdRef = useRef('')
  const selectedServerIdLiveRef = useRef('')
  const [logs, setLogs] = useState([
    '[09:30:12] Ops Flow ready',
    '[09:30:13] No server configured'
  ])

  useEffect(() => {
    loadState().then((saved) => {
      if (!saved) return
      const realServers = (saved.servers || [])
        .filter((server) => !isDemoServer(server))
        .map(normalizeSavedServer)
      const realDatabases = (saved.databases || []).filter((item) => !isDemoResource(item))
      const realRedisStores = (saved.redisStores || []).filter((item) => !isDemoResource(item))

      const shouldPersistCleanState =
        realServers.length !== saved.servers?.length ||
        realDatabases.length !== saved.databases?.length ||
        realRedisStores.length !== saved.redisStores?.length ||
        (saved.servers || []).some((server) => server.status === 'connected')

      if (shouldPersistCleanState) {
        persist({ servers: realServers, databases: realDatabases, redisStores: realRedisStores })
      }

      if (realServers.length) {
        setServers(realServers)
        setSelectedServerId(realServers[0].id)
      }
      setDatabases(realDatabases)
      setRedisStores(realRedisStores)
    })
  }, [])

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || emptyServer,
    [servers, selectedServerId]
  )

  const selectedDatabases = databases.filter((item) => item.serverId === selectedServer?.id)
  const selectedRedisStores = redisStores.filter((item) => item.serverId === selectedServer?.id)
  const selectedDatabase = selectedDatabases.find((item) => item.id === selectedDatabaseId) || selectedDatabases[0] || null
  const selectedRedis = selectedRedisStores.find((item) => item.id === selectedRedisId) || selectedRedisStores[0] || null
  const visibleModuleIds = useMemo(() => ['command', 'database', 'redis'], [])

  useEffect(() => {
    if (!selectedServer.id) {
      resetServerWorkspace()
      return
    }

    const cached = workspaceCacheRef.current[selectedServer.id]
    if (cached) {
      restoreServerWorkspace(cached)
      return
    }

    if (selectedServer.status !== 'connected') {
      setDisconnectedWorkspace(selectedServer)
      setResourceHistory(makeInitialUsageHistory())
    } else {
      setConnectedWorkspace(selectedServer)
    }
  }, [selectedServerId, selectedServer.status])

  useEffect(() => {
    if (!selectedServerId) return
    if (selectedServer.status !== 'connected') return
    if (lastWorkspaceServerIdRef.current !== selectedServerId) {
      lastWorkspaceServerIdRef.current = selectedServerId
      return
    }
    workspaceCacheRef.current[selectedServerId] = buildWorkspaceSnapshot()
  }, [
    selectedServerId,
    remotePath,
    remoteItems,
    remoteSort,
    selectedRemoteItem,
    previewFile,
    previewContent,
    selectedDatabaseId,
    selectedDbTable,
    selectedDbColumn,
    tableColumns,
    sqlScript,
    sqlResult,
    selectedRedisId,
    selectedRedisDb,
    redisDatabases,
    redisKeys,
    redisKeyPattern,
    selectedRedisKey,
    redisKeyDetail,
    activeModule,
    terminalInput,
    terminalOutput,
    resourceHistory,
    selectedServer.status
  ])

  useEffect(() => {
    if (!selectedServer.id) {
      setSelectedDatabaseId('')
      return
    }

    setSelectedDatabaseId((current) => {
      if (databases.some((item) => item.id === current && item.serverId === selectedServer.id)) {
        return current
      }
      return databases.find((item) => item.serverId === selectedServer.id)?.id || ''
    })
  }, [selectedServer.id, databases])

  useEffect(() => {
    if (!selectedServer.id) {
      setSelectedRedisId('')
      return
    }
    setSelectedRedisId((current) => {
      if (redisStores.some((item) => item.id === current && item.serverId === selectedServer.id)) return current
      return redisStores.find((item) => item.serverId === selectedServer.id)?.id || ''
    })
  }, [selectedServer.id, redisStores])

  useEffect(() => {
    activeModuleRef.current = activeModule
  }, [activeModule])

  useEffect(() => {
    selectedServerIdLiveRef.current = selectedServer.id || ''
  }, [selectedServer.id])

  useEffect(() => {
    if (!visibleModuleIds.includes(activeModule)) {
      setActiveModule('command')
    }
  }, [activeModule, visibleModuleIds])

  useEffect(() => {
    if (activeModule !== 'redis' || selectedServer.status !== 'connected' || !selectedRedis) return
    const loadKey = `${selectedServer.id}:${selectedRedis.id}:${selectedRedis.host}:${selectedRedis.port}:${selectedRedis.database}`
    if (redisAutoLoadKeyRef.current === loadKey) return
    redisAutoLoadKeyRef.current = loadKey
    refreshRedisDatabases(selectedRedis)
  }, [activeModule, selectedServer.id, selectedServer.status, selectedRedis?.id, selectedRedis?.host, selectedRedis?.port, selectedRedis?.database])

  useEffect(() => {
    if (workspaceRestoringRef.current) return
    redisAutoLoadKeyRef.current = ''
    setRedisDatabases([])
    setRedisKeys([])
    setSelectedRedisKey('')
    setRedisKeyDetail(null)
  }, [selectedServer.id, selectedRedis?.id, selectedRedis?.host, selectedRedis?.port, selectedRedis?.database])

  useEffect(() => {
    if (!selectedServer.id || selectedServer.status !== 'connected') return undefined
    const timer = window.setInterval(() => {
      inspectServer({ silent: true })
    }, 10000)
    return () => window.clearInterval(timer)
  }, [selectedServer.id, selectedServer.status])

  useEffect(() => {
    window.requestAnimationFrame(() => {
      if (!terminalOutputRef.current) return
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight
    })
  }, [terminalOutput])

  useEffect(() => {
    if (!terminalHostRef.current || terminalRef.current) return undefined

    const pasteIntoTerminal = () => {
      if (activeModuleRef.current !== 'command') return false
      const text = window.opsFlow.readClipboardText()
      if (!text) {
        showToast('error', 'Clipboard is empty')
        return false
      }
      if (!shellSessionRef.current) {
        showToast('error', 'Connect before pasting')
        return false
      }
      terminalRef.current?.focus()
      window.opsFlow.writeSshShell(shellSessionRef.current, text)
      return true
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      fontWeight: 700,
      lineHeight: 1.35,
      convertEol: true,
      scrollback: 4000,
      theme: {
        background: '#08111f',
        foreground: '#f8fafc',
        cursor: '#bae6fd',
        selectionBackground: '#334155'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalHostRef.current)
    terminal.writeln('Add a server, then click Connect to start the SSH terminal.')
    fitAddon.fit()

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true
      const key = event.key.toLowerCase()
      if (key === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          window.opsFlow.writeClipboardText(selection)
          terminal.clearSelection()
          showToast('success', 'Copied')
          return false
        }
      }
      if (key === 'v') {
        pasteIntoTerminal()
        return false
      }
      return true
    })

    terminal.onData((data) => {
      if (shellSessionRef.current) {
        window.opsFlow.writeSshShell(shellSessionRef.current, data)
      }
    })

    const removeTerminalPasteListener = window.opsFlow.onTerminalPasteRequest(() => {
      pasteIntoTerminal()
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      if (shellSessionRef.current) {
        window.opsFlow.resizeSshShell(shellSessionRef.current, {
          cols: terminal.cols,
          rows: terminal.rows
        })
      }
    })
    resizeObserver.observe(terminalHostRef.current)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      removeTerminalPasteListener()
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const removeDataListener = window.opsFlow.onSshShellData((payload) => {
      const serverId = shellServerBySessionRef.current[payload.sessionId] || (
        payload.sessionId === shellSessionRef.current ? shellServerIdRef.current : ''
      )
      if (serverId) appendShellBuffer(serverId, payload.data)
      if (payload.sessionId !== shellSessionRef.current) return
      terminalRef.current?.write(payload.data)
    })
    const removeCloseListener = window.opsFlow.onSshShellClose((payload) => {
      const serverId = shellServerBySessionRef.current[payload.sessionId] || (
        payload.sessionId === shellSessionRef.current ? shellServerIdRef.current : ''
      )
      if (!serverId) return
      const wasIntentional = intentionalShellCloseRef.current === payload.sessionId
      delete shellServerBySessionRef.current[payload.sessionId]
      if (shellSessionsByServerRef.current[serverId] === payload.sessionId) {
        delete shellSessionsByServerRef.current[serverId]
      }
      if (payload.sessionId === shellSessionRef.current) {
        shellSessionRef.current = null
        shellServerIdRef.current = ''
      }
      if (wasIntentional) intentionalShellCloseRef.current = ''
      if (wasIntentional) return

      const message = payload.message || 'Connection closed. Idle timeout or remote host disconnected.'
      appendShellBuffer(serverId, `\r\n${message}\r\n`)
      if (payload.sessionId === shellSessionRef.current || selectedServerIdLiveRef.current === serverId) {
        terminalRef.current?.writeln(`\r\n${message}`)
      }
      setServers((currentServers) => {
        const nextServers = currentServers.map((server) => (
          server.id === serverId ? resetServerRuntime(server) : server
        ))
        window.opsFlow.setStore('servers', nextServers)
        return nextServers
      })
      if (selectedServerIdLiveRef.current === serverId) {
        setRemoteItems([])
        setSelectedRemoteItem(null)
      }
      appendLog(message)
      showToast('error', 'SSH connection closed')
    })
    const removeErrorListener = window.opsFlow.onSshShellError((payload) => {
      const serverId = shellServerBySessionRef.current[payload.sessionId] || (
        payload.sessionId === shellSessionRef.current ? shellServerIdRef.current : ''
      )
      const message = `\r\nConnection error: ${payload.message}\r\n`
      if (serverId) appendShellBuffer(serverId, message)
      if (payload.sessionId !== shellSessionRef.current) return
      terminalRef.current?.write(message)
    })

    return () => {
      removeDataListener()
      removeCloseListener()
      removeErrorListener()
    }
  }, [])

  useEffect(() => {
    window.opsFlow.getStore('transferTasks').then((savedTasks) => {
      if (!Array.isArray(savedTasks)) return
      setTransferTasks(savedTasks.map(normalizeStoredTransferTask).slice(0, 50))
    })
  }, [])

  useEffect(() => {
    return window.opsFlow.onTransferProgress((payload) => {
      updateTransferTask(payload)
    })
  }, [])

  useEffect(() => {
    if (activeModule !== 'command') return
    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
      if (shellSessionRef.current && terminalRef.current) {
        window.opsFlow.resizeSshShell(shellSessionRef.current, {
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows
        })
      }
    })
  }, [activeModule])

  const openAddServer = () => {
    setServerForm(emptyServerForm)
    setEditingServerId('')
    setServerNotice(null)
    setIsServerDialogOpen(true)
  }

  const openEditServer = () => {
    if (!selectedServer.id) {
      appendLog('Edit skipped: no server selected')
      return
    }
    setServerForm(buildFormFromServer(selectedServer))
    setEditingServerId(selectedServer.id)
    setServerNotice(null)
    setIsServerDialogOpen(true)
  }

  const saveServer = () => {
    const server = buildServerFromForm(serverForm)
    if (!server.host || !server.username) {
      appendLog('Server save failed: host and username are required')
      return
    }

    if (editingServerId) {
      const previous = servers.find((item) => item.id === editingServerId)
      const editedServer = {
        ...previous,
        ...server,
        id: editingServerId,
        hostname: '-',
        status: 'disconnected',
        load: '-',
        memory: '-',
        cpuUsage: null,
        memoryUsage: null,
        cpu: '-',
        arch: '-',
        os: '-',
        kernel: '-',
        uptime: '-'
      }
      const next = servers.map((item) => (item.id === editingServerId ? editedServer : item))
      setServers(next)
      setSelectedServerId(editingServerId)
      setRemoteItems([])
      setSelectedRemoteItem(null)
      persist({ servers: next, databases, redisStores })
      appendLog(`Server updated: ${editedServer.name}`)
      setTerminalOutput([
        `Server updated: ${editedServer.name}`,
        'Click Connect to reconnect with the new settings.',
        ''
      ].join('\n'))
    } else {
      const next = [...servers, server]
      setServers(next)
      setSelectedServerId(server.id)
      persist({ servers: next, databases, redisStores })
      appendLog(`Server saved: ${server.name}`)
      setTerminalOutput([
        `Server saved: ${server.name}`,
        'Click Connect to open the SSH terminal.',
        ''
      ].join('\n'))
    }

    setIsServerDialogOpen(false)
    setEditingServerId('')
  }

  const testServerConnection = async () => {
    const server = buildServerFromForm(serverForm)
    if (!server.host || !server.username) {
      appendLog('Connection test skipped: host and username are required')
      setServerNotice({ type: 'error', text: 'Host and username are required.' })
      return
    }

    setIsTestingServer(true)
    setServerNotice({ type: 'info', text: `Testing ${server.username}@${server.host}:${server.port} ...` })
    appendLog(`Testing SSH: ${server.username}@${server.host}:${server.port}`)

    try {
      const result = await window.opsFlow.testSsh(server)
      appendLog(result.ok ? `SSH connected: ${server.name}` : `SSH failed: ${result.message}`)
      setServerNotice(
        result.ok
          ? { type: 'success', text: `SSH connected: ${server.username}@${server.host}:${server.port}` }
          : { type: 'error', text: `Connection failed: ${result.message}` }
      )
      showToast(result.ok ? 'success' : 'error', result.ok ? 'SSH connected' : 'SSH connection failed')
    } catch (error) {
      appendLog(`SSH failed: ${error.message}`)
      setServerNotice({ type: 'error', text: `Connection failed: ${error.message}` })
      showToast('error', 'SSH connection failed')
    } finally {
      setIsTestingServer(false)
    }
  }

  const selectServer = (server) => {
    saveCurrentWorkspace()
    setSelectedServerId(server.id)
    appendLog(`Server selected: ${server.name}`)
  }

  const inspectServer = async (options = {}) => {
    if (!selectedServer.id) {
      appendLog('Inspect skipped: add a server first')
      return null
    }
    if (!options.silent) appendLog(`Refresh server info: ${selectedServer.name}`)
    const result = await window.opsFlow.inspectServer(selectedServer)
    if (!result.ok) {
      if (!options.silent) appendLog(`Refresh failed: ${result.message}`)
      return null
    }

    const nextServer = {
      ...selectedServer,
      ...parseServerInspect(result.stdout),
      status: 'connected'
    }
    const nextServers = servers.map((server) => (server.id === nextServer.id ? nextServer : server))
    setServers(nextServers)
    persist({ servers: nextServers, databases, redisStores })
    updateResourceHistory(nextServer)
    if (!options.silent) appendLog('Server info refreshed')
    return { server: nextServer, stdout: result.stdout }
  }

  const runCommand = async () => {
    if (!selectedServer.id) {
      appendLog('Command skipped: connect a server first')
      return
    }
    if (selectedServer.status !== 'connected') {
      appendTerminal('Please click Connect before running commands.')
      appendLog('Command skipped: server is not connected')
      return
    }
    const command = terminalInput.trim()
    if (!command) {
      appendLog('Command skipped: empty input')
      return
    }

    appendLog(`Command started: ${selectedServer.name}`)
    setIsCommandRunning(true)
    appendTerminal(`${promptFor(selectedServer)} ${command}`)

    try {
      const result = await window.opsFlow.execSsh(selectedServer, command)
      appendTerminal(formatCommandOutput(command, result))
      appendLog(result.ok ? 'Command finished' : `Command failed: ${result.message}`)
      setTerminalInput('')
    } finally {
      setIsCommandRunning(false)
    }
  }

  const openTerminalShell = async (server) => {
    if (!terminalRef.current) return { ok: false, message: 'Terminal is not ready' }
    const existingSessionId = shellSessionsByServerRef.current[server.id]
    if (existingSessionId) {
      shellSessionRef.current = existingSessionId
      shellServerIdRef.current = server.id
      renderShellBuffer(server.id, `${server.name} is connected.`)
      terminalRef.current.focus()
      return { ok: true }
    }

    terminalRef.current.reset()
    terminalRef.current.writeln(`Connecting to ${server.username}@${server.host}:${server.port} ...`)
    shellBuffersByServerRef.current[server.id] = `Connecting to ${server.username}@${server.host}:${server.port} ...\r\n`
    fitAddonRef.current?.fit()

    const result = await window.opsFlow.startSshShell(server, {
      cols: terminalRef.current.cols,
      rows: terminalRef.current.rows
    })
    if (!result.ok) {
      terminalRef.current.writeln(`Connection failed: ${result.message}`)
      return result
    }

    shellSessionRef.current = result.sessionId
    shellServerIdRef.current = server.id
    shellSessionsByServerRef.current[server.id] = result.sessionId
    shellServerBySessionRef.current[result.sessionId] = server.id
    return result
  }

  const closeTerminalShell = async (message, serverId = shellServerIdRef.current) => {
    const sessionId = serverId ? shellSessionsByServerRef.current[serverId] : shellSessionRef.current
    if (sessionId) {
      intentionalShellCloseRef.current = sessionId
      await window.opsFlow.stopSshShell(sessionId)
      delete shellSessionsByServerRef.current[serverId]
      delete shellServerBySessionRef.current[sessionId]
    }
    if (!serverId || shellServerIdRef.current === serverId) {
      shellSessionRef.current = null
      shellServerIdRef.current = ''
      if (message) terminalRef.current?.writeln(`\r\n${message}`)
    }
    if (serverId && message) appendShellBuffer(serverId, `\r\n${message}\r\n`)
  }

  const connectServer = async () => {
    if (!selectedServer.id) {
      appendLog('Connect skipped: add a server first')
      showToast('error', 'Add a server before connecting.')
      return
    }
    appendLog(`Connecting: ${selectedServer.username}@${selectedServer.host}:${selectedServer.port}`)
    setIsTestingServer(true)
    const connectingServer = {
      ...selectedServer,
      status: 'connecting',
      lastError: ''
    }
    const connectingServers = servers.map((server) => (server.id === connectingServer.id ? connectingServer : server))
    setServers(connectingServers)
    persist({ servers: connectingServers, databases, redisStores })

    try {
      const result = await window.opsFlow.testSsh(selectedServer)
      if (!result.ok) {
        const nextServer = markServerConnectionFailed(selectedServer, result.message)
        const nextServers = connectingServers.map((server) => (server.id === nextServer.id ? nextServer : server))
        setServers(nextServers)
        persist({ servers: nextServers, databases, redisStores })
        setRemoteItems([])
        setSelectedRemoteItem(null)
        appendLog(`Connect failed: ${result.message}`)
        appendTerminal(`Connection failed: ${result.message}`)
        showToast('error', `Connection failed: ${result.message}`)
        return
      }

      const inspected = await inspectServer({ silent: true })
      const connectedServer = { ...(inspected?.server || selectedServer), status: 'connected', lastError: '' }
      const nextServers = connectingServers.map((server) => (server.id === connectedServer.id ? connectedServer : server))
      setServers(nextServers)
      persist({ servers: nextServers, databases, redisStores })
      updateResourceHistory(connectedServer, true)
      const shellResult = await openTerminalShell(connectedServer)
      if (!shellResult.ok) {
        const failedServer = markServerConnectionFailed(connectedServer, shellResult.message)
        const failedServers = nextServers.map((server) => (server.id === failedServer.id ? failedServer : server))
        setServers(failedServers)
        persist({ servers: failedServers, databases, redisStores })
        appendLog(`Terminal failed: ${shellResult.message}`)
        showToast('error', `Terminal failed: ${shellResult.message}`)
        return
      }
      const targetPath = remotePath || '/'
      loadRemoteDirectory(targetPath, connectedServer)
      appendLog(`Connected: ${selectedServer.name}`)
      showToast('success', `Connected: ${connectedServer.name}`)
    } catch (error) {
      const nextServer = markServerConnectionFailed(selectedServer, error.message)
      const nextServers = connectingServers.map((server) => (server.id === nextServer.id ? nextServer : server))
      setServers(nextServers)
      persist({ servers: nextServers, databases, redisStores })
      appendLog(`Connect failed: ${error.message}`)
      appendTerminal(`Connection failed: ${error.message}`)
      showToast('error', `Connection failed: ${error.message}`)
    } finally {
      setIsTestingServer(false)
    }
  }

  const disconnectServer = () => {
    if (!selectedServer.id) {
      appendLog('Disconnect skipped: no server selected')
      return
    }
    const nextServer = resetServerRuntime(selectedServer)
    const nextServers = servers.map((server) => (server.id === nextServer.id ? nextServer : server))
    setServers(nextServers)
    persist({ servers: nextServers, databases, redisStores })
    setRemoteItems([])
    setSelectedRemoteItem(null)
    setResourceHistory(makeInitialUsageHistory())
    closeTerminalShell(`Connection closed: ${selectedServer.name}`, selectedServer.id)
    workspaceCacheRef.current[selectedServer.id] = {
      ...buildWorkspaceSnapshot(),
      remoteItems: [],
      selectedRemoteItem: null,
      resourceHistory: makeInitialUsageHistory()
    }
    appendLog(`Disconnected: ${selectedServer.name}`)
  }

  const removeSelectedServer = () => {
    if (!selectedServer.id) {
      appendLog('Remove skipped: no server selected')
      return
    }
    closeTerminalShell('', selectedServer.id)
    delete workspaceCacheRef.current[selectedServer.id]
    delete shellBuffersByServerRef.current[selectedServer.id]
    const nextServers = servers.filter((server) => server.id !== selectedServer.id)
    const nextDatabases = databases.filter((item) => item.serverId !== selectedServer.id)
    const nextRedisStores = redisStores.filter((item) => item.serverId !== selectedServer.id)
    setServers(nextServers)
    setDatabases(nextDatabases)
    setRedisStores(nextRedisStores)
    setSelectedServerId(nextServers[0]?.id || '')
    persist({ servers: nextServers, databases: nextDatabases, redisStores: nextRedisStores })
    setTerminalOutput('Add a server, then click Connect to start the SSH terminal.')
    appendLog(`Removed server: ${selectedServer.name}`)
  }
  const openRemoteItem = (item) => {
    setSelectedRemoteItem(item)
  }

  const openRemoteDirectory = (item) => {
    if (item.type !== 'dir') return
    setSelectedRemoteItem(null)
    const nextPath = joinRemotePath(remotePath, item.name)
    loadRemoteDirectory(nextPath)
  }

  const goRemoteParent = () => {
    if (remotePath === '/') return
    const nextPath = remotePath.split('/').slice(0, -1).join('/') || '/'
    loadRemoteDirectory(nextPath)
  }

  const loadRemoteDirectory = async (path = remotePath, server = selectedServer) => {
    if (!server.id || server.status !== 'connected') {
      appendLog('Remote directory skipped: connect a server first')
      return
    }

    setIsRemoteLoading(true)

    try {
      const result = await window.opsFlow.listRemoteDirectory(server, path)
      if (!result.ok) {
        appendLog(`Remote directory failed: ${result.message}`)
        return
      }
      setRemotePath(result.path || path)
      setRemoteItems(result.items || [])
      setSelectedRemoteItem(null)
    } finally {
      setIsRemoteLoading(false)
    }
  }

  const uploadFile = async () => {
    if (!selectedServer.id || selectedServer.status !== 'connected') {
      appendLog('Upload skipped: connect a server first')
      return
    }

    setIsFileTransferRunning(true)
    appendLog(`Upload to ${remotePath}: selecting local file`)

    try {
      const result = await window.opsFlow.uploadRemoteFile(selectedServer, remotePath)
      if (result.canceled) {
        appendLog('Upload canceled')
        return
      }
      if (!result.ok) {
        appendLog(`Upload failed: ${result.message}`)
        return
      }
      appendLog(`Upload completed: ${result.remotePath}`)
      const uploadedName = result.remotePath ? remoteBasename(result.remotePath) : ''
      if (uploadedName) {
        setPendingRemoteFocusName(uploadedName)
      }
      await loadRemoteDirectory(remotePath)
      if (uploadedName) {
        setSelectedRemoteItem({ name: uploadedName, type: 'file' })
      }
    } finally {
      setIsFileTransferRunning(false)
    }
  }

  const downloadFile = async () => {
    if (!selectedServer.id || selectedServer.status !== 'connected') {
      appendLog('Download skipped: connect a server first')
      return
    }
    if (!selectedRemoteItem || selectedRemoteItem.type !== 'file') {
      appendLog('Download skipped: select a remote file first')
      return
    }

    const targetPath = joinRemotePath(remotePath, selectedRemoteItem.name)
    setIsFileTransferRunning(true)
    appendLog(`Download started: ${targetPath}`)

    try {
      const result = await window.opsFlow.downloadRemoteFile(selectedServer, targetPath)
      if (result.canceled) {
        appendLog('Download canceled')
        return
      }
      appendLog(result.ok ? `Download completed: ${result.localPath}` : `Download failed: ${result.message}`)
    } finally {
      setIsFileTransferRunning(false)
    }
  }

  const previewRemoteFile = async (item = selectedRemoteItem) => {
    if (!selectedServer.id || selectedServer.status !== 'connected') {
      appendLog('Preview skipped: connect a server first')
      return
    }
    if (!item || item.type !== 'file') {
      appendLog('Preview skipped: select a remote file first')
      return
    }

    const targetPath = joinRemotePath(remotePath, item.name)
    setIsFileTransferRunning(true)
    setPreviewFile({ ...item, path: targetPath, loading: true })
    setPreviewContent('')

    try {
      const result = await window.opsFlow.readRemoteFile(selectedServer, targetPath)
      if (!result.ok) {
        appendLog(`Preview failed: ${result.message}`)
        setPreviewFile(null)
        showToast('error', result.message)
        return
      }
      setPreviewFile({ ...item, path: targetPath, loading: false })
      setPreviewContent(result.content || '')
    } finally {
      setIsFileTransferRunning(false)
    }
  }

  const savePreviewFile = async () => {
    if (!previewFile) return
    setIsPreviewSaving(true)
    appendLog(`Saving remote file: ${previewFile.path}`)

    try {
      const result = await window.opsFlow.writeRemoteFile(selectedServer, previewFile.path, previewContent)
      appendLog(result.ok ? `File saved: ${previewFile.path}` : `Save failed: ${result.message}`)
      if (result.ok) await loadRemoteDirectory(remotePath)
    } finally {
      setIsPreviewSaving(false)
    }
  }

  const deleteRemoteItem = async () => {
    if (!selectedServer.id || selectedServer.status !== 'connected') {
      appendLog('Delete skipped: connect a server first')
      return
    }
    if (!selectedRemoteItem) {
      appendLog('Delete skipped: select a remote item first')
      return
    }

    const targetPath = joinRemotePath(remotePath, selectedRemoteItem.name)
    const confirmed = window.confirm(`Delete ${targetPath}?`)
    if (!confirmed) {
      appendLog('Delete canceled')
      return
    }

    setIsFileTransferRunning(true)
    appendLog(`Delete started: ${targetPath}`)

    try {
      const result = await window.opsFlow.deleteRemoteItem(selectedServer, targetPath, selectedRemoteItem.type)
      if (!result.ok) {
        appendLog(`Delete failed: ${result.message}`)
        showToast('error', `Delete failed: ${result.message}`)
        return
      }
      appendLog(`Deleted: ${targetPath}${result.deletedCount ? ` (${result.deletedCount} items)` : ''}`)
      showToast('success', `Deleted: ${selectedRemoteItem.name}`)
      setSelectedRemoteItem(null)
      await loadRemoteDirectory(remotePath)
    } finally {
      setIsFileTransferRunning(false)
    }
  }

  const addDatabase = () => {
    if (!selectedServer.id) {
      appendLog('Database skipped: add a server first')
      return
    }
    setDatabaseForm({
      ...emptyDatabaseForm,
      host: '127.0.0.1',
      name: `${selectedServer.name}-mysql`
    })
    setEditingDatabaseId('')
    setDatabaseNotice(null)
    setIsDatabaseDialogOpen(true)
  }

  const saveDatabase = async () => {
    const database = buildDatabaseFromForm(databaseForm, selectedServer)
    if (!database.host || !database.database || !database.username) {
      appendLog('Database save failed: host, database and username are required')
      setDatabaseNotice({ type: 'error', text: 'Please fill Host, Database and Username.' })
      return
    }

    const nextDatabase = {
      ...database,
      id: editingDatabaseId || database.id,
      tables: editingDatabaseId ? databases.find((item) => item.id === editingDatabaseId)?.tables || [] : [],
      status: 'saved'
    }
    const next = editingDatabaseId
      ? databases.map((item) => (item.id === editingDatabaseId ? nextDatabase : item))
      : [...databases, nextDatabase]

    setDatabases(next)
    setSelectedDatabaseId(nextDatabase.id)
    setSelectedDbTable(null)
    setTableColumns([])
    await persist({ servers, databases: next, redisStores })
    setIsDatabaseDialogOpen(false)
    setEditingDatabaseId('')
    setDatabaseNotice(null)
    appendLog(`Database ${editingDatabaseId ? 'updated' : 'saved'}: ${nextDatabase.name}`)
  }

  const testDatabaseConnection = async () => {
    const database = withDatabaseRuntime(buildDatabaseFromForm(databaseForm, selectedServer), selectedServer)
    if (!database.host || !database.database || !database.username) {
      appendLog('Database test skipped: host, database and username are required')
      setDatabaseNotice({ type: 'error', text: 'Please fill Host, Database and Username.' })
      return
    }
    setIsDatabaseTesting(true)
    setDatabaseNotice({ type: 'info', text: 'Testing database connection...' })
    try {
      const result = await window.opsFlow.testDatabase(database)
      appendLog(result.ok ? `Database connected: ${database.name}` : `Database failed: ${result.message}`)
      setDatabaseNotice({
        type: result.ok ? 'success' : 'error',
        text: result.ok ? 'Database connection succeeded.' : formatDatabaseError(result.message)
      })
    } finally {
      setIsDatabaseTesting(false)
    }
  }

  const loadTableColumns = async (table, database = selectedDatabase) => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!database || !table) return
    const runtimeDatabase = withDatabaseRuntime(database, selectedServer)
    setSelectedDbTable(table)
    setIsTableLoading(true)
    appendLog(`Loading table columns: ${table.schema}.${table.name}`)

    try {
      const result = await window.opsFlow.inspectDatabaseColumns(runtimeDatabase, table)
      if (!result.ok) {
        appendLog(`Columns failed: ${result.message}`)
        return
      }
      setTableColumns(normalizeDbColumns(result.columns))
      setSelectedDbColumn(null)
      appendLog(`Columns loaded: ${table.name}`)
    } finally {
      setIsTableLoading(false)
    }
  }

  const editDatabase = (database = selectedDatabase) => {
    if (!database) {
      appendLog('Database edit skipped: no database selected')
      return
    }
    setDatabaseForm(buildDatabaseFormFromConfig(database))
    setEditingDatabaseId(database.id)
    setIsDatabaseDialogOpen(true)
  }

  const deleteDatabase = (database = selectedDatabase) => {
    if (!database) {
      appendLog('Database delete skipped: no database selected')
      return
    }
    if (!window.confirm(`Delete database connection ${database.name}?`)) return
    const next = databases.filter((item) => item.id !== database.id)
    setDatabases(next)
    setSelectedDatabaseId(next.find((item) => item.serverId === selectedServer.id)?.id || '')
    setSelectedDbTable(null)
    setSelectedDbColumn(null)
    setTableColumns([])
    persist({ servers, databases: next, redisStores })
    appendLog(`Database deleted: ${database.name}`)
  }

  const refreshDatabaseTables = async (database = selectedDatabase) => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!database) {
      appendLog('Refresh tables skipped: no database selected')
      return
    }
    const runtimeDatabase = withDatabaseRuntime(database, selectedServer)
    setIsTableLoading(true)
    appendLog(`Refreshing tables: ${database.name}`)

    try {
      const result = await window.opsFlow.inspectDatabase(runtimeDatabase)
      if (!result.ok) {
        appendLog(`Refresh tables failed: ${result.message}`)
        return
      }
      const updatedDatabase = {
        ...database,
        tables: normalizeDbTables(result.tables),
        status: 'connected'
      }
      const next = databases.map((item) => (item.id === database.id ? updatedDatabase : item))
      setDatabases(next)
      setSelectedDatabaseId(database.id)
      setSelectedDbTable(null)
      setSelectedDbColumn(null)
      setTableColumns([])
      persist({ servers, databases: next, redisStores })
      checkDatabasePrivileges(database, { silent: true })
      appendLog(`Tables refreshed: ${database.name}`)
    } finally {
      setIsTableLoading(false)
    }
  }

  const exportDatabaseTables = async (tables, format) => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!selectedDatabase || !tables.length) {
      showToast('error', 'Select tables to export.')
      return
    }
    const transferId = `db-export-${Date.now()}`
    updateTransferTask({
      id: transferId,
      type: 'export',
      name: `${selectedDatabase.name}.${format}`,
      remotePath: `${tables.length} table${tables.length === 1 ? '' : 's'}`,
      transferred: 0,
      total: 1,
      status: 'running'
    })
    setIsTableLoading(true)
    try {
      const result = await window.opsFlow.exportDatabaseTables(withDatabaseRuntime(selectedDatabase, selectedServer), tables, format)
      if (result.canceled) {
        updateTransferTask({ id: transferId, status: 'failed', message: 'Export canceled' })
        return
      }
      if (!result.ok) {
        updateTransferTask({ id: transferId, status: 'failed', message: result.message })
        showToast('error', result.message)
        return
      }
      updateTransferTask({ id: transferId, transferred: 1, status: 'done' })
      showToast('success', `Exported ${result.tables} table${result.tables === 1 ? '' : 's'}.`)
    } finally {
      setIsTableLoading(false)
    }
  }

  const checkDatabasePrivileges = async (database = selectedDatabase, options = {}) => {
    if (selectedServer.status !== 'connected') {
      if (!options.silent) showToast('error', 'Connect server first.')
      return null
    }
    if (!database) {
      if (!options.silent) showToast('error', 'Select a database connection first.')
      return null
    }
    const runtimeDatabase = withDatabaseRuntime(database, selectedServer)
    if (!options.silent) appendLog(`Checking privileges: ${database.name}`)
    if (!options.silent) setIsPrivilegeLoading(true)
    try {
      const result = await window.opsFlow.inspectDatabasePrivileges(runtimeDatabase)
      if (!result.ok) {
        const message = formatDatabaseOperationError(result.message)
        if (!options.silent) showToast('error', message)
        appendLog(`Privileges failed: ${result.message}`)
        setDatabasePrivileges((current) => ({ ...current, [database.id]: { ok: false, message } }))
        return null
      }
      setDatabasePrivileges((current) => ({ ...current, [database.id]: result }))
      if (!options.silent) showToast('success', `Privileges loaded: ${result.user}`)
      return result
    } finally {
      if (!options.silent) setIsPrivilegeLoading(false)
    }
  }

  const addRedis = () => {
    if (!selectedServer.id) {
      appendLog('Redis skipped: add a server first')
      return
    }
    setRedisForm({ ...emptyRedisForm, host: '127.0.0.1' })
    setEditingRedisId('')
    setRedisNotice(null)
    setIsRedisDialogOpen(true)
  }

  const editRedis = (redis = selectedRedis) => {
    if (!redis) {
      showToast('error', 'Select a Redis connection first.')
      return
    }
    setRedisForm(buildRedisFormFromConfig(redis))
    setEditingRedisId(redis.id)
    setRedisNotice(null)
    setIsRedisDialogOpen(true)
  }

  const deleteRedis = (redis = selectedRedis) => {
    if (!redis) {
      showToast('error', 'Select a Redis connection first.')
      return
    }
    if (!window.confirm(`Delete Redis connection ${redis.name}?`)) return
    const next = redisStores.filter((item) => item.id !== redis.id)
    setRedisStores(next)
    setSelectedRedisId(next.find((item) => item.serverId === selectedServer.id)?.id || '')
    setRedisDatabases([])
    setRedisKeys([])
    setSelectedRedisKey('')
    setRedisKeyDetail(null)
    persist({ servers, databases, redisStores: next })
  }

  const saveRedis = () => {
    const redis = buildRedisFromForm(redisForm, selectedServer.id, editingRedisId)
    if (!redis.name || !redis.host) {
      setRedisNotice({ type: 'error', text: 'Name and host are required.' })
      return
    }
    const next = editingRedisId
      ? redisStores.map((item) => (item.id === editingRedisId ? { ...item, ...redis, id: editingRedisId } : item))
      : [...redisStores, redis]
    setRedisStores(next)
    setSelectedRedisId(redis.id)
    persist({ servers, databases, redisStores: next })
    setIsRedisDialogOpen(false)
    setEditingRedisId('')
    setRedisNotice(null)
  }

  const testRedisConnection = async () => {
    const redis = withRedisRuntime(buildRedisFromForm(redisForm, selectedServer.id, editingRedisId || 'redis-test'), selectedServer)
    if (!redis.host) {
      setRedisNotice({ type: 'error', text: 'Host is required.' })
      return
    }
    setIsRedisTesting(true)
    setRedisNotice({ type: 'info', text: `Testing ${redis.host}:${redis.port} ...` })
    showToast('success', 'Testing Redis connection...')
    try {
      const result = await window.opsFlow.testRedis(redis)
      setRedisNotice(result.ok
        ? { type: 'success', text: `Redis connected: ${redis.host}:${redis.port}` }
        : { type: 'error', text: `Connection failed: ${result.message}` })
      showToast(result.ok ? 'success' : 'error', result.ok ? 'Redis connected' : 'Redis connection failed')
    } catch (error) {
      setRedisNotice({ type: 'error', text: `Connection failed: ${error.message}` })
      showToast('error', 'Redis connection failed')
    } finally {
      setIsRedisTesting(false)
    }
  }

  const runSql = async () => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    const target = selectedDatabase
    if (!target) {
      appendLog('SQL skipped: no database configured')
      return
    }
    if (dryRun) {
      appendLog(`Dry run SQL: ${target.name}`)
      return
    }
    setSqlResult('Running SQL...')
    const result = await window.opsFlow.execDatabase(withDatabaseRuntime(target, selectedServer), sqlScript)
    appendLog(result.ok ? 'SQL executed' : `SQL failed: ${result.message}`)
    setSqlResult(formatSqlResult(result))
  }

  const openAddTable = () => {
    if (!selectedDatabase) {
      showToast('error', 'Select a database connection first.')
      return
    }
    setTableForm(emptyTableForm)
    setTableDialog({ mode: 'add' })
  }

  const openEditTable = () => {
    if (!selectedDbTable) {
      showToast('error', 'Select a table first.')
      return
    }
    setTableForm({
      ...emptyTableForm,
      name: selectedDbTable.name,
      newName: selectedDbTable.name
    })
    setTableDialog({ mode: 'edit', table: selectedDbTable })
  }

  const saveTableChange = async () => {
    if (!selectedDatabase || !tableDialog) return
    const sql = buildTableAlterSql(selectedDatabase, tableDialog, tableForm)
    if (!sql) {
      showToast('error', 'Please fill required table information.')
      return
    }
    setIsTableLoading(true)
    appendLog(`Table change started: ${selectedDatabase.name}`)
    try {
      const result = await window.opsFlow.execDatabase(withDatabaseRuntime(selectedDatabase, selectedServer), sql)
      if (!result.ok) {
        appendLog(`Table change failed: ${result.message}`)
        const message = formatDatabaseOperationError(result.message)
        showToast('error', message)
        setSqlResult({ ok: false, message })
        return
      }
      showToast('success', 'Table updated.')
      setTableDialog(null)
      setTableForm(emptyTableForm)
      await refreshDatabaseTables(selectedDatabase)
    } finally {
      setIsTableLoading(false)
    }
  }

  const deleteTable = async () => {
    if (!selectedDatabase || !selectedDbTable) {
      showToast('error', 'Select a table first.')
      return
    }
    if (!window.confirm(`Delete table ${selectedDbTable.name}? This cannot be undone.`)) return
    const sql = buildDropTableSql(selectedDatabase, selectedDbTable)
    setIsTableLoading(true)
    appendLog(`Deleting table: ${selectedDbTable.name}`)
    try {
      const result = await window.opsFlow.execDatabase(withDatabaseRuntime(selectedDatabase, selectedServer), sql)
      if (!result.ok) {
        appendLog(`Delete table failed: ${result.message}`)
        const message = formatDatabaseOperationError(result.message)
        showToast('error', message)
        setSqlResult({ ok: false, message })
        return
      }
      showToast('success', `Deleted table: ${selectedDbTable.name}`)
      setSelectedDbTable(null)
      setSelectedDbColumn(null)
      setTableColumns([])
      await refreshDatabaseTables(selectedDatabase)
    } finally {
      setIsTableLoading(false)
    }
  }

  const openAddColumn = () => {
    if (!selectedDbTable) {
      showToast('error', 'Select a table first.')
      return
    }
    setColumnForm(emptyColumnForm)
    setColumnDialog({ mode: 'add' })
  }

  const openEditColumn = () => {
    if (!selectedDbColumn) {
      showToast('error', 'Select a field first.')
      return
    }
    setColumnForm({
      ...emptyColumnForm,
      name: selectedDbColumn.name,
      newName: selectedDbColumn.name,
      type: selectedDbColumn.type || emptyColumnForm.type,
      nullable: !/^no$/i.test(selectedDbColumn.nullable || ''),
      defaultValue: selectedDbColumn.defaultValue === '-' ? '' : selectedDbColumn.defaultValue || ''
    })
    setColumnDialog({ mode: 'edit', column: selectedDbColumn })
  }

  const saveColumnChange = async () => {
    if (!selectedDatabase || !selectedDbTable || !columnDialog) return
    const sql = buildColumnAlterSql(selectedDatabase, selectedDbTable, columnDialog, columnForm)
    if (!sql) {
      showToast('error', 'Please fill required column information.')
      return
    }

    setIsTableLoading(true)
    appendLog(`Column change started: ${selectedDbTable.name}`)
    try {
      const result = await window.opsFlow.execDatabase(withDatabaseRuntime(selectedDatabase, selectedServer), sql)
      if (!result.ok) {
        appendLog(`Column change failed: ${result.message}`)
        const message = formatDatabaseOperationError(result.message)
        showToast('error', message)
        setSqlResult({ ok: false, message })
        return
      }
      showToast('success', 'Column updated.')
      setColumnDialog(null)
      setColumnForm(emptyColumnForm)
      await loadTableColumns(selectedDbTable, selectedDatabase)
    } finally {
      setIsTableLoading(false)
    }
  }

  const deleteColumn = async () => {
    if (!selectedDatabase || !selectedDbTable || !selectedDbColumn) {
      showToast('error', 'Select a field first.')
      return
    }
    if (!window.confirm(`Delete column ${selectedDbColumn.name}?`)) return
    const sql = buildDropColumnSql(selectedDatabase, selectedDbTable, selectedDbColumn.name)
    setIsTableLoading(true)
    appendLog(`Deleting column: ${selectedDbColumn.name}`)
    try {
      const result = await window.opsFlow.execDatabase(withDatabaseRuntime(selectedDatabase, selectedServer), sql)
      if (!result.ok) {
        appendLog(`Delete column failed: ${result.message}`)
        const message = formatDatabaseOperationError(result.message)
        showToast('error', message)
        setSqlResult({ ok: false, message })
        return
      }
      showToast('success', `Deleted column: ${selectedDbColumn.name}`)
      setSelectedDbColumn(null)
      await loadTableColumns(selectedDbTable, selectedDatabase)
    } finally {
      setIsTableLoading(false)
    }
  }

  const refreshRedisDatabases = async (redis = selectedRedis) => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!redis) {
      showToast('error', 'Select a Redis connection first.')
      return
    }
    setIsRedisLoading(true)
    try {
      const result = await window.opsFlow.inspectRedisDatabases(withRedisRuntime(redis, selectedServer))
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setRedisDatabases(result.databases || [])
      setSelectedRedisDb(Number(redis.database || 0))
      await loadRedisKeys(redis, Number(redis.database || 0))
    } finally {
      setIsRedisLoading(false)
    }
  }

  const loadRedisKeys = async (redis = selectedRedis, database = selectedRedisDb, pattern = redisKeyPattern) => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!redis) return
    setIsRedisLoading(true)
    setSelectedRedisKey('')
    setRedisKeyDetail(null)
    try {
      const result = await window.opsFlow.listRedisKeys(withRedisRuntime(redis, selectedServer), database, pattern || '*')
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setSelectedRedisDb(database)
      setRedisKeys(result.keys || [])
      setRedisDatabases((current) => updateRedisDatabaseCount(current, database, result.keys?.length || 0))
      if (result.truncated) showToast('success', 'Loaded first 1000 keys.')
    } finally {
      setIsRedisLoading(false)
    }
  }

  const openRedisKey = async (key, redis = selectedRedis, database = selectedRedisDb) => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!redis || !key) return
    setSelectedRedisKey(key)
    setIsRedisLoading(true)
    try {
      const result = await window.opsFlow.readRedisKey(withRedisRuntime(redis, selectedServer), database, key)
      if (!result.ok) {
        showToast('error', result.message)
        return
      }
      setRedisKeyDetail(result)
    } finally {
      setIsRedisLoading(false)
    }
  }

  const deleteRedisKey = async () => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!selectedRedis || !selectedRedisKey) {
      showToast('error', 'Select a Redis key first.')
      return
    }
    if (!window.confirm(`Delete key ${selectedRedisKey}?`)) return
    const result = await window.opsFlow.deleteRedisKey(withRedisRuntime(selectedRedis, selectedServer), selectedRedisDb, selectedRedisKey)
    if (!result.ok) {
      showToast('error', result.message)
      return
    }
    showToast('success', 'Key deleted.')
    await loadRedisKeys(selectedRedis, selectedRedisDb)
  }

  const flushRedisDb = async () => {
    if (selectedServer.status !== 'connected') {
      showToast('error', 'Connect server first.')
      return
    }
    if (!selectedRedis) {
      showToast('error', 'Select a Redis connection first.')
      return
    }
    if (!window.confirm(`Clear Redis db${selectedRedisDb}? This cannot be undone.`)) return
    const result = await window.opsFlow.flushRedisDatabase(withRedisRuntime(selectedRedis, selectedServer), selectedRedisDb)
    if (!result.ok) {
      showToast('error', result.message)
      return
    }
    showToast('success', `db${selectedRedisDb} cleared.`)
    await refreshRedisDatabases(selectedRedis)
  }

  function appendLog(message) {
    setLogs((current) => [...current.slice(-9), `[${time()}] ${message}`])
  }

  function appendTerminal(output) {
    setTerminalOutput((current) => `${current.trimEnd()}\n\n${output}`.trimStart())
    terminalRef.current?.writeln(output)
  }

  function showToast(type, message) {
    setToast({ type, message })
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }

  function scrollModuleTabs(direction) {
    const target = moduleTabsRef.current
    if (!target) return
    target.scrollBy({
      left: direction * Math.max(180, target.clientWidth * 0.65),
      behavior: 'smooth'
    })
  }

  function updateTransferTask(payload) {
    window.clearTimeout(transferPanelTimerRef.current)
    setTransferTasks((current) => {
      const existing = current.find((item) => item.id === payload.id)
      const nextTask = {
        ...existing,
        ...payload,
        updatedAt: Date.now()
      }
      const next = existing
        ? current.map((item) => (item.id === payload.id ? nextTask : item))
        : [nextTask, ...current]
      const limited = next.slice(0, 50)
      window.opsFlow.setStore('transferTasks', limited)
      return limited
    })
    if (payload.status === 'failed') {
      setTransferPanelOpen(true)
      return
    }
    if (payload.status === 'done') {
      transferPanelTimerRef.current = window.setTimeout(() => {
        setTransferPanelOpen(false)
      }, 900)
      return
    }
    setTransferPanelOpen(true)
  }

  function clearTransferTasks() {
    window.clearTimeout(transferPanelTimerRef.current)
    setTransferTasks([])
    window.opsFlow.setStore('transferTasks', [])
  }

  function appendShellBuffer(serverId, data) {
    if (!serverId || !data) return
    const next = `${shellBuffersByServerRef.current[serverId] || ''}${data}`
    shellBuffersByServerRef.current[serverId] = next.length > 240000 ? next.slice(-240000) : next
  }

  function renderShellBuffer(serverId, fallback = '') {
    if (!terminalRef.current) return
    terminalRef.current.reset()
    const buffer = shellBuffersByServerRef.current[serverId] || ''
    if (buffer) {
      terminalRef.current.write(buffer)
    } else if (fallback) {
      terminalRef.current.writeln(fallback)
    }
    fitAddonRef.current?.fit()
    terminalRef.current.focus()
  }

  function bindTerminalToServer(server) {
    const sessionId = shellSessionsByServerRef.current[server.id]
    shellSessionRef.current = sessionId || null
    shellServerIdRef.current = sessionId ? server.id : ''
    if (sessionId) {
      renderShellBuffer(server.id, `${server.name} is connected.`)
      return true
    }
    return false
  }

  function saveCurrentWorkspace() {
    if (!selectedServerId) return
    if (selectedServer.status !== 'connected') return
    workspaceCacheRef.current[selectedServerId] = buildWorkspaceSnapshot()
  }

  function buildWorkspaceSnapshot() {
    return {
      remotePath,
      remoteItems,
      remoteSort,
      selectedRemoteItem,
      previewFile,
      previewContent,
      selectedDatabaseId,
      selectedDbTable,
      selectedDbColumn,
      tableColumns,
      sqlScript,
      sqlResult,
      selectedRedisId,
      selectedRedisDb,
      redisDatabases,
      redisKeys,
      redisKeyPattern,
      selectedRedisKey,
      redisKeyDetail,
      activeModule,
      terminalInput,
      terminalOutput,
      resourceHistory,
    }
  }

  function restoreServerWorkspace(workspace) {
    workspaceRestoringRef.current = true
    setRemotePath(workspace.remotePath || '/')
    setRemoteItems(workspace.remoteItems || [])
    setRemoteSort(workspace.remoteSort || { key: 'name', direction: 'asc' })
    setPendingRemoteFocusName('')
    setSelectedRemoteItem(workspace.selectedRemoteItem || null)
    setPreviewFile(workspace.previewFile || null)
    setPreviewContent(workspace.previewContent || '')
    setSelectedDatabaseId(workspace.selectedDatabaseId || '')
    setSelectedDbTable(workspace.selectedDbTable || null)
    setSelectedDbColumn(workspace.selectedDbColumn || null)
    setTableColumns(workspace.tableColumns || [])
    setSqlScript(workspace.sqlScript || sqlTemplate)
    setSqlResult(workspace.sqlResult || '')
    setSelectedRedisId(workspace.selectedRedisId || '')
    setSelectedRedisDb(Number(workspace.selectedRedisDb || 0))
    setRedisDatabases(workspace.redisDatabases || [])
    setRedisKeys(workspace.redisKeys || [])
    setRedisKeyPattern(workspace.redisKeyPattern || '*')
    setSelectedRedisKey(workspace.selectedRedisKey || '')
    setRedisKeyDetail(workspace.redisKeyDetail || null)
    if (workspace.activeModule && visibleModuleIds.includes(workspace.activeModule)) {
      setActiveModule(workspace.activeModule)
    }
    setTerminalInput(workspace.terminalInput || '')
    setTerminalOutput(workspace.terminalOutput || '')
    setResourceHistory(workspace.resourceHistory || makeInitialUsageHistory())
    const server = servers.find((item) => item.id === selectedServerId)
    if (server?.status === 'connected') {
      bindTerminalToServer(server)
    }
    window.requestAnimationFrame(() => {
      workspaceRestoringRef.current = false
    })
  }

  function resetTerminalForDisconnectedServer(server) {
    const sessionId = shellSessionsByServerRef.current[server.id]
    if (sessionId) {
      intentionalShellCloseRef.current = sessionId
      window.opsFlow.stopSshShell(sessionId)
      delete shellSessionsByServerRef.current[server.id]
      delete shellServerBySessionRef.current[sessionId]
    }
    if (shellServerIdRef.current === server.id) {
      shellSessionRef.current = null
      shellServerIdRef.current = ''
    }
    if (!terminalRef.current) return
    terminalRef.current.reset()
    terminalRef.current.writeln(`${server.name} is disconnected.`)
    terminalRef.current.writeln('Click Connect to start the SSH terminal.')
    fitAddonRef.current?.fit()
  }

  function setDisconnectedWorkspace(server) {
    resetTerminalForDisconnectedServer(server)
    setRemotePath('/')
    setRemoteItems([])
    setRemoteSort({ key: 'name', direction: 'asc' })
    setPendingRemoteFocusName('')
    setSelectedRemoteItem(null)
    setPreviewFile(null)
    setPreviewContent('')
    setSelectedDbTable(null)
    setSelectedDbColumn(null)
    setTableColumns([])
    setSqlResult('')
    setTerminalInput('')
    setTerminalOutput([
      `${server.name} is disconnected.`,
      'Click Connect to start the SSH terminal.',
      ''
    ].join('\n'))
    setSelectedDatabaseId(databases.find((item) => item.serverId === server.id)?.id || '')
  }

  function setConnectedWorkspace(server) {
    setRemotePath('/')
    setRemoteItems([])
    setRemoteSort({ key: 'name', direction: 'asc' })
    setPendingRemoteFocusName('')
    setSelectedRemoteItem(null)
    setPreviewFile(null)
    setPreviewContent('')
    setSelectedDbTable(null)
    setSelectedDbColumn(null)
    setTableColumns([])
    setSqlResult('')
    setTerminalInput('')
    setTerminalOutput([
      `${server.name} is connected.`,
      `${server.username}@${server.host}:${server.port}`,
      ''
    ].join('\n'))
    setSelectedDatabaseId(databases.find((item) => item.serverId === server.id)?.id || '')
    if (bindTerminalToServer(server)) {
      loadRemoteDirectory('/', server)
      return
    }
    terminalRef.current?.reset()
    terminalRef.current?.writeln(`${server.name} has no active terminal session.`)
    terminalRef.current?.writeln('Click Connect to open the SSH terminal.')
    fitAddonRef.current?.fit()
    loadRemoteDirectory('/', server)
  }

  function resetServerWorkspace() {
    setRemotePath('/')
    setRemoteItems([])
    setRemoteSort({ key: 'name', direction: 'asc' })
    setPendingRemoteFocusName('')
    setSelectedRemoteItem(null)
    setSelectedDatabaseId('')
    setSelectedDbTable(null)
    setSelectedDbColumn(null)
    setTableColumns([])
    setSqlResult('')
    setPreviewFile(null)
    setPreviewContent('')
    setTerminalInput('')
    setTerminalOutput([
      'Select a server, then click Connect to start the SSH terminal.',
      ''
    ].join('\n'))
  }

  function updateResourceHistory(server, reset = false) {
    const cpu = normalizePercent(server.cpuUsage)
    const memory = normalizePercent(server.memoryUsage)
    setResourceHistory((current) => {
      const base = reset ? makeInitialUsageHistory(cpu, memory) : current
      return {
        cpu: [...base.cpu.slice(-23), cpu],
        memory: [...base.memory.slice(-23), memory]
      }
    })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Boxes size={22} /></div>
          <div>
            <strong>Ops Flow</strong>
            <span>Server operations</span>
          </div>
        </div>

        <button className="primary-button" onClick={openAddServer}>
          <Plus size={16} />
          Add server
        </button>

        <div className="server-list">
          {servers.length ? (
            servers.map((server) => (
              <button
                key={server.id}
                className={`server-item server-${server.status || 'disconnected'} ${server.id === selectedServerId ? 'active' : ''}`}
                onClick={() => selectServer(server)}
              >
                <Server size={18} />
                <span>
                  <strong>{server.name}</strong>
                  <small>{server.host}:{server.port}</small>
                </span>
                <em title={server.lastError || server.status}>{formatServerStatus(server)}</em>
              </button>
            ))
          ) : (
            <div className="server-empty">
              <strong>No servers</strong>
              <span>Add your first SSH connection.</span>
            </div>
          )}
        </div>

        <section className="side-log">
          <div>Tool log</div>
          <pre>{logs.slice(-6).join('\n')}</pre>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{selectedServer.name}</h1>
            <p>{selectedServer.username}@{selectedServer.host}:{selectedServer.port}</p>
          </div>
          <div className="topbar-actions">
            <div className="transfer-center">
              <button
                title="Transfers"
                className={transferPanelOpen ? 'selected' : ''}
                onClick={() => setTransferPanelOpen((current) => !current)}
              >
              <Boxes size={16} />Transfers
              </button>
              {transferPanelOpen && (
                <TransferPopover transfers={transferTasks} onClear={clearTransferTasks} />
              )}
            </div>
            <button className="connect-button" onClick={connectServer} disabled={!selectedServer.id || isTestingServer}>
              <Power size={16} />{isTestingServer ? 'Connecting' : 'Connect'}
            </button>
            <button onClick={openEditServer} disabled={!selectedServer.id || isTestingServer}>
              <SquarePen size={16} />Edit
            </button>
            <button onClick={disconnectServer} disabled={!selectedServer.id || selectedServer.status !== 'connected'}>
              <PowerOff size={16} />Disconnect
            </button>
            <button className="danger-button" onClick={removeSelectedServer} disabled={!selectedServer.id}>
              <Trash2 size={16} />Remove
            </button>
          </div>
        </header>

        <section className="metrics">
          <Metric icon={<Activity />} label="Load" value={selectedServer.load} />
          <Metric icon={<HardDrive />} label="Memory" value={selectedServer.memory} />
          <Metric icon={<Server />} label="CPU" value={selectedServer.cpu} />
          <Metric icon={<ShieldCheck />} label="Status" value={selectedServer.status} tone={selectedServer.status} />
        </section>

        <section className="desktop-grid">
          <div className="left-stack">
            <Panel title="Basic info" icon={<Server size={17} />}>
              <InfoGrid server={selectedServer} history={resourceHistory} onCopy={(value) => copyText(value, showToast)} />
            </Panel>
            <RemoteFilesPanel
              path={remotePath}
              items={remoteItems}
              sort={remoteSort}
              focusedItemName={pendingRemoteFocusName}
              selectedItem={selectedRemoteItem}
              loading={isRemoteLoading}
              transferring={isFileTransferRunning}
              onOpen={openRemoteItem}
              onOpenDirectory={openRemoteDirectory}
              onOpenPath={(path) => loadRemoteDirectory(path)}
              onCopyPath={(value) => copyText(value, showToast)}
              onSort={(key) => {
                setRemoteSort((current) => ({
                  key,
                  direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
                }))
              }}
              onFocusHandled={() => setPendingRemoteFocusName('')}
              onParent={goRemoteParent}
              onUpload={uploadFile}
              onDownload={downloadFile}
              onEditFile={previewRemoteFile}
              onDelete={deleteRemoteItem}
              onRefresh={() => loadRemoteDirectory(remotePath)}
            />
          </div>

          <div className="right-stack">
            <section className="ops-panel">
              <div className="module-tabs-shell">
                <button className="tab-scroll-button" title="Scroll left" onClick={() => scrollModuleTabs(-1)}>&lt;</button>
                <nav className="module-tabs" ref={moduleTabsRef}>
                  <button className={activeModule === 'command' ? 'selected' : ''} onClick={() => setActiveModule('command')}>
                    <SquareTerminal size={16} />Command
                  </button>
                  <button className={activeModule === 'database' ? 'selected' : ''} onClick={() => setActiveModule('database')}>
                    <Database size={16} />Database
                  </button>
                  <button className={activeModule === 'redis' ? 'selected' : ''} onClick={() => setActiveModule('redis')}>
                    <Cable size={16} />Redis
                  </button>
                </nav>
                <button className="tab-scroll-button" title="Scroll right" onClick={() => scrollModuleTabs(1)}>&gt;</button>
              </div>

              <div className={`command-workspace ${activeModule === 'command' ? '' : 'hidden-module'}`}>
                <div className="terminal-shell">
                  <div className="terminal-xterm" ref={terminalHostRef} />
                </div>
              </div>

              {activeModule === 'database' && (
                <MaintenanceModule
                  empty={!selectedDatabases.length}
                  title="No database configured"
                  actionLabel="Add database"
                  onAdd={addDatabase}
                >
                  <DatabaseBrowser
                    databases={selectedDatabases}
                    selectedDatabase={selectedDatabase}
                    serverConnected={selectedServer.status === 'connected'}
                    selectedTable={selectedDbTable}
                    selectedColumn={selectedDbColumn}
                    privileges={selectedDatabase ? databasePrivileges[selectedDatabase.id] : null}
                    columns={tableColumns}
                    loading={isTableLoading}
                    privilegeLoading={isPrivilegeLoading}
                    sqlScript={sqlScript}
                    sqlResult={sqlResult}
                    onAdd={addDatabase}
                    onSelectDatabase={(database) => {
                      setSelectedDatabaseId(database.id)
                      setSelectedDbTable(null)
                      setSelectedDbColumn(null)
                      setTableColumns([])
                    }}
                    onSelectColumn={setSelectedDbColumn}
                    onEdit={editDatabase}
                    onDelete={deleteDatabase}
                    onRefreshTables={refreshDatabaseTables}
                    onCheckPrivileges={checkDatabasePrivileges}
                    onOpenTable={loadTableColumns}
                    onExportTables={exportDatabaseTables}
                    onSqlChange={setSqlScript}
                    onRunSql={runSql}
                    onCopy={(value) => copyText(value, showToast)}
                    onAddTable={openAddTable}
                    onEditTable={openEditTable}
                    onDeleteTable={deleteTable}
                    onAddColumn={openAddColumn}
                    onEditColumn={openEditColumn}
                    onDeleteColumn={deleteColumn}
                  />
                </MaintenanceModule>
              )}

              {activeModule === 'redis' && (
                <MaintenanceModule
                  empty={!selectedRedisStores.length}
                  title="No Redis configured"
                  actionLabel="Add Redis"
                  onAdd={addRedis}
                >
                  <RedisBrowser
                    connections={selectedRedisStores}
                    selected={selectedRedis}
                    serverConnected={selectedServer.status === 'connected'}
                    databases={redisDatabases}
                    selectedDb={selectedRedisDb}
                    keys={redisKeys}
                    pattern={redisKeyPattern}
                    selectedKey={selectedRedisKey}
                    detail={redisKeyDetail}
                    loading={isRedisLoading}
                    onAdd={addRedis}
                    onEdit={editRedis}
                    onDelete={deleteRedis}
                    onSelect={(redis) => {
                      setSelectedRedisId(redis.id)
                      setRedisDatabases([])
                      setRedisKeys([])
                      setSelectedRedisKey('')
                      setRedisKeyDetail(null)
                    }}
                    onRefresh={refreshRedisDatabases}
                    onSelectDb={(database) => loadRedisKeys(selectedRedis, database)}
                    onPatternChange={setRedisKeyPattern}
                    onSearch={() => loadRedisKeys(selectedRedis, selectedRedisDb)}
                    onOpenKey={openRedisKey}
                    onDeleteKey={deleteRedisKey}
                    onFlushDb={flushRedisDb}
                  />
                </MaintenanceModule>
              )}

            </section>
          </div>
        </section>
      </main>
      {isServerDialogOpen && (
        <ServerDialog
          form={serverForm}
          mode={editingServerId ? 'edit' : 'add'}
          isTesting={isTestingServer}
          notice={serverNotice}
          onChange={(key, value) => setServerForm((current) => ({ ...current, [key]: value }))}
          onClose={() => {
            setIsServerDialogOpen(false)
            setServerNotice(null)
          }}
          onSave={saveServer}
          onTest={testServerConnection}
        />
      )}
      {previewFile && (
        <FilePreviewDialog
          file={previewFile}
          content={previewContent}
          saving={isPreviewSaving}
          onChange={setPreviewContent}
          onClose={() => setPreviewFile(null)}
          onSave={savePreviewFile}
        />
      )}
      {isDatabaseDialogOpen && (
        <DatabaseDialog
          form={databaseForm}
          mode={editingDatabaseId ? 'edit' : 'add'}
          isTesting={isDatabaseTesting}
          notice={databaseNotice}
          onChange={(key, value) => setDatabaseForm((current) => ({ ...current, [key]: value }))}
          onClose={() => {
            setIsDatabaseDialogOpen(false)
            setEditingDatabaseId('')
            setDatabaseNotice(null)
          }}
          onSave={saveDatabase}
          onTest={testDatabaseConnection}
        />
      )}
      {isRedisDialogOpen && (
        <RedisDialog
          form={redisForm}
          mode={editingRedisId ? 'edit' : 'add'}
          isTesting={isRedisTesting}
          notice={redisNotice}
          onChange={(key, value) => setRedisForm((current) => ({ ...current, [key]: value }))}
          onClose={() => {
            setIsRedisDialogOpen(false)
            setEditingRedisId('')
            setRedisNotice(null)
          }}
          onSave={saveRedis}
          onTest={testRedisConnection}
        />
      )}
      {tableDialog && (
        <TableDialog
          mode={tableDialog.mode}
          form={tableForm}
          onChange={setTableForm}
          onClose={() => setTableDialog(null)}
          onSave={saveTableChange}
        />
      )}
      {columnDialog && (
        <ColumnDialog
          mode={columnDialog.mode}
          form={columnForm}
          onChange={(key, value) => setColumnForm((current) => ({ ...current, [key]: value }))}
          onClose={() => setColumnDialog(null)}
          onSave={saveColumnChange}
        />
      )}
      {toast && (
        <div className={`app-toast ${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  )
}

function Metric({ icon, label, value, tone }) {
  return (
    <div className={`metric ${tone ? `metric-${tone}` : ''}`}>
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}


function Panel({ title, icon, children }) {
  return (
    <section className="panel">
      <div className="panel-title"><span>{icon}{title}</span></div>
      {children}
    </section>
  )
}


function InfoGrid({ server, history, onCopy }) {
  const copyTimerRef = useRef(null)
  const machineName = server.hostname && server.hostname !== '-' ? server.hostname : server.name
  const items = [
    ['Machine', machineName],
    ['Kernel', server.kernel],
    ['OS / Arch', `${server.os} / ${server.arch}`],
    ['Uptime', server.uptime]
  ]
  const copyOnSingleClick = (value) => {
    window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => onCopy(value), 180)
  }
  const cancelCopy = () => {
    window.clearTimeout(copyTimerRef.current)
  }

  return (
    <div className="server-overview">
      <div className="machine-summary">
        {items.map(([label, value]) => (
          <button
            key={label}
            title={`Click to copy: ${value}`}
            onClick={() => copyOnSingleClick(value)}
            onDoubleClick={cancelCopy}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </button>
        ))}
      </div>
      <div className="usage-charts">
        <UsageChart label="CPU" value={server.cpuUsage} points={history.cpu} color="#0f766e" />
        <UsageChart label="Memory" value={server.memoryUsage} points={history.memory} color="#2563eb" />
      </div>
    </div>
  )
}


function UsageChart({ label, value, points }) {
  return (
    <div className="usage-chart">
      <div className="chart-head">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <svg viewBox="0 0 100 56" preserveAspectRatio="none">
        <path d={linePath(points)} fill="none" stroke="#2563eb" strokeWidth="2.5" />
      </svg>
    </div>
  )
}

function RemoteFilesPanel({ path, items, sort, focusedItemName, selectedItem, loading, transferring, onOpen, onOpenDirectory, onOpenPath, onCopyPath, onSort, onFocusHandled, onParent, onUpload, onDownload, onEditFile, onDelete, onRefresh }) {
  const breadcrumbs = buildRemoteBreadcrumbs(path)
  const [isPathTextMode, setIsPathTextMode] = useState(false)
  const pathInputRef = useRef(null)
  const focusedRowRef = useRef(null)
  const breadcrumbClickTimerRef = useRef(null)
  const itemCopyTimerRef = useRef(null)
  const sortedItems = useMemo(() => sortRemoteItems(items, sort), [items, sort])

  useEffect(() => {
    if (!isPathTextMode) return
    window.requestAnimationFrame(() => {
      pathInputRef.current?.focus()
      pathInputRef.current?.select()
    })
  }, [isPathTextMode, path])

  useEffect(() => () => {
    window.clearTimeout(breadcrumbClickTimerRef.current)
    window.clearTimeout(itemCopyTimerRef.current)
  }, [])

  useEffect(() => {
    if (!focusedItemName || loading) return
    window.requestAnimationFrame(() => {
      focusedRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      onFocusHandled?.()
    })
  }, [focusedItemName, loading, sortedItems, onFocusHandled])

  const renderSortHead = (key, label) => (
    <button type="button" className="remote-sort-button" onClick={() => onSort(key)}>
      <span>{label}</span>
      <em>{sort?.key === key ? (sort.direction === 'asc' ? '▲' : '▼') : ''}</em>
    </button>
  )

  const openBreadcrumbPath = (nextPath) => {
    window.clearTimeout(breadcrumbClickTimerRef.current)
    breadcrumbClickTimerRef.current = window.setTimeout(() => onOpenPath(nextPath), 180)
  }

  const enterPathTextMode = () => {
    window.clearTimeout(breadcrumbClickTimerRef.current)
    setIsPathTextMode(true)
  }

  const copyItemPath = (item) => {
    window.clearTimeout(itemCopyTimerRef.current)
    itemCopyTimerRef.current = window.setTimeout(() => {
      onCopyPath(joinRemotePath(path, item.name))
    }, 220)
  }

  const cancelItemCopy = () => {
    window.clearTimeout(itemCopyTimerRef.current)
  }

  return (
    <section className="panel remote-panel">
      <div className="panel-title">
        <span><Folder size={17} />Remote files</span>
        <div className="icon-actions">
          <button title="Upload" onClick={onUpload} disabled={loading || transferring}><Upload size={16} /></button>
          <button title="Download" onClick={onDownload} disabled={loading || transferring || selectedItem?.type !== 'file'}><Download size={16} /></button>
          <button title="Delete" onClick={onDelete} disabled={loading || transferring || !selectedItem}><Trash2 size={16} /></button>
          <button title="Refresh" onClick={onRefresh} disabled={loading || transferring}><RefreshCw size={16} /></button>
        </div>
      </div>
      <div className="remote-path">
        <button onClick={() => onParent()}>..</button>
        {isPathTextMode ? (
          <input
            ref={pathInputRef}
            className="remote-path-input"
            value={path}
            readOnly
            onBlur={() => setIsPathTextMode(false)}
            onMouseLeave={() => setIsPathTextMode(false)}
            onClick={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Enter') {
                setIsPathTextMode(false)
              }
            }}
          />
        ) : (
          <div
            className="remote-breadcrumbs"
            title="Double-click to select full path"
            onDoubleClick={enterPathTextMode}
            onContextMenu={(event) => {
              event.preventDefault()
              onCopyPath(path)
            }}
          >
            {breadcrumbs.map((part, index) => (
              <React.Fragment key={part.path}>
                {index > 0 && <span className="breadcrumb-separator">/</span>}
                <button
                  type="button"
                  title={part.path}
                  onClick={() => openBreadcrumbPath(part.path)}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    enterPathTextMode()
                  }}
                >
                  {part.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
      <div className="remote-table-wrap">
        <table className="remote-table">
          <thead>
            <tr>
              <th>{renderSortHead('name', 'Name')}</th>
              <th>{renderSortHead('type', 'Type')}</th>
              <th>{renderSortHead('size', 'Size')}</th>
              <th>{renderSortHead('permissions', 'Permissions')}</th>
              <th>{renderSortHead('owner', 'Owner')}</th>
              <th>{renderSortHead('modified', 'Modified')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr
              >
                <td className="remote-empty-row" colSpan="6">{transferring ? 'Transferring file...' : 'Loading remote directory...'}</td>
              </tr>
            ) : sortedItems.length ? (
              sortedItems.map((item) => {
                const isSelected = selectedItem?.name === item.name && selectedItem?.type === item.type
                const isFocused = focusedItemName === item.name
                return (
                <tr
                  key={`${path}-${item.name}`}
                  ref={isFocused ? focusedRowRef : null}
                  className={[isSelected ? 'selected' : '', isFocused ? 'focused' : ''].filter(Boolean).join(' ')}
                  onClick={() => onOpen(item)}
                  onDoubleClick={() => {
                    cancelItemCopy()
                    item.type === 'file' ? onEditFile(item) : onOpenDirectory(item)
                  }}
                >
                  <td>
                    {item.type === 'dir' ? <Folder size={15} /> : <File size={15} />}
                    <span
                      title={`${joinRemotePath(path, item.name)} - click to copy path`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onOpen(item)
                        copyItemPath(item)
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        cancelItemCopy()
                        item.type === 'file' ? onEditFile(item) : onOpenDirectory(item)
                      }}
                    >
                      {item.name}
                    </span>
                  </td>
                  <td>{item.type}</td>
                  <td>{item.size}</td>
                  <td>{item.permissions || '-'}</td>
                  <td>{item.owner || '-'}</td>
                  <td>{item.modified}</td>
                </tr>
                )
              })
            ) : (
              <tr>
                <td className="remote-empty-row" colSpan="6">Connect to a server to load files.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}


function MaintenanceModule({ empty, title, actionLabel, onAdd, children }) {
  if (empty) {
    return (
      <div className="empty-module">
        <strong>{title}</strong>
        <span>Configure it only when this server needs that maintenance capability.</span>
        <button className="solid-button" onClick={onAdd}><Plus size={16} />{actionLabel}</button>
      </div>
    )
  }
  return <div className="maintenance-content">{children}</div>
}


function DatabaseBrowser({ databases, selectedDatabase, serverConnected, selectedTable, selectedColumn, privileges, columns, loading, privilegeLoading, sqlScript, sqlResult, onAdd, onSelectDatabase, onSelectColumn, onEdit, onDelete, onRefreshTables, onCheckPrivileges, onOpenTable, onExportTables, onSqlChange, onRunSql, onCopy, onAddTable, onEditTable, onDeleteTable, onAddColumn, onEditColumn, onDeleteColumn }) {
  const tables = selectedDatabase?.tables || []
  const [checkedTables, setCheckedTables] = useState([])
  const canCreate = hasPrivilege(privileges, 'create')
  const canAlter = hasPrivilege(privileges, 'alter')
  const canDrop = hasPrivilege(privileges, 'drop')
  const copyTimerRef = useRef(null)
  const copyOnSingleClick = (value) => {
    window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => onCopy(value), 180)
  }
  const cancelCopy = () => {
    window.clearTimeout(copyTimerRef.current)
  }
  const selectedExportTables = tables.filter((table) => checkedTables.includes(`${table.schema}.${table.name}`))
  const toggleTableCheck = (table) => {
    const id = `${table.schema}.${table.name}`
    setCheckedTables((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  return (
    <div className="database-browser">
      {!serverConnected && <div className="module-disabled-banner">Connect server first to use database tools.</div>}
      <div className="database-toolbar">
        <div className="database-picker">
          <span>Connection</span>
          <select
            value={selectedDatabase?.id || ''}
            onChange={(event) => {
              const database = databases.find((item) => item.id === event.target.value)
              if (database) onSelectDatabase(database)
            }}
          >
            {databases.map((database) => (
              <option key={database.id} value={database.id}>
                {database.name} / {database.engine} / {database.database}
              </option>
            ))}
          </select>
        </div>
        <div className="db-actions">
          <button title="Add connection" onClick={onAdd}><Plus size={15} />Add</button>
          <button title="Edit connection" onClick={() => onEdit(selectedDatabase)} disabled={!selectedDatabase}><SquarePen size={15} />Edit</button>
          <button title="Delete connection" onClick={() => onDelete(selectedDatabase)} disabled={!selectedDatabase}><Trash2 size={15} />Delete</button>
          <button title="Refresh tables" onClick={() => onRefreshTables(selectedDatabase)} disabled={!serverConnected || !selectedDatabase || loading}><RefreshCw size={15} />Refresh</button>
          <button title="Check privileges" onClick={() => onCheckPrivileges(selectedDatabase)} disabled={!serverConnected || !selectedDatabase || privilegeLoading}><ShieldCheck size={15} />{privilegeLoading ? 'Checking' : 'Privileges'}</button>
        </div>
      </div>
      <div className={`privilege-strip ${privileges?.ok === false ? 'error' : privileges ? '' : 'empty'}`}>
        {privilegeLoading ? (
          <span>Checking privileges...</span>
        ) : privileges?.ok === false ? (
          <span>{privileges.message}</span>
        ) : privileges ? (
          <>
          <span title={privileges.user}>{privileges.user}</span>
          {['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop'].map((name) => (
            <em key={name} className={privilegeClass(privileges.privileges?.[name])}>{name}</em>
          ))}
          </>
        ) : (
          <span>Privileges not checked</span>
        )}
      </div>

      <div className="schema-browser">
        <div className="table-list">
          <div className="database-head">
            <strong>Tables</strong>
            <div className="column-actions table-actions">
              <span className="count-badge">{tables.length}</span>
              <button title="Export SQL" onClick={() => onExportTables(selectedExportTables, 'sql')} disabled={!serverConnected || !selectedExportTables.length || loading}>SQL</button>
              <button title="Export CSV" onClick={() => onExportTables(selectedExportTables, 'csv')} disabled={!serverConnected || !selectedExportTables.length || loading}>CSV</button>
              <button onClick={onAddTable} disabled={!serverConnected || !selectedDatabase || loading || !canCreate} title={!canCreate ? 'No CREATE permission' : 'Add table'}><Plus size={14} /><span>Add</span></button>
              <button onClick={onEditTable} disabled={!serverConnected || !selectedTable || loading || !canAlter} title={!canAlter ? 'No ALTER permission' : 'Rename table'}><SquarePen size={14} /><span>Edit</span></button>
              <button onClick={onDeleteTable} disabled={!serverConnected || !selectedTable || loading || !canDrop} title={!canDrop ? 'No DROP permission' : 'Delete table'}><Trash2 size={14} /><span>Delete</span></button>
            </div>
          </div>
          <div className="table-items">
            {tables.length ? (
              tables.map((table) => (
                <div
                  key={`${table.schema}.${table.name}`}
                  className={`table-item ${selectedTable?.schema === table.schema && selectedTable?.name === table.name ? 'selected' : ''}`}
                  title={`${table.schema}.${table.name}`}
                  onDoubleClick={() => {
                    cancelCopy()
                    onOpenTable(table)
                  }}
                  onClick={() => copyOnSingleClick(table.name)}
                >
                  <input
                    type="checkbox"
                    checked={checkedTables.includes(`${table.schema}.${table.name}`)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggleTableCheck(table)}
                  />
                  <Database size={15} />
                  <span
                    className="copyable-name"
                    title={`Click to copy: ${table.name}`}
                  >
                    {table.name}
                  </span>
                </div>
              ))
            ) : (
              <div className="table-empty">
                <span>No tables loaded.</span>
                <button onClick={() => onRefreshTables(selectedDatabase)} disabled={!selectedDatabase || loading}>
                  <RefreshCw size={15} />{loading ? 'Loading' : 'Load tables'}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="column-panel">
          <div className="database-head">
            <strong>Fields</strong>
            <div className="column-actions field-actions">
              <span className="count-badge">{loading ? '...' : columns.length}</span>
              <button onClick={onAddColumn} disabled={!serverConnected || !selectedTable || loading || !canAlter} title={!canAlter ? 'No ALTER permission' : 'Add field'}><Plus size={14} /><span>Add</span></button>
              <button onClick={onEditColumn} disabled={!serverConnected || !selectedColumn || loading || !canAlter} title={!canAlter ? 'No ALTER permission' : 'Edit field'}><SquarePen size={14} /><span>Edit</span></button>
              <button onClick={onDeleteColumn} disabled={!serverConnected || !selectedColumn || loading || !canAlter} title={!canAlter ? 'No ALTER permission' : 'Delete field'}><Trash2 size={14} /><span>Delete</span></button>
            </div>
          </div>
          <div className="columns-table-wrap">
            <table className="columns-table">
              <colgroup>
                <col className="field-name-col" />
                <col className="field-type-col" />
                <col className="field-null-col" />
                <col className="field-default-col" />
              </colgroup>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Default</th>
                </tr>
              </thead>
              <tbody>
                {columns.length ? (
                  columns.map((column) => (
                    <tr
                      key={column.name}
                      className={selectedColumn?.name === column.name ? 'selected' : ''}
                      onClick={() => onSelectColumn(column)}
                    >
                      <td
                        className="copyable-field"
                        title={`Click to copy: ${column.name}`}
                        onClick={() => copyOnSingleClick(column.name)}
                        onDoubleClick={cancelCopy}
                      >
                        {column.name}
                      </td>
                      <td title={column.type}>{column.type}</td>
                      <td>{column.nullable}</td>
                      <td title={column.defaultValue}>{column.defaultValue}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="4" className="db-empty-row">Double-click a table to view fields.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="sql-editor-panel">
        <div className="database-head">
          <strong>SQL</strong>
          <div>
            <span>Ctrl+Enter to run</span>
            <button className="solid-button" onClick={onRunSql} disabled={!serverConnected}><CirclePlay size={15} />Run</button>
          </div>
        </div>
        <textarea
          value={sqlScript}
          onChange={(event) => onSqlChange(event.target.value)}
          onKeyDown={(event) => {
            if (serverConnected && event.ctrlKey && event.key === 'Enter') {
              event.preventDefault()
              onRunSql()
            }
          }}
        />
      </div>

      <div className="sql-result-panel">
        <div className="database-head">
          <strong>Result</strong>
          <span>{resultSummary(sqlResult)}</span>
        </div>
        <SqlResultView result={sqlResult} />
      </div>
    </div>
  )
}


function RedisBrowser({ connections, selected, serverConnected, databases, selectedDb, keys, pattern, selectedKey, detail, loading, onAdd, onEdit, onDelete, onSelect, onRefresh, onSelectDb, onPatternChange, onSearch, onOpenKey, onDeleteKey, onFlushDb }) {
  return (
    <div className="redis-browser">
      {!serverConnected && <div className="module-disabled-banner">Connect server first to use Redis tools.</div>}
      <div className="redis-toolbar">
        <select value={selected?.id || ''} onChange={(event) => onSelect(connections.find((item) => item.id === event.target.value))}>
          {connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button onClick={onAdd}><Plus size={14} />Add</button>
        <button onClick={() => onEdit()} disabled={!selected}><SquarePen size={14} />Edit</button>
        <button onClick={() => onDelete()} disabled={!selected}><Trash2 size={14} />Delete</button>
        <button className="solid-button" onClick={() => onRefresh()} disabled={!serverConnected || !selected || loading}><RefreshCw size={14} />{loading ? 'Loading' : 'Load'}</button>
      </div>
      <div className="redis-main">
        <aside className="redis-sidebar">
          <div className="redis-section-title">Databases</div>
          <div className="redis-db-list">
            {(databases.length ? databases : Array.from({ length: 16 }, (_item, index) => ({ index, keys: 0 }))).map((db) => (
              <button key={db.index} className={Number(selectedDb) === db.index ? 'selected' : ''} onClick={() => onSelectDb(db.index)} disabled={!serverConnected}>
                <Database size={14} /><span>db{db.index}</span><em>{db.keys || 0}</em>
              </button>
            ))}
          </div>
        </aside>
        <section className="redis-key-panel">
          <div className="redis-section-title"><span>Keys</span><button onClick={onFlushDb} disabled={!serverConnected || !selected || loading}><Trash2 size={14} />Clear DB</button></div>
          <div className="redis-search">
            <input value={pattern} onChange={(event) => onPatternChange(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onSearch()} placeholder="Pattern, e.g. user:*" />
            <button onClick={onSearch} disabled={!serverConnected || !selected || loading}>Search</button>
          </div>
          <div className="redis-key-list">
            {keys.length ? keys.map((key) => (
              <button key={key} className={selectedKey === key ? 'selected' : ''} onClick={() => onOpenKey(key)} disabled={!serverConnected}>
                <ShieldCheck size={14} /><span title={key}>{key}</span>
              </button>
            )) : <div className="redis-empty">{loading ? 'Loading keys...' : 'No keys loaded.'}</div>}
          </div>
        </section>
        <section className="redis-value-panel">
          <div className="redis-section-title"><span>Value</span><button onClick={onDeleteKey} disabled={!serverConnected || !selectedKey || loading}><Trash2 size={14} />Delete key</button></div>
          {detail ? (
            <>
              <div className="redis-meta"><span>Type: {detail.type}</span><span>TTL: {formatRedisTtl(detail.ttl)}</span></div>
              <textarea readOnly value={formatRedisValue(detail.value)} />
            </>
          ) : <div className="redis-empty">Select a key to view its value.</div>}
        </section>
      </div>
    </div>
  )
}


function TransferPopover({ transfers, onClear }) {
  return (
    <div className="transfer-popover">
      <div className="transfer-popover-title">
        <div>
          <strong>Transfers</strong>
          <span>{transfers.length ? `${transfers.length} history` : 'No activity'}</span>
        </div>
        <button onClick={onClear} disabled={!transfers.length}>Clear</button>
      </div>
      <div className="transfer-list">
        {transfers.length ? transfers.map((task) => (
          <div className={`transfer-row ${task.status || 'running'}`} key={task.id}>
            <div>
              <strong title={task.name || task.remotePath}>
                <small>{transferTypeLabel(task)}</small>
                {task.name || task.remotePath}
              </strong>
              <span>{task.status === 'failed' ? task.message : transferPathLabel(task)}</span>
            </div>
            <em>{transferStatusLabel(task)}</em>
            <div className="transfer-progress"><span style={{ width: `${formatTransferPercent(task)}%` }} /></div>
          </div>
        )) : (
          <div className="transfer-empty">No transfers yet.</div>
        )}
      </div>
    </div>
  )
}


function FilePreviewDialog({ file, content, saving, onChange, onClose, onSave }) {
  return (
    <div className="modal-backdrop">
      <section className="file-preview-dialog">
        <div className="dialog-title">
          <div>
            <strong>{file.name}</strong>
            <span>{file.path}</span>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <textarea
          className="preview-editor"
          value={file.loading ? 'Loading remote file...' : content}
          onChange={(event) => onChange(event.target.value)}
          disabled={file.loading}
          spellCheck="false"
        />
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
          <button className="solid-button" onClick={onSave} disabled={saving || file.loading}>
            <Save size={16} />{file.loading ? 'Loading' : saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </section>
    </div>
  )
}


function DatabaseDialog({ form, mode, isTesting, notice, onChange, onClose, onSave, onTest }) {
  const isEdit = mode === 'edit'
  const changeEngine = (engine) => {
    onChange('engine', engine)
    onChange('port', defaultDatabasePort(engine))
  }

  return (
    <div className="modal-backdrop">
      <section className="server-dialog">
        <div className="dialog-title">
          <div>
            <strong>{isEdit ? 'Edit database' : 'Add database'}</strong>
            <span>{isEdit ? 'Update connection information.' : 'Save connection information. Load tables after saving.'}</span>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="server-form">
          <Field label="Name">
            <input value={form.name} onChange={(event) => onChange('name', event.target.value)} placeholder="prod-mysql" />
          </Field>
          <Field label="Engine">
            <select value={form.engine} onChange={(event) => changeEngine(event.target.value)}>
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
              <option value="sqlserver">SQL Server</option>
              <option value="oracle">Oracle</option>
              <option value="dm">Dameng</option>
            </select>
          </Field>
          <Field label="Connection method">
            <select value={form.connectionMode} onChange={(event) => onChange('connectionMode', event.target.value)}>
              <option value="ssh">Via server SSH</option>
              <option value="direct">Direct connection</option>
            </select>
          </Field>
          <Field label="Host">
            <input value={form.host} onChange={(event) => onChange('host', event.target.value)} placeholder="127.0.0.1" />
          </Field>
          <Field label="Port">
            <input type="number" value={form.port} onChange={(event) => onChange('port', event.target.value)} />
          </Field>
          <Field label="Database">
            <input value={form.database} onChange={(event) => onChange('database', event.target.value)} placeholder="app" />
          </Field>
          <Field label="Username">
            <input value={form.username} onChange={(event) => onChange('username', event.target.value)} placeholder="root" />
          </Field>
          <Field label="Password">
            <input type="password" value={form.password} onChange={(event) => onChange('password', event.target.value)} />
          </Field>
        </div>
        {notice && (
          <div className={`dialog-notice ${notice.type}`}>
            {notice.text}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onTest} disabled={isTesting}>
            <CheckCircle2 size={16} />{isTesting ? 'Testing' : 'Test connection'}
          </button>
          <button className="solid-button" onClick={onSave}>
            {isEdit ? 'Save changes' : 'Save config'}
          </button>
        </div>
      </section>
    </div>
  )
}


function RedisDialog({ form, mode, isTesting, notice, onChange, onClose, onSave, onTest }) {
  const isEdit = mode === 'edit'
  return (
    <div className="modal-backdrop">
      <section className="server-dialog">
        <div className="dialog-title">
          <div><strong>{isEdit ? 'Edit Redis' : 'Add Redis'}</strong><span>Save Redis connection information locally.</span></div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="server-form">
          <Field label="Name"><input value={form.name} onChange={(event) => onChange('name', event.target.value)} placeholder="local-redis" /></Field>
          <Field label="Connection method">
            <select value={form.connectionMode} onChange={(event) => onChange('connectionMode', event.target.value)}>
              <option value="ssh">Via server SSH</option>
              <option value="direct">Direct connection</option>
            </select>
          </Field>
          <Field label="Host"><input value={form.host} onChange={(event) => onChange('host', event.target.value)} placeholder="127.0.0.1" /></Field>
          <Field label="Port"><input type="number" value={form.port} onChange={(event) => onChange('port', event.target.value)} /></Field>
          <Field label="Database"><input type="number" value={form.database} onChange={(event) => onChange('database', event.target.value)} /></Field>
          <Field label="Password"><input type="password" value={form.password} onChange={(event) => onChange('password', event.target.value)} /></Field>
          <label className="field checkbox-field"><span>TLS</span><input type="checkbox" checked={Boolean(form.tls)} onChange={(event) => onChange('tls', event.target.checked)} /></label>
        </div>
        {notice && <div className={`dialog-notice ${notice.type}`}>{notice.text}</div>}
        <div className="dialog-actions">
          <button onClick={onTest} disabled={isTesting}><CheckCircle2 size={16} />{isTesting ? 'Testing' : 'Test connection'}</button>
          <button className="solid-button" onClick={onSave} disabled={isTesting}>{isEdit ? 'Save changes' : 'Save Redis'}</button>
        </div>
      </section>
    </div>
  )
}


function TableDialog({ mode, form, onChange, onClose, onSave }) {
  const isEdit = mode === 'edit'
  const update = (patch) => onChange((current) => ({ ...current, ...patch }))
  const updateColumn = (id, patch) => {
    onChange((current) => ({
      ...current,
      columns: current.columns.map((column) => (column.id === id ? { ...column, ...patch } : column))
    }))
  }
  const addColumnRow = () => {
    onChange((current) => ({
      ...current,
      columns: [
        ...current.columns,
        { id: `column-${Date.now()}`, name: '', type: 'varchar(255)', nullable: true, defaultValue: '' }
      ]
    }))
  }
  const removeColumnRow = (id) => {
    onChange((current) => ({
      ...current,
      columns: current.columns.length > 1 ? current.columns.filter((column) => column.id !== id) : current.columns
    }))
  }

  return (
    <div className="modal-backdrop">
      <section className="server-dialog table-dialog">
        <div className="dialog-title">
          <div>
            <strong>{isEdit ? 'Rename table' : 'Add table'}</strong>
            <span>{isEdit ? 'Only table rename is handled here. Edit fields in the Fields area.' : 'Create a table with initial fields.'}</span>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="server-form">
          {isEdit ? (
            <>
              <Field label="Current name">
                <input value={form.name} disabled />
              </Field>
              <Field label="New name">
                <input value={form.newName} onChange={(event) => update({ newName: event.target.value })} placeholder="new_table_name" />
              </Field>
            </>
          ) : (
            <Field label="Table name">
              <input value={form.name} onChange={(event) => update({ name: event.target.value })} placeholder="new_table" />
            </Field>
          )}
        </div>
        {!isEdit && (
          <div className="table-column-editor">
            <div className="database-head">
              <strong>Initial fields</strong>
              <button onClick={addColumnRow}><Plus size={14} />Add field</button>
            </div>
            <div className="table-column-rows">
              {form.columns.map((column) => (
                <div key={column.id} className="table-column-row">
                  <input value={column.name} onChange={(event) => updateColumn(column.id, { name: event.target.value })} placeholder="field_name" />
                  <input value={column.type} onChange={(event) => updateColumn(column.id, { type: event.target.value })} placeholder="varchar(255)" />
                  <select value={column.nullable ? 'yes' : 'no'} onChange={(event) => updateColumn(column.id, { nullable: event.target.value === 'yes' })}>
                    <option value="yes">Nullable</option>
                    <option value="no">Not null</option>
                  </select>
                  <input value={column.defaultValue} onChange={(event) => updateColumn(column.id, { defaultValue: event.target.value })} placeholder="default" />
                  <button title="Remove field" onClick={() => removeColumnRow(column.id)} disabled={form.columns.length <= 1}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="solid-button" onClick={onSave}>{isEdit ? 'Rename' : 'Create table'}</button>
        </div>
      </section>
    </div>
  )
}


function ColumnDialog({ mode, form, onChange, onClose, onSave }) {
  const isEdit = mode === 'edit'
  return (
    <div className="modal-backdrop">
      <section className="server-dialog column-dialog">
        <div className="dialog-title">
          <div>
            <strong>{isEdit ? 'Edit column' : 'Add column'}</strong>
            <span>{isEdit ? 'Update name, type, nullability and default value.' : 'Create a new field on the selected table.'}</span>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="server-form">
          {isEdit ? (
            <>
              <Field label="Current name">
                <input value={form.name} disabled />
              </Field>
              <Field label="New name">
                <input value={form.newName} onChange={(event) => onChange('newName', event.target.value)} placeholder="new_column_name" />
              </Field>
              <Field label="Type">
                <input value={form.type} onChange={(event) => onChange('type', event.target.value)} placeholder="varchar(255)" />
              </Field>
              <Field label="Nullable">
                <select value={form.nullable ? 'yes' : 'no'} onChange={(event) => onChange('nullable', event.target.value === 'yes')}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Default">
                <input value={form.defaultValue} onChange={(event) => onChange('defaultValue', event.target.value)} placeholder="optional SQL expression" />
              </Field>
            </>
          ) : (
            <>
              <Field label="Name">
                <input value={form.name} onChange={(event) => onChange('name', event.target.value)} placeholder="new_column" />
              </Field>
              <Field label="Type">
                <input value={form.type} onChange={(event) => onChange('type', event.target.value)} placeholder="varchar(255)" />
              </Field>
              <Field label="Nullable">
                <select value={form.nullable ? 'yes' : 'no'} onChange={(event) => onChange('nullable', event.target.value === 'yes')}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Default">
                <input value={form.defaultValue} onChange={(event) => onChange('defaultValue', event.target.value)} placeholder="optional SQL expression" />
              </Field>
            </>
          )}
        </div>
        {notice && (
          <div className={`dialog-notice ${notice.type}`}>
            {notice.text}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="solid-button" onClick={onSave}>{isEdit ? 'Save changes' : 'Add column'}</button>
        </div>
      </section>
    </div>
  )
}


function ServerDialog({ form, mode, isTesting, notice, onChange, onClose, onSave, onTest }) {
  const isEdit = mode === 'edit'
  return (
    <div className="modal-backdrop">
      <section className="server-dialog">
        <div className="dialog-title">
          <div>
            <strong>{isEdit ? 'Edit server' : 'Add server'}</strong>
            <span>{isEdit ? 'Update SSH connection information.' : 'Save SSH connection information locally.'}</span>
          </div>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="server-form">
          <Field label="Name">
            <input value={form.name} onChange={(event) => onChange('name', event.target.value)} placeholder="prod-api-01" />
          </Field>
          <Field label="Env">
            <input value={form.env} onChange={(event) => onChange('env', event.target.value)} placeholder="prod" />
          </Field>
          <Field label="Host">
            <input value={form.host} onChange={(event) => onChange('host', event.target.value)} placeholder="192.168.1.20" />
          </Field>
          <Field label="Port">
            <input type="number" value={form.port} onChange={(event) => onChange('port', event.target.value)} />
          </Field>
          <Field label="Username">
            <input value={form.username} onChange={(event) => onChange('username', event.target.value)} placeholder="root" />
          </Field>
          <Field label="Auth">
            <select value={form.authType} onChange={(event) => onChange('authType', event.target.value)}>
              <option value="password">Password</option>
              <option value="privateKey">Private key</option>
            </select>
          </Field>
          {form.authType === 'password' ? (
            <Field label="Password">
              <input type="password" value={form.password} onChange={(event) => onChange('password', event.target.value)} />
            </Field>
          ) : (
            <>
              <Field label="Passphrase">
                <input type="password" value={form.passphrase} onChange={(event) => onChange('passphrase', event.target.value)} />
              </Field>
              <label className="field field-wide">
                <span>Private key</span>
                <textarea value={form.privateKey} onChange={(event) => onChange('privateKey', event.target.value)} />
              </label>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button onClick={onTest} disabled={isTesting}>
            <CheckCircle2 size={16} />{isTesting ? 'Testing' : 'Test connection'}
          </button>
          <button className="solid-button" onClick={onSave}>{isEdit ? 'Save changes' : 'Save server'}</button>
        </div>
      </section>
    </div>
  )
}

function Field({ label, className = '', children }) {
  return (
    <label className={`field ${className}`.trim()}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function ResourceStrip({ items }) {
  return (
    <div className="resource-strip">
      {items.map((item) => (
        <div key={item.id}>
          <strong>{item.name}</strong>
          <span>{item.host}:{item.port}</span>
        </div>
      ))}
    </div>
  )
}

async function loadState() {
  const rawResources = await window.opsFlow.getStore('resources')
  const storedServers = await window.opsFlow.getStore('servers')
  const storedDatabases = await window.opsFlow.getStore('databases')
  const storedRedisStores = await window.opsFlow.getStore('redisStores')

  if (!rawResources?.length && !storedServers?.length && !storedDatabases?.length && !storedRedisStores?.length) return null
  const resourceServers = rawResources?.filter((item) => item.type === 'server') || []
  const resourceDatabases = rawResources?.filter((item) => item.type === 'database') || []
  const resourceRedisStores = rawResources?.filter((item) => item.type === 'redis') || []

  return {
    servers: mergeSavedItems(resourceServers, storedServers || []),
    databases: mergeSavedItems(resourceDatabases, storedDatabases || []),
    redisStores: mergeSavedItems(resourceRedisStores, storedRedisStores || [])
  }
}

function mergeSavedItems(resourceItems, storedItems) {
  const byId = new Map()
  resourceItems.forEach((item) => byId.set(item.id, stripResourceType(item)))
  storedItems.forEach((item) => byId.set(item.id, stripResourceType(item)))
  return Array.from(byId.values())
}

function stripResourceType(item) {
  const { type, ...rest } = item
  return rest
}

function persist({ servers, databases, redisStores }) {
  const resources = [
    ...servers.map((item) => ({ ...item, type: 'server' })),
    ...databases.map((item) => ({ ...item, type: 'database' })),
    ...redisStores.map((item) => ({ ...item, type: 'redis' }))
  ]

  return Promise.all([
    window.opsFlow.setStore('resources', resources),
    window.opsFlow.setStore('servers', servers),
    window.opsFlow.setStore('databases', databases),
    window.opsFlow.setStore('redisStores', redisStores)
  ])
}

function buildServerFromForm(form) {
  const name = form.name?.trim() || form.host?.trim() || 'new-server'
  const server = {
    id: `server-${Date.now()}`,
    name,
    hostname: '-',
    host: form.host.trim(),
    port: Number(form.port || 22),
    username: form.username.trim(),
    env: form.env?.trim() || 'dev',
    status: 'disconnected',
    load: '-',
    memory: '-',
    cpuUsage: null,
    memoryUsage: null,
    cpu: '-',
    arch: '-',
    os: '-',
    kernel: '-',
    uptime: '-'
  }

  if (form.authType === 'privateKey') {
    server.privateKey = form.privateKey
    server.passphrase = form.passphrase
  } else {
    server.password = form.password
  }

  return server
}

function buildFormFromServer(server) {
  const authType = server.privateKey ? 'privateKey' : 'password'
  return {
    name: server.name || '',
    host: server.host || '',
    port: server.port || 22,
    username: server.username || '',
    password: server.password || '',
    privateKey: server.privateKey || '',
    passphrase: server.passphrase || '',
    env: server.env || 'dev',
    authType
  }
}

function buildDatabaseFromForm(form, server) {
  return {
    id: `db-${Date.now()}`,
    serverId: server.id,
    name: form.name?.trim() || `${form.engine}-${form.database || form.host}`,
    engine: form.engine,
    connectionMode: form.connectionMode || 'ssh',
    host: form.host?.trim(),
    port: Number(form.port || defaultDatabasePort(form.engine)),
    database: form.database?.trim(),
    username: form.username?.trim(),
    password: form.password || '',
    tables: [],
    status: 'configured'
  }
}

function buildDatabaseFormFromConfig(database) {
  return {
    name: database.name || '',
    engine: database.engine || 'mysql',
    connectionMode: database.connectionMode || 'ssh',
    host: database.host || '127.0.0.1',
    port: database.port || defaultDatabasePort(database.engine),
    database: database.database || '',
    username: database.username || '',
    password: database.password || ''
  }
}

function buildRedisFromForm(form, serverId, id = `redis-${Date.now()}`) {
  return {
    id,
    serverId,
    name: form.name?.trim() || `${form.host || 'redis'}:${form.port || 6379}`,
    connectionMode: form.connectionMode || 'ssh',
    host: form.host?.trim(),
    port: Number(form.port || 6379),
    password: form.password || '',
    database: Number(form.database || 0),
    tls: Boolean(form.tls),
    status: 'configured'
  }
}

function buildRedisFormFromConfig(redis) {
  return {
    ...emptyRedisForm,
    name: redis.name || '',
    connectionMode: redis.connectionMode || 'ssh',
    host: redis.host || '127.0.0.1',
    port: redis.port || 6379,
    password: redis.password || '',
    database: redis.database || 0,
    tls: Boolean(redis.tls)
  }
}

function formatRedisTtl(ttl) {
  if (ttl === -1) return 'No expire'
  if (ttl === -2) return 'Missing'
  return `${ttl}s`
}

function updateRedisDatabaseCount(databases, database, count) {
  const index = Number(database || 0)
  const nextCount = Number(count || 0)
  const base = databases.length
    ? databases
    : Array.from({ length: 16 }, (_item, itemIndex) => ({ index: itemIndex, keys: 0, expires: 0, avgTtl: 0 }))

  return base.map((item) => (
    Number(item.index) === index
      ? { ...item, keys: Math.max(Number(item.keys || 0), nextCount) }
      : item
  ))
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function toTitle(value) {
  return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1)
}

function formatRedisValue(value) {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2)
}

function withDatabaseRuntime(database, server) {
  if (!database || database.connectionMode !== 'ssh') return database
  return {
    ...database,
    sshConfig: server
  }
}

function withRedisRuntime(redis, server) {
  if (!redis || redis.connectionMode !== 'ssh') return redis
  return {
    ...redis,
    sshConfig: server
  }
}

function buildColumnAlterSql(database, table, dialog, form) {
  if (dialog.mode === 'edit') {
    const nextName = form.newName?.trim()
    const type = form.type?.trim()
    if (!dialog.column?.name || !nextName || !type) return ''
    return buildEditColumnSql(database, table, dialog.column, { ...form, newName: nextName, type })
  }

  const name = form.name?.trim()
  const type = form.type?.trim()
  if (!name || !type) return ''

  const pieces = [
    `ALTER TABLE ${qualifiedTableName(database, table)} ADD COLUMN ${quoteIdentifier(database, name)} ${type}`,
    form.nullable ? '' : 'NOT NULL',
    form.defaultValue?.trim() ? `DEFAULT ${form.defaultValue.trim()}` : ''
  ].filter(Boolean)

  return `${pieces.join(' ')};`
}

function buildTableAlterSql(database, dialog, form) {
  if (dialog.mode === 'edit') {
    const nextName = form.newName?.trim()
    if (!dialog.table?.name || !nextName) return ''
    return buildRenameTableSql(database, dialog.table, nextName)
  }

  const name = form.name?.trim()
  const columns = (form.columns || [])
    .map((column) => ({
      name: column.name?.trim(),
      type: column.type?.trim(),
      nullable: column.nullable,
      defaultValue: column.defaultValue?.trim()
    }))
    .filter((column) => column.name && column.type)

  if (!name || !columns.length) return ''

  const columnSql = columns.map((column) => [
    `${quoteIdentifier(database, column.name)} ${column.type}`,
    column.nullable ? '' : 'NOT NULL',
    column.defaultValue ? `DEFAULT ${column.defaultValue}` : ''
  ].filter(Boolean).join(' '))

  return `CREATE TABLE ${qualifiedTableName(database, { schema: defaultSchemaForCreate(database), name })} (\n  ${columnSql.join(',\n  ')}\n);`
}

function buildRenameTableSql(database, table, nextName) {
  if (database.engine === 'postgres') {
    return `ALTER TABLE ${qualifiedTableName(database, table)} RENAME TO ${quoteIdentifier(database, nextName)};`
  }
  if (database.engine === 'sqlserver') {
    return `EXEC sp_rename '${table.schema}.${table.name}', '${nextName}';`
  }
  if (isOracleLikeEngine(database.engine)) {
    return `ALTER TABLE ${qualifiedTableName(database, table)} RENAME TO ${quoteIdentifier(database, nextName)};`
  }
  return `RENAME TABLE ${qualifiedTableName(database, table)} TO ${qualifiedTableName(database, { schema: table.schema, name: nextName })};`
}

function buildDropTableSql(database, table) {
  return `DROP TABLE ${qualifiedTableName(database, table)};`
}

function buildEditColumnSql(database, table, column, form) {
  const tableName = qualifiedTableName(database, table)
  const currentName = column.name
  const nextName = form.newName
  const defaultValue = form.defaultValue?.trim()
  const nullableSql = form.nullable ? 'NULL' : 'NOT NULL'
  const defaultSql = defaultValue ? `DEFAULT ${defaultValue}` : ''

  if (database.engine === 'postgres') {
    const statements = []
    if (currentName !== nextName) {
      statements.push(`ALTER TABLE ${tableName} RENAME COLUMN ${quoteIdentifier(database, currentName)} TO ${quoteIdentifier(database, nextName)}`)
    }
    const finalName = quoteIdentifier(database, nextName)
    statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${finalName} TYPE ${form.type}`)
    statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${finalName} ${form.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`)
    statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${finalName} ${defaultValue ? `SET DEFAULT ${defaultValue}` : 'DROP DEFAULT'}`)
    return `${statements.join(';\n')};`
  }

  if (database.engine === 'sqlserver') {
    const statements = []
    if (currentName !== nextName) {
      statements.push(`EXEC sp_rename '${table.schema}.${table.name}.${currentName}', '${nextName}', 'COLUMN'`)
    }
    statements.push(`ALTER TABLE ${tableName} ALTER COLUMN ${quoteIdentifier(database, nextName)} ${form.type} ${nullableSql}`)
    if (defaultValue) {
      statements.push(`ALTER TABLE ${tableName} ADD DEFAULT ${defaultValue} FOR ${quoteIdentifier(database, nextName)}`)
    }
    return `${statements.join(';\n')};`
  }

  if (isOracleLikeEngine(database.engine)) {
    const statements = []
    if (currentName !== nextName) {
      statements.push(`ALTER TABLE ${tableName} RENAME COLUMN ${quoteIdentifier(database, currentName)} TO ${quoteIdentifier(database, nextName)}`)
    }
    statements.push(`ALTER TABLE ${tableName} MODIFY ${quoteIdentifier(database, nextName)} ${form.type} ${form.nullable ? 'NULL' : 'NOT NULL'}`)
    if (defaultValue) {
      statements.push(`ALTER TABLE ${tableName} MODIFY ${quoteIdentifier(database, nextName)} DEFAULT ${defaultValue}`)
    }
    return `${statements.join(';\n')};`
  }

  return [
    `ALTER TABLE ${tableName} CHANGE COLUMN ${quoteIdentifier(database, currentName)} ${quoteIdentifier(database, nextName)} ${form.type}`,
    nullableSql,
    defaultSql
  ].filter(Boolean).join(' ') + ';'
}

function buildDropColumnSql(database, table, columnName) {
  return `ALTER TABLE ${qualifiedTableName(database, table)} DROP COLUMN ${quoteIdentifier(database, columnName)};`
}

function qualifiedTableName(database, table) {
  const schema = table.schema && table.schema !== '-' ? `${quoteIdentifier(database, table.schema)}.` : ''
  return `${schema}${quoteIdentifier(database, table.name)}`
}

function defaultSchemaForCreate(database) {
  if (database.engine === 'postgres') return 'public'
  if (database.engine === 'sqlserver') return 'dbo'
  if (isOracleLikeEngine(database.engine)) return database.username?.toUpperCase() || database.database
  return database.database
}

function quoteIdentifier(database, identifier) {
  const value = String(identifier || '')
  if (database.engine === 'postgres' || isOracleLikeEngine(database.engine)) return `"${value.replace(/"/g, '""')}"`
  if (database.engine === 'sqlserver') return `[${value.replace(/]/g, ']]')}]`
  return `\`${value.replace(/`/g, '``')}\``
}

function defaultDatabasePort(engine) {
  if (engine === 'postgres') return 5432
  if (engine === 'sqlserver') return 1433
  if (engine === 'oracle') return 1521
  if (engine === 'dm') return 5236
  return 3306
}

function isOracleLikeEngine(engine) {
  return engine === 'oracle' || engine === 'dm'
}

function formatConnectionMode(mode) {
  return mode === 'ssh' ? 'Via server SSH' : 'Direct'
}

function formatDatabaseError(message = '') {
  if (/Channel open failure: Connection refused/i.test(message)) {
    return 'Database connection failed: SSH reached the server, but the database host/port refused the connection. Check the DB port, service status, or Docker/internal address.'
  }
  if (/ETIMEDOUT|timed out/i.test(message)) {
    return 'Database connection failed: timed out. For local-only databases, use Via server SSH with Host 127.0.0.1; for exposed databases, use Direct connection.'
  }
  return `Database connection failed: ${message}`
}

function formatDatabaseOperationError(message = '') {
  const denied = message.match(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\s+command denied/i)
  if (denied) {
    const action = denied[1].toUpperCase()
    return `Permission denied: current database user does not have ${action} permission. Ask the DBA to grant it, then retry.`
  }
  if (/access denied/i.test(message)) {
    return `Permission denied: ${message}`
  }
  return message || 'Database operation failed.'
}

function normalizeDbTables(tables = []) {
  return tables.map((table) => ({
    schema: table.table_schema || table.TABLE_SCHEMA || table.schema || '-',
    name: table.table_name || table.TABLE_NAME || table.name || '-'
  }))
}

function normalizeDbColumns(columns = []) {
  return columns.map((column) => ({
    name: column.column_name || column.COLUMN_NAME || column.name || '-',
    type: column.data_type || column.DATA_TYPE || column.column_type || column.COLUMN_TYPE || '-',
    nullable: column.is_nullable || column.IS_NULLABLE || '-',
    defaultValue: column.column_default ?? column.COLUMN_DEFAULT ?? '-'
  }))
}

function normalizeSavedServer(server) {
  return resetServerRuntime(server)
}

function resetServerRuntime(server) {
  return {
    ...server,
    hostname: '-',
    status: 'disconnected',
    lastError: '',
    load: '-',
    memory: '-',
    cpuUsage: null,
    memoryUsage: null,
    cpu: '-',
    arch: '-',
    os: '-',
    kernel: '-',
    uptime: '-'
  }
}

function markServerConnectionFailed(server, message) {
  return {
    ...resetServerRuntime(server),
    status: 'error',
    lastError: message || 'Connection failed'
  }
}

function formatServerStatus(server) {
  if (server.status === 'connected') return 'online'
  if (server.status === 'connecting') return 'connecting'
  if (server.status === 'error') return 'failed'
  return server.env || 'offline'
}

function formatCommandOutput(command, result) {
  const chunks = []
  if (result.stdout?.trim()) chunks.push(result.stdout.trimEnd())
  if (result.stderr?.trim()) chunks.push(result.stderr.trimEnd())
  if (!result.ok && !chunks.length) chunks.push(result.message || `Command failed: ${command}`)
  if (!chunks.length) chunks.push('')
  return chunks.join('\n')
}

function formatSqlResult(result) {
  if (!result.ok) return { ok: false, message: `Error: ${result.message}` }
  const rows = result.rows || []
  if (Array.isArray(rows)) {
    return {
      ok: true,
      rows: rows.slice(0, 500),
      rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length,
      message: rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'} returned` : 'Query OK, 0 rows returned'
    }
  }

  const affectedRows = rows.affectedRows ?? result.rowCount
  const changedRows = rows.changedRows
  const insertId = rows.insertId
  const details = [
    typeof affectedRows === 'number' ? `${affectedRows} row${affectedRows === 1 ? '' : 's'} affected` : 'Query OK',
    typeof changedRows === 'number' ? `${changedRows} changed` : '',
    insertId ? `insert id ${insertId}` : ''
  ].filter(Boolean).join(', ')

  return {
    ok: true,
    rows: null,
    rowCount: affectedRows,
    message: details
  }
}

function resultSummary(result) {
  if (!result) return 'No result'
  if (typeof result === 'string') return result
  return result.message || 'Ready'
}

function hasPrivilege(privileges, name) {
  if (privileges?.ok === false) return false
  const value = privileges?.privileges?.[name]
  return value !== false
}

function privilegeClass(value) {
  if (value === true) return 'allowed'
  if (value === false) return 'denied'
  return 'unknown'
}

function formatCellValue(value) {
  if (value === null) return 'NULL'
  if (typeof value === 'undefined') return ''
  if (value instanceof Date) return value.toLocaleString('zh-CN', { hour12: false })
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatWelcomeTerminal(server, stdout = '') {
  const parsed = parseServerInspect(stdout)
  const hostname = parseHostname(stdout) || server.name
  const diskUsage = parseRootDiskUsage(stdout)
  const now = new Date().toLocaleString('zh-CN', { hour12: false })

  return [
    `Last login: ${now} from ${server.host}`,
    `Connected to ${hostname}`,
    '',
    `System information as of ${now}`,
    '',
    `  System load:    ${parsed.load}`,
    `  Memory:         ${parsed.memory}`,
    `  Root usage:     ${diskUsage}`,
    `  OS:             ${parsed.os}`,
    `  Kernel:         ${parsed.kernel}`,
    `  CPU:            ${parsed.cpu}`,
    `  Architecture:   ${parsed.arch}`,
    `  Uptime:         ${parsed.uptime}`,
    `  IP address:     ${server.host}`,
    ''
  ].join('\n')
}

function parseServerInspect(stdout = '') {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const hostname = parseHostname(stdout)
  const unameLine = lines.find((line) => /Linux|Darwin|Ubuntu|Rocky|CentOS|Debian/i.test(line)) || ''
  const uptimeLine = lines.find((line) => line.includes('load average') || line.includes('load averages')) || ''
  const memoryLine = lines.find((line) => line.startsWith('Mem:')) || ''
  const cpuUsageLine = lines.find((line) => line.startsWith('CPU_USAGE')) || ''
  const memoryUsageLine = lines.find((line) => line.startsWith('MEM_USAGE')) || ''
  const cpuLine = lines.find((line) => line.startsWith('CPU(s):')) || ''
  const archLine = lines.find((line) => line.startsWith('Architecture:')) || ''
  const modelLine = lines.find((line) => line.startsWith('Model name:')) || ''

  return {
    hostname: hostname || '-',
    os: parseOs(unameLine),
    kernel: parseKernel(unameLine),
    arch: archLine ? valueAfterColon(archLine) : '-',
    cpu: cpuLine ? `${valueAfterColon(cpuLine)} Core` : modelLine ? valueAfterColon(modelLine) : '-',
    cpuUsage: parseTaggedPercent(cpuUsageLine),
    memoryUsage: parseTaggedPercent(memoryUsageLine),
    memory: parseMemory(memoryLine),
    load: parseLoad(uptimeLine),
    uptime: parseUptime(uptimeLine)
  }
}

function parseOs(unameLine) {
  if (!unameLine) return '-'
  const parts = unameLine.split(/\s+/)
  return parts[0] || '-'
}

function parseKernel(unameLine) {
  if (!unameLine) return '-'
  const parts = unameLine.split(/\s+/)
  return parts[2] || parts[1] || '-'
}

function parseLoad(uptimeLine) {
  const match = uptimeLine.match(/load averages?:\s*([0-9.,\s]+)/i)
  if (match) return match[1].split(',')[0].trim()
  return '-'
}

function parseUptime(uptimeLine) {
  const match = uptimeLine.match(/up\s+(.+?),\s+\d+\s+users?/i)
  if (match) return match[1].trim()
  const compact = uptimeLine.match(/up\s+(.+?),\s+load averages?/i)
  return compact ? compact[1].trim() : '-'
}

function parseMemory(memoryLine) {
  if (!memoryLine) return '-'
  const parts = memoryLine.split(/\s+/)
  return parts[1] || '-'
}

function valueAfterColon(line) {
  return line.split(':').slice(1).join(':').trim()
}

function parseTaggedPercent(line) {
  const match = line.match(/([0-9]+(?:\.[0-9]+)?)/)
  return match ? Number(match[1]) : null
}

function normalizePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-'
  return `${Math.round(value)}%`
}

function makeInitialUsageHistory(cpu = 0, memory = 0) {
  return {
    cpu: Array.from({ length: 24 }, (_, index) => Math.max(0, normalizePercent(cpu) - (23 - index) * 0.2)),
    memory: Array.from({ length: 24 }, (_, index) => Math.max(0, normalizePercent(memory) - (23 - index) * 0.12))
  }
}

function linePath(points = []) {
  const safePoints = points.length ? points : makeInitialUsageHistory().cpu
  const step = safePoints.length > 1 ? 100 / (safePoints.length - 1) : 100
  return safePoints
    .map((point, index) => {
      const x = Number((index * step).toFixed(2))
      const y = Number((52 - normalizePercent(point) * 0.48).toFixed(2))
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')
}

function promptFor(server) {
  if (!server?.id) return '[not-connected]$'
  return `[${server.username || 'user'}@${server.host || 'host'} ~]$`
}

function parseHostname(stdout = '') {
  return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
}

function parseRootDiskUsage(stdout = '') {
  const line = stdout.split(/\r?\n/).find((item) => /\s\/$/.test(item.trim()))
  if (!line) return '-'
  const parts = line.trim().split(/\s+/)
  return parts.length >= 5 ? `${parts[4]} of ${parts[1]}` : '-'
}

function isDemoServer(server) {
  return ['prod-1', 'test-1'].includes(server.id) || ['prod-api-01', 'test-web-01'].includes(server.name)
}

function isDemoResource(resource) {
  return ['mysql-prod', 'redis-prod'].includes(resource.id) || ['order_mysql', 'cache_redis', 'app_cache'].includes(resource.name)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function copyText(value, notify) {
  const text = String(value ?? '').trim()
  if (!text || text === '-') {
    notify?.('error', 'Nothing to copy.')
    return
  }

  try {
    if (window.opsFlow?.writeClipboardText) {
      await window.opsFlow.writeClipboardText(text)
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      throw new Error('Clipboard API is unavailable.')
    }
    notify?.('success', 'Copied')
  } catch (error) {
    notify?.('error', `Copy failed: ${error.message || 'clipboard is unavailable'}`)
  }
}

function remoteBasename(path = '') {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function joinRemotePath(current, child) {
  if (current === '/') return `/${child}`
  return `${current}/${child}`
}

function buildCrumbs(path = '/') {
  const parts = String(path || '/').split('/').filter(Boolean)
  const crumbs = [{ label: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

function buildRemoteBreadcrumbs(path = '/') {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const parts = normalized.split('/').filter(Boolean)
  const breadcrumbs = [{ label: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current = `${current}/${part}`
    breadcrumbs.push({ label: part, path: current })
  }
  return breadcrumbs
}

function formatTransferPercent(task) {
  if (task.status === 'done') return 100
  if (!task.total) return 0
  return Math.max(0, Math.min(99, Math.round((Number(task.transferred || 0) / Number(task.total)) * 100)))
}

function transferTypeLabel(task) {
  if (task.type === 'deploy') return toTitle(task.action || 'Deploy')
  if (task.type === 'download') return 'Download'
  if (task.type === 'delete') return 'Delete'
  if (task.type === 'export') return 'Export'
  return 'Upload'
}

function transferPathLabel(task) {
  if (task.type === 'deploy') return task.message || task.remotePath || 'Remote command'
  if (task.type === 'download') return task.localPath
  if (task.type === 'delete') return task.currentPath || task.remotePath
  return task.remotePath || task.localPath
}

function transferStatusLabel(task) {
  if (task.status === 'done') return 'Done'
  if (task.status === 'failed') return 'Failed'
  return `${formatTransferPercent(task)}%`
}

function sortRemoteItems(items = [], sort = { key: 'name', direction: 'asc' }) {
  const key = sort?.key || 'name'
  const direction = sort?.direction === 'desc' ? -1 : 1
  return [...items].sort((left, right) => compareRemoteItems(left, right, key) * direction)
}

function compareRemoteItems(left, right, key) {
  if (key === 'size') {
    return parseRemoteSize(left.size) - parseRemoteSize(right.size)
  }
  const leftValue = normalizeRemoteSortValue(left[key])
  const rightValue = normalizeRemoteSortValue(right[key])
  return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' })
}

function normalizeRemoteSortValue(value) {
  return String(value || '').trim()
}

function parseRemoteSize(value) {
  if (typeof value === 'number') return value
  const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGT]?B)?$/i)
  if (!match) return -1
  const unit = (match[2] || 'B').toUpperCase()
  const multiplier = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1
  return Number(match[1]) * multiplier
}

function formatFileSize(value) {
  const size = Number(value || 0)
  if (!Number.isFinite(size) || size <= 0) return value === 0 ? '0 B' : '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let current = size
  let unit = 0
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024
    unit += 1
  }
  return `${Number(current.toFixed(current >= 10 || unit === 0 ? 0 : 1))} ${units[unit]}`
}

function tableKey(table) {
  if (!table) return ''
  return [table.schema, table.name || table.table || table.TABLE_NAME].filter(Boolean).join('.')
}

function formatTableName(table) {
  if (!table) return ''
  return tableKey(table) || String(table)
}

function SqlResultView({ result }) {
  if (!result) return <pre>Run SQL to show result here.</pre>
  if (typeof result === 'string') return <pre>{result}</pre>
  if (!result.ok) return <pre>{result.message}</pre>
  if (!Array.isArray(result.rows)) return <pre>{result.message}</pre>
  if (!result.rows.length) return <pre>{result.message}</pre>

  const columns = Array.from(result.rows.reduce((set, row) => {
    Object.keys(row || {}).forEach((key) => set.add(key))
    return set
  }, new Set()))

  return (
    <div className="result-table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>{formatCellValue(row?.[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function transferPercent(task) {
  if (task?.total) return Math.max(0, Math.min(100, Math.round((Number(task.transferred || 0) / Number(task.total)) * 100)))
  if (task?.status === 'done') return 100
  if (task?.status === 'failed') return 55
  return 35
}

function normalizeStoredTransferTask(task = {}) {
  return {
    id: String(task.id || `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: String(task.type || 'task'),
    name: String(task.name || task.remotePath || task.localPath || 'Transfer'),
    status: String(task.status || 'running'),
    message: String(task.message || ''),
    currentPath: String(task.currentPath || ''),
    remotePath: String(task.remotePath || ''),
    localPath: String(task.localPath || ''),
    transferred: Number(task.transferred || 0),
    total: Number(task.total || 0),
    updatedAt: task.updatedAt || new Date().toISOString()
  }
}

function time() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)



