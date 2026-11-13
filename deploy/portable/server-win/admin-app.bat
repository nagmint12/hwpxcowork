@echo off
chcp 65001 >nul
setlocal
rem hwpx-cowork 관리자 앱 — 두 번 클릭. 관리 창(이 PC 에서만 열림)에서 서버 켜기·끄기·다시 켜기, 주소·관리자 토큰, 참여자용 앱 만들기를 한다.
rem 관리자 앱은 작업 표시줄의 최소화된 창으로 돈다 — 그 창을 닫으면 서버도 꺼진다. 이미 떠 있으면 관리 창만 다시 연다.
rem 편집 화면(사용자 앱)은 관리 창의 [편집 화면 열기] 또는 user-app.bat. 콘솔로만 켜려면 start-server.bat.
cd /d "%~dp0"
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
start "hwpx-cowork 관리자 앱 (닫으면 서버도 꺼짐)" /min "%NODE%" "%~dp0app\portable\manager.mjs"
exit /b 0
