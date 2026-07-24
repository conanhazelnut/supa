# supa installer (Windows) — downloads the prebuilt supa.exe from GitHub
# Releases. No compiler, no Deno required.
#
#   irm https://raw.githubusercontent.com/conanhazelnut/supa/main/install.ps1 | iex
#
# Env overrides:
#   $env:SUPA_VERSION   tag to install (default: latest)
#   $env:SUPA_BIN_DIR   install dir     (default: %LOCALAPPDATA%\supa\bin)
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 may not negotiate TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "conanhazelnut/supa"
$binDir = if ($env:SUPA_BIN_DIR) { $env:SUPA_BIN_DIR } else { "$env:LOCALAPPDATA\supa\bin" }
$version = if ($env:SUPA_VERSION) { $env:SUPA_VERSION } else { "latest" }
$asset = "supa-x86_64-pc-windows-msvc.exe"

$base = if ($version -eq "latest") {
  "https://github.com/$repo/releases/latest/download"
} else {
  "https://github.com/$repo/releases/download/$version"
}
$url = "$base/$asset"
$sumsUrl = "$base/SHA256SUMS.txt"

Write-Host "supa: installing x86_64-pc-windows-msvc ($version) -> $binDir\supa.exe"
$tmp = New-TemporaryFile
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Write-Error "supa: download failed ($url). Is a release published? https://github.com/$repo/releases"
  exit 1
}

# Verify against SHA256SUMS.txt. Fail CLOSED: refuse to install if we can't
# verify (override deliberately with $env:SUPA_SKIP_CHECKSUM = '1').
if ($env:SUPA_SKIP_CHECKSUM -eq "1") {
  Write-Host "supa: SUPA_SKIP_CHECKSUM=1 — skipping checksum verification"
} else {
  $expected = $null
  try {
    $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
    foreach ($line in ($sums -split "\r?\n")) {
      $parts = $line -split '\s+'
      if ($parts.Length -ge 2 -and $parts[1] -eq $asset) { $expected = $parts[0].ToLower() }
    }
  } catch { }
  if (-not $expected) {
    Remove-Item $tmp -Force
    Write-Error "supa: cannot verify download — no SHA256SUMS entry for $asset. Override with `$env:SUPA_SKIP_CHECKSUM='1'."
    exit 1
  }
  $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Remove-Item $tmp -Force
    Write-Error "supa: checksum mismatch for $asset — aborting"
    exit 1
  }
  Write-Host "supa: checksum verified"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# A running supa.exe locks the file against overwrite, but Windows still allows
# a rename — shuffle the old exe aside so upgrading while supa runs works. The
# leftover .old is removed on the next install if it's locked right now.
$dest = "$binDir\supa.exe"
if (Test-Path $dest) {
  try { Move-Item -Force $dest "$dest.old" } catch { }
}
Move-Item -Force $tmp $dest
Remove-Item "$dest.old" -Force -ErrorAction SilentlyContinue
# Strip Mark-of-the-Web: the download is already checksum-verified above, so
# SmartScreen second-guessing the Zone.Identifier stream adds no protection.
Unblock-File -Path "$binDir\supa.exe" -ErrorAction SilentlyContinue

# Add install dir to the user PATH if it's not there yet. Read/write the registry
# value directly instead of [Environment]::SetEnvironmentVariable: that API expands
# REG_EXPAND_SZ entries (e.g. %JAVA_HOME%\bin) on read and writes them back
# flattened as REG_SZ, silently breaking other tools' PATH entries.
$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
try {
  $userPath = [string]$envKey.GetValue("Path", "",
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $expanded = $userPath -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }
  if ($expanded -notcontains $binDir) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    try { $kind = $envKey.GetValueKind("Path") } catch { }
    $envKey.SetValue("Path", $newPath, $kind)
    Write-Host "supa: added $binDir to your user PATH (restart the terminal to pick it up)"
    # Broadcast WM_SETTINGCHANGE so newly opened shells see the PATH without a
    # logoff ([Environment]::SetEnvironmentVariable did this; a raw write doesn't).
    $sig = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    $win32 = Add-Type -MemberDefinition $sig -Name "EnvBroadcast" -Namespace "Supa" -PassThru
    [UIntPtr]$result = [UIntPtr]::Zero
    $null = $win32::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
  }
} finally {
  $envKey.Close()
}

# Seed a starter registry if none exists (never overwrites).
$cfg = if ($env:SUPA_HOME) { $env:SUPA_HOME } else { "$env:APPDATA\supa" }
if (-not (Test-Path "$cfg\supa.registry")) {
  New-Item -ItemType Directory -Force -Path $cfg | Out-Null
  try {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/main/examples/supa.registry.example" -OutFile "$cfg\supa.registry" -UseBasicParsing
    Write-Host "supa: seeded a starter registry at $cfg\supa.registry (edit it)"
  } catch { }
}

Write-Host "supa: installed. Next: edit $cfg\supa.registry, then run 'supa ls'."
