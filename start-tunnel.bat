@echo off
chcp 65001 >nul
setlocal
rem 인터넷 임시 주소 열기(Cloudflare Quick Tunnel) — 두 번 클릭. 이 창을 켜 둔 동안만 https://….trycloudflare.com 으로 접속된다.
rem 열면 그 주소를 서버 공유 주소로 저장하고 서버를 다시 시작한다. Ctrl+C·창 닫기·터널 끊김이면 공유 주소를 로컬로 되돌린다.
rem 켤 때마다 주소가 바뀌고, SSE 스트림은 안 된다(웹 공동 편집은 됨). 처음 한 번: winget install --id Cloudflare.cloudflared -e
cd /d "%~dp0"
title hwpx-cowork 인터넷 임시 주소 (Cloudflare Quick Tunnel)

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 없습니다. https://nodejs.org 에서 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

set "PORT="
for /f "usebackq delims=" %%p in (`node -e "let c={};try{c=require(process.env.HWPX_COWORK_CONFIG?require('path').resolve(process.env.HWPX_COWORK_CONFIG):'./config.json')}catch{}const p=Number(process.env.HWPX_COWORK_PORT||c.port||8787);if(Number.isInteger(p)&&p>0&&p<65536)console.log(p)"`) do set "PORT=%%p"
if not defined PORT set "PORT=8787"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo 서버가 꺼져 있어 start-server.bat 로 먼저 켭니다...
  start "" "%~dp0start-server.bat"
  powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
  if errorlevel 1 (
    echo [오류] 서버가 응답하지 않습니다. 서버 창을 확인한 뒤 다시 실행하세요.
    pause
    exit /b 1
  )
)

node scripts\quick-tunnel.mjs %*
echo.
echo 터널이 꺼졌습니다.
pause
