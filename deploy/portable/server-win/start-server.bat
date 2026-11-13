@echo off
chcp 65001 >nul
setlocal
rem hwpx-cowork 서버 켜기 — 두 번 클릭. 이 폴더의 runtime\node.exe, 없으면 이 PC 에 설치된 Node.js 22 이상을 쓴다.
rem 둘 다 없으면 공식 Node.js 를 runtime\ 에 내려받을지 묻는다(install-node.bat, 관리자 권한 불필요).
rem 설정·문서는 userdata\ 에 저장된다(환경 변수 HWPX_COWORK_USERDATA 로 다른 폴더 지정 가능). 이 창을 닫거나 Ctrl+C 를 누르면 꺼진다.
rem HWPX_COWORK_NO_BROWSER=1 이면 창을 열지 않고, HWPX_COWORK_BROWSER=default 면 앱 창 대신 기본 브라우저로 연다.
cd /d "%~dp0"
title hwpx-cowork 서버
call "%~dp0app\portable\ensure-node.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
if not defined HWPX_COWORK_USERDATA set "HWPX_COWORK_USERDATA=%~dp0userdata"
if exist "%~dp0app\portable\install-dependencies.mjs" (
  "%NODE%" "%~dp0app\portable\install-dependencies.mjs" --check
  if errorlevel 1 (
    echo [설치 필요] install-dependencies.bat 를 먼저 실행하세요.
    pause
    exit /b 1
  )
)

"%NODE%" "%~dp0app\portable\portable.mjs" init
if errorlevel 4 (
  pause
  exit /b 1
)
if errorlevel 3 goto already
if errorlevel 1 (
  echo [오류] 첫 실행 준비에 실패했습니다.
  pause
  exit /b 1
)

set "HWPX_COWORK_CONFIG=%HWPX_COWORK_USERDATA%\config.json"
if not "%HWPX_COWORK_NO_BROWSER%"=="1" start "" /b "%NODE%" "%~dp0app\portable\portable.mjs" open
echo  - 끄기: 이 창에서 Ctrl+C 또는 창 닫기 (stop-server.bat 도 됨)
echo  - AI(MCP)를 쓰는 동안 이 창을 켜 두세요
echo.
"%NODE%" "%~dp0app\server\launcher.js"
echo.
echo 서버가 멈췄습니다 (종료 코드 %errorlevel%).
pause
exit /b 0

:already
if not "%HWPX_COWORK_NO_BROWSER%"=="1" "%NODE%" "%~dp0app\portable\portable.mjs" open
timeout /t 5 >nul 2>&1
exit /b 0
