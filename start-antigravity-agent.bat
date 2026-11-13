@echo off
setlocal
set "HWPX_LAUNCH_PROVIDER=antigravity"
call "%~dp0start-google-agent.bat" %*
exit /b %errorlevel%
