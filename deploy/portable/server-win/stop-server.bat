@echo off
chcp 65001 >nul
setlocal
rem 명시적인 종료 기록을 남겨 자동 복구를 멈추고 기존 저장 작업을 기다린다.
cd /d "%~dp0"
call "%~dp0app\portable\ensure-node.cmd"
if errorlevel 1 exit /b 1
if not defined HWPX_COWORK_USERDATA set "HWPX_COWORK_USERDATA=%~dp0userdata"
set "HWPX_COWORK_CONFIG=%HWPX_COWORK_USERDATA%\config.json"
"%NODE%" "%~dp0app\server\control-cli.js" stop
if errorlevel 1 (
  echo 서버 종료를 완료하지 못했습니다. 실행기 상태를 확인하세요.
) else (
  echo 종료를 요청했습니다. 다음에 직접 켤 때까지 자동 복구하지 않습니다.
)
timeout /t 3 >nul 2>&1
