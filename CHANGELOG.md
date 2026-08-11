# Changelog

## Unreleased

### Added

- Added a collapsible, resizable auxiliary workspace for basic server information
  and remote files. The main module expands into the released space, while the
  saved width and collapsed state persist across app restarts.
- Added a collapsible server navigation rail with a searchable server switcher,
  connection-status indicators and quick server creation. The expanded width
  and collapsed state are saved independently from the auxiliary workspace.
- Added automatic column-comment metadata adapters for MySQL/MariaDB,
  PostgreSQL, SQL Server, Oracle and Dameng. Every connection reuses its engine
  adapter and returns the same normalized column shape without user setup.
- Added column comments to the add/edit field dialog, including automatic
  engine-specific comment writes and comment removal when an edited value is cleared.

### Fixed

- Kept the database browser mounted and cached across top-level tab switches.
  Table metadata now reloads only when the selected database connection changes,
  when the user refreshes it explicitly, or after a schema-changing operation.

## 0.2.4 - 2026-08-11

### Added

- Added database-side pagination for single read-only `SELECT` and `WITH`
  queries, with selectable page sizes and next/previous navigation that avoids
  loading the full result set into the renderer.
- Added full query-result export to streaming Excel workbooks. Exports re-run
  only validated read-only queries, write rows in batches, report progress in
  Transfers and support cancellation with partial-file cleanup.

### Improved

- Made the table/field browser vertically resizable so more space can be given
  to the SQL editor and result grid, while retaining the existing horizontal
  table/field splitter.
- Renamed the SQL-file action to “Select script” to distinguish file selection
  from actual execution, and expanded the built-in database help.
- Simplified database and Redis connection selectors to display saved names
  only, and tightened the database toolbar layout for smaller windows.
- Added ExcelJS runtime licensing information and pinned its UUID dependency to
  a patched release.

## 0.2.3 - 2026-08-10

### Fixed

- Removed duplicate Dameng table entries by keeping schema-aware metadata and
  defaulting the browser to the connected user's current schema. Switching
  schemas now updates the active schema automatically for table and column
  queries.
- Improved SSH/SFTP stability by reusing the active terminal transport where
  possible and avoiding redundant owner lookups when the SFTP response already
  contains named owner and group information.
- Reduced UI stalls during uploads by throttling upload-only progress events,
  batching transfer-history persistence and remembering the last upload folder.

### Improved

- Added terminal-to-file-browser directory synchronization. Successful `cd`
  commands, including absolute and multi-level paths, now resolve through SFTP
  and update the remote file panel.
- Refined terminal typography and colors for longer sessions, and replaced the
  blue-black dark theme with an IDEA-inspired neutral charcoal palette while
  preserving the existing teal selection and status colors.
- Expanded the built-in help for Dameng schema browsing, terminal directory
  synchronization and SSH tunnel workflows.

## 0.2.2 - 2026-08-06

### Added

- Added saved SSH jump servers for terminal, SFTP, workflows, deployment and
  host-management connections to private servers without public IP addresses.
  Multi-hop chains, cycle validation and automatic tunnel cleanup are included.
- Added persistent localhost-only SSH tunnels for external database clients.
  Saved tunnels support manual start and stop, jump chains, port-conflict
  reporting, connection testing, concurrent local clients and automatic cleanup
  when the app exits.

### Improved

- Reused the active terminal SSH transport for host inspection and standard
  SFTP operations, reducing connection bursts on rate-limited SSH gateways.
  Remote-file failures now remain visible, and reconnect checks use delayed,
  lower-frequency attempts after a transport reset.

## 0.2.1 - 2026-07-27

### Fixed

- Kept the application icon consistent in development, packaged windows and
  Windows taskbar shortcuts
- Reduced terminal and sidebar scrollbars and corrected remote-file type and
  column-resize behavior
- Improved database connections through SSH for multiple MySQL instances,
  including TCP and Unix Socket modes
- Decoupled saved database and Redis connections from the currently selected
  server. Direct connections work without SSH, while SSH connections keep an
  explicit fixed jump-server association and open tunnels on demand
- Corrected runtime detection so process-only matches do not misidentify Java
  and other components
- Kept the database toolbar usable on smaller Windows displays by removing
  redundant manual refresh and privilege actions; table metadata and privileges
  continue to refresh automatically
- Reduced long workflow-name typography so deployment workflow titles no
  longer crowd or clip the list and detail panels

### Improved

- Added built-in logical database backups for direct and SSH-tunneled
  connections. Table fields, primary keys, secondary indexes, foreign keys,
  check and unique constraints, views, triggers, stored routines and data are
  written in batches to local SQL or GZIP-compressed SQL files without requiring
  native command-line clients; cancellation, partial-file cleanup, progress and
  SHA-256 output are included
- Added streaming execution for SQL and GZIP scripts larger than 10 MB, avoiding
  the editor and whole-file memory limits while retaining progress and
  cancellation
- Added current-database Redis logical backups using Redis DUMP payloads and
  expiration timestamps, plus verified `.opsredis` restoration with configurable
  conflict handling, progress and cancellation, without requiring `redis-cli`
- Added database-connection copying, recent remote paths and reusable command
  templates
- Added an explicit external-driver selector for Dameng. The commercial `dmdb`
  package is loaded from a user-selected local installation and is never copied
  into the app, dependency lock or encrypted configuration export
- Added an opt-in legacy Dameng compatibility mode. Dameng operations run in a
  dedicated Node.js child process that automatically selects the compatible
  cipher environment, while the main process, credential encryption and other
  database connections remain unchanged
- Kept configuration export, decrypt-preview and import progress with their
  corresponding panels, including visible success, cancellation and failure
  results
- Clarified Linux remote-server support, configuration privacy and unsigned
  Windows release requirements
- Read the displayed application version from Electron instead of maintaining a
  separate hard-coded value

## 0.2.0 - 2026-07-24

### Added

- Visual workflows with multi-server execution, role scopes and rollback nodes
- Package deployment and runtime inspection
- System services, cron tasks, firewall and listening-port management
- Backup-task discovery, artifact verification and confirmed restoration
- Encrypted configuration export, preview and cross-device import
- Remote path history, favorites and saved command templates
- Transfer and configuration-operation progress with cancellation support

### Improved

- Installation detection now recognizes package-managed and custom runtime paths
- Workflow dialogs and deployment results provide more space for command output
- Remote files support rename operations and faster path switching
- Help content covers workflows, backup and recovery, configuration migration and
  auxiliary tools

### Project

- All features are provided under a single project distribution
- Project source code is licensed under MPL-2.0
- Repository metadata, source notices, lint configuration and release guidance
  have been refreshed
