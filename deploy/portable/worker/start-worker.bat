@echo off
chcp 65001 >nul
setlocal
rem 개인 AI 실행기 켜기 — 두 번 클릭. 중앙 서버에 맡긴 내 검토 요청을 내 AI 계정으로 처리해 제안·의견으로 돌려준다(본문 자동 반영 없음).
rem 설정: worker-settings.txt(서버 주소·AI 방식). 토큰·API 키: 처음 실행할 때 묻고 사용자 환경 변수(setx)에 저장한다.
rem 덧붙인 인자는 실행기에 그대로 넘긴다(예: start-worker.bat --check).
rem Node: 이 폴더의 runtime\node.exe, 없으면 설치된 Node.js 22 이상. 둘 다 없으면 공식 Node 를 runtime\ 에 받을지 묻는다.
cd /d "%~dp0"
title hwpx 개인 AI 실행기
call "%~dp0app\portable\ensure-node.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
if exist "%~dp0app\portable\install-dependencies.mjs" (
  "%NODE%" "%~dp0app\portable\install-dependencies.mjs" --check
  if errorlevel 1 (
    echo [설치 필요] install-dependencies.bat 를 먼저 실행하세요.
    pause
    exit /b 1
  )
)
call :settings || exit /b 1

call :fromreg HWPX_COWORK_TOKEN
if defined HWPX_COWORK_TOKEN goto key
echo 중앙 서버 관리자에게 받은 본인 토큰을 붙여 넣으세요. 이 PC 사용자 환경 변수에 저장되어 다음부터 묻지 않습니다.
:asktoken
set /p "HWPX_COWORK_TOKEN=토큰: "
if not defined HWPX_COWORK_TOKEN goto asktoken
setx HWPX_COWORK_TOKEN "%HWPX_COWORK_TOKEN%" >nul

:key
if not defined WORKER_KEY_ENV goto run
call :fromreg %WORKER_KEY_ENV%
call set "WORKER_KEY_VALUE=%%%WORKER_KEY_ENV%%%"
if defined WORKER_KEY_VALUE goto run
echo %WORKER_KEY_ENV% 가 없습니다. AI API 키를 붙여 넣으세요(사용자 환경 변수에 저장).
:askkey
set /p "WORKER_KEY_VALUE=%WORKER_KEY_ENV%: "
if not defined WORKER_KEY_VALUE goto askkey
setx %WORKER_KEY_ENV% "%WORKER_KEY_VALUE%" >nul
set "%WORKER_KEY_ENV%=%WORKER_KEY_VALUE%"

:run
set "WORKER_KEY_VALUE="
echo.
echo  hwpx 개인 AI 실행기
echo   - 서버: %HWPX_COWORK_URL%
echo   - AI 방식: %WORKER_ARGS%
echo   - 끄기: Ctrl+C 또는 창 닫기. 설정 바꾸기: worker-settings.txt
echo.
"%NODE%" "%~dp0app\scripts\ai-worker.mjs" %WORKER_ARGS% %*
echo.
echo 실행기가 멈췄습니다 (종료 코드 %errorlevel%).
pause
exit /b 0

rem worker-settings.txt 의 KEY=VALUE 줄만 읽는다('#' 줄은 설명). 메모장이 줄 끝을 바꿔 저장해도 된다
:settings
if not exist "%~dp0worker-settings.txt" (
  echo [오류] worker-settings.txt 가 없습니다.
  pause
  exit /b 1
)
set "HWPX_COWORK_URL="
set "WORKER_ARGS="
set "WORKER_KEY_ENV="
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0worker-settings.txt") do (
  if /i "%%a"=="HWPX_COWORK_URL" set "HWPX_COWORK_URL=%%b"
  if /i "%%a"=="WORKER_ARGS" set "WORKER_ARGS=%%b"
  if /i "%%a"=="WORKER_KEY_ENV" set "WORKER_KEY_ENV=%%b"
)
if not defined WORKER_ARGS (
  echo [설정 필요] worker-settings.txt 에서 AI 방식^(WORKER_ARGS^) 한 줄의 # 을 지우세요.
  pause
  exit /b 1
)
exit /b 0

rem 이 창에 없는 환경 변수는 setx 로 저장된 값(HKCU\Environment)에서 읽는다 — 값은 화면에 보이지 않는다
:fromreg
if defined %1 exit /b 0
for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v %1 2^>nul ^| findstr /i /c:"%1"') do set "%1=%%b"
exit /b 0
