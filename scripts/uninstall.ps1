<#
.SYNOPSIS
  Uninstalls TermPocket that was installed with install.ps1 (per user).

.DESCRIPTION
  Stops the TermPocket agent and tray monitor of this install, removes their logon tasks (when they
  belong to this install), shuts down the durable terminals host (asking first while terminals still
  run), uninstalls the VS Code extension if install.ps1 installed it, removes the Settings > Apps
  entry and deletes the install folder.

  Your settings (%APPDATA%\TermPocket: config.json with the pairing token, relay.json, logs) are kept
  unless you pass -Purge.

.PARAMETER InstallDir
  The install folder (default: the folder this script was installed in, else
  %LOCALAPPDATA%\Programs\TermPocket).

.PARAMETER Purge
  Also delete the settings folder (%APPDATA%\TermPocket, or TERMPOCKET_HOME when set). Paired phones
  will need to pair again.

.PARAMETER Force
  Do not ask: end running terminals without confirmation.

.PARAMETER KeepExtension
  Leave the VS Code extension installed.

.PARAMETER NodePath
  node.exe to talk to the terminals host with, when the install has no bundled node.exe (tests).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [switch]$Purge,
  [switch]$Force,
  [switch]$KeepExtension,
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExtensionId = 'ehabmansour1.termpocket'
$Marker = 'termpocket-install.json'
function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# --- which install ------------------------------------------------------------------------------
if (-not $InstallDir) {
  $here = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { $null }
  $InstallDir = if ($here -and (Test-Path -LiteralPath (Join-Path $here $Marker))) { $here } else { Join-Path $env:LOCALAPPDATA 'Programs\TermPocket' }
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (-not (Test-Path -LiteralPath $InstallDir)) { Write-Host "TermPocket is not installed in $InstallDir."; exit 0 }
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $Marker)) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'termpocket-bundle.json'))) {
  throw "$InstallDir is not a TermPocket install (no $Marker). A git checkout is removed with scripts\uninstall-autostart.ps1 and by deleting the folder."
}
$info = $null
try { $info = Get-Content -LiteralPath (Join-Path $InstallDir $Marker) -Raw | ConvertFrom-Json } catch { }

$ConfigDir = if ($env:TERMPOCKET_HOME) { $env:TERMPOCKET_HOME } elseif ($env:VSCONTROL_HOME) { $env:VSCONTROL_HOME } else { Join-Path $env:APPDATA 'TermPocket' }
$ConfigDir = [System.IO.Path]::GetFullPath($ConfigDir).TrimEnd('\')
$Entry = Join-Path $InstallDir 'agent\src\index.js'
$HostClient = Join-Path $InstallDir 'agent\src\ptyhostClient.js'

$node = $null
if ($NodePath) { $node = (Resolve-Path -LiteralPath $NodePath).ProviderPath }
elseif (Test-Path -LiteralPath (Join-Path $InstallDir 'node\node.exe')) { $node = Join-Path $InstallDir 'node\node.exe' }
else { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } }

$interactive = [Environment]::UserInteractive -and -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-NonI' }) -and -not [Console]::IsInputRedirected

function Test-Contains([string]$Text, [string]$Part) { return $Text -and $Text.IndexOf($Part, [StringComparison]::OrdinalIgnoreCase) -ge 0 }

# --- 1. the terminals host of this install: ask before ending live terminals ----------------------
# It runs node.exe from this folder, so it has to stop before the folder can be deleted.
$hostPid = 0
$hostLive = 0
$hostInfoFile = Join-Path $ConfigDir 'ptyhost.json'
if (Test-Path -LiteralPath $hostInfoFile) {
  try {
    $hi = Get-Content -LiteralPath $hostInfoFile -Raw | ConvertFrom-Json
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$hi.pid)" -ErrorAction SilentlyContinue
    if ($p -and (Test-Contains ([string]$p.CommandLine) (Join-Path $InstallDir 'agent\src\ptyhost.js'))) { $hostPid = [int]$hi.pid }
  } catch { }
}
if ($hostPid -and $node -and (Test-Path -LiteralPath $HostClient)) {
  $url = ([Uri]$HostClient).AbsoluteUri
  # Authenticated status op; the host's secret never leaves node.
  $js = "import('$url').then(async (m) => { const d = process.argv[1]; const t = await m.connectPtyHost({ pipe: m.resolvePipe(d), configDir: d }); const s = await t.request('status', {}); t.close(); console.log('live=' + s.live); }).catch((e) => { console.log(e.code === 'ENOHOST' ? 'none' : 'error: ' + e.message); })"
  $st = "$((& $node --input-type=module -e $js $ConfigDir) 2>&1)"
  if ($st -match 'live=(\d+)') { $hostLive = [int]$Matches[1] }
}
if ($hostPid -and $hostLive -gt 0 -and -not $Force) {
  if (-not $interactive) {
    Write-Host "$hostLive terminal(s) still run in the TermPocket terminals host. Close them, or run again with -Force to end them. Nothing was changed." -ForegroundColor Yellow
    exit 1
  }
  $answer = Read-Host "$hostLive terminal(s) still run in TermPocket (shells and programs you started from the phone). End them and uninstall? [y/N]"
  if ($answer -notmatch '^\s*y') { Write-Host 'Nothing was changed.'; exit 1 }
}

# --- 2. autostart of this install ---------------------------------------------------------------
$launcher = Join-Path $env:APPDATA 'TermPocket\termpocket-agent.vbs'
$autostartOurs = $false
if (Test-Path -LiteralPath $launcher) { $autostartOurs = Test-Contains ([System.IO.File]::ReadAllText($launcher)) $Entry }
$removeAutostart = Join-Path $InstallDir 'scripts\uninstall-autostart.ps1'
if ($autostartOurs -and (Test-Path -LiteralPath $removeAutostart)) {
  # Removes the tasks / Startup shortcuts and launchers, stops the monitor, launcher and agent.
  # The terminals host is handled below (it may live in TERMPOCKET_HOME).
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $removeAutostart -KeepTerminals | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warning "uninstall-autostart.ps1 exited with $LASTEXITCODE" }
} elseif (Get-ScheduledTask -TaskName 'TermPocket Agent' -ErrorAction SilentlyContinue) {
  Write-Step "The 'TermPocket Agent' logon task belongs to another copy of TermPocket; left alone"
}

# --- 3. what still runs from this folder (agent, monitor) ----------------------------------------
$monitor = Join-Path $InstallDir 'scripts\monitor-tray.ps1'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and ((Test-Contains ([string]$_.CommandLine) $Entry) -or (Test-Contains ([string]$_.CommandLine) $monitor)) })
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($procs.Count) { Write-Step "Stopped $($procs.Count) TermPocket process(es)" }

# --- 4. the terminals host ----------------------------------------------------------------------
if ($hostPid) {
  $stopped = $false
  if ($node -and (Test-Path -LiteralPath $HostClient)) {
    $url = ([Uri]$HostClient).AbsoluteUri
    $js = "import('$url').then(async (m) => { const d = process.argv[1]; const had = await m.shutdownPtyHost({ pipe: m.resolvePipe(d), configDir: d }); console.log(had ? 'stopped' : 'none'); }).catch((e) => { console.log('error: ' + e.message); })"
    $r = "$((& $node --input-type=module -e $js $ConfigDir) 2>&1)"
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 200 }
    $stopped = -not (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)
    if (-not $stopped -and $r -match 'error') { Write-Warning "Terminals host: $r" }
  }
  if (-not $stopped) { Stop-Process -Id $hostPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
  Write-Step "Stopped the terminals host$(if ($hostLive) { " ($hostLive terminal(s) ended)" })"
}

# --- 5. VS Code extension -----------------------------------------------------------------------
$hadExtension = $false
if ($info -and ($info.PSObject.Properties.Name -contains 'extension')) { $hadExtension = [bool]$info.extension }
if ($hadExtension -and -not $KeepExtension) {
  $code = $null
  foreach ($name in @('code.cmd', 'code')) {
    $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $code = $c.Source; break }
  }
  if (-not $code -and (Test-Path -LiteralPath "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd")) { $code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" }
  if ($code) {
    $out = & $code --uninstall-extension $ExtensionId 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Step "VS Code extension $ExtensionId uninstalled" } else { Write-Warning "code --uninstall-extension: $out" }
  } else {
    Write-Warning "VS Code's 'code' command was not found; remove the TermPocket extension in VS Code's Extensions view."
  }
}

# --- 6. Settings > Apps entry -------------------------------------------------------------------
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPocket'
if (Test-Path -LiteralPath $key) {
  $loc = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).InstallLocation
  if ($loc -and ([string]$loc).TrimEnd('\') -ieq $InstallDir) {
    Remove-Item -LiteralPath $key -Recurse -Force
    Write-Step 'Removed TermPocket from Settings > Apps'
  }
}

# --- 7. files -----------------------------------------------------------------------------------
Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
$removed = $false
for ($i = 0; $i -lt 5 -and -not $removed; $i++) {
  try {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    $removed = $true
  } catch {
    Start-Sleep -Seconds 1
  }
}
if ($removed) {
  Write-Step "Removed $InstallDir"
} else {
  Write-Warning "Some files in $InstallDir are still in use and were left behind; delete the folder after restarting Windows."
}

if ($Purge) {
  if ((Test-Path -LiteralPath $ConfigDir) -and ((Test-Path -LiteralPath (Join-Path $ConfigDir 'config.json')) -or (Split-Path -Leaf $ConfigDir) -ieq 'TermPocket')) {
    Remove-Item -LiteralPath $ConfigDir -Recurse -Force
    Write-Step "Removed your settings ($ConfigDir)"
  }
} else {
  Write-Host ''
  Write-Host "Kept your settings in $ConfigDir (pairing token, relay.json, logs). Delete it, or run with -Purge, to remove them."
}
Write-Host 'TermPocket was uninstalled.' -ForegroundColor Green
