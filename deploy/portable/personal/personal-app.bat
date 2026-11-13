@echo off
chcp 65001 >nul
setlocal
rem hwpx-cowork 개인용 앱 — 두 번 클릭. 이 PC 에서만 열리는 서버를 켜고 앱 창을 연다(중앙 서버에 접속하지 않는다).
rem 처음 실행하면 연결할 PC 폴더를 고르는 창이 뜬다 — 그 폴더의 HWPX 를 열어 고치면 그 파일에 저장된다.
rem 폴더를 이 파일 위에 끌어다 놓으면 그 폴더를 연결한다. 앱은 작업 표시줄의 최소화된 창으로 돌고, 앱 창을 닫으면 함께 꺼진다.
rem 설정·기록은 userdata-personal\ (환경 변수 HWPX_COWORK_USERDATA 로 다른 폴더 지정 가능). 이미 떠 있으면 앱 창만 하나 더 연다.
cd /d "%~dp0"
call "%~dp0app\portable\ensure-node.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)
if not defined HWPX_COWORK_USERDATA set "HWPX_COWORK_USERDATA=%~dp0userdata-personal"
if exist "%~dp0app\portable\install-dependencies.mjs" (
  "%NODE%" "%~dp0app\portable\install-dependencies.mjs" --check
  if errorlevel 1 (
    echo [설치 필요] install-dependencies.bat 를 먼저 실행하세요.
    pause
    exit /b 1
  )
)
start "hwpx-cowork 개인용 앱 (닫으면 앱도 꺼짐)" /min "%NODE%" "%~dp0app\portable\personal.mjs" %*
exit /b 0
