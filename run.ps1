# run.ps1 — start both the token server and the agent worker from one terminal
# Usage: .venv\Scripts\activate  then  .\run.ps1

$root = $PSScriptRoot

Write-Host "`n=== Maneuver Talk-to-Founder ===" -ForegroundColor Cyan
Write-Host "Starting token server on http://localhost:8000 ..."  -ForegroundColor Green

# Start app.py in a background PowerShell job
$serverJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    & ".venv\Scripts\python" "app.py"
} -ArgumentList $root

Write-Host "Starting LiveKit agent worker (dev mode) ..." -ForegroundColor Green
Write-Host "Press Ctrl+C to stop both processes.`n" -ForegroundColor Yellow

try {
    # Run agent in foreground so logs are visible
    & ".venv\Scripts\python" "$root\agent.py" dev
} finally {
    Write-Host "`nStopping token server..." -ForegroundColor Yellow
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -ErrorAction SilentlyContinue
    Write-Host "Done." -ForegroundColor Green
}
