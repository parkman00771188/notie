# Notie 프론트엔드 실행 스크립트
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\frontend

if (-not (Test-Path "node_modules")) {
    Write-Host "npm 패키지 설치 중..." -ForegroundColor Cyan
    npm install
}

Write-Host "프론트엔드 시작: http://localhost:5173" -ForegroundColor Green
npm run dev
