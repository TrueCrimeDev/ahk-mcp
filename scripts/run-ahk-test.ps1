param(
    [string]$AhkExe = $(if ($env:AHK_PATH_WIN) { $env:AHK_PATH_WIN } else { 'AutoHotkey64.exe' }),
    [string]$Script = (Join-Path $PSScriptRoot '..\Tests\manual\test-run-ok.ahk'),
    [switch]$Wait
)

Write-Host "Launching AHK: $AhkExe -> $Script" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $AhkExe)) {
    Write-Error "AHK executable not found: $AhkExe"; exit 2
}
if (-not (Test-Path -LiteralPath $Script)) {
    Write-Error "AHK script not found: $Script"; exit 3
}

$argsList = @($Script)
if ($Wait) {
    Start-Process -FilePath $AhkExe -ArgumentList $argsList -Wait -PassThru | Out-Host
} else {
    Start-Process -FilePath $AhkExe -ArgumentList $argsList -PassThru | Out-Host
}

Write-Host "Done." -ForegroundColor Green
