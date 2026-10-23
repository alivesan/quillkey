$ErrorActionPreference = 'Stop'
$fixtureDir = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
$voice = New-Object -ComObject SAPI.SpVoice
$stream = New-Object -ComObject SAPI.SpFileStream
try {
    $stream.Format.Type = 22
    $stream.Open((Join-Path $fixtureDir 'synthetic-english.wav'), 3, $false)
    $voice.AudioOutputStream = $stream
    [void]$voice.Speak('Please send the draft tomorrow morning. We should keep the blue version.')
} finally { $stream.Close() }
