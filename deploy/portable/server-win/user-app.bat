@echo off
chcp 65001 >nul
setlocal
rem 사용자 앱 — 이 PC 의 서버 편집 화면을 앱 창(Edge·Chrome 의 --app 창, 없으면 기본 브라우저)으로 연다.
rem 서버를 켜고 끄는 일은 관리자 앱(admin-app.bat)에서 한다. 다른 PC 의 참여자에게는 관리자 앱의 [참여자용 앱]을 준다.
cd /d "%~dp0"
call "%~dp0app\portable\find-node.cmd"
if not defined NODE (
  echo 서버를 먼저 관리자 앱^(admin-app.bat^)으로 켜세요.
  timeout /t 5 >nul 2>&1
  exit /b 1
)
if not defined HWPX_COWORK_USERDATA set "HWPX_COWORK_USERDATA=%~dp0userdata"
set "HWPX_COWORK_OPEN_WAIT_MS=3000"
"%NODE%" "%~dp0app\portable\portable.mjs" open
if errorlevel 1 timeout /t 5 >nul 2>&1
