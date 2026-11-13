@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
rem Google CLI 자동 처리 실행기. 두 번 클릭하면 기존 대기 요청부터 처리한다.
rem 추가 인자는 ai-worker에 전달한다: --check, --model ID, --url https://서버/mcp
if not defined HWPX_LAUNCH_PROVIDER set "HWPX_LAUNCH_PROVIDER=gemini-cli"
if not "%HWPX_LAUNCH_PROVIDER%"=="gemini-cli" if not "%HWPX_LAUNCH_PROVIDER%"=="antigravity" exit /b 1
set "AGENT_EXIT=1"
set "AGENT_PAUSE="
if "%~1"=="" set "AGENT_PAUSE=1"
pushd "%~dp0"
if errorlevel 1 exit /b 1
title hwpx-cowork 에이전트 (Google CLI 자동 처리)

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js가 없습니다. https://nodejs.org 에서 설치하세요.
  goto finish
)
if not exist node_modules\@modelcontextprotocol\sdk\package.json (
  echo [오류] 필요한 패키지가 없습니다. 이 폴더에서 npm install을 실행하세요.
  goto finish
)
if /i "%~1"=="--help" goto run
if /i "%~1"=="-h" goto run

rem setx 저장 후 부모 프로그램을 다시 열지 않았어도 사용자 환경 변수를 읽는다.
if not defined HWPX_COWORK_TOKEN for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v HWPX_COWORK_TOKEN 2^>nul ^| findstr /i HWPX_COWORK_TOKEN') do set "HWPX_COWORK_TOKEN=%%b"
if not defined HWPX_COWORK_TOKEN (
  echo [오류] HWPX 개인 토큰이 없습니다. 한 번만 아래 명령을 실행하세요.
  echo     setx HWPX_COWORK_TOKEN "내-개인-토큰"
  echo Google CLI 로그인도 처음 한 번 필요합니다: gemini 또는 agy
  goto finish
)

rem 주소는 이 PC 서버(설정 포트)로 고정한다. 환경 변수 HWPX_COWORK_URL(예전 ngrok 등)은 쓰지 않고, 원격은 --url 로만 지정한다.
set "SERVERPORT="
for /f "delims=" %%p in ('node -e "let c={};try{c=require('./config.json')}catch{}const p=Number(process.env.HWPX_COWORK_PORT||c.port||8787);if(Number.isInteger(p)&&p>0&&p<65536)console.log(p)"') do set "SERVERPORT=%%p"
if not defined SERVERPORT (
  echo [오류] 서버 포트 설정을 확인하세요.
  goto finish
)
set "HWPX_COWORK_URL=http://localhost:%SERVERPORT%/mcp"

rem 실제 --url 옵션을 포함해 파싱한다. 토큰과 URL은 화면에 출력하지 않는다.
node --input-type=module -e "import {parseWorkerArgs} from './scripts/ai-worker.mjs';parseWorkerArgs([...process.argv.slice(1),'--provider',process.env.HWPX_LAUNCH_PROVIDER])" -- %*
if errorlevel 1 goto finish
set "LOCALPORT="
for /f "delims=" %%p in ('node --input-type=module -e "import {parseWorkerArgs} from './scripts/ai-worker.mjs';const o=parseWorkerArgs([...process.argv.slice(1),'--provider',process.env.HWPX_LAUNCH_PROVIDER]);const u=new URL(o.url);if(['localhost','127.0.0.1','[::1]'].includes(u.hostname))console.log(u.port||(u.protocol==='https:'?443:80))" -- %*') do set "LOCALPORT=%%p"
if not defined LOCALPORT goto run

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %LOCALPORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 }; exit 1"
if not errorlevel 1 goto run
if not "%LOCALPORT%"=="%SERVERPORT%" (
  echo [오류] 지정한 로컬 주소에 서버가 없습니다. 해당 서버를 먼저 켜세요.
  goto finish
)
echo 로컬 서버가 꺼져 있어 start-server.bat로 먼저 켭니다...
start "" "%~dp0start-server.bat"
powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort %LOCALPORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo [오류] 서버 시작을 확인하지 못했습니다. 서버 창을 확인하고 다시 실행하세요.
  goto finish
)

:run
echo.
echo  Google CLI 자동 처리 실행기 - 본인 Google CLI 로그인 사용
echo   - 최초 로그인: gemini 또는 agy를 대화형으로 실행하세요.
echo   - 이 창을 켜 두면 본인의 기존 대기 요청과 새 요청을 자동 처리합니다.
echo   - 점검만 실행: start-gemini-agent.bat --check 또는 start-antigravity-agent.bat --check
echo   - 종료: Ctrl+C
echo.
node scripts\ai-worker.mjs %* --provider %HWPX_LAUNCH_PROVIDER%
set "AGENT_EXIT=%errorlevel%"
echo.
echo Google CLI 실행기가 끝났습니다. 종료 코드: %AGENT_EXIT%

:finish
popd
if defined AGENT_PAUSE pause
exit /b %AGENT_EXIT%
