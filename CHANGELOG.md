# Changelog

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
