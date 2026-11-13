@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
call "%~dp0app\portable\ensure-node.cmd"
if errorlevel 1 exit /b 1
"%NODE%" "%~dp0app\portable\install-dependencies.mjs"
set "RC=%errorlevel%"
if not "%~1"=="--called" pause
exit /b %RC%
