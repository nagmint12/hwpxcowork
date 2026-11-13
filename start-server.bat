@echo off
chcp 65001 >nul
setlocal
rem Keep this CMD entry point ASCII-only: UTF-8 Korean batch lines can be split
rem into commands by CMD when launched from Explorer. Node prints Korean logs.
rem Port: HWPX_COWORK_PORT > config.json > 8787. NO_BROWSER=1 disables opening.
cd /d "%~dp0"
title hwpx-cowork server

where node >nul 2>&1
if errorlevel 1 (
  echo [Error] Node.js is missing. Install it from https://nodejs.org and retry.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo [Error] npm install failed.
    pause
    exit /b 1
  )
)

if not exist studio\dist\index.html (
  echo Building the editor ^(npm run build:studio^)...
  call npm run build:studio
  if errorlevel 1 (
    echo [Error] Editor build failed.
    pause
    exit /b 1
  )
)

set "PORT=%HWPX_COWORK_PORT%"
if not defined PORT for /f "usebackq delims=" %%p in (`node -e "try{console.log(require('./config.json').port||8787)}catch{console.log(8787)}"`) do set "PORT=%%p"
title hwpx-cowork server (port %PORT%)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo Already running: http://localhost:%PORT%
  echo Use the admin panel to restart, or stop-server.bat to stop.
  if not "%HWPX_COWORK_NO_BROWSER%"=="1" start "" "http://localhost:%PORT%/"
  timeout /t 5 >nul 2>&1
  exit /b 0
)

rem Open the browser after the server responds (up to 30 seconds).
if not "%HWPX_COWORK_NO_BROWSER%"=="1" start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:%PORT%/' | Out-Null; Start-Process 'http://localhost:%PORT%/'; break } catch { Start-Sleep -Milliseconds 500 } }"

echo.
echo  Starting hwpx-cowork (port %PORT%)
echo   - Browser: http://localhost:%PORT%/
echo   - Stop: Ctrl+C, close this window, or run stop-server.bat
echo   - Keep this window open while using the server and MCP.
echo   - The admin panel supports settings and graceful restart.
echo.
node "%~dp0server\launcher.js"
echo.
echo Server stopped (exit code %errorlevel%).
pause
