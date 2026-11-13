@echo off
chcp 65001 >nul
setlocal
rem 명시적인 종료 기록을 남기고 진행 중 저장을 마친 뒤 끈다. 자동 복구도 중지한다.
cd /d "%~dp0"

node "%~dp0server\control-cli.js" stop
if errorlevel 1 (
  echo 종료 요청을 완료하지 못했습니다. 기존 저장 작업과 실행기 상태를 확인하세요.
  goto :end
)
echo 서버 종료를 요청했습니다. 다음에 직접 켤 때까지 자동 복구하지 않습니다.

:end
timeout /t 3 >nul 2>&1
