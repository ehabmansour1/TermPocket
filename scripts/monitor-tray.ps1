<#
.SYNOPSIS
  TermPocket Monitor: a tray icon that tells you whether the TermPocket agent (and the public link your
  phone uses) is working.

.DESCRIPTION
  Polls the agent's loopback-only GET /status every 5 s and the public <publicUrl>/healthz every 60 s.
    GREEN  agent running, and (no relay configured, or relay connected and the public link answers)
    AMBER  agent running, but the relay is disconnected / the public link fails / the helper crashed
    RED    agent not running
  Shows a balloon when something changes (agent down/up, relay lost/restored, public link down/up) and
  for security events (a new device connected, failed pairing attempts). Left-click opens the monitor
  dashboard (http://127.0.0.1:<port>/monitor) in an app window. Right-click for the menu.

  Run with Windows PowerShell 5.1 in STA mode:
    powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts\monitor-tray.ps1
  (scripts\start-monitor.cmd does that; scripts\install-autostart.ps1 starts it at logon.)

  Its own errors go to %APPDATA%\TermPocket\monitor.log (rotated at 1 MB).

.PARAMETER Once
  Test mode: poll once, print the computed state (color, tooltip, reasons, menu lines, alerts) and exit.
  Exit code 0 = green, 1 = amber, 2 = red.

.PARAMETER Json
  With -Once: print the state as JSON.

.PARAMETER StatusUrl
  Override the agent status URL (default http://127.0.0.1:<port>/status). The other agent URLs
  (/healthz, /status/selftest, /monitor, /pair) are derived from it.

.PARAMETER HealthUrl
  Override the public health URL (default https://<publicUrl host>/healthz).

.PARAMETER NoHealth
  Skip the public health check.

.PARAMETER StateFile
  With -Once: previous-state file. Alerts are computed against it, then it is rewritten.

.PARAMETER ConfigDir
  Folder holding config.json / relay.json (default: $env:TERMPOCKET_HOME or %APPDATA%\TermPocket; the
  pre-rename names $env:VSCONTROL_HOME and %APPDATA%\VSControl are used while the new ones do not exist).

.PARAMETER Port
  Agent port (default: "port" in config.json, else 8765).

.PARAMETER NowMs
  With -Once: the current time in Unix ms (tests only).

.PARAMETER SmokeSeconds
  Tests only: run the tray app with an invisible icon for this many seconds against -StatusUrl, print
  state changes and alerts to stdout instead of showing them, then exit. Never controls the agent.

.PARAMETER SaveIconsTo
  Tests and docs only: write the generated tray icons (16, 32 and 64 px) as PNG files to this folder and exit.

.PARAMETER ProcessTargetsTest
  Tests only: a JSON file {processes:[Win32_Process-like objects], owners:[pids], launcher:"..."}.
  Prints which PIDs "Stop/Restart agent" would end (as JSON) and exits. Never ends anything.
#>
[CmdletBinding()]
param(
  [switch]$Once,
  [switch]$Json,
  [string]$StatusUrl,
  [string]$HealthUrl,
  [switch]$NoHealth,
  [string]$StateFile,
  [string]$ConfigDir,
  [int]$Port = 0,
  [long]$NowMs = 0,
  [int]$SmokeSeconds = 0,
  [string]$SaveIconsTo,
  [string]$ProcessTargetsTest
)

$ErrorActionPreference = 'Continue'

# ------------------------------------------------------------------------------------------------
# Constants / paths
# ------------------------------------------------------------------------------------------------
$MonitorVersion   = '1.0.0'
$AgentTaskName    = 'TermPocket Agent'
$RepoRoot         = Split-Path -Parent $PSScriptRoot
$AgentEntry       = Join-Path $RepoRoot 'agent\src\index.js'
if (-not $ConfigDir) {
  if ($env:TERMPOCKET_HOME) { $ConfigDir = $env:TERMPOCKET_HOME }
  elseif ($env:VSCONTROL_HOME) { $ConfigDir = $env:VSCONTROL_HOME }
  else {
    $ConfigDir = Join-Path $env:APPDATA 'TermPocket'
    # Before the agent's one-time copy of the old (VS Control) folder, the settings are only there.
    $legacyDir = Join-Path $env:APPDATA 'VSControl'
    if (-not (Test-Path -LiteralPath (Join-Path $ConfigDir 'config.json')) -and (Test-Path -LiteralPath (Join-Path $legacyDir 'config.json'))) {
      $ConfigDir = $legacyDir
    }
  }
}
$MonitorLogFile   = Join-Path $ConfigDir 'monitor.log'
$AgentLogFile     = Join-Path $ConfigDir 'agent.log'
$AgentLauncher    = Join-Path $ConfigDir 'termpocket-agent.vbs'

$AlertDebounceMs  = 30000     # never repeat an identical alert within 30 s
$RelayGraceSec    = 20        # a freshly started agent gets this long to connect to the relay
$KnownDeviceMs    = 86400000  # a device address seen within 24 h is not announced as "new" again
$PollIntervalMs   = 5000
$HealthOkMs       = 60000     # public check cadence while it works
$HealthFailMs     = 20000     # ... and while it fails (notice the recovery sooner)

# PowerShell 5.1 may not offer TLS 1.2 by default; the public relay needs it.
try {
  $proto = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  try { $proto = $proto -bor [System.Net.SecurityProtocolType]'Tls13' } catch { }
  [System.Net.ServicePointManager]::SecurityProtocol = $proto
} catch { }

# ------------------------------------------------------------------------------------------------
# Small helpers (also exported to the background runspaces)
# ------------------------------------------------------------------------------------------------
function Write-MonitorLog {
  param([string]$Level, [string]$Message)
  try {
    $f = $MonitorLogFile
    if (-not $f) { return }
    $dir = [System.IO.Path]::GetDirectoryName($f)
    if (-not [System.IO.Directory]::Exists($dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    $fi = New-Object System.IO.FileInfo $f
    if ($fi.Exists -and $fi.Length -gt 1MB) {
      $old = $f + '.1'
      if ([System.IO.File]::Exists($old)) { [System.IO.File]::Delete($old) }
      [System.IO.File]::Move($f, $old)
    }
    $line = '{0} {1,-5} {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level.ToUpperInvariant(), $Message
    [System.IO.File]::AppendAllText($f, $line + "`r`n", (New-Object System.Text.UTF8Encoding $false))
  } catch { }
}

function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name) -and $null -ne $Object[$Name]) { return $Object[$Name] }
    return $Default
  }
  $p = $Object.PSObject.Properties[$Name]
  if ($p -and $null -ne $p.Value) { return $p.Value }
  return $Default
}

function Get-NowMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function ConvertTo-PlainHashtable {
  param($Object)
  $h = @{}
  if ($null -eq $Object) { return $h }
  if ($Object -is [System.Collections.IDictionary]) {
    foreach ($k in $Object.Keys) { $h[[string]$k] = $Object[$k] }
    return $h
  }
  foreach ($p in $Object.PSObject.Properties) { $h[$p.Name] = $p.Value }
  return $h
}

function Get-TextLimited {
  param([string]$Text, [int]$Max)
  if ($null -eq $Text) { return '' }
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, [Math]::Max(0, $Max - 3)) + '...'
}

function Format-Uptime {
  param($Seconds)
  if ($null -eq $Seconds) { return '' }
  $s = [long][Math]::Max(0, [double]$Seconds)
  $d = [long][Math]::Floor($s / 86400); $h = [long][Math]::Floor(($s % 86400) / 3600); $m = [long][Math]::Floor(($s % 3600) / 60)
  if ($d -gt 0) { return "${d}d ${h}h" }
  if ($h -gt 0) { return "${h}h ${m}m" }
  if ($m -gt 0) { return "${m}m" }
  return "${s}s"
}

function Get-HostOfUrl {
  param([string]$Url)
  if (-not $Url) { return $null }
  try { return ([Uri]$Url).Authority } catch { return $Url }
}

function Get-HealthUrlFromPublic {
  param([string]$PublicUrl)
  if (-not $PublicUrl) { return $null }
  try {
    $u = [Uri]($PublicUrl -replace '^ws', 'http')
    if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') { return $null }
    return ('{0}://{1}/healthz' -f $u.Scheme, $u.Authority)
  } catch { return $null }
}

function Read-JsonFile {
  param([string]$Path)
  if (-not $Path -or -not [System.IO.File]::Exists($Path)) { return $null }
  $text = [System.IO.File]::ReadAllText($Path)
  if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  if (-not $text.Trim()) { return $null }
  return ($text | ConvertFrom-Json)
}

# Reads port / publicUrl from config.json and the relay URL from relay.json (never the token or key).
function Read-MonitorConfig {
  param([string]$Dir, [int]$PortOverride = 0, [string]$StatusUrlOverride)
  $cfg = [ordered]@{ port = 8765; publicUrl = $null; relayConfigured = $false; relayUrl = $null; ptyHostPid = $null; ptyHostAlive = $false; errors = @() }
  $errors = New-Object System.Collections.Generic.List[string]
  try {
    $c = Read-JsonFile (Join-Path $Dir 'config.json')
    if ($c) {
      $p = Get-Prop $c 'port'
      if ($p) { $cfg.port = [int]$p }
      $pu = Get-Prop $c 'publicUrl'
      if ($pu -and ([string]$pu).Trim()) { $cfg.publicUrl = ([string]$pu).Trim().TrimEnd('/') }
    }
  } catch { $errors.Add("config.json: $($_.Exception.Message)") }
  try {
    $relayFile = Join-Path $Dir 'relay.json'
    if ([System.IO.File]::Exists($relayFile)) {
      $cfg.relayConfigured = $true
      $r = Read-JsonFile $relayFile
      $ru = Get-Prop $r 'url'
      if ($ru) { $cfg.relayUrl = ([string]$ru).Trim().TrimEnd('/') }
    }
  } catch { $errors.Add("relay.json: $($_.Exception.Message)") }
  try {
    # The durable terminals host (agent\src\ptyhost.js) writes its pid here; never read or show its secret.
    $ph = Read-JsonFile (Join-Path $Dir 'ptyhost.json')
    $phPid = Get-Prop $ph 'pid'
    if ($phPid) {
      $cfg.ptyHostPid = [int]$phPid
      $proc = Get-Process -Id ([int]$phPid) -ErrorAction SilentlyContinue
      $cfg.ptyHostAlive = [bool]($proc -and $proc.ProcessName -ieq 'node')
    }
  } catch { }
  if ($PortOverride -gt 0) { $cfg.port = $PortOverride }
  if ($StatusUrlOverride) { try { $cfg.port = ([Uri]$StatusUrlOverride).Port } catch { } }
  if (-not $cfg.publicUrl -and $cfg.relayUrl) { $cfg.publicUrl = $cfg.relayUrl -replace '^ws', 'http' }
  $cfg.errors = $errors.ToArray()
  return [pscustomobject]$cfg
}

# HTTP request that never throws. Returns {ok, status, body, error, kind, ms}.
function Invoke-MonitorHttp {
  param(
    [string]$Url,
    [string]$Method = 'GET',
    [int]$TimeoutMs = 3000,
    [hashtable]$Headers = @{},
    [switch]$UseProxy
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = [ordered]@{ ok = $false; status = 0; body = $null; error = $null; kind = $null; ms = 0 }
  $resp = $null
  try {
    $req = [System.Net.HttpWebRequest]([System.Net.WebRequest]::Create($Url))
    $req.Method = $Method
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.KeepAlive = $false
    $req.AllowAutoRedirect = $false
    $req.UserAgent = 'TermPocket-Monitor/1.0'
    $req.Accept = 'application/json'
    if (-not $UseProxy) { $req.Proxy = $null }
    try { $req.ServicePoint.Expect100Continue = $false } catch { }
    foreach ($k in $Headers.Keys) { $req.Headers[[string]$k] = [string]$Headers[$k] }
    if ($Method -eq 'POST') {
      # No body: a server that answers before reading an unread body may reset the connection.
      $req.ContentLength = 0
    }
    $resp = [System.Net.HttpWebResponse]$req.GetResponse()
    $res.status = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    try { $res.body = $sr.ReadToEnd() } finally { $sr.Close() }
    $res.ok = ($res.status -ge 200 -and $res.status -lt 300)
    if (-not $res.ok) { $res.error = "HTTP $($res.status)"; $res.kind = 'http' }
  } catch {
    $ex = $_.Exception
    $we = $null
    while ($ex) {
      if ($ex -is [System.Net.WebException]) { $we = $ex; break }
      $ex = $ex.InnerException
    }
    if ($we) {
      $r = $we.Response
      if ($r -is [System.Net.HttpWebResponse]) {
        $res.status = [int]$r.StatusCode
        try {
          $sr = New-Object System.IO.StreamReader($r.GetResponseStream(), [System.Text.Encoding]::UTF8)
          try { $res.body = $sr.ReadToEnd() } finally { $sr.Close() }
        } catch { }
        try { $r.Close() } catch { }
        $res.kind = 'http'
        $res.error = "HTTP $($res.status)"
      } else {
        switch ($we.Status) {
          'ConnectFailure'        { $res.kind = 'refused'; $res.error = 'connection refused' }
          'Timeout'               { $res.kind = 'timeout'; $res.error = "no answer within $([Math]::Round($TimeoutMs / 1000)) s" }
          'NameResolutionFailure' { $res.kind = 'dns'; $res.error = 'DNS lookup failed' }
          'ProxyNameResolutionFailure' { $res.kind = 'dns'; $res.error = 'proxy DNS lookup failed' }
          'TrustFailure'          { $res.kind = 'tls'; $res.error = 'TLS certificate not trusted' }
          'SecureChannelFailure'  { $res.kind = 'tls'; $res.error = 'TLS handshake failed' }
          default                 { $res.kind = 'network'; $res.error = $we.Message }
        }
      }
    } else {
      $res.kind = 'error'
      $res.error = $_.Exception.Message
    }
  } finally {
    if ($resp) { try { $resp.Close() } catch { } }
    $sw.Stop()
    $res.ms = [int]$sw.ElapsedMilliseconds
  }
  return [pscustomobject]$res
}

function Test-PortListening {
  param([int]$Port)
  if ($Port -le 0) { return $null }
  try {
    foreach ($ep in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
      if ($ep.Port -eq $Port) { return $true }
    }
    return $false
  } catch { return $null }
}

# One monitoring sample: agent /status (3 s), fallback /healthz when /status is missing (old agent),
# optional public healthz. Pure I/O; the classification happens in Get-MonitorState.
function Get-PollResult {
  param(
    [string]$StatusUrl,
    [string]$HealthUrl,
    [string]$ConfigPublicUrl,
    [bool]$DoHealth = $true,
    [int]$Port = 0
  )
  $r = [ordered]@{
    at = (Get-NowMs); port = $Port; portListening = $null
    statusOk = $false; status = $null; statusError = $null; statusHttp = 0; statusKind = $null; statusMs = 0; healthzOnly = $false
    healthChecked = $false; healthOk = $null; healthError = $null; healthUrl = $null; pcOnline = $null; healthAt = $null
  }
  try {
    if ($Port -gt 0) { $r.portListening = Test-PortListening $Port }
    $s = Invoke-MonitorHttp -Url $StatusUrl -TimeoutMs 3000
    $r.statusHttp = $s.status; $r.statusMs = $s.ms; $r.statusKind = $s.kind
    if ($s.ok) {
      try {
        $obj = $s.body | ConvertFrom-Json
        if ($obj -and (Get-Prop $obj 'ok') -ne $false) { $r.statusOk = $true; $r.status = $obj }
        else { $r.statusError = 'status says not ok' }
      } catch { $r.statusError = 'invalid JSON from /status' }
    } elseif ($s.status -eq 404) {
      # Agent from before /status existed: it is up if /healthz answers.
      $hzUrl = $StatusUrl -replace '/status/?$', '/healthz'
      $hz = Invoke-MonitorHttp -Url $hzUrl -TimeoutMs 3000
      if ($hz.ok) { $r.healthzOnly = $true } else { $r.statusError = "/status 404, /healthz $($hz.error)" }
    } else {
      $r.statusError = $s.error
    }

    $publicBase = $ConfigPublicUrl
    $sp = Get-Prop $r.status 'publicUrl'
    if ($sp) { $publicBase = [string]$sp }
    $hu = $HealthUrl
    if (-not $hu) { $hu = Get-HealthUrlFromPublic $publicBase }
    $r.healthUrl = $hu
    if ($DoHealth -and $hu) {
      $r.healthChecked = $true
      $r.healthAt = Get-NowMs
      $loop = ($hu -match '^https?://(127\.0\.0\.1|localhost|\[::1\])[:/]')
      $h = Invoke-MonitorHttp -Url $hu -TimeoutMs 8000 -UseProxy:(-not $loop)
      if ($h.ok) {
        $hobj = $null
        try { $hobj = $h.body | ConvertFrom-Json } catch { }
        $pc = Get-Prop $hobj 'pcOnline'
        if ($null -ne $pc) { $r.pcOnline = [bool]$pc }
        if ($null -eq $hobj) { $r.healthOk = $false; $r.healthError = 'invalid answer from the public link' }
        elseif ((Get-Prop $hobj 'ok') -eq $false) { $r.healthOk = $false; $r.healthError = 'public link says not ok' }
        elseif ($r.pcOnline -eq $false) { $r.healthOk = $false; $r.healthError = 'the relay says this PC is offline' }
        else { $r.healthOk = $true }
      } else {
        $r.healthOk = $false
        $r.healthError = $h.error
      }
    }
  } catch {
    if (-not $r.statusError -and -not $r.statusOk -and -not $r.healthzOnly) { $r.statusError = $_.Exception.Message }
  }
  return [pscustomobject]$r
}

# ------------------------------------------------------------------------------------------------
# Pure classification: poll result + config  ->  color / tooltip / reasons / menu lines
# ------------------------------------------------------------------------------------------------
function Get-MonitorState {
  param($Poll, $Config, [long]$NowMs = 0)
  if (-not $NowMs) { $NowMs = Get-NowMs }
  $dot = [string][char]0x00B7
  $port = [int](Get-Prop $Config 'port' 8765)
  $st = Get-Prop $Poll 'status'
  $statusAvailable = [bool](Get-Prop $Poll 'statusOk' $false) -and ($null -ne $st)
  $agentUp = $statusAvailable -or [bool](Get-Prop $Poll 'healthzOnly' $false)

  $relayConfigured = [bool](Get-Prop $Config 'relayConfigured' $false)
  $relayConnected = $null; $relayError = $null; $relaySince = $null
  $publicUrl = Get-Prop $Config 'publicUrl'
  $phones = @(); $vscodeCount = 0; $terminalCount = 0; $screenStreams = 0
  $helperRunning = $null; $helperError = $null
  $ptyHost = $null
  $authFailures = $null; $lastAuthIp = $null; $rateLimitedIps = 0
  $agentPid = $null; $uptimeSec = $null; $version = $null

  if ($statusAvailable) {
    $agentPid = Get-Prop $st 'pid'
    $uptimeSec = Get-Prop $st 'uptimeSec'
    $version = Get-Prop $st 'version'
    $pu = Get-Prop $st 'publicUrl'
    if ($pu) { $publicUrl = [string]$pu }
    $relay = Get-Prop $st 'relay'
    if ($null -ne $relay) {
      $relayConfigured = [bool](Get-Prop $relay 'configured' $relayConfigured)
      if ($relayConfigured) { $relayConnected = [bool](Get-Prop $relay 'connected' $false) }
      $relayError = Get-Prop $relay 'lastError'
      $relaySince = Get-Prop $relay 'since'
    }
    $phones = @(@(Get-Prop $st 'phones' @()) | Where-Object { $null -ne $_ } | ForEach-Object {
      [pscustomobject]@{
        id = Get-Prop $_ 'id'
        ip = [string](Get-Prop $_ 'ip' '?')
        via = [string](Get-Prop $_ 'via' 'direct')
        client = [string](Get-Prop $_ 'client' '')
        connectedAt = Get-Prop $_ 'connectedAt'
      }
    })
    $vscodeCount = @(Get-Prop $st 'vscode' @()).Count
    $terminalCount = @(Get-Prop $st 'terminals' @()).Count
    $screenStreams = [int](Get-Prop (Get-Prop $st 'screen') 'streams' 0)
    $helper = Get-Prop $st 'helper'
    if ($null -ne $helper) {
      $helperRunning = [bool](Get-Prop $helper 'running' $false)
      $helperError = Get-Prop $helper 'lastError'
    }
    $ptyHost = Get-Prop $st 'ptyHost'
    $sec = Get-Prop $st 'security'
    if ($null -ne $sec) {
      $authFailures = [long](Get-Prop $sec 'authFailures' 0)
      $rateLimitedIps = [int](Get-Prop $sec 'rateLimitedIps' 0)
      $lastAuthIp = Get-Prop (Get-Prop $sec 'lastAuthFailure') 'ip'
    }
  }

  $publicChecked = [bool](Get-Prop $Poll 'healthChecked' $false)
  $publicOk = $null
  if ($publicChecked) { $publicOk = [bool](Get-Prop $Poll 'healthOk' $false) }
  $publicError = Get-Prop $Poll 'healthError'
  $publicHost = Get-HostOfUrl $publicUrl

  $reasons = New-Object System.Collections.Generic.List[string]
  $short = New-Object System.Collections.Generic.List[string]
  if (-not $agentUp) {
    $color = 'red'
    $listening = Get-Prop $Poll 'portListening'
    $err = Get-Prop $Poll 'statusError'
    if ($listening -eq $false) {
      $reasons.Add("Agent is not running (nothing is listening on port $port)")
    } elseif ($err) {
      $reasons.Add("Agent is not responding on port ${port}: $err")
    } else {
      $reasons.Add("Agent is not running (port $port)")
    }
    $short.Add('agent NOT running')
  } else {
    if (-not $statusAvailable) {
      $reasons.Add('Agent is running, but it has no /status page (older version): restart the agent')
      $short.Add('restart agent (old version)')
    }
    if ($relayConfigured -and $relayConnected -eq $false) {
      $t = 'Public relay is disconnected'
      if ($relayError) { $t += ": $relayError" }
      $reasons.Add($t)
      $short.Add('relay disconnected')
    }
    if ($publicChecked -and $publicOk -eq $false) {
      $t = 'Public link'
      if ($publicHost) { $t += " $publicHost" }
      $t += ' is not working'
      if ($publicError) { $t += ": $publicError" }
      $reasons.Add($t)
      $short.Add('public link down')
    }
    if ($helperRunning -eq $false -and $helperError) {
      $reasons.Add("Windows helper (screen/keyboard) is not running: $helperError")
      $short.Add('helper down')
    }
    if ($reasons.Count -gt 0) { $color = 'amber' } else { $color = 'green' }
  }

  $n = $phones.Count
  if ($n -eq 1) { $phonesText = '1 phone' } else { $phonesText = "$n phones" }
  switch ($color) {
    'green' { $tooltip = "TermPocket: all good $dot $phonesText" }
    'amber' {
      $tooltip = "TermPocket: $($short[0])"
      if ($short.Count -gt 1) { $tooltip += " (+$($short.Count - 1))" }
      $tooltip += " $dot $phonesText"
    }
    default { $tooltip = 'TermPocket: agent is NOT running' }
  }
  if ($tooltip.Length -gt 63) { $tooltip = Get-TextLimited $tooltip 63 }

  # Menu status lines
  if (-not $agentUp) { $agentLine = 'Agent: NOT running' }
  elseif ($null -ne $uptimeSec) { $agentLine = "Agent: running $(Format-Uptime $uptimeSec)" }
  else { $agentLine = 'Agent: running' }

  if (-not $agentUp) {
    if ($relayConfigured -or $publicUrl) { $publicLine = 'Public: offline (agent not running)' } else { $publicLine = 'Public: not configured' }
  } elseif ($relayConfigured) {
    if ($relayConnected -eq $true) {
      if ($publicOk -eq $false) { $publicLine = 'Public: relay connected, link failing' } else { $publicLine = 'Public: connected' }
    } elseif ($relayConnected -eq $false) {
      $publicLine = 'Public: disconnected'
    } elseif ($publicOk -eq $true) { $publicLine = 'Public: reachable' }
    elseif ($publicOk -eq $false) { $publicLine = 'Public: unreachable' }
    else { $publicLine = 'Public: unknown' }
  } elseif ($publicUrl) {
    if ($publicOk -eq $true) { $publicLine = 'Public: reachable' }
    elseif ($publicOk -eq $false) { $publicLine = 'Public: unreachable' }
    else { $publicLine = 'Public: not checked yet' }
  } else {
    $publicLine = 'Public: not configured'
  }

  # Durable terminals host (survives agent restarts): from /status, else from ptyhost.json's pid.
  $ptyHostRunning = $null; $ptyHostSessions = $null
  if ($null -ne $ptyHost) {
    $ptyHostSessions = [int](Get-Prop $ptyHost 'sessions' 0)
    if ($ptyHostSessions -eq 1) { $sTxt = '1 session' } else { $sTxt = "$ptyHostSessions sessions" }
    if ((Get-Prop $ptyHost 'mode') -eq 'inprocess') { $ptyHostRunning = $false; $ptyLine = "Terminals host: inside the agent ($sTxt)" }
    elseif ([bool](Get-Prop $ptyHost 'running' $false)) { $ptyHostRunning = $true; $ptyLine = "Terminals host: running ($sTxt)" }
    else { $ptyHostRunning = $false; $ptyLine = 'Terminals host: reconnecting' }
  } elseif ([bool](Get-Prop $Config 'ptyHostAlive' $false)) { $ptyHostRunning = $true; $ptyLine = 'Terminals host: running' }
  else { $ptyHostRunning = $false; $ptyLine = 'Terminals host: not running' }

  return [pscustomobject][ordered]@{
    at = $NowMs
    color = $color
    tooltip = $tooltip
    reasons = [string[]]$reasons.ToArray()
    menu = [string[]]@($agentLine, $publicLine, "Phones: $n", "VS Code windows: $vscodeCount", $ptyLine)
    agentUp = $agentUp
    statusAvailable = $statusAvailable
    pid = $agentPid
    version = $version
    uptimeSec = $uptimeSec
    port = $port
    publicUrl = $publicUrl
    relayConfigured = $relayConfigured
    relayConnected = $relayConnected
    relayError = $relayError
    publicChecked = $publicChecked
    publicOk = $publicOk
    publicError = $publicError
    helperRunning = $helperRunning
    helperError = $helperError
    ptyHostRunning = $ptyHostRunning
    ptyHostSessions = $ptyHostSessions
    phones = @($phones)
    phoneCount = $n
    vscodeCount = $vscodeCount
    terminalCount = $terminalCount
    screenStreams = $screenStreams
    authFailures = $authFailures
    lastAuthFailureIp = $lastAuthIp
    rateLimitedIps = $rateLimitedIps
  }
}

# ------------------------------------------------------------------------------------------------
# Pure alert detection: previous snapshot + current state  ->  alerts + next snapshot
#   Snapshot: {at, agentUp, pid, relayEff, publicEff, phonesKnown, phones[{id,ip,via}], seen{"ip|via": ms}, authFailures}
#   relayEff / publicEff are the last *settled* values ($null = never known), so an agent restart or a
#   skipped public check does not produce false "lost/restored" pairs.
# ------------------------------------------------------------------------------------------------
function Get-Alerts {
  param(
    $Previous,
    $State,
    [long]$NowMs = 0,
    $LastAlerts = $null,
    [long]$SuppressAgentUntil = 0
  )
  if (-not $NowMs) { $NowMs = Get-NowMs }
  $last = ConvertTo-PlainHashtable $LastAlerts
  $prevKnown = $null -ne $Previous
  $cand = New-Object System.Collections.Generic.List[object]
  function Add-Candidate([string]$Key, [string]$Level, [string]$Title, [string]$Text) {
    $cand.Add([pscustomobject][ordered]@{ key = $Key; level = $Level; title = $Title; text = $Text })
  }

  $curUp = [bool]$State.agentUp
  $prevUp = $null
  if ($prevKnown) { $prevUp = Get-Prop $Previous 'agentUp' }
  $prevPid = Get-Prop $Previous 'pid'
  $curPid = $State.pid
  $statusAvailable = [bool]$State.statusAvailable
  $samePid = ($null -ne $prevPid) -and ($null -ne $curPid) -and ("$prevPid" -eq "$curPid")

  # --- agent up / down
  if ($NowMs -ge $SuppressAgentUntil) {
    if (-not $curUp -and ($prevUp -ne $false)) {
      Add-Candidate 'agent-down' 'error' 'TermPocket agent stopped' ("The agent is not running, so your phone can't reach this PC. " + (@($State.reasons) -join ' ')).Trim()
    } elseif ($curUp -and $prevUp -eq $false) {
      Add-Candidate 'agent-up' 'info' 'TermPocket agent is running' 'The agent is running again.'
    }
  }

  # --- relay connected / lost
  $relayEff = Get-Prop $Previous 'relayEff'
  $prevRelayEff = $relayEff
  if ($curUp -and $statusAvailable) {
    if (-not $State.relayConfigured) { $relayEff = $null }
    elseif ($State.relayConnected -eq $true) { $relayEff = $true }
    elseif ($null -eq $State.uptimeSec -or [double]$State.uptimeSec -ge $RelayGraceSec) { $relayEff = $false }
  }
  if ($relayEff -eq $false -and $prevRelayEff -ne $false) {
    $t = 'Your phone cannot reach this PC through the public link.'
    if ($State.relayError) { $t += " ($($State.relayError))" }
    Add-Candidate 'relay-lost' 'warning' 'TermPocket: public relay lost' $t
  } elseif ($relayEff -eq $true -and $prevRelayEff -eq $false) {
    Add-Candidate 'relay-restored' 'info' 'TermPocket: public relay restored' 'The public relay is connected again.'
  }

  # --- public URL reachable / unreachable (only judged while the agent runs)
  $publicEff = Get-Prop $Previous 'publicEff'
  $prevPublicEff = $publicEff
  if ($curUp -and $State.publicChecked) { $publicEff = [bool]$State.publicOk }
  if (-not $State.publicUrl -and $statusAvailable) { $publicEff = $null }
  $host_ = Get-HostOfUrl $State.publicUrl
  if ($publicEff -eq $false -and $prevPublicEff -ne $false) {
    $t = "$host_ is not reachable"
    if ($State.publicError) { $t += ": $($State.publicError)" }
    Add-Candidate 'public-down' 'warning' 'TermPocket: public URL unreachable' $t
  } elseif ($publicEff -eq $true -and $prevPublicEff -eq $false) {
    Add-Candidate 'public-up' 'info' 'TermPocket: public URL restored' "$host_ is reachable again."
  }

  # --- security: new devices
  # A "new device" is an address (ip + route) not seen connected in the last 24 h. Your own phone
  # reconnects every time it wakes up or the agent restarts; that is not news, a new address is.
  $phonesKnown = [bool](Get-Prop $Previous 'phonesKnown' $false)
  $snapPhones = @(Get-Prop $Previous 'phones' @())
  $seen = ConvertTo-PlainHashtable (Get-Prop $Previous 'seen')
  foreach ($p in $snapPhones) {
    $k = "$(Get-Prop $p 'ip')|$(Get-Prop $p 'via')"
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $NowMs }
  }
  foreach ($k in @($seen.Keys)) {
    if (($NowMs - [long]$seen[$k]) -gt $KnownDeviceMs) { $seen.Remove($k) }
  }
  if ($statusAvailable) {
    $cur = @($State.phones)
    if ($prevKnown -and $phonesKnown) {
      foreach ($p in $cur) {
        if (-not $seen.ContainsKey("$($p.ip)|$($p.via)")) {
          Add-Candidate "new-device|$($p.ip)|$($p.via)" 'warning' 'TermPocket security' "New device connected from $($p.ip) (via $($p.via))"
        }
      }
    }
    foreach ($p in $cur) { $seen["$($p.ip)|$($p.via)"] = $NowMs }
    $snapPhones = @($cur | ForEach-Object { [pscustomobject]@{ id = $_.id; ip = $_.ip; via = $_.via } })
    $phonesKnown = $true
  }

  # --- security: failed pairing attempts
  # One alert key for all addresses (an attacker rotating IPs must not get a balloon every poll); the
  # count of attempts held back by the debounce is carried into the next alert (see below).
  $prevFails = Get-Prop $Previous 'authFailures'
  $authFailures = $prevFails
  $authHeldBase = $null
  if ($statusAvailable -and $null -ne $State.authFailures) {
    $curFails = [long]$State.authFailures
    if ($prevKnown -and $null -ne $prevFails) {
      if ($samePid) { $delta = $curFails - [long]$prevFails; $authHeldBase = [long]$prevFails } else { $delta = $curFails; $authHeldBase = 0 }
      if ($delta -gt 0) {
        $ip = $State.lastAuthFailureIp
        if (-not $ip) { $ip = 'an unknown address' }
        if ($delta -eq 1) { $what = '1 failed pairing attempt' } else { $what = "$delta failed pairing attempts" }
        Add-Candidate 'auth-fail' 'warning' 'TermPocket security' "$what from $ip"
      }
    }
    $authFailures = $curFails
  }

  # --- debounce
  $alerts = New-Object System.Collections.Generic.List[object]
  foreach ($c in $cand) {
    $prevAt = $last[$c.key]
    if ($null -ne $prevAt -and ($NowMs - [long]$prevAt) -lt $AlertDebounceMs) {
      # Held back: keep the old baseline so the next alert reports these attempts too.
      if ($c.key -eq 'auth-fail' -and $null -ne $authHeldBase) { $authFailures = $authHeldBase }
      continue
    }
    $last[$c.key] = $NowMs
    $alerts.Add($c)
  }
  foreach ($k in @($last.Keys)) {
    if (($NowMs - [long]$last[$k]) -gt 3600000) { $last.Remove($k) }
  }

  $snapPid = $prevPid
  if ($statusAvailable) { $snapPid = $curPid }
  $snapshot = [pscustomobject][ordered]@{
    at = $NowMs
    agentUp = $curUp
    pid = $snapPid
    relayEff = $relayEff
    publicEff = $publicEff
    phonesKnown = $phonesKnown
    phones = @($snapPhones)
    seen = $seen
    authFailures = $authFailures
    color = $State.color
  }
  return [pscustomobject]@{ alerts = [object[]]$alerts.ToArray(); snapshot = $snapshot; lastAlerts = $last }
}

# ------------------------------------------------------------------------------------------------
# Agent control (run in a background runspace from the tray)
# ------------------------------------------------------------------------------------------------
# Pure: which processes ARE the agent. Only the launcher (wscript running termpocket-agent.vbs), the
# cmd.exe / node.exe it started that run agent\src\index.js, and the agent node that owns the port.
# Never the agent's other descendants: shells of phone terminals and whatever was started from them
# (dev servers, a VS Code window opened with `code .`, browsers...) must survive "Restart agent". The
# agent's own helpers (windows helper) exit by themselves when its node process ends. NEVER the terminals
# host (node agent\src\ptyhost.js): it owns every terminal and must survive Restart/Stop - its command
# line does not match index.js, it does not own the port, and it is not in the launcher's tree.
# A child must also be newer than its parent: Windows reuses PIDs, so a stale ParentProcessId can
# point at an unrelated process.
function Select-AgentProcesses {
  param([object[]]$Processes, [object[]]$PortOwners, [string]$Launcher)
  $all = @($Processes | Where-Object { $null -ne $_ })
  $owners = @($PortOwners | ForEach-Object { [long]$_ })
  $isAgentCmd = { param($p) $p.CommandLine -and ([string]$p.CommandLine) -match 'agent[\\/]+src[\\/]+index\.js' }
  $created = {
    param($p)
    $c = $p.CreationDate
    if ($null -eq $c -or '' -eq $c) { return $null }
    try { return [datetime]$c } catch { return $null }
  }
  $launchers = @($all | Where-Object { $_.Name -ieq 'wscript.exe' -and $Launcher -and $_.CommandLine -and ([string]$_.CommandLine).IndexOf($Launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  $tree = New-Object System.Collections.Generic.List[object]
  $frontier = @($launchers)
  for ($depth = 0; $depth -lt 4 -and $frontier.Count -gt 0; $depth++) {
    $next = New-Object System.Collections.Generic.List[object]
    foreach ($parent in $frontier) {
      $pc = & $created $parent
      foreach ($c in $all) {
        if ([long]$c.ParentProcessId -ne [long]$parent.ProcessId) { continue }
        if (-not ($c.Name -ieq 'cmd.exe' -or $c.Name -ieq 'node.exe')) { continue }
        if (-not (& $isAgentCmd $c)) { continue }
        $cc = & $created $c
        if ($pc -and $cc -and $cc -lt $pc) { continue }
        if (@($tree | Where-Object { $_.ProcessId -eq $c.ProcessId }).Count) { continue }
        $tree.Add($c); $next.Add($c)
      }
    }
    $frontier = @($next.ToArray())
  }
  # The node process that owns the agent port, if it is an agent (also covers a console-started one).
  $portAgents = @($all | Where-Object { $owners -contains [long]$_.ProcessId -and $_.Name -ieq 'node.exe' -and (& $isAgentCmd $_) })
  return [pscustomobject]@{ launchers = $launchers; tree = @($tree.ToArray()); portAgents = $portAgents }
}

function Get-AgentProcessTargets {
  param([int]$Port, [string]$Launcher)
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $owners = @()
  try {
    $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { }
  return Select-AgentProcesses -Processes $all -PortOwners $owners -Launcher $Launcher
}

function Wait-AgentState {
  param([string]$HealthzUrl, [bool]$Up, [int]$TimeoutSec = 20)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    $h = Invoke-MonitorHttp -Url $HealthzUrl -TimeoutMs 2000
    if ([bool]$h.ok -eq $Up) { return $true }
    Start-Sleep -Milliseconds 700
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-VSAgent {
  param([int]$Port, [string]$Launcher, [string]$TaskName, [string]$AgentBase)
  $notes = New-Object System.Collections.Generic.List[string]
  $t = Get-AgentProcessTargets -Port $Port -Launcher $Launcher
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $notes.Add("Stop-ScheduledTask: $($_.Exception.Message)") }
  }
  # Launcher first (it would restart the agent), then what it started, then the port owner.
  $killed = 0
  foreach ($p in @($t.launchers) + @($t.tree) + @($t.portAgents)) {
    try {
      $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
      if ($proc) { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ }
    } catch { $notes.Add("pid $($p.ProcessId): $($_.Exception.Message)") }
  }
  $stopped = Wait-AgentState -HealthzUrl "$AgentBase/healthz" -Up $false -TimeoutSec 10
  Write-MonitorLog 'INFO' "stop agent: task=$([bool]$task) killed=$killed stopped=$stopped $($notes -join '; ')"
  if ($stopped) { return [pscustomobject]@{ ok = $true; message = 'The TermPocket agent is stopped.' } }
  return [pscustomobject]@{ ok = $false; message = "The agent still answers on port $Port. $($notes -join ' ')".Trim() }
}

function Start-VSAgent {
  param([int]$Port, [string]$Launcher, [string]$TaskName, [string]$AgentBase, [string]$RepoRoot, [string]$AgentEntry, [string]$AgentLog)
  $h = Invoke-MonitorHttp -Url "$AgentBase/healthz" -TimeoutMs 2000
  if ($h.ok) { return [pscustomobject]@{ ok = $true; message = 'The agent is already running.' } }
  $how = $null
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; $how = 'scheduled task' } catch { Write-MonitorLog 'WARN' "Start-ScheduledTask: $($_.Exception.Message)" }
  }
  if (-not $how -and (Test-Path -LiteralPath $Launcher)) {
    $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
    Start-Process -FilePath $wscript -ArgumentList ('"{0}"' -f $Launcher) -WorkingDirectory $RepoRoot
    $how = 'launcher'
  }
  if (-not $how) {
    # The release bundle's own node\node.exe, else node on PATH (git checkout).
    $nodeExe = Join-Path $RepoRoot 'node\node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
      $node = (Get-Command node -ErrorAction SilentlyContinue)
      $nodeExe = if ($node) { $node.Source } else { $null }
    }
    if (-not $nodeExe) { return [pscustomobject]@{ ok = $false; message = 'Node.js was not found, and autostart is not installed. Run scripts\install-autostart.ps1.' } }
    $cmdArgs = '/d /c ""{0}" "{1}" >> "{2}" 2>&1"' -f $nodeExe, $AgentEntry, $AgentLog
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\cmd.exe') -ArgumentList $cmdArgs -WorkingDirectory $RepoRoot -WindowStyle Hidden
    $how = 'node'
  }
  $up = Wait-AgentState -HealthzUrl "$AgentBase/healthz" -Up $true -TimeoutSec 25
  Write-MonitorLog 'INFO' "start agent via ${how}: up=$up"
  if ($up) { return [pscustomobject]@{ ok = $true; message = "The TermPocket agent is running (started via $how)." } }
  return [pscustomobject]@{ ok = $false; message = "The agent did not answer within 25 s (started via $how). Open the log file to see why." }
}

function Restart-VSAgent {
  param([int]$Port, [string]$Launcher, [string]$TaskName, [string]$AgentBase, [string]$RepoRoot, [string]$AgentEntry, [string]$AgentLog)
  $s = Stop-VSAgent -Port $Port -Launcher $Launcher -TaskName $TaskName -AgentBase $AgentBase
  if (-not $s.ok) { return [pscustomobject]@{ ok = $false; message = "Restart failed: $($s.message)" } }
  Start-Sleep -Milliseconds 500
  $r = Start-VSAgent -Port $Port -Launcher $Launcher -TaskName $TaskName -AgentBase $AgentBase -RepoRoot $RepoRoot -AgentEntry $AgentEntry -AgentLog $AgentLog
  if ($r.ok) { return [pscustomobject]@{ ok = $true; message = 'The TermPocket agent was restarted.' } }
  return $r
}

function Format-SelfTestResult {
  param($Http)
  if ($Http.ok) {
    try { $res = $Http.body | ConvertFrom-Json } catch { return [pscustomobject]@{ ok = $false; text = 'The self-test returned an invalid answer.' } }
    $ok = [bool](Get-Prop $res 'ok' $false)
    $lines = New-Object System.Collections.Generic.List[string]
    if ($ok) { $lines.Add('All checks passed - your phone can reach this PC.') } else { $lines.Add('Some checks failed:') }
    $lines.Add('')
    foreach ($s in @(Get-Prop $res 'steps' @())) {
      if ($null -eq $s) { continue }
      if ([bool](Get-Prop $s 'ok' $false)) { $mark = '[ OK ]' } else { $mark = '[FAIL]' }
      $line = '{0} {1} ({2} ms)' -f $mark, (Get-Prop $s 'name' '?'), (Get-Prop $s 'ms' 0)
      $d = Get-Prop $s 'detail'
      if ($d) { $line += ' - ' + $d }
      $lines.Add($line)
    }
    return [pscustomobject]@{ ok = $ok; text = ($lines -join "`r`n") }
  }
  if ($Http.status -eq 404) { return [pscustomobject]@{ ok = $false; text = 'This agent version has no self-test. Use "Restart agent" to load the new version.' } }
  if ($Http.kind -eq 'refused') { return [pscustomobject]@{ ok = $false; text = 'The agent is not running.' } }
  return [pscustomobject]@{ ok = $false; text = "The self-test could not run: $($Http.error)" }
}

# ------------------------------------------------------------------------------------------------
# -Once test mode
# ------------------------------------------------------------------------------------------------
function Get-AgentBase {
  param([string]$StatusUrlOverride, [int]$AgentPort)
  if ($StatusUrlOverride) { return ($StatusUrlOverride -replace '/status/?$', '').TrimEnd('/') }
  return "http://127.0.0.1:$AgentPort"
}

function Invoke-Once {
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
  $cfg = Read-MonitorConfig -Dir $ConfigDir -PortOverride $Port -StatusUrlOverride $StatusUrl
  $su = $StatusUrl
  if (-not $su) { $su = "http://127.0.0.1:$($cfg.port)/status" }
  $checkPort = 0
  if (-not $StatusUrl) { $checkPort = $cfg.port }
  $poll = Get-PollResult -StatusUrl $su -HealthUrl $HealthUrl -ConfigPublicUrl $cfg.publicUrl -DoHealth (-not $NoHealth) -Port $checkPort
  $now = $NowMs
  if (-not $now) { $now = Get-NowMs }
  $state = Get-MonitorState -Poll $poll -Config $cfg -NowMs $now

  $prev = $null; $lastAlerts = @{}
  if ($StateFile) {
    try {
      $saved = Read-JsonFile $StateFile
      if ($saved) {
        $prev = Get-Prop $saved 'snapshot'
        $lastAlerts = ConvertTo-PlainHashtable (Get-Prop $saved 'lastAlerts')
      }
    } catch { Write-MonitorLog 'WARN' "state file unreadable: $($_.Exception.Message)" }
  }
  $res = Get-Alerts -Previous $prev -State $state -NowMs $now -LastAlerts $lastAlerts
  if ($StateFile) {
    try {
      $out = [pscustomobject]@{ snapshot = $res.snapshot; lastAlerts = [pscustomobject]$res.lastAlerts }
      [System.IO.File]::WriteAllText($StateFile, (ConvertTo-Json -InputObject $out -Depth 8), (New-Object System.Text.UTF8Encoding $false))
    } catch { Write-MonitorLog 'WARN' "state file not written: $($_.Exception.Message)" }
  }

  $result = [ordered]@{}
  foreach ($p in $state.PSObject.Properties) { $result[$p.Name] = $p.Value }
  $result.alerts = @($res.alerts)
  $result.snapshot = $res.snapshot
  $result.statusUrl = $su
  $result.healthUrl = $poll.healthUrl
  $result.statusError = $poll.statusError
  $result.configErrors = @($cfg.errors)
  if ($Json) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]$result) -Depth 8))
  } else {
    [Console]::Out.WriteLine(('{0}  {1}' -f $state.color.ToUpperInvariant(), $state.tooltip))
    foreach ($l in $state.menu) { [Console]::Out.WriteLine('  ' + $l) }
    foreach ($r in $state.reasons) { [Console]::Out.WriteLine('  - ' + $r) }
    foreach ($a in $res.alerts) { [Console]::Out.WriteLine(('  ALERT [{0}] {1}: {2}' -f $a.level, $a.title, $a.text)) }
  }
  switch ($state.color) { 'green' { return 0 } 'amber' { return 1 } default { return 2 } }
}

if ($ProcessTargetsTest) {
  $spec = Read-JsonFile $ProcessTargetsTest
  $t = Select-AgentProcesses -Processes @(Get-Prop $spec 'processes' @()) -PortOwners @(Get-Prop $spec 'owners' @()) -Launcher (Get-Prop $spec 'launcher' '')
  $out = [pscustomobject]@{
    launchers = [long[]]@($t.launchers | ForEach-Object { $_.ProcessId })
    tree = [long[]]@($t.tree | ForEach-Object { $_.ProcessId })
    portAgents = [long[]]@($t.portAgents | ForEach-Object { $_.ProcessId })
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Depth 4 -Compress))
  exit 0
}

if ($Once) {
  $code = Invoke-Once
  exit $code
}

# ================================================================================================
# Tray application
# ================================================================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-StatusIcon {
  param([System.Drawing.Color]$DotColor, [int]$Size = 32)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)
    # rounded square
    $rad = [float]($Size * 0.25); $d = $rad * 2; $w = [float]($Size - 1)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($w - $d, 0, $d, $d, 270, 90)
    $path.AddArc($w - $d, $w - $d, $d, $d, 0, 90)
    $path.AddArc(0, $w - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    # TermPocket brand: dark ink square, mint ">_" (same palette as the app icon)
    $bgColor = [System.Drawing.Color]::FromArgb(255, 18, 28, 38)
    $bg = New-Object System.Drawing.SolidBrush $bgColor
    $g.FillPath($bg, $path)
    # ">_" drawn as strokes (stays crisp at 16 px)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 110, 240, 194)), ([float][Math]::Max(1.6, $Size * 0.11))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $u = [float]$Size
    $chev = [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF(($u * 0.18), ($u * 0.20))),
      (New-Object System.Drawing.PointF(($u * 0.38), ($u * 0.35))),
      (New-Object System.Drawing.PointF(($u * 0.18), ($u * 0.50))))
    $g.DrawLines($pen, $chev)
    $g.DrawLine($pen, ($u * 0.18), ($u * 0.72), ($u * 0.40), ($u * 0.72))
    # status dot (bottom right) with a white ring
    $dd = [float]($Size * 0.50); $x = [float]($Size - $dd - 0.5); $y = [float]($Size - $dd - 0.5)
    $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillEllipse($ring, $x, $y, $dd, $dd)
    $inset = [float][Math]::Max(1.2, $Size * 0.07)
    $dot = New-Object System.Drawing.SolidBrush $DotColor
    $g.FillEllipse($dot, $x + $inset, $y + $inset, $dd - 2 * $inset, $dd - 2 * $inset)
    $bg.Dispose(); $pen.Dispose(); $ring.Dispose(); $dot.Dispose(); $path.Dispose()
  } finally { $g.Dispose() }
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  return [pscustomobject]@{ icon = $icon; bitmap = $bmp }
}

$script:IconColors = @{
  green = [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
  amber = [System.Drawing.Color]::FromArgb(255, 245, 158, 11)
  red   = [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
  gray  = [System.Drawing.Color]::FromArgb(255, 156, 163, 175)
}

if ($SaveIconsTo) {
  [void][System.IO.Directory]::CreateDirectory($SaveIconsTo)
  foreach ($k in $script:IconColors.Keys) {
    foreach ($sz in 16, 32, 64) {
      $ic = New-StatusIcon -DotColor $script:IconColors[$k] -Size $sz
      $ic.bitmap.Save((Join-Path $SaveIconsTo "monitor-$k-$sz.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    }
  }
  [Console]::Out.WriteLine("icons written to $SaveIconsTo")
  exit 0
}

$script:Smoke = $SmokeSeconds -gt 0
if ($script:Smoke) { try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { } }
function Write-Smoke([string]$Text) { if ($script:Smoke) { try { [Console]::Out.WriteLine($Text) } catch { } } }

# --- single instance ----------------------------------------------------------------------------
$mutexName = 'Local\TermPocket.Monitor'
$exitEventName = 'Local\TermPocket.Monitor.Exit'
if ($script:Smoke) { $mutexName += ".smoke.$PID"; $exitEventName += ".smoke.$PID" }
$createdNew = $false
try {
  $script:Mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
} catch {
  Write-MonitorLog 'ERROR' "cannot create the single-instance mutex: $($_.Exception.Message)"
  exit 0
}
if (-not $createdNew) {
  Write-MonitorLog 'INFO' 'another TermPocket Monitor is already running; exiting'
  exit 0
}
# Lets install/uninstall-autostart.ps1 ask a running monitor to quit cleanly (no ghost tray icon).
$script:ExitEvent = $null
try { $script:ExitEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $exitEventName) } catch { }

Write-MonitorLog 'INFO' "monitor $MonitorVersion started (pid $PID, config $ConfigDir)"

# --- background runspace pool (HTTP + agent control never block the UI thread) ------------------
$iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2()
foreach ($fn in 'Write-MonitorLog', 'Get-Prop', 'Get-NowMs', 'Get-HostOfUrl', 'Get-HealthUrlFromPublic', 'Invoke-MonitorHttp',
  'Test-PortListening', 'Get-PollResult', 'Select-AgentProcesses', 'Get-AgentProcessTargets', 'Wait-AgentState', 'Stop-VSAgent', 'Start-VSAgent', 'Restart-VSAgent') {
  $def = (Get-Item "function:$fn").Definition
  $iss.Commands.Add((New-Object System.Management.Automation.Runspaces.SessionStateFunctionEntry($fn, $def)))
}
$iss.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry('MonitorLogFile', $MonitorLogFile, '')))
$script:Pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, 3, $iss, $Host)
$script:Pool.ApartmentState = [System.Threading.ApartmentState]::MTA
$script:Pool.Open()
$script:Jobs = New-Object System.Collections.ArrayList

function Start-BgJob {
  param([string]$Name, [string]$Code, [object[]]$Arguments, [scriptblock]$OnDone)
  $ps = [PowerShell]::Create()
  $ps.RunspacePool = $script:Pool
  [void]$ps.AddScript($Code)
  foreach ($a in $Arguments) { [void]$ps.AddArgument($a) }
  $handle = $ps.BeginInvoke()
  [void]$script:Jobs.Add([pscustomobject]@{ name = $Name; ps = $ps; handle = $handle; onDone = $OnDone; started = Get-Date })
}

function Invoke-JobPump {
  foreach ($j in @($script:Jobs)) {
    # A handler may show a modal dialog; its message loop keeps ticking and can pump (and dispose) jobs
    # of this same snapshot. Handle each job exactly once.
    if (-not $script:Jobs.Contains($j)) { continue }
    if (-not $j.handle.IsCompleted) { continue }
    $script:Jobs.Remove($j)
    $out = $null; $err = $null
    try { $out = $j.ps.EndInvoke($j.handle) } catch { $err = $_.Exception.Message }
    try {
      if ($j.ps.Streams.Error.Count -gt 0) { $err = (@($j.ps.Streams.Error) | ForEach-Object { $_.ToString() }) -join '; ' }
    } catch { }
    try { $j.ps.Dispose() } catch { }
    if ($err) { Write-MonitorLog 'WARN' "job $($j.name): $err" }
    $result = $null
    if ($out -and $out.Count -gt 0) { $result = $out[$out.Count - 1] }
    try { & $j.onDone $result $err } catch { Write-MonitorLog 'ERROR' "job $($j.name) handler: $($_.Exception.Message)" }
  }
}

# --- UI state -----------------------------------------------------------------------------------
$script:Config = Read-MonitorConfig -Dir $ConfigDir -PortOverride $Port -StatusUrlOverride $StatusUrl
$script:AgentBase = Get-AgentBase -StatusUrlOverride $StatusUrl -AgentPort $script:Config.port
$script:State = $null
$script:Snapshot = $null
$script:LastAlerts = @{}
$script:SuppressAgentUntil = 0
$script:PollRunning = $false
$script:NextPollAt = [DateTime]::MinValue
$script:NextHealthAt = [DateTime]::MinValue
$script:LastHealth = $null
$script:DownCount = 0
$script:ActionRunning = $false
$script:SelfTestRunning = $false
$script:LastOpenAt = [DateTime]::MinValue
$script:CurrentColor = $null
$script:Exiting = $false

$script:Icons = @{}
foreach ($k in $script:IconColors.Keys) { $script:Icons[$k] = (New-StatusIcon -DotColor $script:IconColors[$k] -Size 32).icon }

function Invoke-Safe {
  param([string]$What, [scriptblock]$Action)
  try { & $Action } catch { Write-MonitorLog 'ERROR' "${What}: $($_.Exception.Message)" }
}

function Show-Message {
  param([string]$Text, [string]$Title = 'TermPocket Monitor', [string]$Kind = 'Information')
  if ($script:Smoke) { Write-Smoke "MESSAGE [$Kind] ${Title}: $($Text -replace "`r?`n", ' | ')"; return }
  $owner = New-Object System.Windows.Forms.Form
  try {
    $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'
    $owner.StartPosition = 'Manual'; $owner.Location = New-Object System.Drawing.Point(-3000, -3000); $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Show(); $owner.Activate()
    [void][System.Windows.Forms.MessageBox]::Show($owner, $Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]$Kind)
  } finally { $owner.Close(); $owner.Dispose() }
}

function Confirm-Action {
  param([string]$Text)
  if ($script:Smoke) { return $false }
  $owner = New-Object System.Windows.Forms.Form
  try {
    $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'
    $owner.StartPosition = 'Manual'; $owner.Location = New-Object System.Drawing.Point(-3000, -3000); $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Show(); $owner.Activate()
    $r = [System.Windows.Forms.MessageBox]::Show($owner, $Text, 'TermPocket Monitor', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
  } finally { $owner.Close(); $owner.Dispose() }
}

function Show-Balloon {
  param([string]$Title, [string]$Text, [string]$Level = 'info')
  $Text = Get-TextLimited $Text 250
  $Title = Get-TextLimited $Title 60
  Write-MonitorLog 'INFO' "notify [$Level] ${Title}: $Text"
  if ($script:Smoke) { Write-Smoke "ALERT [$Level] ${Title}: $Text"; return }
  switch ($Level) { 'error' { $ic = [System.Windows.Forms.ToolTipIcon]::Error } 'warning' { $ic = [System.Windows.Forms.ToolTipIcon]::Warning } default { $ic = [System.Windows.Forms.ToolTipIcon]::Info } }
  try { $script:Tray.ShowBalloonTip(10000, $Title, $Text, $ic) } catch { Write-MonitorLog 'WARN' "balloon: $($_.Exception.Message)" }
}

function Show-Alerts {
  param([object[]]$Alerts)
  $list = @($Alerts | Where-Object { $null -ne $_ })
  if ($list.Count -eq 0) { return }
  $level = 'info'
  if (@($list | Where-Object { $_.level -eq 'warning' }).Count) { $level = 'warning' }
  if (@($list | Where-Object { $_.level -eq 'error' }).Count) { $level = 'error' }
  if ($list.Count -eq 1) { Show-Balloon -Title $list[0].title -Text $list[0].text -Level $level; return }
  $title = @($list | Where-Object { $_.level -eq $level })[0].title
  Show-Balloon -Title $title -Text (($list | ForEach-Object { $_.text }) -join "`n") -Level $level
}

function Find-AppBrowser {
  foreach ($exe in 'msedge.exe', 'chrome.exe') {
    foreach ($root in 'HKCU:', 'HKLM:', 'HKLM:\SOFTWARE\WOW6432Node') {
      $key = if ($root -like 'HKLM:\SOFTWARE*') { "$root\Microsoft\Windows\CurrentVersion\App Paths\$exe" } else { "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" }
      try {
        $v = (Get-Item -LiteralPath $key -ErrorAction Stop).GetValue('')
        if ($v) { $v = ([string]$v).Trim('"'); if (Test-Path -LiteralPath $v) { return $v } }
      } catch { }
    }
  }
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

function Open-Url([string]$Url) {
  if ($script:Smoke) { Write-Smoke "OPEN $Url"; return }
  Start-Process -FilePath $Url
}

function Open-MonitorWindow {
  if (((Get-Date) - $script:LastOpenAt).TotalMilliseconds -lt 1500) { return }
  $script:LastOpenAt = Get-Date
  if ($script:State -and -not $script:State.agentUp) {
    # The dashboard is served by the agent itself.
    Show-Balloon -Title 'TermPocket agent is not running' -Text 'Right-click this icon and choose "Start agent" (or "Open log file" to see why it stopped).' -Level 'warning'
    return
  }
  $url = "$($script:AgentBase)/monitor"
  if ($script:Smoke) { Write-Smoke "OPEN-APP $url"; return }
  $browser = Find-AppBrowser
  if ($browser) {
    try { Start-Process -FilePath $browser -ArgumentList @("--app=$url", '--window-size=1180,860'); return }
    catch { Write-MonitorLog 'WARN' "app window: $($_.Exception.Message)" }
  }
  Start-Process -FilePath $url
}

function Start-Poll {
  if ($script:PollRunning -or $script:Exiting) { return }
  $script:PollRunning = $true
  try { $script:Config = Read-MonitorConfig -Dir $ConfigDir -PortOverride $Port -StatusUrlOverride $StatusUrl } catch { }
  $script:AgentBase = Get-AgentBase -StatusUrlOverride $StatusUrl -AgentPort $script:Config.port
  $doHealth = (-not $NoHealth) -and ((Get-Date) -ge $script:NextHealthAt)
  $checkPort = 0
  if (-not $StatusUrl) { $checkPort = $script:Config.port }
  $code = 'param($su, $hu, $pub, $dh, $pt) Get-PollResult -StatusUrl $su -HealthUrl $hu -ConfigPublicUrl $pub -DoHealth $dh -Port $pt'
  Start-BgJob -Name 'poll' -Code $code -Arguments @("$($script:AgentBase)/status", $HealthUrl, $script:Config.publicUrl, [bool]$doHealth, $checkPort) -OnDone {
    param($poll, $err)
    Complete-Poll $poll
  }
}

function Complete-Poll {
  param($Poll)
  $script:PollRunning = $false
  $script:NextPollAt = (Get-Date).AddMilliseconds($PollIntervalMs)
  if ($null -eq $Poll) { return }

  if ($Poll.healthChecked) {
    $script:LastHealth = $Poll
    if ($Poll.healthOk) { $script:NextHealthAt = (Get-Date).AddMilliseconds($HealthOkMs) } else { $script:NextHealthAt = (Get-Date).AddMilliseconds($HealthFailMs) }
  } elseif ($script:LastHealth) {
    # carry the last public result forward between checks (for the color / menu)
    $Poll.healthChecked = $true
    $Poll.healthOk = $script:LastHealth.healthOk
    $Poll.healthError = $script:LastHealth.healthError
    $Poll.pcOnline = $script:LastHealth.pcOnline
  }

  # One failed sample is not enough to call the agent down (a busy agent or a slow restart).
  $up = [bool]($Poll.statusOk -or $Poll.healthzOnly)
  if (-not $up) {
    $script:DownCount++
    if ($script:State -and $script:State.agentUp -and $script:DownCount -lt 2) {
      $script:NextPollAt = (Get-Date).AddMilliseconds(1500)
      return
    }
  } else { $script:DownCount = 0 }

  $now = Get-NowMs
  $state = Get-MonitorState -Poll $Poll -Config $script:Config -NowMs $now
  $res = Get-Alerts -Previous $script:Snapshot -State $state -NowMs $now -LastAlerts $script:LastAlerts -SuppressAgentUntil $script:SuppressAgentUntil
  $script:Snapshot = $res.snapshot
  $script:LastAlerts = $res.lastAlerts
  if ($state.color -ne $script:CurrentColor) {
    Write-MonitorLog 'INFO' ("state {0} -> {1}: {2}" -f $script:CurrentColor, $state.color, ((@($state.reasons) -join '; ')))
    Write-Smoke ("STATE {0} | {1} | {2}" -f $state.color, $state.tooltip, ($state.menu -join ' / '))
  }
  $script:State = $state
  Update-TrayUi
  Show-Alerts -Alerts $res.alerts
}

function Update-TrayUi {
  $s = $script:State
  if ($null -eq $s) {
    $script:Tray.Icon = $script:Icons.gray
    $script:Tray.Text = 'TermPocket: checking...'
    $lines = @('Agent: checking...', 'Public: checking...', 'Phones: -', 'VS Code windows: -', 'Terminals host: -')
  } else {
    if ($s.color -ne $script:CurrentColor) {
      $script:Tray.Icon = $script:Icons[$s.color]
      $script:CurrentColor = $s.color
    }
    $script:Tray.Text = Get-TextLimited $s.tooltip 63
    $lines = @($s.menu)
  }
  for ($i = 0; $i -lt $script:StatusItems.Count; $i++) {
    if ($i -lt $lines.Count) { $script:StatusItems[$i].Text = $lines[$i] }
  }
  $up = ($null -ne $s) -and $s.agentUp
  $busy = $script:ActionRunning
  $script:MiSelfTest.Enabled = $up -and -not $script:SelfTestRunning
  $script:MiRestart.Enabled = -not $busy
  $script:MiStop.Enabled = $up -and -not $busy
  $script:MiStart.Enabled = -not $up -and -not $busy
  $script:MiOpenMonitor.Enabled = $up
  $pub = $null
  if ($s) { $pub = $s.publicUrl } else { $pub = $script:Config.publicUrl }
  $script:MiPhoneLink.Enabled = [bool]$pub
  $logExists = $false
  try { $logExists = [System.IO.File]::Exists($AgentLogFile) } catch { }
  $script:MiLog.Enabled = $logExists
}

function Start-AgentAction {
  param([string]$Verb)
  if ($script:ActionRunning) { return }
  if ($script:Smoke) { Write-Smoke "ACTION $Verb refused in smoke mode"; return }
  $script:ActionRunning = $true
  $script:SuppressAgentUntil = (Get-NowMs) + 60000
  Update-TrayUi
  $fn = @{ restart = 'Restart-VSAgent'; stop = 'Stop-VSAgent'; start = 'Start-VSAgent' }[$Verb]
  $label = @{ restart = 'Restarting'; stop = 'Stopping'; start = 'Starting' }[$Verb]
  Show-Balloon -Title 'TermPocket Monitor' -Text "$label the agent..." -Level 'info'
  if ($Verb -eq 'stop') {
    $code = 'param($pt, $l, $tn, $ab) Stop-VSAgent -Port $pt -Launcher $l -TaskName $tn -AgentBase $ab'
    $jobArgs = @($script:Config.port, $AgentLauncher, $AgentTaskName, $script:AgentBase)
  } else {
    $code = "param(`$pt, `$l, `$tn, `$ab, `$rr, `$ae, `$al) $fn -Port `$pt -Launcher `$l -TaskName `$tn -AgentBase `$ab -RepoRoot `$rr -AgentEntry `$ae -AgentLog `$al"
    $jobArgs = @($script:Config.port, $AgentLauncher, $AgentTaskName, $script:AgentBase, $RepoRoot, $AgentEntry, $AgentLogFile)
  }
  Start-BgJob -Name $Verb -Code $code -Arguments $jobArgs -OnDone {
    param($r, $err)
    $script:ActionRunning = $false
    $script:SuppressAgentUntil = (Get-NowMs) + 10000
    $script:NextPollAt = Get-Date
    $script:DownCount = 2
    if ($null -eq $r) { Show-Balloon -Title 'TermPocket Monitor' -Text "Action failed: $err" -Level 'error' }
    elseif ($r.ok) { Show-Balloon -Title 'TermPocket Monitor' -Text $r.message -Level 'info' }
    else { Show-Balloon -Title 'TermPocket Monitor' -Text $r.message -Level 'warning' }
    Update-TrayUi
  }
}

function Start-SelfTest {
  if ($script:SelfTestRunning) { return }
  $script:SelfTestRunning = $true
  Update-TrayUi
  if (-not $script:Smoke) { Show-Balloon -Title 'TermPocket Monitor' -Text 'Running the self-test (up to 15 s)...' -Level 'info' }
  $code = 'param($u) Invoke-MonitorHttp -Url $u -Method POST -TimeoutMs 20000 -Headers @{ "X-TermPocket-Monitor" = "1" }'
  Start-BgJob -Name 'selftest' -Code $code -Arguments @("$($script:AgentBase)/status/selftest") -OnDone {
    param($http, $err)
    $script:SelfTestRunning = $false
    Update-TrayUi
    if ($null -eq $http) { Show-Message -Text "The self-test could not run: $err" -Kind 'Warning'; return }
    $f = Format-SelfTestResult $http
    Write-MonitorLog 'INFO' ("self-test ok={0}: {1}" -f $f.ok, ($f.text -replace "`r?`n", ' | '))
    if ($f.ok) { $kind = 'Information' } else { $kind = 'Warning' }
    Show-Message -Text $f.text -Title 'TermPocket self-test' -Kind $kind
  }
}

function Exit-Monitor {
  if ($script:Exiting) { return }
  $script:Exiting = $true
  Write-MonitorLog 'INFO' 'monitor exiting'
  try { $script:Timer.Stop() } catch { }
  try { $script:Tray.Visible = $false; $script:Tray.Dispose() } catch { }
  try { $script:AppContext.ExitThread() } catch { }
}

# --- build the tray icon and menu ----------------------------------------------------------------
[System.Windows.Forms.Application]::EnableVisualStyles()
try { [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException) } catch { }
[System.Windows.Forms.Application]::add_ThreadException({
  param($sender, $e)
  Write-MonitorLog 'ERROR' "UI exception: $($e.Exception.Message)"
})

$script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:Menu.ShowImageMargin = $false
$script:StatusItems = @()
for ($i = 0; $i -lt 5; $i++) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem
  $it.Enabled = $false
  [void]$script:Menu.Items.Add($it)
  $script:StatusItems += $it
}
function New-MenuItem([string]$Text, [scriptblock]$OnClick) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem $Text
  $it.add_Click($OnClick)
  [void]$script:Menu.Items.Add($it)
  return $it
}
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:MiOpenMonitor = New-MenuItem 'Open Monitor' { Invoke-Safe 'open monitor' { $script:LastOpenAt = [DateTime]::MinValue; Open-MonitorWindow } }
$script:MiOpenMonitor.Font = New-Object System.Drawing.Font($script:MiOpenMonitor.Font, [System.Drawing.FontStyle]::Bold)
$script:MiSelfTest = New-MenuItem 'Run self-test' { Invoke-Safe 'self-test' { Start-SelfTest } }
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:MiRestart = New-MenuItem 'Restart agent' { Invoke-Safe 'restart agent' { Start-AgentAction 'restart' } }
$script:MiStop = New-MenuItem 'Stop agent' {
  Invoke-Safe 'stop agent' {
    if (Confirm-Action "Stop the TermPocket agent?`n`nYour phone and VS Code lose the connection until you start it again. Terminals keep running (they live in the terminals host).") { Start-AgentAction 'stop' }
  }
}
$script:MiStart = New-MenuItem 'Start agent' { Invoke-Safe 'start agent' { Start-AgentAction 'start' } }
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:MiLog = New-MenuItem 'Open log file' {
  Invoke-Safe 'open log' {
    if ($script:Smoke) { Write-Smoke "OPEN $AgentLogFile"; return }
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\notepad.exe') -ArgumentList ('"{0}"' -f $AgentLogFile)
  }
}
$script:MiPair = New-MenuItem 'Open pairing page' { Invoke-Safe 'open pairing page' { Open-Url "$($script:AgentBase)/pair" } }
$script:MiPhoneLink = New-MenuItem 'Open phone link' {
  Invoke-Safe 'open phone link' {
    $u = $null
    if ($script:State) { $u = $script:State.publicUrl }
    if (-not $u) { $u = $script:Config.publicUrl }
    if ($u -and $u -match '^https?://') { Open-Url $u }
  }
}
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$script:MiExit = New-MenuItem 'Exit monitor' { Invoke-Safe 'exit' { Exit-Monitor } }
$script:Menu.add_Opening({ Invoke-Safe 'menu opening' { Update-TrayUi } })

$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$script:Tray.ContextMenuStrip = $script:Menu
$script:Tray.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-Safe 'click' { Open-MonitorWindow } }
})
$script:Tray.add_DoubleClick({ Invoke-Safe 'double-click' { Open-MonitorWindow } })
$script:Tray.add_BalloonTipClicked({ Invoke-Safe 'balloon click' { $script:LastOpenAt = [DateTime]::MinValue; Open-MonitorWindow } })
Update-TrayUi
$script:Tray.Visible = -not $script:Smoke

# --- main timer (UI thread) ----------------------------------------------------------------------
$script:StartedAt = Get-Date
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 250
$script:Timer.add_Tick({
  Invoke-Safe 'tick' {
    Invoke-JobPump
    if ($script:ExitEvent -and $script:ExitEvent.WaitOne(0)) { Exit-Monitor; return }
    if ($script:Smoke -and ((Get-Date) - $script:StartedAt).TotalSeconds -ge $SmokeSeconds) { Exit-Monitor; return }
    if (-not $script:PollRunning -and (Get-Date) -ge $script:NextPollAt) { Start-Poll }
  }
})
$script:Timer.Start()

if ($script:Smoke) {
  # Exercise the safe menu paths once the first poll has landed.
  $script:SmokeTimer = New-Object System.Windows.Forms.Timer
  $script:SmokeTimer.Interval = 2500
  $script:SmokeTimer.add_Tick({
    Invoke-Safe 'smoke' {
      $script:SmokeTimer.Stop()
      Update-TrayUi
      Write-Smoke ("MENU " + (($script:Menu.Items | ForEach-Object { if ($_ -is [System.Windows.Forms.ToolStripSeparator]) { '---' } else { "$($_.Text)$(if (-not $_.Enabled) { '(off)' })" } }) -join ' | '))
      $script:MiOpenMonitor.PerformClick()
      $script:MiPair.PerformClick()
      $script:MiPhoneLink.PerformClick()
      $script:MiSelfTest.PerformClick()
      $script:MiRestart.PerformClick()
    }
  })
  $script:SmokeTimer.Start()
}

$script:AppContext = New-Object System.Windows.Forms.ApplicationContext
try {
  [System.Windows.Forms.Application]::Run($script:AppContext)
} catch {
  Write-MonitorLog 'ERROR' "message loop: $($_.Exception.Message)"
} finally {
  try { $script:Tray.Visible = $false; $script:Tray.Dispose() } catch { }
  foreach ($j in @($script:Jobs)) { try { $j.ps.Stop(); $j.ps.Dispose() } catch { } }
  try { $script:Pool.Close(); $script:Pool.Dispose() } catch { }
  try { $script:Mutex.ReleaseMutex() } catch { }
  try { $script:Mutex.Dispose() } catch { }
}
exit 0
