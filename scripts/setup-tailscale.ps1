<#
.SYNOPSIS
  Exposes the TermPocket agent to your phone over Tailscale with a real HTTPS certificate.

.DESCRIPTION
  Runs `tailscale serve --bg <port>` so the agent (listening on 127.0.0.1:<port>) becomes reachable
  at https://<pc-name>.<tailnet>.ts.net from devices on your tailnet only, then prints
  `tailscale serve status`. HTTPS is what lets the phone install the app (PWA) and use its
  service worker.

.PARAMETER Port
  Agent port (default: "port" from %APPDATA%\TermPocket\config.json, else 8765).
  (TERMPOCKET_HOME, if set, names another folder.)

.PARAMETER Off
  Remove the serve configuration again (`tailscale serve --https=443 off`).
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$Off
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# --- find tailscale.exe -------------------------------------------------------------------------
$ts = $null
$cmd = Get-Command tailscale -ErrorAction SilentlyContinue
if ($cmd) { $ts = $cmd.Source }
if (-not $ts) {
  foreach ($candidate in @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $ts = $candidate; break }
  }
}
if (-not $ts) {
  Write-Host 'Tailscale is not installed.' -ForegroundColor Yellow
  Write-Host '  1. Install it on this PC:     https://tailscale.com/download/windows'
  Write-Host '  2. Install it on your phone:  Google Play -> "Tailscale"'
  Write-Host '  3. Log in with the same account on both, then run this script again.'
  exit 1
}

# --- port ---------------------------------------------------------------------------------------
if ($Port -le 0) {
  $Port = 8765
  $cfgDir = if ($env:TERMPOCKET_HOME) { $env:TERMPOCKET_HOME } else { Join-Path $env:APPDATA 'TermPocket' }
  $cfgPath = Join-Path $cfgDir 'config.json'
  if (-not (Test-Path -LiteralPath $cfgPath) -and -not $env:TERMPOCKET_HOME) {
    $cfgPath = Join-Path $env:APPDATA 'VSControl\config.json' # before the rename from VS Control
  }
  if (Test-Path -LiteralPath $cfgPath) {
    try {
      $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
      if ($cfg.port) { $Port = [int]$cfg.port }
    } catch { }
  }
}

# --- tailscale must be connected ----------------------------------------------------------------
# Windows PowerShell 5.1 turns redirected native stderr into a terminating error under
# ErrorActionPreference=Stop, so relax it just for this probe and judge by the exit code only
# (tailscale prints "failed to connect to local Tailscale service" / version warnings on stderr).
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $ts status *> $null
  $tsStatusExit = $LASTEXITCODE
} catch {
  $tsStatusExit = 1
} finally {
  $ErrorActionPreference = $prevEap
}
if ($tsStatusExit -ne 0) {
  Write-Host 'Tailscale is installed but not connected. Open the Tailscale app (tray icon) and log in,' -ForegroundColor Yellow
  Write-Host "or run:  `"$ts`" up"
  exit 1
}

if ($Off) {
  Write-Step 'Removing the tailscale serve configuration'
  & $ts serve --https=443 off
  & $ts serve status
  exit $LASTEXITCODE
}

# --- serve --------------------------------------------------------------------------------------
Write-Step "Running: tailscale serve --bg $Port"
Write-Host '(If Tailscale prints a link asking you to enable Serve/HTTPS for your tailnet, open it, approve, and wait.)'
& $ts serve --bg $Port
$serveExit = $LASTEXITCODE
if ($serveExit -ne 0) {
  Write-Host ''
  Write-Host "tailscale serve failed (exit code $serveExit)." -ForegroundColor Red
  Write-Host 'Tailscale Serve needs MagicDNS and HTTPS certificates enabled for your tailnet:'
  Write-Host '  1. Open https://login.tailscale.com/admin/dns'
  Write-Host '  2. Under "DNS", make sure MagicDNS is enabled.'
  Write-Host '  3. Under "HTTPS Certificates", click "Enable HTTPS".'
  Write-Host '  4. Run this script again.'
  Write-Host 'Alternative without HTTPS: set "host": "0.0.0.0" in config.json, restart the agent and open'
  Write-Host "http://<this PC's 100.x.y.z Tailscale IP>:$Port on the phone (the app will not be installable)."
  exit $serveExit
}

Write-Host ''
Write-Step 'tailscale serve status'
& $ts serve status

$dnsName = $null
try {
  $status = (& $ts status --json) -join "`n" | ConvertFrom-Json
  if ($status.Self -and $status.Self.DNSName) { $dnsName = $status.Self.DNSName.TrimEnd('.') }
} catch { }

Write-Host ''
if ($dnsName) {
  Write-Host "Done. On your phone (with Tailscale connected) open:  https://$dnsName" -ForegroundColor Green
} else {
  Write-Host 'Done. On your phone (with Tailscale connected) open the https://... URL shown above.' -ForegroundColor Green
}
Write-Host 'Restart the agent so its pairing QR code uses this HTTPS address, then open'
Write-Host "http://127.0.0.1:$Port/pair on this PC and scan the code with your phone."
