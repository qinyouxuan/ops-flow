# Windows code signing

Code signing identifies the publisher and lets Windows verify that an
installer or executable has not been modified after signing. It does not
replace SHA-256 checksums, source publication or malware scanning.

## Certificate choice

For public releases, use a Windows Authenticode code-signing certificate from
a trusted certificate authority, or a supported cloud signing service such as
Azure Trusted Signing. A self-signed certificate is suitable only for internal
testing because public Windows computers will not trust it automatically.

The actual certificate subject determines the publisher name shown by
Windows. Do not add `publisherName` or `certificateSubjectName` to
`package.json` until the certificate has been issued and its exact subject is
known.

## Secret handling

Never place a `.pfx`, `.p12`, private key or certificate password in this
repository. The project `.gitignore` excludes common certificate and private
key formats, but that is only a last line of defense.

For a local signed build, set process-scoped environment variables:

```powershell
$env:WIN_CSC_LINK = "C:\secure\ops-flow-signing.pfx"
$env:WIN_CSC_KEY_PASSWORD = Read-Host -Prompt "Certificate password"
npm.cmd run dist:win:signed
Remove-Item Env:\WIN_CSC_LINK
Remove-Item Env:\WIN_CSC_KEY_PASSWORD
```

For CI, store `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` as encrypted CI
secrets. `WIN_CSC_LINK` may be a protected file path or supported encoded
certificate value. Normal development packaging keeps Windows signing disabled
so it can run without certificate tooling. The `dist:win:signed` command
explicitly enables signing and `forceCodeSigning=true`, so an official build
fails instead of silently creating unsigned files.

Electron Builder's Windows signing/resource tool archive contains symbolic
links. If extraction fails with “Cannot create symbolic link”, enable Windows
Developer Mode or run the official signing build from an appropriately
privileged build environment, then clear the incomplete `winCodeSign` cache
before retrying.

## Verification

After building:

```powershell
npm.cmd run verify:release:signed
```

For an individual file, Windows PowerShell can inspect the signature:

```powershell
Get-AuthenticodeSignature ".\release\Ops Flow Plus Setup 0.2.0.exe" |
  Format-List Status,StatusMessage,SignerCertificate,TimeStamperCertificate
```

If the Windows SDK is installed, SignTool provides an additional check:

```powershell
signtool verify /pa /v ".\release\Ops Flow Plus Setup 0.2.0.exe"
```

Only publish when the signature status is valid, the signer is the expected
certificate subject and the timestamp is present.

Official references:

- https://www.electron.build/docs/features/code-signing/
- https://www.electron.build/docs/features/code-signing/code-signing-win/
- https://learn.microsoft.com/windows/win32/seccrypto/using-signtool-to-sign-a-file
