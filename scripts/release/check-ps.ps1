<#
.SYNOPSIS
  Parse-checks every PowerShell script of the repository (no script is run) and the scoop manifest.

.DESCRIPTION
  Uses the PowerShell language parser on each *.ps1 outside node_modules / dist. Also warns when a
  script without a UTF-8 BOM contains non-ASCII characters (Windows PowerShell 5.1 would read it in
  the ANSI code page), and checks that packaging\scoop\*.json is valid JSON. Exit code 1 on errors.
#>
[CmdletBinding()]
param([string]$Root = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $Root) { $Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath }

$errors = 0
$files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.ps1' |
  Where-Object { $_.FullName -notmatch '\\(node_modules|dist|\.git|\.tmp)\\' })
foreach ($f in $files) {
  $tokens = $null; $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$parseErrors)
  $rel = $f.FullName.Substring($Root.Length).TrimStart('\')
  if ($parseErrors -and $parseErrors.Count) {
    $errors += $parseErrors.Count
    foreach ($e in $parseErrors) { Write-Host ("FAIL  {0}:{1}: {2}" -f $rel, $e.Extent.StartLineNumber, $e.Message) -ForegroundColor Red }
  } else {
    Write-Host "ok    $rel"
  }
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if (-not $bom -and ($bytes | Where-Object { $_ -gt 0x7F } | Select-Object -First 1)) {
    Write-Warning "$rel has non-ASCII characters but no UTF-8 BOM (Windows PowerShell 5.1 reads it as ANSI)"
  }
}

foreach ($j in @(Get-ChildItem -LiteralPath (Join-Path $Root 'packaging') -Recurse -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
  try {
    $null = Get-Content -LiteralPath $j.FullName -Raw | ConvertFrom-Json
    Write-Host "ok    $($j.FullName.Substring($Root.Length).TrimStart('\'))"
  } catch {
    $errors++
    Write-Host "FAIL  $($j.FullName): $($_.Exception.Message)" -ForegroundColor Red
  }
}

if ($errors) { Write-Host "$errors error(s)" -ForegroundColor Red; exit 1 }
Write-Host "$($files.Count) PowerShell scripts parse cleanly"
