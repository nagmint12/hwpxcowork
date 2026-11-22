@echo off
setlocal
set "HWPX_MCP_NODE=%~dp0..\..\..\runtime\node.exe"
if not exist "%HWPX_MCP_NODE%" set "HWPX_MCP_NODE=node"
"%HWPX_MCP_NODE%" "%~dp0hwpx-mcp.mjs" %*
exit /b %ERRORLEVEL%
