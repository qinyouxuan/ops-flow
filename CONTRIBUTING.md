# Contributing

Thank you for helping improve Ops Flow Plus.

## Before opening a change

1. Search existing Issues and describe the operational problem being solved.
2. Keep changes focused and avoid committing generated output, credentials,
   private keys, certificates, real server addresses or encrypted backups.
3. For destructive remote actions, preserve confirmation, permission checks
   and useful error reporting.

## Local checks

Ops Flow Plus uses Electron, React, Vite, React Flow, xterm.js, ssh2,
mysql2, pg, mssql, oracledb, redis and electron-store.

Node.js `22.12.0` or newer is required. On Windows, use `npm.cmd` if the
PowerShell execution policy blocks `npm.ps1`:

```powershell
npm.cmd install
npm.cmd run audit:prod
npm.cmd run lint
npm.cmd run build
npm.cmd run dev
```

SSH, SFTP, database and Redis operations depend on the Electron preload
bridge. A browser-only Vite session is not a supported runtime.

Windows packages can be built with:

```powershell
npm.cmd run dist:win
npm.cmd run dist:win:zip
```

Generated artifacts are written to `release/` and must not be committed.
Before publishing, follow
[Windows code signing](./docs/windows-code-signing.md) and the
[release checklist](./docs/release-checklist.md).

## License

By submitting a contribution, you agree that your contribution is licensed
under MPL-2.0 and that you have the right to provide it under that license.
New source files should include:

```text
SPDX-License-Identifier: MPL-2.0
```

Use the comment syntax appropriate for the file type.
