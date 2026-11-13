@echo off
rem Sets NODE to a usable Node.js (major >= 22): this package's runtime\node.exe first, then node on PATH.
rem Leaves NODE empty when none is usable; NODE_OLD holds the major version of a too-old node on PATH.
rem Called with CALL from the start scripts (no setlocal here, so NODE reaches the caller).
set "NODE="
set "NODE_OLD="
set "NODE_MAJOR="
if exist "%~dp0..\..\runtime\node.exe" (
  set "NODE=%~dp0..\..\runtime\node.exe"
  exit /b 0
)
where node >nul 2>&1 || exit /b 0
for /f "delims=" %%v in ('node -p "parseInt(process.versions.node)" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR exit /b 0
if %NODE_MAJOR% GEQ 22 (
  set "NODE=node"
) else (
  set "NODE_OLD=%NODE_MAJOR%"
)
exit /b 0
