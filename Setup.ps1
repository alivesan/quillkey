[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = $PSScriptRoot
$runtimeHash = '9ffe5e842c39a7d3211f3b2c3b3aa1bca8c0b2455d96d961ed5f22ec5108f98d'
$modelHash = 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'
$archive = Join-Path $projectRoot 'vendor\runtime.zip'
$model = Join-Path $projectRoot 'models\nemotron-en-q8.gguf'
$runtimeRoot = Join-Path $projectRoot 'vendor\runtime'
$runtimeExe = Join-Path $runtimeRoot 'nemo-speech-0.2.0-windows-x86_64-cuda\bin\nemo-speech.exe'
function Test-ArtifactHash([string]$Path, [string]$Expected) {
    return (Test-Path -LiteralPath $Path -PathType Leaf) -and ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Expected)
}
function Get-VerifiedArtifact([string]$Url, [string]$Path, [string]$Expected) {
    if (Test-ArtifactHash $Path $Expected) { Write-Host ('Verified: ' + (Split-Path $Path -Leaf)); return }
    $partial = $Path + '.partial'
    Write-Host ('Downloading: ' + (Split-Path $Path -Leaf))
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial
    if (-not (Test-ArtifactHash $partial $Expected)) { throw ('SHA256 verification failed: ' + $partial) }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or newer, then run Setup.ps1 again.'
}
$nodeMajor = [int]((& node.exe -p 'process.versions.node.split(".")[0]') | Select-Object -First 1)
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
New-Item -ItemType Directory -Path (Join-Path $projectRoot 'vendor'), (Join-Path $projectRoot 'models'), (Join-Path $projectRoot 'logs') -Force | Out-Null
Get-VerifiedArtifact 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-cuda.zip' $archive $runtimeHash
# Recheck immediately before extraction, including when reusing a cached archive.
if (-not (Test-ArtifactHash $archive $runtimeHash)) { throw 'Runtime archive hash mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
if (-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)) { throw 'Runtime archive did not contain the expected executable.' }
Get-VerifiedArtifact 'https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/ebe59e5a817142986528bbbee5dba8db7b38ed50/nemotron-speech-streaming-en-0.6b.q8_0.gguf' $model $modelHash
Push-Location -LiteralPath $projectRoot
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund --cache (Join-Path $projectRoot 'vendor\npm-cache')
    if ($LASTEXITCODE -ne 0) { throw ('npm ci failed with exit code ' + $LASTEXITCODE) }
    & $runtimeExe --version
    if ($LASTEXITCODE -ne 0) { throw ('Runtime version check failed with exit code ' + $LASTEXITCODE) }
} finally { Pop-Location }
Write-Host 'Setup complete. Run Start.cmd to open QuillKey.'

