# Release checklist

## Source and licensing

- [ ] `package.json` and the About page show the same version.
- [ ] A final Windows `.ico` application icon is configured; the default
      Electron icon is not used.
- [ ] `LICENSE` is the unmodified official MPL-2.0 text.
- [ ] New source files contain `SPDX-License-Identifier: MPL-2.0`.
- [ ] `README.md`, `CHANGELOG.md`, `SOURCE_CODE.md`,
      `THIRD_PARTY_NOTICES.md` and `SECURITY.md` are current.
- [ ] No edition-specific or obsolete licensing copy remains.
- [ ] No private driver or dependency with restricted redistribution is
      included.

## Security

- [ ] No `.env`, private key, certificate, database password, server password,
      real server address or encrypted configuration backup is tracked.
- [ ] The signing certificate and password are supplied only through protected
      local storage or CI secrets.
- [ ] Remote-operation examples use clearly fictional names and addresses.

## Verification

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run build
npm.cmd run dist:win:signed
npm.cmd run verify:release:signed
```

- [ ] The installer and packaged application both have valid Authenticode
      signatures.
- [ ] A clean Windows test machine can install, launch and uninstall the app.
- [ ] Configuration export/import is tested with a temporary password.
- [ ] SSH, SFTP, database, Redis and workflow smoke tests use non-production
      targets.
- [ ] `SHA256SUMS.txt` matches every released installer and ZIP package.

## GitHub release

- [ ] Replace outdated screenshots and release descriptions.
- [ ] Tag the exact source commit as `v<version>`.
- [ ] Upload the installer, portable ZIP, `SHA256SUMS.txt` and corresponding
      source archive to the same release.
- [ ] Link to the repository and MPL-2.0 license in the release description.
- [ ] Download the published assets once and re-verify their signatures and
      hashes.
