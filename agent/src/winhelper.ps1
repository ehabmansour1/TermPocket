# TermPocket - Windows helper bootstrap.
#
# Started by winhelper.js as:
#   powershell.exe -NoProfile -NonInteractive -NoLogo -ExecutionPolicy Bypass -File winhelper.ps1
# Compiles winhelper.cs in memory (Add-Type; no .exe is produced) and hands stdin/stdout to the C#
# JSON-line loop. PowerShell only bootstraps; all request handling happens in C#.
# On a startup failure a single line {"fatal":"..."} is written to stdout and the process exits 1.

$ErrorActionPreference = 'Stop'

function Write-Fatal([string]$message) {
    $json = '{"fatal":' + (ConvertTo-Json -Compress -InputObject $message) + '}'
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    [Environment]::Exit(1)
}

try {
    $source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'winhelper.cs'), [System.Text.Encoding]::UTF8)
    Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @(
        'System.Drawing',
        'System.Windows.Forms',
        'System.Web.Extensions'
    )
}
catch {
    Write-Fatal ("helper compile failed: " + ($_.Exception.Message -replace '\s+', ' '))
}

try {
    $code = [TermPocket.WinHelper]::Run()
}
catch {
    Write-Fatal ("helper crashed: " + $_.Exception.ToString())
}
[Environment]::Exit($code)
