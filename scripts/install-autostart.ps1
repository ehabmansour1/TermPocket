<#
.SYNOPSIS
  Starts the TermPocket agent automatically (hidden) when you log on to Windows.

.DESCRIPTION
  Registers a per-user Scheduled Task "TermPocket Agent" with an at-logon trigger that runs in your
  interactive session (required for screen capture and input). The task launches a generated
  VBScript launcher (%APPDATA%\TermPocket\termpocket-agent.vbs) through wscript.exe so no console
  window is shown. The launcher restarts the agent if it crashes and appends all output to
  %APPDATA%\TermPocket\agent.log (rotated at 5 MB).

  If Windows refuses to create the task (some machines require admin rights for logon triggers),
  a shortcut in your Startup folder is created instead.

  An install from before the rename (VS Control: tasks "VS Control Agent" / "VS Control Monitor",
  launchers in %APPDATA%\VSControl) is stopped and removed first, and its settings (config.json with
  the pairing token, relay.json) are copied to %APPDATA%\TermPocket, so paired phones keep working.

  It also starts the TermPocket Monitor tray icon (scripts\monitor-tray.ps1) at logon, through a
  second hidden launcher (%APPDATA%\TermPocket\termpocket-monitor.vbs) and Scheduled Task
  "TermPocket Monitor". The icon is green when everything works, amber when the public link has a
  problem and red when the agent is not running. Use -NoMonitor to skip it.

.PARAMETER NoStart
  Only register; do not start the agent (or the monitor) now.

.PARAMETER StartupFolder
  Skip the Scheduled Tasks and use Startup-folder shortcuts.

.PARAMETER NoMonitor
  Do not install the TermPocket Monitor tray icon.

.PARAMETER NodePath
  node.exe to run the agent with. Default: the bundled node\node.exe of an installed release
  (%LOCALAPPDATA%\Programs\TermPocket\node\node.exe), else `node` on PATH (a git checkout).

.PARAMETER DryRun
  Only resolve and print what would be registered (node.exe, agent entry, launcher paths); change
  nothing: no old install is stopped, no file is written, no task is registered.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#>
[CmdletBinding()]
param(
  [switch]$NoStart,
  [switch]$StartupFolder,
  [switch]$NoMonitor,
  [string]$NodePath = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName  = 'TermPocket Agent'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Entry     = Join-Path $RepoRoot 'agent\src\index.js'
$ConfigDir = Join-Path $env:APPDATA 'TermPocket'
$Launcher  = Join-Path $ConfigDir 'termpocket-agent.vbs'
$LogFile   = Join-Path $ConfigDir 'agent.log'
$Shortcut  = Join-Path ([Environment]::GetFolderPath('Startup')) 'TermPocket Agent.lnk'
$WScript   = Join-Path $env:WINDIR 'System32\wscript.exe'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# --- prerequisites ------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Entry)) { throw "Agent entry point not found: $Entry" }

# node.exe: -NodePath, else the release bundle's own node\node.exe, else node on PATH (git checkout).
$BundledNode = Join-Path $RepoRoot 'node\node.exe'
$NodeSource = ''
if ($NodePath) {
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "-NodePath not found: $NodePath" }
  $NodeExe = (Resolve-Path -LiteralPath $NodePath).ProviderPath
  $NodeSource = '-NodePath'
} elseif (Test-Path -LiteralPath $BundledNode -PathType Leaf) {
  $NodeExe = $BundledNode
  $NodeSource = 'bundled'
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw 'Node.js was not found on PATH. Install Node.js 20+ from https://nodejs.org/ and retry.' }
  $NodeExe = $nodeCmd.Source
  $NodeSource = 'PATH'
}
$nodeVersion = (& $NodeExe --version) -replace '^v', ''
if ([int]($nodeVersion.Split('.')[0]) -lt 20) { throw "Node.js 20+ is required (found $nodeVersion at $NodeExe)." }

if ($DryRun) {
  Write-Step 'Dry run: nothing is changed'
  Write-Host "Node:          $NodeExe (v$nodeVersion, $NodeSource)"
  Write-Host "Agent entry:   $Entry"
  Write-Host "Working dir:   $RepoRoot"
  Write-Host "Launcher:      $Launcher"
  Write-Host "Log file:      $LogFile"
  Write-Host "Tasks:         '$TaskName'$(if (-not $NoMonitor) { ", 'TermPocket Monitor'" })$(if ($StartupFolder) { ' (Startup-folder shortcuts)' })"
  Write-Host "Dependencies:  $(if (Test-Path -LiteralPath (Join-Path $RepoRoot 'agent\node_modules\ws\package.json')) { 'present' } else { 'missing (npm install would run)' })"
  return
}

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'agent\node_modules\ws\package.json'))) {
  if ($NodeSource -eq 'bundled') { throw "The installed bundle is incomplete (agent\node_modules is missing) - reinstall TermPocket." }
  Write-Step 'Installing agent dependencies (npm install)'
  Push-Location (Join-Path $RepoRoot 'agent')
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  } finally { Pop-Location }
}

# --- previous name (VS Control) -----------------------------------------------------------------
# TermPocket used to be called "VS Control". An older install registered "VS Control Agent" /
# "VS Control Monitor" with launchers in %APPDATA%\VSControl. Stop and remove those (the same agent
# would otherwise hold the port), and copy the old settings (config.json with the pairing token,
# relay.json) so paired phones keep working. The old folder itself is kept.
$LegacyConfigDir = Join-Path $env:APPDATA 'VSControl'
$LegacyTasks     = @('VS Control Monitor', 'VS Control Agent')
$LegacyLaunchers = @((Join-Path $LegacyConfigDir 'vscontrol-monitor.vbs'), (Join-Path $LegacyConfigDir 'vscontrol-agent.vbs'))
$LegacyShortcuts = @('VS Control Monitor.lnk', 'VS Control Agent.lnk') | ForEach-Object { Join-Path ([Environment]::GetFolderPath('Startup')) $_ }

function Remove-LegacyInstall {
  $found = $false
  # Ask an old monitor to quit cleanly (removes its tray icon).
  try {
    $ev = [System.Threading.EventWaitHandle]::OpenExisting('Local\VSControl.Monitor.Exit')
    [void]$ev.Set()
    $ev.Dispose()
    $found = $true
    Start-Sleep -Milliseconds 1500
  } catch { }
  # Stop the old hidden launchers first (they would restart what they run), then what they started, and
  # only then the old tasks (stopping a task ends just its wscript, which would orphan the agent):
  # cmd.exe -> node.exe agent\src\index.js, or powershell.exe monitor-tray.ps1. Never the terminals host.
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $roots = @($procs | Where-Object {
      $cl = [string]$_.CommandLine
      ($_.Name -ieq 'wscript.exe' -and $cl -and ($LegacyLaunchers | Where-Object { $cl.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 })) -or
      # the launcher's "cmd.exe /c node ... >> <old folder>/agent.log", also when its wscript is gone
      ($_.Name -ieq 'cmd.exe' -and $cl -and $cl.IndexOf((Join-Path $LegacyConfigDir 'agent.log'), [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
  # Only these links are followed: wscript -> cmd.exe / powershell.exe monitor-tray.ps1, and
  # cmd.exe -> node.exe agent\src\index.js. Nothing below the agent (its helper exits by itself; shells
  # live in the terminals host) is touched.
  $isChild = {
    param($parent, $child)
    $cl = [string]$child.CommandLine
    if ($parent.Name -ieq 'wscript.exe') {
      return ($child.Name -ieq 'cmd.exe') -or ($child.Name -ieq 'powershell.exe' -and $cl -match 'monitor-tray\.ps1')
    }
    if ($parent.Name -ieq 'cmd.exe') { return $child.Name -ieq 'node.exe' -and $cl -match 'agent[\\/]+src[\\/]+index\.js' }
    return $false
  }
  $victims = New-Object System.Collections.Generic.List[object]
  $seen = New-Object System.Collections.Generic.HashSet[long]
  $frontier = @($roots)
  for ($depth = 0; $depth -lt 3 -and $frontier.Count -gt 0; $depth++) {
    $next = @()
    foreach ($parent in $frontier) {
      if (-not $seen.Add([long]$parent.ProcessId)) { continue }
      $victims.Add($parent)
      $next += @($procs | Where-Object { [long]$_.ParentProcessId -eq [long]$parent.ProcessId -and (& $isChild $parent $_) })
    }
    $frontier = $next
  }
  foreach ($p in $victims) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($victims.Count) { Write-Step "Stopped the old VS Control agent / monitor ($($victims.Count) process(es))"; $found = $true }
  foreach ($name in $LegacyTasks) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($t) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Step "Removed the old Scheduled Task '$name'"
      $found = $true
    }
  }
  foreach ($f in @($LegacyShortcuts + $LegacyLaunchers)) {
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; $found = $true }
  }
  return $found
}

function Copy-LegacySettings {
  # Same rule as the agent (agent/src/config.js migrateLegacyConfigDir): only while the new folder has
  # no config.json yet; never overwrite; not ptyhost.json (it belongs to the old terminals host).
  if (Test-Path -LiteralPath (Join-Path $ConfigDir 'config.json')) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $LegacyConfigDir 'config.json'))) { return }
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $files = @(Get-ChildItem -LiteralPath $LegacyConfigDir -Filter '*.json' -File | Where-Object { $_.Name -ine 'ptyhost.json' } |
    Sort-Object { if ($_.Name -ieq 'config.json') { 1 } else { 0 } })
  foreach ($f in $files) {
    $dest = Join-Path $ConfigDir $f.Name
    if (Test-Path -LiteralPath $dest) { continue }
    Copy-Item -LiteralPath $f.FullName -Destination "$dest.migrating"
    Move-Item -LiteralPath "$dest.migrating" -Destination $dest
  }
  Write-Step "Copied your settings from $LegacyConfigDir (pairing token unchanged): $(@($files | ForEach-Object Name) -join ', ')"
}

if (Remove-LegacyInstall) { Write-Step 'Removed the old VS Control autostart (TermPocket replaces it)' }
Copy-LegacySettings
$legacyHost = Join-Path $LegacyConfigDir 'ptyhost.json'
if (Test-Path -LiteralPath $legacyHost) {
  try {
    $lh = Get-Content -LiteralPath $legacyHost -Raw | ConvertFrom-Json
    if ($lh.pid -and (Get-Process -Id ([int]$lh.pid) -ErrorAction SilentlyContinue)) {
      Write-Warning "The terminals host of the old VS Control install (pid $($lh.pid)) still runs. Its terminals keep running until they exit, but TermPocket does not show them; it starts its own terminals host."
    }
  } catch { }
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

# --- launcher -----------------------------------------------------------------------------------
function ConvertTo-VbsString([string]$s) { '"' + $s.Replace('"', '""') + '"' }

$vbs = @"
' TermPocket agent launcher - generated by scripts\install-autostart.ps1. Do not edit;
' re-run the install script instead. Runs the agent without a console window, appends its output
' to agent.log and restarts it if it exits with an error.
Option Explicit
Dim sh, fso, nodeExe, entry, workDir, logFile, cmd, rc, startedAt, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
nodeExe = $(ConvertTo-VbsString $NodeExe)
entry = $(ConvertTo-VbsString $Entry)
workDir = $(ConvertTo-VbsString $RepoRoot)
logFile = $(ConvertTo-VbsString $LogFile)

Sub RotateLog()
  On Error Resume Next
  If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).Size > 5242880 Then
      If fso.FileExists(logFile & ".1") Then fso.DeleteFile logFile & ".1", True
      fso.MoveFile logFile, logFile & ".1"
    End If
  End If
  On Error GoTo 0
End Sub

sh.CurrentDirectory = workDir
Do
  RotateLog
  startedAt = Now
  cmd = "cmd.exe /d /c " & q & q & nodeExe & q & " " & q & entry & q & " >> " & q & logFile & q & " 2>&1" & q
  rc = sh.Run(cmd, 0, True)
  If rc = 0 Then Exit Do
  ' Crashed or could not start (e.g. port busy): wait, longer if it died right away.
  If DateDiff("s", startedAt, Now) < 30 Then
    WScript.Sleep 30000
  Else
    WScript.Sleep 5000
  End If
Loop
WScript.Quit rc
"@
# wscript reads ANSI or UTF-16; paths may contain non-ASCII characters, so write UTF-16 LE (with BOM).
[System.IO.File]::WriteAllText($Launcher, $vbs, [System.Text.Encoding]::Unicode)
Write-Step "Launcher written: $Launcher"

# --- registration -------------------------------------------------------------------------------
$registered = $false
if (-not $StartupFolder) {
  try {
    $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
    $action = New-ScheduledTaskAction -Execute $WScript -Argument ('"{0}"' -f $Launcher) -WorkingDirectory $RepoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description 'Starts the TermPocket agent (phone remote control for this PC) at logon.' `
      -Force | Out-Null
    $registered = $true
    Write-Step "Scheduled Task '$TaskName' registered (runs at logon as $user)"
    if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut -Force }
  } catch {
    Write-Warning "Could not register the Scheduled Task: $($_.Exception.Message)"
    Write-Warning 'Falling back to a Startup-folder shortcut.'
  }
}
if (-not $registered) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Shortcut)
  $lnk.TargetPath = $WScript
  $lnk.Arguments = '"{0}"' -f $Launcher
  $lnk.WorkingDirectory = $RepoRoot
  $lnk.Description = 'TermPocket agent'
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Step "Startup shortcut created: $Shortcut"
}

# --- start now ----------------------------------------------------------------------------------
$port = 8765
$cfgPath = Join-Path $ConfigDir 'config.json'
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
  } catch { }
}

if (-not $NoStart) {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($busy) {
    Write-Warning "Port $port is already in use (is the agent already running in a console?). Stop it, then log off/on or run: Start-ScheduledTask -TaskName '$TaskName'"
  } elseif ($registered) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Step 'Agent started in the background'
  } else {
    Start-Process -FilePath $WScript -ArgumentList ('"{0}"' -f $Launcher) -WorkingDirectory $RepoRoot
    Write-Step 'Agent started in the background'
  }
}

# --- tray monitor (TermPocket Monitor) ----------------------------------------------------------
$MonitorTaskName = 'TermPocket Monitor'
$MonitorScript   = Join-Path $RepoRoot 'scripts\monitor-tray.ps1'
$MonitorLauncher = Join-Path $ConfigDir 'termpocket-monitor.vbs'
$MonitorShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'TermPocket Monitor.lnk'
$PowerShellExe   = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$monitorInstalled = $false

function Stop-RunningMonitor {
  # Ask a running monitor to quit cleanly (it watches this event), so the new copy can take over.
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
  return $signalled
}

if ($NoMonitor) {
  Write-Step 'Skipping the TermPocket Monitor tray icon (-NoMonitor)'
} elseif (-not (Test-Path -LiteralPath $MonitorScript)) {
  Write-Warning "Monitor script not found: $MonitorScript (skipping the tray icon)"
} else {
  $monitorVbs = @"
' TermPocket Monitor launcher - generated by scripts\install-autostart.ps1. Do not edit;
' re-run the install script instead. Runs the tray monitor (Windows PowerShell, STA, hidden) and
' restarts it if it crashes. "Exit monitor" in its menu ends it for this logon session.
Option Explicit
Dim sh, q, psExe, script, cmd, rc, startedAt, quickFails
Set sh = CreateObject("WScript.Shell")
q = Chr(34)
psExe = $(ConvertTo-VbsString $PowerShellExe)
script = $(ConvertTo-VbsString $MonitorScript)
cmd = q & psExe & q & " -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File " & q & script & q
quickFails = 0
Do
  startedAt = Now
  rc = sh.Run(cmd, 0, True)
  If rc = 0 Then Exit Do
  If DateDiff("s", startedAt, Now) < 60 Then
    quickFails = quickFails + 1
    If quickFails >= 5 Then Exit Do
    WScript.Sleep 30000
  Else
    quickFails = 0
    WScript.Sleep 5000
  End If
Loop
WScript.Quit rc
"@
  [System.IO.File]::WriteAllText($MonitorLauncher, $monitorVbs, [System.Text.Encoding]::Unicode)
  Write-Step "Monitor launcher written: $MonitorLauncher"

  $monitorRegistered = $false
  if (-not $StartupFolder) {
    try {
      $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
      $action = New-ScheduledTaskAction -Execute $WScript -Argument ('"{0}"' -f $MonitorLauncher) -WorkingDirectory $RepoRoot
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
      Register-ScheduledTask -TaskName $MonitorTaskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description 'Shows the TermPocket Monitor tray icon (is the phone remote control working?) at logon.' `
        -Force | Out-Null
      $monitorRegistered = $true
      Write-Step "Scheduled Task '$MonitorTaskName' registered"
      if (Test-Path -LiteralPath $MonitorShortcut) { Remove-Item -LiteralPath $MonitorShortcut -Force }
    } catch {
      Write-Warning "Could not register the monitor Scheduled Task: $($_.Exception.Message)"
      Write-Warning 'Falling back to a Startup-folder shortcut for the monitor.'
    }
  }
  if (-not $monitorRegistered) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($MonitorShortcut)
    $lnk.TargetPath = $WScript
    $lnk.Arguments = '"{0}"' -f $MonitorLauncher
    $lnk.WorkingDirectory = $RepoRoot
    $lnk.Description = 'TermPocket Monitor (tray icon)'
    $lnk.WindowStyle = 7
    $lnk.Save()
    Write-Step "Startup shortcut created: $MonitorShortcut"
  }
  $monitorInstalled = $true

  if (-not $NoStart) {
    # Replace a monitor that is already running (it may be an older version of the script).
    $wasRunning = Stop-RunningMonitor
    if ($monitorRegistered) {
      $deadline = (Get-Date).AddSeconds(6)
      while ((Get-Date) -lt $deadline) {
        $t = Get-ScheduledTask -TaskName $MonitorTaskName -ErrorAction SilentlyContinue
        if (-not $t -or $t.State -ne 'Running') { break }
        Start-Sleep -Milliseconds 300
      }
      Start-ScheduledTask -TaskName $MonitorTaskName
    } else {
      Start-Process -FilePath $WScript -ArgumentList ('"{0}"' -f $MonitorLauncher) -WorkingDirectory $RepoRoot
    }
    if ($wasRunning) { Write-Step 'Monitor restarted (tray icon)' } else { Write-Step 'Monitor started (tray icon near the clock)' }
  }
}

Write-Host ''
Write-Host "Log file:     $LogFile"
Write-Host "Pairing page: http://127.0.0.1:$port/pair  (open on this PC once the agent is running)"
if ($monitorInstalled) {
  Write-Host "Monitor:      tray icon 'TermPocket Monitor' (green = working). Dashboard: http://127.0.0.1:$port/monitor"
  Write-Host '              Start it by hand with scripts\start-monitor.cmd'
}
Write-Host 'Remove with:  powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1'
