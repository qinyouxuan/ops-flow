# SPDX-License-Identifier: MPL-2.0

param(
  [string]$ReleaseDir = "release",
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$resolvedReleaseDir = (Resolve-Path -LiteralPath $ReleaseDir).Path
$artifacts = Get-ChildItem -LiteralPath $resolvedReleaseDir -File |
  Where-Object { $_.Extension -in @(".exe", ".zip") } |
  Sort-Object Name

if (-not $artifacts) {
  throw "No .exe or .zip release artifacts were found in $resolvedReleaseDir"
}

$hashLines = foreach ($artifact in $artifacts) {
  $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $($artifact.Name)"
}

$hashFile = Join-Path $resolvedReleaseDir "SHA256SUMS.txt"
[System.IO.File]::WriteAllLines($hashFile, $hashLines, [System.Text.UTF8Encoding]::new($false))
Write-Output "Wrote $hashFile"

$signatureFailures = @()
foreach ($artifact in $artifacts | Where-Object { $_.Extension -eq ".exe" }) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  Write-Output "$($artifact.Name): signature=$($signature.Status)"
  if ($RequireSignature -and $signature.Status -ne "Valid") {
    $signatureFailures += $artifact.Name
  }
}

if ($signatureFailures.Count -gt 0) {
  throw "Invalid or missing Authenticode signature: $($signatureFailures -join ', ')"
}

Write-Output "Release verification completed for $($artifacts.Count) artifacts."
