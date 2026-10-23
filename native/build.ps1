$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4 compiler is required.' }
& $compiler /nologo /target:exe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/r:$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF\UIAutomationClient.dll" "/r:$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\WPF\UIAutomationTypes.dll" "/out:$PSScriptRoot\QuillKey.Native.exe" "$PSScriptRoot\QuillKey.Native.cs"
if ($LASTEXITCODE -ne 0) { throw 'Native helper compilation failed.' }
