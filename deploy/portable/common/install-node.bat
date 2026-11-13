@echo off
chcp 65001 >nul
setlocal
rem 공식 Node.js(__NODE_VERSION__)를 nodejs.org 에서 받아 SHA-256 을 확인하고 이 폴더의 runtime\ 에 넣는다(약 30 MB).
rem 관리자 권한·시스템 설치·PATH 변경 없음 — 지우려면 runtime\ 폴더를 지운다. 이미 Node.js 22 이상이 설치된 PC 에서는 필요 없다.
rem 시스템 전체에 설치하고 싶으면 대신:  winget install -e --id OpenJS.NodeJS.LTS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\portable\install-node.ps1" -Target "%~dp0runtime"
set "RC=%errorlevel%"
if not "%~1"=="--called" pause
exit /b %RC%
