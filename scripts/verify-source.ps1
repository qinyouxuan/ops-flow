# SPDX-License-Identifier: MPL-2.0

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot
try {
  $files = @(git ls-files --cached --others --exclude-standard)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to enumerate repository files."
  }

  $errors = [System.Collections.Generic.List[string]]::new()
  $sourceExtensions = @(".cjs", ".js", ".jsx", ".mjs", ".py", ".ps1")
  $textExtensions = @(
    ".cjs", ".css", ".html", ".js", ".jsx", ".json", ".md", ".mjs", ".ps1",
    ".py", ".txt", ".yaml", ".yml"
  )
  $allowedAddresses = @(
    "0.0.0.0",
    "127.0.0.1",
    "192.0.2.10",
    "198.51.100.20",
    "203.0.113.30"
  )

  foreach ($relativePath in $files) {
    $normalized = $relativePath.Replace("\", "/")
    $name = [IO.Path]::GetFileName($normalized)
    $extension = [IO.Path]::GetExtension($normalized).ToLowerInvariant()

    if (
      $name -eq "ops-flow.json" -or
      $normalized -match "(^|/)\.env(\.|$)" -or
      $extension -in @(".key", ".pem", ".p12", ".pfx", ".opsflow-backup")
    ) {
      $errors.Add("Forbidden configuration or credential file: $normalized")
      continue
    }

    if ($sourceExtensions -contains $extension) {
      $head = @(Get-Content -LiteralPath $normalized -Encoding UTF8 -TotalCount 5)
      if (($head -join "`n") -notmatch "SPDX-License-Identifier:\s*MPL-2\.0") {
        $errors.Add("Missing MPL-2.0 SPDX header: $normalized")
      }
    }

    if (-not ($textExtensions -contains $extension)) {
      continue
    }

    $content = [IO.File]::ReadAllText((Join-Path $repoRoot $relativePath))
    if ($content -match "BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY") {
      $errors.Add("Private-key material found in: $normalized")
    }
    if ($content -match "(?i)[A-Z]:\\Users\\[^\\\r\n]+\\") {
      $errors.Add("Windows user-profile path found in: $normalized")
    }
    if ($content -match "(?i)AppData\\Local\\Temp") {
      $errors.Add("Windows temporary path found in: $normalized")
    }

    foreach ($match in [regex]::Matches($content, "\b(?:\d{1,3}\.){3}\d{1,3}\b")) {
      $address = $match.Value
      if ($allowedAddresses -notcontains $address) {
        $errors.Add("Non-documentation IPv4 literal '$address' found in: $normalized")
      }
    }
  }

  $packageJson = Get-Content -LiteralPath "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($dependencyGroup in @("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")) {
    $dependencies = $packageJson.$dependencyGroup
    if ($null -ne $dependencies -and $null -ne $dependencies.PSObject.Properties["dmdb"]) {
      $errors.Add("Vendor driver dmdb must not be declared in package.json ($dependencyGroup).")
    }
  }

  $packageLockContent = Get-Content -LiteralPath "package-lock.json" -Raw -Encoding UTF8
  if ($packageLockContent -match '(?i)"(?:[^"]*/)?node_modules/dmdb"\s*:') {
    $errors.Add("Vendor driver dmdb must not be present in package-lock.json.")
  }

  if ($errors.Count -gt 0) {
    $errors | Sort-Object -Unique | ForEach-Object { Write-Error $_ }
    exit 1
  }

  Write-Output "Source privacy and license checks passed for $($files.Count) files."
}
finally {
  Pop-Location
}
