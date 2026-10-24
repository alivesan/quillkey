$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4 compiler is required.' }
& $compiler /nologo /target:exe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/out:$PSScriptRoot\WidgetTest.exe" "$PSScriptRoot\WidgetTest.cs"
if ($LASTEXITCODE -ne 0) { throw 'Widget target compilation failed.' }
