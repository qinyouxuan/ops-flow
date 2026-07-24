# Contributing

Thank you for helping improve Ops Flow Plus.

## Before opening a change

1. Search existing Issues and describe the operational problem being solved.
2. Keep changes focused and avoid committing generated output, credentials,
   private keys, certificates, real server addresses or encrypted backups.
3. For destructive remote actions, preserve confirmation, permission checks
   and useful error reporting.

## Local checks

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd run build
```

## License

By submitting a contribution, you agree that your contribution is licensed
under MPL-2.0 and that you have the right to provide it under that license.
New source files should include:

```text
SPDX-License-Identifier: MPL-2.0
```

Use the comment syntax appropriate for the file type.
