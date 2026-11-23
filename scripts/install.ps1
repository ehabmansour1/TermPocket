<#
.SYNOPSIS
  Installs TermPocket on this Windows PC (per user, no admin rights).

.DESCRIPTION
  Downloads the TermPocket release zip from GitHub Releases, checks its SHA-256 against the release's
  SHA256SUMS.txt, and installs it to %LOCALAPPDATA%\Programs\TermPocket. The zip brings its own
  portable Node.js, so nothing else needs to be installed first. Then it

    * starts the agent and the TermPocket Monitor tray icon at every logon (scripts\install-autostart.ps1,
      Scheduled Tasks "TermPocket Agent" / "TermPocket Monitor", using the bundled node.exe),
    * installs the VS Code extension if the `code` command is available,
    * opens the pairing page http://127.0.0.1:<port>/pair on this PC,
    * adds TermPocket to Settings > Apps (Uninstall runs scripts\uninstall.ps1).

  Running it again upgrades in place: the running agent and monitor are stopped and started again,
  your pairing token (%APPDATA%\TermPocket\config.json) is kept, and terminals in the durable terminals
  host keep running.

  One-liner (PowerShell):
    irm https://github.com/ehabmansour1/TermPocket/releases/latest/download/install.ps1 | iex

  With options:
    & ([scriptblock]::Create((irm https://github.com/ehabmansour1/TermPocket/releases/latest/download/install.ps1))) -NoExtension

.PARAMETER Version
  Install this release (e.g. 1.0.0) instead of the latest one.

.PARAMETER InstallDir
  Install folder (default: %LOCALAPPDATA%\Programs\TermPocket).

.PARAMETER NoAutostart
  Do not register the logon tasks (start the agent yourself with scripts\start-agent.cmd).

.PARAMETER NoExtension
  Do not install the VS Code extension.

.PARAMETER NoOpen
  Do not open the pairing page in the browser.

.PARAMETER NoUninstallEntry
  Do not add TermPocket to Settings > Apps.

.PARAMETER ZipPath
  Install from this local release zip instead of downloading (tests, offline installs). It is verified
  against a SHA256SUMS.txt next to it when there is one.

.PARAMETER NodePath
  node.exe to use instead of the bundled one (tests).

.PARAMETER Repo
  GitHub repository to download from (default: ehabmansour1/TermPocket).
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$InstallDir = '',
  [switch]$NoAutostart,
  [switch]$NoExtension,
  [switch]$NoOpen,
  [switch]$NoUninstallEntry,
  [string]$ZipPath = '',
  [string]$NodePath = '',
  [string]$Repo = 'ehabmansour1/TermPocket'
)

# Everything runs inside this script block, so `irm ... | iex` leaves no preferences or helper
# functions behind in your PowerShell session, and a failure never closes the window.
$TermPocketInstall = {
  param($Version, $InstallDir, $NoAutostart, $NoExtension, $NoOpen, $NoUninstallEntry, $ZipPath, $NodePath, $Repo)

  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version Latest
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times faster without the progress bar

  $ExtensionId = 'ehabmansour1.termpocket'
  $Marker = 'termpocket-install.json'

  function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

  function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

  # "<sha256>  <file name>" lines (sha256sum format) -> hashtable name -> hash.
  function Read-Sums([string]$Text) {
    $map = @{}
    foreach ($line in ($Text -split "`r?`n")) {
      if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$') { $map[$Matches[2]] = $Matches[1].ToLowerInvariant() }
    }
    return $map
  }

  function Get-Download([string]$Url, [string]$OutFile) {
    $headers = @{ 'User-Agent' = 'TermPocket-installer' }
    for ($i = 1; ; $i++) {
      try {
        if ($OutFile) { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers $headers; return }
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $headers
        if ($r.Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($r.Content) }
        return [string]$r.Content
      } catch {
        if ($i -ge 3) { throw "Download failed: $Url ($($_.Exception.Message))" }
        Start-Sleep -Seconds (2 * $i)
      }
    }
  }

  function Test-UnderPath([string]$Path, [string]$Dir) {
    $p = $Path.TrimEnd('\') + '\'
    $d = $Dir.TrimEnd('\') + '\'
    return $p.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)
  }

  # Processes of THIS install (matched by its full path): the agent and its launcher chain, and the
  # tray monitor. Never the durable terminals host (agent\src\ptyhost.js): it keeps the terminals.
  function Get-InstallProcesses([string]$Dir) {
    $entry = Join-Path $Dir 'agent\src\index.js'
    $monitor = Join-Path $Dir 'scripts\monitor-tray.ps1'
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $cl = [string]$_.CommandLine
        $cl -and ($cl.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $cl.IndexOf($monitor, [StringComparison]::OrdinalIgnoreCase) -ge 0)
      })
  }

  # The autostart launcher (written by install-autostart.ps1) runs this install's agent?
  function Test-AutostartIsOurs([string]$Dir) {
    $launcher = Join-Path $env:APPDATA 'TermPocket\termpocket-agent.vbs'
    if (-not (Test-Path -LiteralPath $launcher)) { return $false }
    $text = [System.IO.File]::ReadAllText($launcher) # UTF-16 with BOM, detected
    return $text.IndexOf((Join-Path $Dir 'agent\src\index.js'), [StringComparison]::OrdinalIgnoreCase) -ge 0
  }

  # Replace a file even when the old one is in use (node.exe / conpty.dll of a running terminals host):
  # Windows lets a running image be renamed, so move it aside and copy the new one in.
  function Copy-Replacing([string]$From, [string]$To) {
    $dir = Split-Path -Parent $To
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    try {
      Copy-Item -LiteralPath $From -Destination $To -Force
    } catch {
      if (-not (Test-Path -LiteralPath $To)) { throw }
      $aside = "$To.termpocket-old-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
      Move-Item -LiteralPath $To -Destination $aside -Force
      Copy-Item -LiteralPath $From -Destination $To -Force
    }
  }

  function Get-AgentPort {
    $cfgDir = if ($env:TERMPOCKET_HOME) { $env:TERMPOCKET_HOME } else { Join-Path $env:APPDATA 'TermPocket' }
    $port = 8765
    if ($env:TERMPOCKET_PORT -match '^\d+$') { return [int]$env:TERMPOCKET_PORT }
    $cfg = Join-Path $cfgDir 'config.json'
    if (Test-Path -LiteralPath $cfg) {
      try { $c = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json; if ($c.port) { $port = [int]$c.port } } catch { }
    }
    return $port
  }

  function Find-CodeCli {
    foreach ($name in @('code.cmd', 'code')) {
      $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($c) { return $c.Source }
    }
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd", "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) {
      if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
  }

  # --- checks -----------------------------------------------------------------------------------
  if ($env:OS -ne 'Windows_NT') { throw 'TermPocket runs on Windows 10 / 11.' }
  if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw "PowerShell 5.1 or newer is required (this is $($PSVersionTable.PSVersion))." }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'TermPocket needs 64-bit Windows.' }
  # GitHub needs TLS 1.2 (older Windows PowerShell defaults may not offer it).
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\TermPocket' }
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $refuse = @([System.IO.Path]::GetPathRoot($InstallDir).TrimEnd('\'), $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA,
    (Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, $env:WINDIR) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
  if ($refuse -contains $InstallDir) { throw "Refusing to install directly into $InstallDir; choose a folder of its own." }
  $existing = Test-Path -LiteralPath $InstallDir
  if ($existing -and @(Get-ChildItem -LiteralPath $InstallDir -Force).Count -gt 0 -and
      -not (Test-Path -LiteralPath (Join-Path $InstallDir $Marker)) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'termpocket-bundle.json'))) {
    throw "$InstallDir exists and is not a TermPocket install. Choose another -InstallDir or empty it first."
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("termpocket-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    # --- 1. the release zip ---------------------------------------------------------------------
    if ($ZipPath) {
      $zip = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
      $zipName = Split-Path -Leaf $zip
      $sumsFile = Join-Path (Split-Path -Parent $zip) 'SHA256SUMS.txt'
      if (Test-Path -LiteralPath $sumsFile) {
        $sums = Read-Sums (Get-Content -LiteralPath $sumsFile -Raw)
        if (-not $sums.ContainsKey($zipName)) { throw "$zipName is not listed in $sumsFile" }
        if ((Get-Sha256 $zip) -ne $sums[$zipName]) { throw "SHA-256 mismatch for $zipName - the file is damaged or was modified." }
        Write-Step "Using $zipName (SHA-256 verified)"
      } else {
        Write-Warning "No SHA256SUMS.txt next to $zipName - not verified."
      }
    } else {
      $v = $Version.TrimStart('v')
      $base = if ($v) { "https://github.com/$Repo/releases/download/v$v" } else { "https://github.com/$Repo/releases/latest/download" }
      Write-Step "Looking up the $(if ($v) { "TermPocket $v" } else { 'latest TermPocket' }) release"
      $sums = Read-Sums (Get-Download "$base/SHA256SUMS.txt" $null)
      $zipName = @($sums.Keys | Where-Object { $_ -match '^TermPocket-.+-win-x64\.zip$' }) | Select-Object -First 1
      if (-not $zipName) { throw "The release has no Windows zip listed in SHA256SUMS.txt ($base)." }
      $zip = Join-Path $tmp $zipName
      Write-Step "Downloading $zipName"
      Get-Download "$base/$zipName" $zip
      if ((Get-Sha256 $zip) -ne $sums[$zipName]) { throw "SHA-256 mismatch for $zipName - the download is damaged or was modified. Nothing was installed." }
      Write-Step 'SHA-256 verified'
    }

    # --- 2. unpack to a staging folder ----------------------------------------------------------
    $stage = Join-Path $tmp 'bundle'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
    $bundleInfo = Join-Path $stage 'termpocket-bundle.json'
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'agent\src\index.js')) -or -not (Test-Path -LiteralPath $bundleInfo)) {
      throw "$zipName is not a TermPocket release bundle."
    }
    $bundle = Get-Content -LiteralPath $bundleInfo -Raw | ConvertFrom-Json
    $newVersion = [string]$bundle.version
    if (-not $NodePath -and -not (Test-Path -LiteralPath (Join-Path $stage 'node\node.exe'))) {
      throw "$zipName has no node\node.exe (a test build?); pass -NodePath <node.exe>."
    }

    # --- 3. stop what runs from an existing install (upgrade) -----------------------------------
    $hadAutostart = $false
    if ($existing) {
      $oldVersion = $null
      try { $oldVersion = (Get-Content -LiteralPath (Join-Path $InstallDir $Marker) -Raw | ConvertFrom-Json).version } catch { }
      Write-Step "Upgrading $InstallDir$(if ($oldVersion) { " ($oldVersion -> $newVersion)" })"
      $oldUninstall = Join-Path $InstallDir 'scripts\uninstall-autostart.ps1'
      if ((Test-AutostartIsOurs $InstallDir) -and (Test-Path -LiteralPath $oldUninstall)) {
        $hadAutostart = $true
        # Stops the monitor, the launcher and the agent; leaves the terminals host (and its terminals) running.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $oldUninstall -KeepTerminals | Out-Host
      }
      $procs = @(Get-InstallProcesses $InstallDir)
      foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
      if ($procs.Count) { Write-Step "Stopped $($procs.Count) running TermPocket process(es) of the old version" }
    }

    # --- 4. copy the files in -------------------------------------------------------------------
    Write-Step "Installing TermPocket $newVersion to $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # EnumerateFiles keeps each root exactly as given (Get-ChildItem may expand an 8.3 short name such
    # as C:\Users\ABCDEF~1 in TEMP, which would break the relative paths).
    $all = [System.IO.SearchOption]::AllDirectories
    $stageFull = $stage.TrimEnd('\')
    $newFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in @([System.IO.Directory]::EnumerateFiles($stageFull, '*', $all))) {
      $rel = $file.Substring($stageFull.Length + 1)
      [void]$newFiles.Add($rel)
      Copy-Replacing $file (Join-Path $InstallDir $rel)
    }
    # Files of the previous version that the new one no longer has (and files moved aside earlier).
    $stale = 0
    foreach ($file in @([System.IO.Directory]::EnumerateFiles($InstallDir, '*', $all))) {
      $rel = $file.Substring($InstallDir.Length + 1)
      if ($rel -ieq $Marker -or $newFiles.Contains($rel)) { continue }
      try { Remove-Item -LiteralPath $file -Force; $stale++ } catch { }
    }
    foreach ($d in @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending)) {
      if (@(Get-ChildItem -LiteralPath $d.FullName -Force).Count -eq 0) { Remove-Item -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue }
    }
    if ($stale) { Write-Host "    removed $stale file(s) of the previous version" }

    # --- 5. node.exe ----------------------------------------------------------------------------
    if ($NodePath) {
      $node = (Resolve-Path -LiteralPath $NodePath).ProviderPath
    } else {
      $node = Join-Path $InstallDir 'node\node.exe'
      if (-not (Test-Path -LiteralPath $node)) { throw "This bundle has no node\node.exe; pass -NodePath <node.exe>." }
    }
    $nodeVersion = ((& $node --version) -replace '^v', '').Trim()
    if ([int]$nodeVersion.Split('.')[0] -lt 20) { throw "Node.js 20+ is required (got $nodeVersion from $node)." }

    # --- 6. VS Code extension -------------------------------------------------------------------
    $extensionInstalled = $false
    $vsix = Get-ChildItem -LiteralPath $InstallDir -Filter 'termpocket-*.vsix' -File | Select-Object -First 1
    if ($NoExtension) {
      Write-Step 'Skipping the VS Code extension (-NoExtension)'
    } elseif (-not $vsix) {
      Write-Warning 'This bundle has no VS Code extension package.'
    } else {
      $code = Find-CodeCli
      if ($code) {
        Write-Step "Installing the VS Code extension ($ExtensionId)"
        $out = & $code --install-extension $vsix.FullName --force 2>&1
        if ($LASTEXITCODE -eq 0) {
          $extensionInstalled = $true
          Write-Host '    Reload open VS Code windows (Developer: Reload Window) to connect them.'
        } else {
          Write-Warning "code --install-extension failed: $out"
        }
      } else {
        Write-Warning "VS Code's 'code' command was not found. Install the extension later with:"
        Write-Host "    code --install-extension `"$($vsix.FullName)`""
      }
    }

    # --- 7. marker + Settings > Apps entry ------------------------------------------------------
    $markerData = [ordered]@{
      name = 'TermPocket'; version = $newVersion; installDir = $InstallDir
      installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      extension = $extensionInstalled; autostart = (-not $NoAutostart)
    }
    [System.IO.File]::WriteAllText((Join-Path $InstallDir $Marker), ($markerData | ConvertTo-Json) + "`n", (New-Object System.Text.UTF8Encoding($false)))

    if (-not $NoUninstallEntry) {
      $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TermPocket'
      New-Item -Path $key -Force | Out-Null
      $sizeKb = [int](((Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force | Measure-Object Length -Sum).Sum) / 1KB)
      $uninst = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'), (Join-Path $InstallDir 'scripts\uninstall.ps1')
      $values = @{
        DisplayName = 'TermPocket'; DisplayVersion = $newVersion; Publisher = 'Ehab Mansour'
        InstallLocation = $InstallDir; UninstallString = $uninst
        URLInfoAbout = "https://github.com/$Repo"; HelpLink = "https://github.com/$Repo#readme"
      }
      foreach ($k in $values.Keys) { New-ItemProperty -Path $key -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
      foreach ($k in @('NoModify', 'NoRepair')) { New-ItemProperty -Path $key -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
      New-ItemProperty -Path $key -Name 'EstimatedSize' -Value $sizeKb -PropertyType DWord -Force | Out-Null
    }

    # --- 8. autostart (agent + tray monitor) ----------------------------------------------------
    $started = $false
    if ($NoAutostart) {
      Write-Step 'Skipping autostart (-NoAutostart)'
      if ($hadAutostart) { Write-Warning 'The previous version started at logon; that is now removed. Run scripts\install-autostart.ps1 to restore it.' }
    } else {
      $autostart = Join-Path $InstallDir 'scripts\install-autostart.ps1'
      $asArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $autostart)
      if ($NodePath) { $asArgs += @('-NodePath', $node) }
      & powershell.exe @asArgs | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "install-autostart.ps1 failed ($LASTEXITCODE)." }
      $started = $true
    }

    # --- 9. pairing page ------------------------------------------------------------------------
    $port = Get-AgentPort
    $pairUrl = "http://127.0.0.1:$port/pair"
    if ($started) {
      $up = $false
      $deadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $deadline) {
        try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $up = $true; break } } catch { }
        Start-Sleep -Milliseconds 700
      }
      if ($up) {
        Write-Step "The agent is running on port $port"
        if (-not $NoOpen) { Start-Process $pairUrl }
      } else {
        Write-Warning "The agent did not answer on port $port yet. Log: $(Join-Path $env:APPDATA 'TermPocket\agent.log')"
      }
    }

    # --- 10. next steps -------------------------------------------------------------------------
    Write-Host ''
    Write-Host "TermPocket $newVersion is installed in $InstallDir" -ForegroundColor Green
    Write-Host ''
    Write-Host 'Next steps:'
    if (-not $started) {
      Write-Host "  0. Start the agent:  `"$(Join-Path $InstallDir 'scripts\start-agent.cmd')`""
    }
    Write-Host "  1. Pair your phone or laptop: open $pairUrl on this PC and scan the QR code."
    Write-Host '  2. Reach the PC from anywhere (pick one):'
    Write-Host '     - Tailscale (recommended): install Tailscale on this PC and on your phone (same account),'
    Write-Host '       enable MagicDNS + HTTPS certificates in the Tailscale admin console, then run'
    Write-Host "         powershell -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'scripts\setup-tailscale.ps1')`""
    Write-Host '       and open the pairing page again for the https://<pc>.<tailnet>.ts.net link.'
    Write-Host "     - Your own relay server: see $(Join-Path $InstallDir 'docs\relay.md')"
    Write-Host '  3. On the phone: open the link in Chrome, then menu > Add to Home screen / Install app.'
    Write-Host ''
    Write-Host "Uninstall: Settings > Apps > TermPocket, or  powershell -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'scripts\uninstall.ps1')`""
    return $true
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  $null = & $TermPocketInstall $Version $InstallDir ([bool]$NoAutostart) ([bool]$NoExtension) ([bool]$NoOpen) ([bool]$NoUninstallEntry) $ZipPath $NodePath $Repo
} catch {
  Write-Host ''
  Write-Host "TermPocket was not installed: $($_.Exception.Message)" -ForegroundColor Red
  # A script run with -File exits non-zero; `irm | iex` just returns (it must not close the window).
  if ($PSCommandPath -and $MyInvocation.MyCommand.Path -eq $PSCommandPath) { exit 1 }
}
