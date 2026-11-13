@echo off
chcp 65001 >nul
setlocal
rem 내 에이전트(Claude Code 채널 세션) 띄우기 — 두 번 클릭. 웹에서 맡긴 AI 작업을 이 창의 Claude 가 알림으로 받아 처리한다.
rem = cd agent ^& claude --dangerously-load-development-channels server:hwpx  (덧붙인 인자는 claude 에 그대로 넘김. 예: start-agent.bat --debug)
rem 개발은 이 PC 서버(localhost)만 쓴다 — agent\.mcp.json 이 다른 주소(예: 예전 ngrok)면 http://localhost:포트/mcp 로 고친다.
rem 서버가 꺼져 있으면 start-server.bat 로 먼저 켠다. 이 창을 닫으면 에이전트 연결도 끊긴다.
cd /d "%~dp0agent"
title hwpx-cowork 에이전트 (Claude Code 채널)

where claude >nul 2>&1
if errorlevel 1 (
  echo [오류] claude 명령이 없습니다. Claude Code 를 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

if not exist .mcp.json (
  echo agent\.mcp.json 이 없어 만듭니다 ^(node scripts\setup-agent.mjs^)...
  pushd ..
  node scripts\setup-agent.mjs
  popd
)
if not exist .mcp.json (
  echo [오류] agent\.mcp.json 을 만들지 못했습니다. docs\AGENT_SETUP.md 를 보세요.
  pause
  exit /b 1
)

rem 토큰: setx 로 저장했는데 이 창을 연 프로그램이 그 전에 떠 있었으면 환경 변수가 비어 있다 — 사용자 환경 변수(레지스트리)에서 읽는다
if not defined HWPX_COWORK_TOKEN for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v HWPX_COWORK_TOKEN 2^>nul ^| findstr /i HWPX_COWORK_TOKEN') do set "HWPX_COWORK_TOKEN=%%b"
if not defined HWPX_COWORK_TOKEN (
  echo [오류] 토큰 환경 변수 HWPX_COWORK_TOKEN 이 없습니다. 한 번만 아래를 실행한 뒤 이 파일을 다시 실행하세요.
  echo     setx HWPX_COWORK_TOKEN "내-토큰"
  pause
  exit /b 1
)

rem 이 PC 서버 포트(HWPX_COWORK_PORT > config.json 의 port > 8787)로 .mcp.json 주소를 맞춘다
set "LOCALPORT="
for /f "usebackq delims=" %%p in (`node -e "let c={};try{c=require('../config.json')}catch{}const p=Number(process.env.HWPX_COWORK_PORT||c.port||8787);if(Number.isInteger(p)&&p>0&&p<65536)console.log(p)"`) do set "LOCALPORT=%%p"
if not defined LOCALPORT set "LOCALPORT=8787"
node -e "const fs=require('fs');const f='.mcp.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));const a=j.mcpServers.hwpx.args;const i=a.indexOf('--url');const want='http://localhost:'+process.argv[1]+'/mcp';if(i<0||a[i+1]===want)process.exit(0);a[i+1]=want;fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');console.log('agent/.mcp.json 의 서버 주소를 '+want+' 로 바꿨습니다')" %LOCALPORT%
if errorlevel 1 (
  echo [오류] agent\.mcp.json 을 읽지 못했습니다. 지우고 다시 실행하면 새로 만듭니다.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %LOCALPORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo 서버가 꺼져 있어 start-server.bat 로 먼저 켭니다...
  start "" "%~dp0start-server.bat"
  powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort %LOCALPORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
  if errorlevel 1 echo [주의] 서버가 아직 응답하지 않습니다. 서버 창을 확인하세요.
)

rem 웹 문서함 'AI 모델·추론 강도'의 Claude Code 칸(정했으면) → --model·--effort (scripts\run-settings.mjs, 영문·숫자와 . _ : / @ - 만)
set "RUNARGS="
for /f "usebackq delims=" %%a in (`node ..\scripts\run-settings.mjs claude-code --port %LOCALPORT%`) do set "RUNARGS=%%a"

rem Context size policy (docs\MCP_LEAN_FLOW_2026-11-10.md section 6, same values as scripts\agent-hidden.ps1):
rem   idle compaction when the conversation is 120k tokens or more (about 54 minutes after the last request),
rem   hard auto-compact window 400k. Set the variables yourself before running this file to override.
if not defined CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS set "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS=120000"
if not defined CLAUDE_CODE_AUTO_COMPACT_WINDOW set "CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000"

echo.
echo  내 에이전트^(Claude Code^)를 채널로 띄웁니다 — %CD%
if defined RUNARGS echo   - 웹에서 정한 모델·추론 강도: %RUNARGS%
echo   - 서버: http://localhost:%LOCALPORT%/mcp ^(이 PC^)
echo   - 처음 한 번: 'I am using this for local development', 'Use this MCP server' 를 고르세요
echo   - 시작 배너 아래 'Channels (experimental) ... server:hwpx' 줄이 보이면 연결된 것입니다
echo   - 끝내려면 /exit 또는 이 창 닫기
echo.
call claude --dangerously-load-development-channels server:hwpx %RUNARGS% %*
echo.
echo Claude Code 가 끝났습니다.
pause
