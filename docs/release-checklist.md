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
- [ ] The Dameng compatibility worker (`damengLegacyWorker.cjs`) is present in
      packaged resources, while
      the vendor `dmdb` package and any local Node.js runtime remain excluded.

## Security

- [ ] No `.env`, private key, certificate, database password, server password,
      real server address or encrypted configuration backup is tracked.
- [ ] Screenshots use a disposable demo environment and contain no real host,
      account, path, database, Redis, log, backup or local-user information.
- [ ] Electron user-data files such as `ops-flow.json` are not copied into the
      repository, source archive or release assets.
- [ ] The signing certificate and password are supplied only through protected
      local storage or CI secrets.
- [ ] Remote-operation examples use clearly fictional names and addresses.

## Verification

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run build
npm.cmd run audit:prod
npm.cmd run verify:source
```

For a signed release:

```powershell
npm.cmd run dist:win:signed
npm.cmd run verify:release:signed
```

For an unsigned individual/open-source release:

```powershell
npm.cmd run dist:win
npm.cmd run verify:release
```

- [ ] When a trusted certificate is available, the installer and packaged
      application both have valid Authenticode signatures.
- [ ] When publishing without Authenticode signing, the release description
      clearly states that the binaries are unsigned and might trigger Windows
      SmartScreen, and links to the matching source tag and SHA-256 checksums.
- [ ] A clean Windows test machine can install, launch and uninstall the app.
- [ ] Configuration export/import is tested with a temporary password.
- [ ] SSH, SFTP, database, Redis and workflow smoke tests use non-production
      targets.
- [ ] Normal Dameng mode and isolated legacy compatibility mode are tested
      separately; closing a database operation also terminates its compatibility
      child process.
- [ ] `SHA256SUMS.txt` matches every released installer and ZIP package.

## GitHub release

- [ ] Replace outdated screenshots and release descriptions.
- [ ] Tag the exact source commit as `v<version>`.
- [ ] Upload the installer, portable ZIP, `SHA256SUMS.txt` and corresponding
      source archive to the same release.
- [ ] Link to the repository and MPL-2.0 license in the release description.
- [ ] Download the published assets once and re-verify their signatures and
      hashes.
