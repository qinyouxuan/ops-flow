# Ops Flow

Ops Flow is a lightweight desktop operations workbench for SSH, SFTP, database and Redis maintenance.

This repository is the open-source base edition. It intentionally contains only the free core features:

- SSH server connection management
- Interactive SSH terminal
- Remote file browsing, upload, download, edit and delete
- Basic server resource summary
- Database connection management, table/field browsing and SQL execution
- Redis connection management, database/key browsing and basic commands
- Local transfer history for upload, download, delete and export tasks

Commercial-only capabilities are maintained outside this base edition.

## License

Ops Flow Community Edition is licensed under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).

Commercial and plus editions are distributed separately and are not included in this repository.

## Stack

- Electron
- React + Vite
- xterm.js
- ssh2
- mysql2 / pg
- redis
- electron-store

## Run

Use PowerShell:

```powershell
npm.cmd install
npm.cmd run dev
```

Ops Flow depends on the Electron preload bridge for SSH, SFTP, database and Redis operations. Running the Vite renderer directly in a browser is not a supported production entry.

## Build

```powershell
npm.cmd run build
```

## Release Packages

Build a Windows installer and a zip package:

```powershell
npm.cmd run dist:win
```

Build only the Windows zip package:

```powershell
npm.cmd run dist:win:zip
```

Release artifacts are written to `release/`. The NSIS installer target may download Electron Builder helper binaries on the first run. If GitHub access is slow or blocked, retry after the helper cache is available, or publish the zip package as a no-install fallback.
