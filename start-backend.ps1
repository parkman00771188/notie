# Notie backend runner
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\backend

if (-not (Test-Path ".venv")) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Cyan
    python -m venv .venv
}

Write-Host "Installing/checking backend dependencies..." -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt

$hostName = if ($env:NOTIE_BACKEND_HOST) { $env:NOTIE_BACKEND_HOST } else { "127.0.0.1" }
$port = if ($env:NOTIE_BACKEND_PORT) { [int]$env:NOTIE_BACKEND_PORT } else { 8000 }

Write-Host "Starting backend: http://$hostName`:$port" -ForegroundColor Green
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host $hostName --port $port
