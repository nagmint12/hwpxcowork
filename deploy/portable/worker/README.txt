hwpx 개인 AI 실행기 (포터블)
==============================

중앙 hwpx-cowork 서버에 맡긴 "내 검토 요청"을 내 AI 계정으로 자동 처리하는 작은 프로그램입니다.
결과는 문서에 제안·의견으로 남고, 반영은 웹 편집기에서 사람이 결정합니다(본문 자동 반영 없음).
서버·편집기는 들어 있지 않습니다. 내 PC 에서 서버를 켤 필요가 없습니다.

준비물
  - 중앙 서버 MCP 주소(예: https://hwpx.기관도메인/mcp)와 본인 토큰 — 관리자에게 받습니다.
  - AI 계정 중 하나
      ChatGPT 로그인: Codex CLI 설치 후 터미널에서 codex login  (API 키 불필요, 계정 사용 한도 적용)
      Claude 로그인: Claude Code 설치 후 claude auth login  (API 키 불필요, 구독 사용 한도 적용)
      API 키(BAZE_API_KEY), OpenAI·Claude·Gemini API 키(사용료 별도)
      Gemini CLI 로그인

Node.js
  - 이 PC 에 Node.js 22 이상이 있으면 그것을 씁니다(lite 판은 Node 를 넣지 않아 약 4 MB).
  - 없으면 처음 켤 때 공식 Node.js 를 이 폴더 runtime\ 에 내려받을지 묻습니다(약 30 MB, 관리자 권한 불필요).
    미리 받으려면 install-node.bat(macOS·Linux 는 ./install-node.sh). runtime 이 들어 있는 win-x64 판은 인터넷이 막힌 PC 용입니다.

Windows
  0. 인터넷에서 받은 ZIP 이면 ZIP 파일 [속성] → '차단 해제' 체크 뒤 풉니다.
  1. ZIP 을 풀고 worker-settings.txt 를 메모장으로 열어 서버 주소(HWPX_COWORK_URL)와 AI 방식(WORKER_ARGS)을 고릅니다.
     API 방식이면 WORKER_KEY_ENV 에 키 변수 이름(예: BAZE_API_KEY)도 적습니다.
  2. check-worker.bat — 처음에 토큰(필요하면 API 키)을 묻고 사용자 환경 변수에 저장한 뒤 연결만 점검합니다.
  3. start-worker.bat — 켜 두는 동안 새 요청과 밀린 요청을 오래된 순서로 처리합니다. 끄기: Ctrl+C.
  4. Claude 구독을 쓰면 start-claude-agent.bat — 채널 없이 기존 대기 요청과 새 요청을 자동 처리합니다.
     점검만 하려면 start-claude-agent.bat --check. 사용자 MCP 등록·개발 채널 옵션은 필요 없습니다.
     또는 worker-settings.txt 에 WORKER_ARGS=--provider claude-code 를 고르고 start-worker.bat 를 씁니다.
     최신 Claude Code의 --restricted 지원이 필요합니다. API 키 로그인은 거절하며 명령 실행 도구는 주지 않습니다.
     그림은 SVG·차트 MCP 도구로 만듭니다. 모델·추론 강도는 웹의 'AI 모델·추론 강도'에서 요청마다 적용됩니다.

macOS·Linux
  Node.js 22 이상이 없으면 ./install-node.sh 를 한 번 실행합니다. worker-settings.txt 를 고친 뒤
    export HWPX_COWORK_TOKEN='본인 토큰'      (API 방식이면 키 변수도 export)
    ./start-worker.sh --check
    ./start-worker.sh

멀티에이전트(지휘자·작업자) 실행: app\docs\MULTI_AGENT_ORCHESTRATION.md
  예) node app\scripts\orchestration-worker.mjs --agent-id codex --provider codex   (포함판은 runtime\node.exe)

주의
  - 토큰은 문서 서버 로그인 수단, API 키는 AI 사용료가 걸린 인증 수단입니다. 다른 사람과 공유하지 마세요.
  - 요청의 문서 문맥·첨부는 내가 고른 AI 로 전달됩니다. 기관 정책에 맞는 계정을 쓰세요.
  - 저장된 토큰 지우기: 명령 프롬프트에서  reg delete HKCU\Environment /v HWPX_COWORK_TOKEN /f
