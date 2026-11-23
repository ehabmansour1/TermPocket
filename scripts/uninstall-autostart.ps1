<#
.SYNOPSIS
  Removes the TermPocket agent autostart (Scheduled Task and/or Startup shortcut) and stops the
  background agent that it started. Also removes the TermPocket Monitor tray icon's autostart and
  closes the monitor.

.PARAMETER KeepRunning
  Only remove the autostart registration; leave a running background agent (and monitor) alone.

.PARAMETER KeepTerminals
  Stop the agent but leave the terminals host (agent\src\ptyhost.js) and the terminals it runs alone.
  Without it, an interactive run asks first when terminals are still running; a non-interactive run
  stops the host (it then exits by itself anyway once it has no terminals and no agent for 10 minutes).

.NOTES
  config.json (your pairing token) and agent.log in %APPDATA%\TermPocket are kept.
  Agents started by hand in a console (scripts\start-agent.cmd) are not touched.
#>
[CmdletBinding()]
param(
  [switch]$KeepRunning,
  [switch]$KeepTerminals
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName  = 'TermPocket Agent'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Entry     = Join-Path $RepoRoot 'agent\src\index.js'
$ConfigDir = Join-Path $env:APPDATA 'TermPocket'
$Launcher  = Join-Path $ConfigDir 'termpocket-agent.vbs'
$Shortcut  = Join-Path ([Environment]::GetFolderPath('Startup')) 'TermPocket Agent.lnk'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# --- tray monitor (first, so it does not report the agent stopping) ------------------------------
$MonitorTaskName = 'TermPocket Monitor'
$MonitorScript   = Join-Path $RepoRoot 'scripts\monitor-tray.ps1'
$MonitorLauncher = Join-Path $ConfigDir 'termpocket-monitor.vbs'
$MonitorShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'TermPocket Monitor.lnk'

$mtask = Get-ScheduledTask -TaskName $MonitorTaskName -ErrorAction SilentlyContinue
if (-not $KeepRunning) {
  # Ask the monitor to quit cleanly (removes its tray icon), then make sure.
  $signalled = $false
  try {
    $ev = [System.Threading.EventWaitHandle]::OpenExisting('Local\TermPocket.Monitor.Exit')
    [void]$ev.Set()
    $ev.Dispose()
    $signalled = $true
  } catch { }
  if ($signalled) {
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
      $m = $null
      $exists = $true
      try { $exists = [System.Threading.Mutex]::TryOpenExisting('Local\TermPocket.Monitor', [ref]$m) } catch { }
      if (-not $exists) { break }
      if ($m) { $m.Dispose() }
      Start-Sleep -Milliseconds 250
    }
  }
  if ($mtask) { Stop-ScheduledTask -TaskName $MonitorTaskName -ErrorAction SilentlyContinue }
  $mprocs = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($MonitorLauncher) -or ($_.CommandLine.Contains($MonitorScript) -and $_.CommandLine -notmatch '\s-(Once|SmokeSeconds|SaveIconsTo)\b')) })
  foreach ($p in $mprocs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($signalled -or $mprocs.Count) { Write-Step 'Stopped the TermPocket Monitor' }
}
if ($mtask) {
  Unregister-ScheduledTask -TaskName $MonitorTaskName -Confirm:$false
  Write-Step "Scheduled Task '$MonitorTaskName' removed"
}
if (Test-Path -LiteralPath $MonitorShortcut) {
  Remove-Item -LiteralPath $MonitorShortcut -Force
  Write-Step 'Monitor startup shortcut removed'
}
if (Test-Path -LiteralPath $MonitorLauncher) {
  Remove-Item -LiteralPath $MonitorLauncher -Force
  Write-Step 'Monitor launcher removed'
}

# --- agent --------------------------------------------------------------------------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if (-not $KeepRunning) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Step "Scheduled Task '$TaskName' removed"
} else {
  Write-Step "No Scheduled Task named '$TaskName'"
}

if (Test-Path -LiteralPath $Shortcut) {
  Remove-Item -LiteralPath $Shortcut -Force
  Write-Step 'Startup shortcut removed'
}

if (-not $KeepRunning) {
  # Stop the hidden launcher first (otherwise it would restart the agent), then the agent it ran.
  # Only processes started by this installation's launcher (matched by full path) are touched.
  $launchers = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Launcher) })
  foreach ($p in $launchers) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $agents = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"' + $Entry + '"') })
  foreach ($p in $agents) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($launchers.Count -or $agents.Count) { Write-Step 'Stopped the background agent' }

  # The terminals host (agent\src\ptyhost.js) outlives agent restarts on purpose; uninstalling ends it
  # with its authenticated "shutdown" op, which also ends every terminal it still runs.
  # -KeepTerminals leaves it running; an interactive run asks first when terminals are still running.
  $hostClient = Join-Path $RepoRoot 'agent\src\ptyhostClient.js'
  # node.exe: the release bundle's own node\node.exe, else node on PATH (git checkout).
  $nodeExe = Join-Path $RepoRoot 'node\node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { $null }
  }
  if ($KeepTerminals) {
    Write-Step 'Left the terminals host running (-KeepTerminals)'
  } elseif ($nodeExe -and (Test-Path -LiteralPath (Join-Path $ConfigDir 'ptyhost.json')) -and (Test-Path -LiteralPath $hostClient)) {
    $url = ([Uri]$hostClient).AbsoluteUri
    # Ask the host how many terminals still run (authenticated status op; the secret never leaves node).
    $jsStatus = "import('$url').then(async (m) => { const d = process.argv[1]; const t = await m.connectPtyHost({ pipe: m.resolvePipe(d), configDir: d }); const s = await t.request('status', {}); t.close(); console.log('live=' + s.live); }).catch((e) => { console.log(e.code === 'ENOHOST' ? 'none' : 'error: ' + e.message); })"
    $st = "$((& $nodeExe --input-type=module -e $jsStatus $ConfigDir) 2>&1)"
    $live = 0
    if ($st -match 'live=(\d+)') { $live = [int]$Matches[1] }
    $stop = $st -notmatch '^none'
    $interactive = [Environment]::UserInteractive -and -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-NonI' }) -and -not [Console]::IsInputRedirected
    if ($stop -and $live -gt 0 -and $interactive) {
      $answer = Read-Host "The terminals host still runs $live terminal(s) (they survive agent restarts). Stop it and end them now? [Y/n]"
      if ($answer -match '^\s*n') { $stop = $false; Write-Step "Left the terminals host running ($live terminal(s)); it exits by itself 10 minutes after its last terminal ends" }
    }
    if ($stop) {
      $js = "import('$url').then(async (m) => { const d = process.argv[1]; const had = await m.shutdownPtyHost({ pipe: m.resolvePipe(d), configDir: d }); console.log(had ? 'stopped' : 'none'); }).catch((e) => { console.log('error: ' + e.message); })"
      $r = (& $nodeExe --input-type=module -e $js $ConfigDir) 2>&1
      if ("$r" -match 'stopped') { Write-Step 'Stopped the terminals host (its terminals ended)' }
      elseif ("$r" -match 'error') { Write-Warning "Terminals host: $r" }
    }
  }
}

if (Test-Path -LiteralPath $Launcher) {
  Remove-Item -LiteralPath $Launcher -Force
  Write-Step 'Launcher removed'
}

# --- previous name (VS Control) ----------------------------------------------------------------
# Autostart entries an install from before the rename may have left (scripts\install-autostart.ps1
# normally removes them already). Only the registrations and launchers; running processes are left alone.
foreach ($name in @('VS Control Monitor', 'VS Control Agent')) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Step "Old Scheduled Task '$name' removed"
  }
}
$legacyDir = Join-Path $env:APPDATA 'VSControl'
foreach ($f in @((Join-Path $legacyDir 'vscontrol-agent.vbs'), (Join-Path $legacyDir 'vscontrol-monitor.vbs'),
                 (Join-Path ([Environment]::GetFolderPath('Startup')) 'VS Control Agent.lnk'),
                 (Join-Path ([Environment]::GetFolderPath('Startup')) 'VS Control Monitor.lnk'))) {
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Step "Removed $f" }
}

Write-Host ''
Write-Host "Kept: $ConfigDir (config.json with your pairing token, agent.log). Delete it to reset pairing."
