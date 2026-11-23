<#
.SYNOPSIS
  Builds the TermPocket Windows release: TermPocket-<ver>-win-x64.zip, termpocket-<ver>.vsix,
  install.ps1 and SHA256SUMS.txt in the output folder.

.DESCRIPTION
  The zip is a portable, ready-to-run copy of the repository layout (the agent finds web\ and the
  scripts find agent\ relative to themselves):

    node\node.exe            portable Node.js (official win-x64 build, from -NodeDir)
    agent\                   src, monitor, demo, package.json + production node_modules
                             (npm ci --omit=dev; monaco-editor is removed after vendoring)
    web\                     the PWA incl. web\vendor (xterm.js, Monaco) from the agent's postinstall
    scripts\                 start / autostart / tray / Tailscale / install / uninstall scripts
    relay\                   the optional self-hosted relay (server.js + package files) for your own server
    docs\relay.md            how to self-host the relay
    termpocket-<ver>.vsix    the VS Code extension
    LICENSE, README.md, PROTOCOL.md, CHANGELOG.md, termpocket-bundle.json

  CI (.github/workflows/release.yml) passes -NodeDir (verified official Node.js) and -Vsix. Local test
  builds can skip the network entirely: no -NodeDir (no bundled node.exe; test with -NodePath), -NoVsix
  or an existing -Vsix, and -UseInstalledModules (copy agent\node_modules and web\vendor from this tree).

.PARAMETER Version
  Release version (default: "version" of vscode-extension\package.json).

.PARAMETER OutDir
  Output folder (default: <repo>\dist). The staging folder is <OutDir>\stage.

.PARAMETER NodeDir
  Folder containing the official node.exe (and LICENSE) to bundle as node\node.exe.

.PARAMETER Vsix
  A packaged extension to bundle. Without it (and without -NoVsix) the extension is packaged with
  `npx @vscode/vsce package` (needs vscode-extension\node_modules and network).

.PARAMETER NoVsix
  Build without the VS Code extension (local tests).

.PARAMETER UseInstalledModules
  Copy agent\node_modules (minus monaco-editor) and web\vendor from this tree instead of running
  `npm ci --omit=dev` in the staging folder.

.PARAMETER KeepStage
  Keep <OutDir>\stage after zipping.
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$OutDir = '',
  [string]$NodeDir = '',
  [string]$Vsix = '',
  [switch]$NoVsix,
  [switch]$UseInstalledModules,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

$extPkg = Get-Content -LiteralPath (Join-Path $Root 'vscode-extension\package.json') -Raw | ConvertFrom-Json
$agentPkg = Get-Content -LiteralPath (Join-Path $Root 'agent\package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$extPkg.version }
$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw "Not a semantic version: $Version" }
if ([string]$extPkg.version -ne $Version) { Write-Warning "vscode-extension\package.json has version $($extPkg.version), building $Version" }
if ([string]$agentPkg.version -ne $Version) { Write-Warning "agent\package.json has version $($agentPkg.version), building $Version" }

if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath
$Stage = Join-Path $OutDir 'stage'
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

$ZipName  = "TermPocket-$Version-win-x64.zip"
$VsixName = "termpocket-$Version.vsix"

# Copy every file below $From whose path relative to $From (backslashes) does not match $Exclude.
function Copy-Tree {
  param([string]$From, [string]$To, [string]$Exclude = '')
  # EnumerateFiles keeps the root exactly as given (Get-ChildItem may expand an 8.3 short name such as
  # C:\Users\ABCDEF~1, which would break the relative paths).
  $from = (Resolve-Path -LiteralPath $From).ProviderPath.TrimEnd('\')
  $n = 0
  foreach ($file in [System.IO.Directory]::EnumerateFiles($from, '*', [System.IO.SearchOption]::AllDirectories)) {
    $rel = $file.Substring($from.Length + 1)
    if ($Exclude -and $rel -match $Exclude) { continue }
    $dest = Join-Path $To $rel
    $dir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $file -Destination $dest -Force
    $n++
  }
  return $n
}

function Copy-One([string]$From, [string]$To) {
  $dir = Split-Path -Parent $To
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Copy-Item -LiteralPath $From -Destination $To -Force
}

# Common junk that never ships.
$Junk = '(^|\\)(\.git|\.tmp|\.vscode|test-results|artifacts)(\\|$)|\.log$|\.map$|(^|\\)\.env(\..*)?$|(^|\\)server\.md$'

# --- sources ------------------------------------------------------------------------------------
Write-Step "Staging TermPocket $Version in $Stage"
$sa = Join-Path $Stage 'agent'
foreach ($d in @('src', 'monitor', 'demo', 'scripts')) {
  [void](Copy-Tree (Join-Path $Root "agent\$d") (Join-Path $sa $d) $Junk)
}
Copy-One (Join-Path $Root 'agent\package.json') (Join-Path $sa 'package.json')
Copy-One (Join-Path $Root 'agent\package-lock.json') (Join-Path $sa 'package-lock.json')

# web\ without vendor (generated below) and tools (developer checks).
[void](Copy-Tree (Join-Path $Root 'web') (Join-Path $Stage 'web') "$Junk|^(vendor|tools)(\\|$)")

# scripts\: the top-level scripts only (scripts\release is build tooling).
foreach ($f in Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -File) {
  if ($f.Extension -in @('.ps1', '.cmd')) { Copy-One $f.FullName (Join-Path $Stage "scripts\$($f.Name)") }
}

# relay\ for self-hosters (no node_modules: `npm ci --omit=dev` on the server).
foreach ($n in @('server.js', 'package.json', 'package-lock.json')) {
  Copy-One (Join-Path $Root "relay\$n") (Join-Path $Stage "relay\$n")
}
if (Test-Path -LiteralPath (Join-Path $Root 'docs\relay.md')) { Copy-One (Join-Path $Root 'docs\relay.md') (Join-Path $Stage 'docs\relay.md') }

foreach ($n in @('LICENSE', 'README.md', 'PROTOCOL.md')) { Copy-One (Join-Path $Root $n) (Join-Path $Stage $n) }
$changelog = if (Test-Path -LiteralPath (Join-Path $Root 'CHANGELOG.md')) { Join-Path $Root 'CHANGELOG.md' } else { Join-Path $Root 'vscode-extension\CHANGELOG.md' }
Copy-One $changelog (Join-Path $Stage 'CHANGELOG.md')

# --- node.exe -----------------------------------------------------------------------------------
$nodeForChecks = $null
$nodeVersion = $null
if ($NodeDir) {
  $nodeExe = Join-Path $NodeDir 'node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { throw "node.exe not found in -NodeDir $NodeDir" }
  Copy-One $nodeExe (Join-Path $Stage 'node\node.exe')
  if (Test-Path -LiteralPath (Join-Path $NodeDir 'LICENSE')) { Copy-One (Join-Path $NodeDir 'LICENSE') (Join-Path $Stage 'node\LICENSE') }
  $nodeForChecks = Join-Path $Stage 'node\node.exe'
  $nodeVersion = ((& $nodeForChecks --version) -replace '^v', '').Trim()
  if ([int]$nodeVersion.Split('.')[0] -lt 20) { throw "Bundled Node.js must be 20+ (got $nodeVersion)" }
  Write-Step "Bundled Node.js $nodeVersion"
} else {
  Write-Warning 'No -NodeDir: the bundle has no node\node.exe (test build; install with -NodePath).'
  $nodeForChecks = (Get-Command node -ErrorAction Stop).Source
}

# --- agent dependencies + web\vendor ------------------------------------------------------------
if ($UseInstalledModules) {
  Write-Step 'Copying agent\node_modules and web\vendor from this tree (-UseInstalledModules)'
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'agent\node_modules\ws\package.json'))) { throw 'agent\node_modules is missing: run npm install in agent\ first.' }
  $n = Copy-Tree (Join-Path $Root 'agent\node_modules') (Join-Path $sa 'node_modules') '^(monaco-editor|\.cache)(\\|$)'
  Write-Host "    $n files"
  [void](Copy-Tree (Join-Path $Root 'web\vendor') (Join-Path $Stage 'web\vendor') '\.map$')
} else {
  Write-Step 'npm ci --omit=dev in the staged agent (its postinstall vendors xterm.js and Monaco into web\vendor)'
  Push-Location $sa
  try {
    & npm.cmd ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}

$vendorChecks = @('web\vendor\xterm.js', 'web\vendor\xterm.css', 'web\vendor\addon-fit.js', 'web\vendor\monaco\vs\loader.js')
foreach ($v in $vendorChecks) { if (-not (Test-Path -LiteralPath (Join-Path $Stage $v))) { throw "Missing $v (agent postinstall / npm run vendor did not run?)" } }
# Monaco is served from web\vendor\monaco; the 100 MB package itself is not needed at runtime.
$monacoPkg = Join-Path $sa 'node_modules\monaco-editor'
if (Test-Path -LiteralPath $monacoPkg) { Remove-Item -LiteralPath $monacoPkg -Recurse -Force }

# node-pty must have its Windows x64 prebuild (no compiler on the user's PC).
$pre = Join-Path $sa 'node_modules\@lydell\node-pty-win32-x64\prebuilds\win32-x64'
foreach ($f in @('conpty.node', 'conpty_console_list.node', 'conpty\conpty.dll', 'conpty\OpenConsole.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $pre $f))) { throw "@lydell/node-pty win32-x64 prebuild is missing $f" }
}
Push-Location $sa
try {
  $probe = "const p=require('@lydell/node-pty');require('ws');require('qrcode-terminal');if(typeof p.spawn!=='function')throw new Error('node-pty has no spawn');console.log('deps ok')"
  $out = & $nodeForChecks -e $probe 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Loading the agent's dependencies failed: $out" }
  foreach ($f in Get-ChildItem -LiteralPath (Join-Path $sa 'src') -Filter '*.js' -File) {
    & $nodeForChecks --check $f.FullName
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($f.Name)" }
  }
} finally { Pop-Location }
Write-Step "Agent dependencies verified with $nodeForChecks (node-pty win32-x64 prebuild loads)"

# --- VS Code extension --------------------------------------------------------------------------
$vsixOut = Join-Path $OutDir $VsixName
if ($Vsix) {
  $src = (Resolve-Path -LiteralPath $Vsix).ProviderPath
  if ($src -ne $vsixOut) { Copy-Item -LiteralPath $src -Destination $vsixOut -Force }
} elseif (-not $NoVsix) {
  Write-Step 'Packaging the VS Code extension (vsce)'
  Push-Location (Join-Path $Root 'vscode-extension')
  try {
    & npx.cmd --yes '@vscode/vsce@3' package --out $vsixOut
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}
if (Test-Path -LiteralPath $vsixOut) {
  Copy-One $vsixOut (Join-Path $Stage $VsixName)
} elseif (-not $NoVsix) { throw "Extension package not found: $vsixOut" }

# --- metadata -----------------------------------------------------------------------------------
$commit = $null
try { $commit = (& git -C $Root rev-parse HEAD 2>$null) } catch { }
if ($LASTEXITCODE -ne 0) { $commit = $null }
$meta = [ordered]@{
  name      = 'TermPocket'
  version   = $Version
  platform  = 'win-x64'
  commit    = $commit
  node      = $nodeVersion
  extension = if (Test-Path -LiteralPath (Join-Path $Stage $VsixName)) { $VsixName } else { $null }
  builtAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
[System.IO.File]::WriteAllText((Join-Path $Stage 'termpocket-bundle.json'), ($meta | ConvertTo-Json) + "`n", (New-Object System.Text.UTF8Encoding($false)))

# --- zip (entries with forward slashes, no top-level folder) -------------------------------------
$zipPath = Join-Path $OutDir $ZipName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Write-Step "Writing $ZipName"
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::CreateNew)
$count = 0
try {
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in [System.IO.Directory]::EnumerateFiles($Stage, '*', [System.IO.SearchOption]::AllDirectories)) {
      $rel = $file.Substring($Stage.Length + 1).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $count++
    }
  } finally { $zip.Dispose() }
} finally { $fs.Dispose() }

# --- install.ps1 + checksums --------------------------------------------------------------------
Copy-Item -LiteralPath (Join-Path $Root 'scripts\install.ps1') -Destination (Join-Path $OutDir 'install.ps1') -Force
$assets = @($ZipName)
if (Test-Path -LiteralPath $vsixOut) { $assets += $VsixName }
$assets += 'install.ps1'
$lines = foreach ($a in $assets) { '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutDir $a)).Hash.ToLowerInvariant(), $a }
[System.IO.File]::WriteAllText((Join-Path $OutDir 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

if (-not $KeepStage) { Remove-Item -LiteralPath $Stage -Recurse -Force }

Write-Host ''
foreach ($a in @($assets + 'SHA256SUMS.txt')) {
  $p = Join-Path $OutDir $a
  Write-Host ('{0,-34} {1,8:N1} MB' -f $a, ((Get-Item -LiteralPath $p).Length / 1MB))
}
Write-Host "$count files in $ZipName"
