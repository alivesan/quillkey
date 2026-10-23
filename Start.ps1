[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = $PSScriptRoot
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is missing. Install Node.js 22 or newer and run Setup.ps1.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ws\package.json'))) {
    throw 'Dependencies are missing. Run Setup.ps1 first.'
}
$port = if ($env:QUILLKEY_PORT) { [int]$env:QUILLKEY_PORT } else { 8765 }
$baseUrl = 'http://127.0.0.1:' + $port
# Open only after this app reports its speech engine ready. Node remains in this console.
$browserJob = $null
if (-not $NoBrowser) {
    $browserJob = Start-Job -ArgumentList $baseUrl -ScriptBlock {
        param($Url)
        for ($attempt = 0; $attempt -lt 180; $attempt++) {
            try {
                $status = Invoke-RestMethod -Uri ($Url + '/api/status') -TimeoutSec 2
                if ($status.ready -eq $true) { Start-Process $Url; return }
                if ($status.status -eq 'error') { Write-Output ('Speech engine: ' + $status.error); return }
            } catch { }
            Start-Sleep -Seconds 1
        }
        Write-Output ('Open ' + $Url + ' to inspect startup status.')
    }
}
Push-Location -LiteralPath $projectRoot
try {
    Write-Host ('QuillKey: ' + $baseUrl)
    Write-Host 'Keep this window open. Press Ctrl+C to stop.'
    & $node.Source (Join-Path $projectRoot 'server.mjs')
    $serverExit = $LASTEXITCODE
} finally {
    Pop-Location
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
        Receive-Job -Job $browserJob -ErrorAction SilentlyContinue | Write-Host
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
}
if ($serverExit -ne 0) { throw ('QuillKey stopped with exit code ' + $serverExit) }
