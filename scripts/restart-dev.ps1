# Stops any running Radia dev instance and starts a fresh one.
#
# electron-vite does not reliably restart the main process on change here, and a
# stale instance holds the single-instance lock so the new one exits silently.
#
#   powershell -File scripts/restart-dev.ps1 [logPath]

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$log = if ($args[0]) { $args[0] } else { Join-Path $root 'dev.log' }

Get-Process -Name electron, RadiaBridge | Stop-Process -Force
Start-Sleep -Seconds 2

Push-Location $root
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c", "npx electron-vite dev > `"$log`" 2>&1" `
  -WindowStyle Hidden
Pop-Location

Write-Output "restarted; log -> $log"
