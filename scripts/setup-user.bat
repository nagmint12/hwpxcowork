@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-user.ps1" %*
exit /b %errorlevel%
