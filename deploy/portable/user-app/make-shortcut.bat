@echo off
chcp 65001 >nul
setlocal
rem 바탕 화면에 'hwpx-cowork' 바로 가기를 만든다 — 누르면 server-url.txt 의 서버를 앱 창으로 연다(이 폴더가 없어도 동작).
cd /d "%~dp0"
set "URL="
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0server-url.txt") do if /i "%%a"=="HWPX_COWORK_SERVER" set "URL=%%b"
if not defined URL (
  echo [설정 필요] server-url.txt 에 서버 주소를 적으세요.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1" -Name "hwpx-cowork" -Url "%URL%" -Icon "%~dp0hwpx-cowork.ico"
pause
