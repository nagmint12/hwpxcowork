@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
rem Claude 구독 자동 실행기 — 개발 채널·사용자 MCP 등록 없이 요청마다 claude -p 로 처리한다.
rem 이름은 기존 ZIP의 바로가기를 유지한다. WORKER_ARGS·API 키 설정은 쓰지 않는다.
set "AGENT_EXIT=1"
set "AGENT_PAUSE="
if "%~1"=="" set "AGENT_PAUSE=1"
pushd "%~dp0"
if errorlevel 1 exit /b 1
title hwpx 개인 AI 실행기 (Claude Code 구독)
call "%~dp0app\portable\ensure-node.cmd"
if errorlevel 1 goto finish
if exist "%~dp0app\portable\install-dependencies.mjs" (
  "%NODE%" "%~dp0app\portable\install-dependencies.mjs" --check
  if errorlevel 1 (
    echo [설치 필요] install-dependencies.bat 를 먼저 실행하세요.
    goto finish
  )
)
if /i "%~1"=="--help" goto run
if /i "%~1"=="-h" goto run
if exist "%~dp0worker-settings.txt" for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0worker-settings.txt") do if /i "%%a"=="HWPX_COWORK_URL" set "HWPX_COWORK_URL=%%b"
if not defined HWPX_COWORK_TOKEN for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v HWPX_COWORK_TOKEN 2^>nul ^| findstr /i HWPX_COWORK_TOKEN') do set "HWPX_COWORK_TOKEN=%%b"
if not defined HWPX_COWORK_TOKEN (
  echo [오류] 본인 HWPX 토큰이 없습니다. check-worker.bat 를 한 번 실행해 저장하세요.
  goto finish
)

:run
echo.
echo Claude Code 구독 자동 처리 - 최초 로그인: claude auth login
echo 이 창을 켜 두면 기존 대기 요청과 새 요청을 자동 처리합니다. 종료: Ctrl+C
echo 점검만: start-claude-agent.bat --check  /  도움말: start-claude-agent.bat --help
echo API 키는 사용하지 않습니다. 구독 사용 한도에서 차감됩니다.
echo.
"%NODE%" "%~dp0app\scripts\ai-worker.mjs" %* --provider claude-code
set "AGENT_EXIT=%errorlevel%"

:finish
popd
if defined AGENT_PAUSE pause
exit /b %AGENT_EXIT%
