# Notie frontend runner
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\frontend

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing frontend packages..." -ForegroundColor Cyan
    npm install
}

$hostName = if ($env:NOTIE_FRONTEND_HOST) { $env:NOTIE_FRONTEND_HOST } else { "localhost" }
$port = if ($env:NOTIE_FRONTEND_PORT) { [int]$env:NOTIE_FRONTEND_PORT } else { 5173 }
if (-not $env:VITE_API_TARGET) {
    $backendPort = if ($env:NOTIE_BACKEND_PORT) { [int]$env:NOTIE_BACKEND_PORT } else { 8000 }
    $env:VITE_API_TARGET = "http://127.0.0.1:$backendPort"
}

$defaultHttpsPfx = Join-Path $PSScriptRoot ".certs\notie-lan-dev.pfx"
if (-not $env:NOTIE_HTTPS_PFX -and (Test-Path $defaultHttpsPfx)) {
    $env:NOTIE_HTTPS_PFX = (Resolve-Path $defaultHttpsPfx).Path
    if (-not $env:NOTIE_HTTPS_PFX_PASSPHRASE) {
        $env:NOTIE_HTTPS_PFX_PASSPHRASE = "notie-dev"
    }
}

$scheme = if ($env:NOTIE_HTTPS_PFX) { "https" } else { "http" }
Write-Host "Starting frontend: ${scheme}://$hostName`:$port" -ForegroundColor Green
npm run dev -- --host $hostName --port $port
