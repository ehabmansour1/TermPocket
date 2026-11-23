<#
.SYNOPSIS
  Smoke test of install.ps1 / uninstall.ps1 against a locally built release zip. No network, no
  scheduled tasks, no registry entry, no VS Code, no browser, nothing in %APPDATA%\TermPocket.

.DESCRIPTION
  1. A zip whose SHA256SUMS.txt does not match is refused (nothing installed).
  2. install.ps1 -ZipPath <zip> -InstallDir <temp> -NoAutostart -NoExtension -NoOpen -NoUninstallEntry
     and the installed files are checked (agent, node-pty prebuild, web\vendor, scripts, relay, vsix).
  3. The installed install-autostart.ps1 -DryRun resolves the right node.exe (bundled or -NodePath).
  4. The installed agent is started (temp TERMPOCKET_HOME, free port, dry-run input, its own PTY host
     pipe) and /healthz, /, /vendor/xterm.js and /pair answer.
  5. install.ps1 again over the running install (upgrade): the agent of that folder is stopped, files are
     replaced, and the agent starts again.
  6. uninstall.ps1 -Purge stops the agent and its terminals host, removes the folder and the temp home.

.PARAMETER ZipPath
  The zip to test (default: the newest dist\TermPocket-*-win-x64.zip).

.PARAMETER NodePath
  node.exe for the installed agent when the bundle has none (default: node on PATH).

.PARAMETER KeepTemp
  Keep the temp folder (install dir, home, logs) for inspection.
#>
[CmdletBinding()]
param(
  [string]$ZipPath = '',
  [string]$NodePath = '',
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
$PS = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$results = New-Object System.Collections.Generic.List[string]
$failed = 0
function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Pass([string]$Name) { $script:results.Add("PASS  $Name"); Write-Host "  PASS  $Name" -ForegroundColor Green }
function Fail([string]$Name, [string]$Why) { $script:failed++; $script:results.Add("FAIL  $Name - $Why"); Write-Host "  FAIL  $Name - $Why" -ForegroundColor Red }
function Check([string]$Name, [bool]$Ok, [string]$Why = '') { if ($Ok) { Pass $Name } else { Fail $Name $Why } }

if (-not $ZipPath) {
  $z = Get-ChildItem -LiteralPath (Join-Path $Root 'dist') -Filter 'TermPocket-*-win-x64.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $z) { throw 'No dist\TermPocket-*-win-x64.zip: run scripts\release\build-bundle.ps1 first.' }
  $ZipPath = $z.FullName
}
$ZipPath = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
$InstallScript = Join-Path $Root 'scripts\install.ps1'

# Does the bundle bring node\node.exe (release builds) or is this a test build (use -NodePath / PATH)?
Add-Type -AssemblyName System.IO.Compression.FileSystem
$za = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try { $ZipHasNode = [bool]($za.Entries | Where-Object { $_.FullName -eq 'node/node.exe' } | Select-Object -First 1) } finally { $za.Dispose() }
$ExtNode = $null
if (-not $ZipHasNode) {
  $ExtNode = if ($NodePath) { (Resolve-Path -LiteralPath $NodePath).ProviderPath } else { (Get-Command node -ErrorAction Stop).Source }
  Write-Host "Test build without node\node.exe: using $ExtNode"
}

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("termpocket-install-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$InstallDir = Join-Path $Temp 'Programs\TermPocket'
$HomeDir = Join-Path $Temp 'home'
New-Item -ItemType Directory -Force -Path $Temp, $HomeDir | Out-Null

# The agent under test: temp home, free port, dry-run input, its own PTY host pipe. Never the user's.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start(); $Port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
foreach ($k in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'VSCONTROL_*' -or $_.Name -like 'TERMPOCKET_*' })) { Remove-Item -LiteralPath "Env:$($k.Name)" }
$env:TERMPOCKET_HOME = $HomeDir
$env:TERMPOCKET_PORT = "$Port"
$env:TERMPOCKET_HOST = '127.0.0.1'
$env:TERMPOCKET_DRYRUN_INPUT = '1'
$env:TERMPOCKET_PTYHOST_PIPE = "\\.\pipe\termpocket-ptyhost-installtest-$PID-$Port"
$Base = "http://127.0.0.1:$Port"

$agentProc = $null
function Get-Http([string]$Path) {
  try { return Invoke-WebRequest -Uri "$Base$Path" -UseBasicParsing -TimeoutSec 5 } catch { return $null }
}
function Start-InstalledAgent([string]$Node, [string]$Tag) {
  $entry = Join-Path $InstallDir 'agent\src\index.js'
  $p = Start-Process -FilePath $Node -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory (Join-Path $InstallDir 'agent') -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Temp "agent-$Tag.out.log") -RedirectStandardError (Join-Path $Temp "agent-$Tag.err.log")
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { throw "the installed agent exited early ($($p.ExitCode)): $(Get-Content -Raw -LiteralPath (Join-Path $Temp "agent-$Tag.err.log"))" }
    $h = Get-Http '/healthz'
    if ($h -and $h.StatusCode -eq 200) { return $p }
    Start-Sleep -Milliseconds 300
  }
  throw 'the installed agent did not answer /healthz within 30 s'
}
function Invoke-Script([string]$File, [string[]]$Arguments) {
  $ErrorActionPreference = 'Continue' # the child's stderr must not become a terminating error here
  $out = & $PS -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $File @Arguments 2>&1 | Out-String
  return [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
}

try {
  # --- 1. checksum mismatch is refused ----------------------------------------------------------
  Write-Step 'Tampered SHA256SUMS.txt is refused'
  $bad = Join-Path $Temp 'bad'
  New-Item -ItemType Directory -Force -Path $bad | Out-Null
  $badZip = Join-Path $bad (Split-Path -Leaf $ZipPath)
  Copy-Item -LiteralPath $ZipPath -Destination $badZip
  Set-Content -LiteralPath (Join-Path $bad 'SHA256SUMS.txt') -Value ('{0}  {1}' -f ('0' * 64), (Split-Path -Leaf $ZipPath)) -Encoding Ascii
  $badDir = Join-Path $Temp 'bad-install'
  $r = Invoke-Script $InstallScript @('-ZipPath', $badZip, '-InstallDir', $badDir, '-NoAutostart', '-NoExtension', '-NoOpen', '-NoUninstallEntry')
  Check 'install refuses a zip with the wrong SHA-256' ($r.code -ne 0 -and $r.out -match 'SHA-256 mismatch' -and -not (Test-Path -LiteralPath $badDir)) "exit $($r.code): $($r.out)"

  if (-not $ZipHasNode) {
    $r = Invoke-Script $InstallScript @('-ZipPath', $ZipPath, '-InstallDir', $badDir, '-NoAutostart', '-NoExtension', '-NoOpen', '-NoUninstallEntry')
    Check 'install of a bundle without node.exe needs -NodePath (nothing copied)' ($r.code -ne 0 -and $r.out -match 'NodePath' -and -not (Test-Path -LiteralPath $badDir)) "exit $($r.code): $($r.out)"
  }

  # --- 2. install ------------------------------------------------------------------------------
  Write-Step "install.ps1 -ZipPath $(Split-Path -Leaf $ZipPath) -InstallDir <temp>"
  $sums = Join-Path (Split-Path -Parent $ZipPath) 'SHA256SUMS.txt'
  $instArgs = @('-ZipPath', $ZipPath, '-InstallDir', $InstallDir, '-NoAutostart', '-NoExtension', '-NoOpen', '-NoUninstallEntry')
  if ($ExtNode) { $instArgs += @('-NodePath', $ExtNode) }
  $r = Invoke-Script $InstallScript $instArgs
  Write-Host ($r.out.Trim() -replace '(?m)^', '    ')
  Check 'install.ps1 exits 0' ($r.code -eq 0) "exit $($r.code)"
  if (Test-Path -LiteralPath $sums) { Check 'install verified the SHA-256' ($r.out -match 'SHA-256 verified') 'no "SHA-256 verified" line' }

  $bundle = Get-Content -LiteralPath (Join-Path $InstallDir 'termpocket-bundle.json') -Raw | ConvertFrom-Json
  $mustExist = @(
    'agent\src\index.js', 'agent\src\ptyhost.js', 'agent\monitor\index.html', 'agent\package.json',
    'agent\node_modules\ws\package.json', 'agent\node_modules\qrcode-terminal\package.json',
    'agent\node_modules\@lydell\node-pty-win32-x64\prebuilds\win32-x64\conpty.node',
    'agent\node_modules\@lydell\node-pty-win32-x64\prebuilds\win32-x64\conpty\OpenConsole.exe',
    'web\index.html', 'web\sw.js', 'web\vendor\xterm.js', 'web\vendor\addon-fit.js', 'web\vendor\monaco\vs\loader.js',
    'scripts\install-autostart.ps1', 'scripts\uninstall-autostart.ps1', 'scripts\monitor-tray.ps1', 'scripts\start-agent.cmd',
    'scripts\setup-tailscale.ps1', 'scripts\install.ps1', 'scripts\uninstall.ps1',
    'relay\server.js', 'relay\package.json', 'LICENSE', 'README.md', 'termpocket-install.json')
  $missing = @($mustExist | Where-Object { -not (Test-Path -LiteralPath (Join-Path $InstallDir $_)) })
  Check 'installed files are complete' ($missing.Count -eq 0) "missing: $($missing -join ', ')"
  $mustNot = @('agent\node_modules\monaco-editor', 'agent\test', 'web\tools', 'scripts\release', 'relay\node_modules', 'server.md', 'e2e', '.github')
  $present = @($mustNot | Where-Object { Test-Path -LiteralPath (Join-Path $InstallDir $_) })
  Check 'dev-only files are not installed' ($present.Count -eq 0) "present: $($present -join ', ')"
  if ($bundle.extension) { Check 'the VS Code extension package is bundled' (Test-Path -LiteralPath (Join-Path $InstallDir $bundle.extension)) $bundle.extension }
  $marker = Get-Content -LiteralPath (Join-Path $InstallDir 'termpocket-install.json') -Raw | ConvertFrom-Json
  Check 'install marker records version, no extension, no autostart' ($marker.version -eq $bundle.version -and -not $marker.extension -and -not $marker.autostart) ($marker | ConvertTo-Json -Compress)

  $bundledNode = Join-Path $InstallDir 'node\node.exe'
  $Node = if ($ExtNode) { $ExtNode } else { $bundledNode }
  Check 'node.exe for the installed agent exists' (Test-Path -LiteralPath $Node) $Node
  Write-Host "    node for the installed agent: $Node"

  # --- 3. install-autostart.ps1 -DryRun --------------------------------------------------------
  $as = Join-Path $InstallDir 'scripts\install-autostart.ps1'
  $r = Invoke-Script $as @('-DryRun', '-NodePath', $Node)
  Check 'install-autostart -DryRun -NodePath uses that node' ($r.code -eq 0 -and $r.out.Contains("Node:          $Node") -and $r.out.Contains((Join-Path $InstallDir 'agent\src\index.js'))) $r.out
  $r = Invoke-Script $as @('-DryRun')
  $expect = if (Test-Path -LiteralPath $bundledNode) { "$bundledNode (" } else { '(v' }
  $expectSrc = if (Test-Path -LiteralPath $bundledNode) { 'bundled' } else { 'PATH' }
  Check "install-autostart -DryRun picks the $expectSrc node" ($r.code -eq 0 -and $r.out.Contains($expect) -and $r.out -match ", $expectSrc\)") $r.out

  # --- 4. run the installed agent --------------------------------------------------------------
  Write-Step "Starting the installed agent on $Base (temp home, dry-run input)"
  $agentProc = Start-InstalledAgent $Node 'run1'
  $h = Get-Http '/healthz'
  Check '/healthz answers 200' ($h -and $h.StatusCode -eq 200) 'no answer'
  $j = $null; try { $j = $h.Content | ConvertFrom-Json } catch { }
  Check '/healthz is JSON with ok' ($j -and $j.ok) "$($h.Content)"
  $page = Get-Http '/'
  Check '/ serves the PWA' ($page -and $page.StatusCode -eq 200 -and $page.Content -match 'TermPocket') 'no index.html'
  $xt = Get-Http '/vendor/xterm.js'
  Check '/vendor/xterm.js is served' ($xt -and $xt.StatusCode -eq 200 -and $xt.RawContentLength -gt 10000) 'missing'
  $mo = Get-Http '/vendor/monaco/vs/loader.js'
  Check '/vendor/monaco/vs/loader.js is served' ($mo -and $mo.StatusCode -eq 200) 'missing'
  $pair = Get-Http '/pair'
  Check '/pair answers on loopback' ($pair -and $pair.StatusCode -eq 200) 'no answer'
  Check 'config.json was created in the temp home (not %APPDATA%)' (Test-Path -LiteralPath (Join-Path $HomeDir 'config.json')) 'no config.json'

  # --- 5. upgrade over the running install -----------------------------------------------------
  Write-Step 'install.ps1 again over the running install (upgrade)'
  $hostBefore = 0
  try { $hostBefore = [int](Get-Content -LiteralPath (Join-Path $HomeDir 'ptyhost.json') -Raw | ConvertFrom-Json).pid } catch { }
  $sentinel = Join-Path $InstallDir 'web\stale-file-from-old-version.txt'
  Set-Content -LiteralPath $sentinel -Value 'old' -Encoding Ascii
  # The documented "with options" one-liner form: & ([scriptblock]::Create((irm .../install.ps1))) -Option ...
  $quoted = ($instArgs | ForEach-Object { if ($_ -like '-*') { $_ } else { "'" + $_.Replace("'", "''") + "'" } }) -join ' '
  $cmd = "& ([scriptblock]::Create([System.IO.File]::ReadAllText('$($InstallScript.Replace("'", "''"))'))) $quoted; 'still-alive'"
  $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
  $out = & $PS -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc 2>&1 | Out-String
  $r = [pscustomobject]@{ code = $LASTEXITCODE; out = $out }
  Check 'upgrade (scriptblock form) succeeds and returns to the caller' ($r.code -eq 0 -and $r.out -match 'is installed in' -and $r.out -match 'still-alive') "exit $($r.code): $($r.out)"
  Check 'upgrade says it is upgrading' ($r.out -match 'Upgrading') $r.out
  $agentProc.WaitForExit(10000) | Out-Null
  Check 'upgrade stopped the agent of that folder' ($agentProc.HasExited) "pid $($agentProc.Id) still runs"
  Check 'upgrade removed files the new version does not have' (-not (Test-Path -LiteralPath $sentinel)) 'stale file kept'
  Check 'upgrade kept the settings (temp home config.json)' (Test-Path -LiteralPath (Join-Path $HomeDir 'config.json')) 'config.json gone'
  if ($hostBefore) {
    # The durable terminals host keeps its terminals across upgrades, although it holds files of the
    # install open (the bundled node.exe, conpty.dll): those are moved aside and replaced.
    Check 'upgrade left the terminals host running' ([bool](Get-Process -Id $hostBefore -ErrorAction SilentlyContinue)) "pid $hostBefore gone"
    if ($ZipHasNode) {
      $aside = @(Get-ChildItem -LiteralPath (Join-Path $InstallDir 'node') -Filter 'node.exe.termpocket-old-*' -File -ErrorAction SilentlyContinue)
      Check 'upgrade replaced the in-use node.exe (old one moved aside)' ($aside.Count -ge 1 -and (Test-Path -LiteralPath $bundledNode)) "aside: $($aside.Count)"
    }
  }
  $agentProc = Start-InstalledAgent $Node 'run2'
  Check 'the upgraded agent answers /healthz' ($null -ne (Get-Http '/healthz')) 'no answer'

  # --- 6. uninstall ----------------------------------------------------------------------------
  Write-Step 'uninstall.ps1 -Purge (agent running)'
  $hostInfo = Join-Path $HomeDir 'ptyhost.json'
  $hostPid = 0
  if (Test-Path -LiteralPath $hostInfo) { try { $hostPid = [int](Get-Content -LiteralPath $hostInfo -Raw | ConvertFrom-Json).pid } catch { } }
  $un = Join-Path $InstallDir 'scripts\uninstall.ps1'
  $unArgs = @('-InstallDir', $InstallDir, '-Purge')
  if (-not (Test-Path -LiteralPath $bundledNode)) { $unArgs += @('-NodePath', $Node) }

  # A live terminal (pty.create over /ws, PROTOCOL 3-4): uninstall must not end it without asking.
  $wsModule = Join-Path $InstallDir 'agent\node_modules\ws'
  $js = @"
const [port, token, wsModule] = process.argv.slice(1);
const WebSocket = require(wsModule);
const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
const t = setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
ws.on('open', () => ws.send(JSON.stringify({ t: 'req', id: 1, m: 'auth', p: { token, client: 'install-test' } })));
ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.t !== 'res') return;
  if (m.id === 1) { if (!m.ok) { console.log('auth failed ' + m.e); process.exit(1); } ws.send(JSON.stringify({ t: 'req', id: 2, m: 'pty.create', p: { cols: 80, rows: 24, title: 'install-test' } })); }
  if (m.id === 2) { clearTimeout(t); console.log(m.ok ? 'pty ' + m.r.id : 'pty.create failed ' + m.e); ws.close(); setTimeout(() => process.exit(m.ok ? 0 : 1), 200); }
});
ws.on('error', (e) => { console.log('ws error ' + e.message); process.exit(1); });
"@
  $token = (Get-Content -LiteralPath (Join-Path $HomeDir 'config.json') -Raw | ConvertFrom-Json).token
  $ptyOut = "$(& $Node -e $js $Port $token $wsModule 2>&1)"
  Check 'a terminal was opened over /ws' ($LASTEXITCODE -eq 0 -and $ptyOut -match '^pty ') $ptyOut
  $r = Invoke-Script $un $unArgs
  Check 'uninstall (non-interactive) refuses while a terminal runs' ($r.code -ne 0 -and $r.out -match 'terminal\(s\) still run' -and (Test-Path -LiteralPath $InstallDir) -and -not $agentProc.HasExited) "exit $($r.code): $($r.out)"

  $unArgs += '-Force'
  $r = Invoke-Script $un $unArgs
  Write-Host ($r.out.Trim() -replace '(?m)^', '    ')
  Check 'uninstall.ps1 exits 0' ($r.code -eq 0) "exit $($r.code)"
  $agentProc.WaitForExit(10000) | Out-Null
  Check 'uninstall stopped the agent' ($agentProc.HasExited) "pid $($agentProc.Id) still runs"
  if ($hostPid) {
    Start-Sleep -Milliseconds 500
    Check 'uninstall stopped the terminals host' (-not (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) "pid $hostPid still runs"
  }
  Check 'uninstall removed the install folder' (-not (Test-Path -LiteralPath $InstallDir)) 'folder still there'
  Check 'uninstall -Purge removed the (temp) settings folder' (-not (Test-Path -LiteralPath $HomeDir)) 'home still there'
  Check 'the agent port is free again' ($null -eq (Get-Http '/healthz')) 'still answers'
} catch {
  Fail 'test run' $_.Exception.Message
} finally {
  # Safety net: only processes that run from this test's temp folder.
  $left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='wscript.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($Temp, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($left.Count) { Write-Warning "Stopped $($left.Count) leftover test process(es)" }
  if (-not $KeepTemp) { Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue } else { Write-Host "Temp kept: $Temp" }
}

Write-Host ''
$results | ForEach-Object { Write-Host $_ }
Write-Host ''
if ($failed) { Write-Host "$failed check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host "All $($results.Count) checks passed" -ForegroundColor Green
