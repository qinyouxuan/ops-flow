# SPDX-License-Identifier: MPL-2.0

param(
  [string]$ReleaseDir = "release",
  [string]$Version = "",
  [switch]$AllVersions,
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$resolvedReleaseDir = (Resolve-Path -LiteralPath $ReleaseDir).Path

if (-not $AllVersions -and [string]::IsNullOrWhiteSpace($Version)) {
  $packageJsonPath = Join-Path $PSScriptRoot "..\package.json"
  $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Version = [string]$packageJson.version
}

$artifacts = Get-ChildItem -LiteralPath $resolvedReleaseDir -File |
  Where-Object {
    $_.Extension -in @(".exe", ".zip") -and
    ($AllVersions -or $_.Name -match [regex]::Escape($Version))
  } |
  Sort-Object Name

if (-not $artifacts) {
  $scope = if ($AllVersions) { "all versions" } else { "version $Version" }
  throw "No .exe or .zip release artifacts were found in $resolvedReleaseDir for $scope"
}

$hashLines = foreach ($artifact in $artifacts) {
  $stream = [System.IO.File]::OpenRead($artifact.FullName)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($stream)
    $hash = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLowerInvariant()
  }
  finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
  "$hash  $($artifact.Name)"
}

$hashFile = Join-Path $resolvedReleaseDir "SHA256SUMS.txt"
[System.IO.File]::WriteAllLines($hashFile, $hashLines, [System.Text.UTF8Encoding]::new($false))
Write-Output "Wrote $hashFile"

$signatureFailures = @()
$authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
foreach ($artifact in $artifacts | Where-Object { $_.Extension -eq ".exe" }) {
  if ($authenticodeCommand) {
    $signatureStatus = (Get-AuthenticodeSignature -LiteralPath $artifact.FullName).Status
  }
  else {
    $signatureStatus = "Unavailable"
  }
  Write-Output "$($artifact.Name): signature=$signatureStatus"
  if ($RequireSignature -and $signatureStatus -ne "Valid") {
    $signatureFailures += $artifact.Name
  }
}

$zipFailures = @()
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($artifact in $artifacts | Where-Object { $_.Extension -eq ".zip" }) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($artifact.FullName)
  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
    $hasCompatibilityWorker = @(
      $entryNames | Where-Object { $_ -match "(^|/)resources/damengLegacyWorker\.cjs$" }
    ).Count -gt 0
    $containsVendorDriver = @(
      $entryNames | Where-Object { $_ -match "(^|/)node_modules/dmdb/" }
    ).Count -gt 0
    $containsExternalNode = @(
      $entryNames | Where-Object { $_ -match "(^|/)node\.exe$" }
    ).Count -gt 0

    Write-Output "$($artifact.Name): dameng-worker=$hasCompatibilityWorker vendor-dmdb=$containsVendorDriver external-node=$containsExternalNode"
    if (-not $hasCompatibilityWorker) {
      $zipFailures += "$($artifact.Name) is missing resources/damengLegacyWorker.cjs"
    }
    if ($containsVendorDriver) {
      $zipFailures += "$($artifact.Name) contains the restricted vendor dmdb package"
    }
    if ($containsExternalNode) {
      $zipFailures += "$($artifact.Name) unexpectedly bundles node.exe"
    }
  }
  finally {
    $archive.Dispose()
  }
}

if ($signatureFailures.Count -gt 0) {
  throw "Invalid or missing Authenticode signature: $($signatureFailures -join ', ')"
}

if ($zipFailures.Count -gt 0) {
  throw "Invalid release package contents: $($zipFailures -join '; ')"
}

Write-Output "Release verification completed for $($artifacts.Count) artifacts."
