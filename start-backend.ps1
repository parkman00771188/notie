# Gimnote 백엔드 실행 스크립트
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\backend

if (-not (Test-Path ".venv")) {
    Write-Host "가상환경 생성 중..." -ForegroundColor Cyan
    python -m venv .venv
}

Write-Host "의존성 설치 확인 중..." -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt

Write-Host "백엔드 시작: http://127.0.0.1:8000" -ForegroundColor Green
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
