@echo off
setlocal
set "HWPX_LAUNCH_PROVIDER=gemini-cli"
call "%~dp0start-google-agent.bat" %*
exit /b %errorlevel%
