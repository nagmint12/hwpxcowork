@echo off
chcp 65001 >nul
setlocal
rem hwpx-cowork 사용자 앱 — 두 번 클릭하면 서버의 편집 화면을 앱 창(Edge·Chrome, 주소창 없음)으로 연다. 설치할 것이 없다.
rem 서버 주소는 server-url.txt. 바탕 화면에 바로 가기를 만들려면 make-shortcut.bat.
cd /d "%~dp0"
call :url || exit /b 1
call :browser
if defined BROWSER (
  start "" "%BROWSER%" --app=%URL%
) else (
  start "" "%URL%"
)
exit /b 0

:url
set "URL="
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0server-url.txt") do if /i "%%a"=="HWPX_COWORK_SERVER" set "URL=%%b"
if defined URL exit /b 0
echo [설정 필요] server-url.txt 에 관리자에게 받은 서버 주소를 적으세요.
pause
exit /b 1

:browser
set "BROWSER="
for %%p in ("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe") do if not defined BROWSER if exist %%p set "BROWSER=%%~p"
exit /b 0
