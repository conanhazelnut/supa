# supa installer (Windows) — downloads the prebuilt supa.exe from GitHub
# Releases. No compiler, no Deno required.
#
#   irm https://raw.githubusercontent.com/conanhazelnut/supa/main/install.ps1 | iex
#
# Env overrides:
#   $env:SUPA_VERSION   tag to install (default: latest)
#   $env:SUPA_BIN_DIR   install dir     (default: %LOCALAPPDATA%\supa\bin)
$ErrorActionPreference = "Stop"

$repo = "conanhazelnut/supa"
$binDir = if ($env:SUPA_BIN_DIR) { $env:SUPA_BIN_DIR } else { "$env:LOCALAPPDATA\supa\bin" }
$version = if ($env:SUPA_VERSION) { $env:SUPA_VERSION } else { "latest" }
$asset = "supa-x86_64-pc-windows-msvc.exe"

$url = if ($version -eq "latest") {
  "https://github.com/$repo/releases/latest/download/$asset"
} else {
  "https://github.com/$repo/releases/download/$version/$asset"
}

Write-Host "supa: installing x86_64-pc-windows-msvc ($version) -> $binDir\supa.exe"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
try {
  Invoke-WebRequest -Uri $url -OutFile "$binDir\supa.exe"
} catch {
  Write-Error "supa: download failed ($url). Is a release published? https://github.com/$repo/releases"
  exit 1
}

# Add install dir to the user PATH if it's not there yet.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
  Write-Host "supa: added $binDir to your user PATH (restart the terminal to pick it up)"
}

# Seed a starter registry if none exists (never overwrites).
$cfg = if ($env:SUPA_HOME) { $env:SUPA_HOME } else { "$env:APPDATA\supa" }
if (-not (Test-Path "$cfg\supa.registry")) {
  New-Item -ItemType Directory -Force -Path $cfg | Out-Null
  try {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/main/supa.registry.example" -OutFile "$cfg\supa.registry"
    Write-Host "supa: seeded a starter registry at $cfg\supa.registry (edit it)"
  } catch { }
}

Write-Host "supa: installed. Next: edit $cfg\supa.registry, then run 'supa ls'."
