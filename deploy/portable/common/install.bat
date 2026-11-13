@echo off
call "%~dp0install-dependencies.bat" %*
exit /b %errorlevel%
