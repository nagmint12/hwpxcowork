hwpx-cowork 서버 (Windows 10/11)
=================================

HWPX(한글) 문서를 브라우저에서 함께 열고, 메모·변경 추적·AI 제안(MCP)으로 공동 검토하는 서버입니다.
npm·Rust·한글 프로그램을 설치하지 않아도 됩니다. 미리 빌드한 편집기·엔진(WASM)이 들어 있습니다.

0. Node.js
   - 이 PC 에 Node.js 22 이상이 있으면 그것을 씁니다(lite 판은 Node 를 넣지 않아 작습니다).
   - 없으면 처음 켤 때 "공식 Node.js 를 이 폴더 runtime\ 에 내려받을까요?" 라고 묻습니다(약 30 MB, 관리자 권한 불필요,
     nodejs.org 공식 파일의 SHA-256 을 확인). 미리 받으려면 install-node.bat, 시스템에 설치하려면
     winget install -e --id OpenJS.NodeJS.LTS
   - runtime\node.exe 가 이미 들어 있는 판(win-x64)은 인터넷이 막힌 PC 용입니다.

1. 관리자 앱으로 켜기(권장)
   - 인터넷에서 받은 ZIP 이면 먼저 ZIP 파일 [속성] → '차단 해제'를 체크한 뒤 풉니다. 한글·공백이 든 경로도 됩니다.
   - admin-app.bat 를 두 번 누르면 관리 창이 열립니다. 처음에는 관리자 토큰을 직접 정합니다(4자 이상,
     시험용이면 짧아도 됨). [자동으로]를 누르면 무작위 토큰을 만듭니다. 그다음 서버가 켜집니다.
     관리 창: 켜기·끄기·다시 켜기, 이 PC·같은 망·외부·MCP 주소 복사, 관리자 토큰 보기, 설정·문서 폴더,
              바탕 화면 바로 가기 만들기, 참여자용 앱 내려받기, 기록
   - 관리자 앱은 작업 표시줄에 최소화된 창으로 돕니다. 그 창을 닫거나 [관리자 앱 끝내기]를 누르면 서버도 꺼집니다.
     관리 창만 닫았다면 admin-app.bat 를 다시 누르면 같은 관리 창이 다시 열립니다.
   - 정한 토큰으로 편집 화면에 로그인하고, 편집 화면의 [관리자]에서 참여자 계정을 만듭니다(참여자 토큰도 직접 정하거나 [자동]).
     관리자 토큰은 관리 창의 [관리자 토큰 → 바꾸기]로 언제든 바꿉니다. start-server.bat 로 처음 켜면 창에서 토큰을 묻습니다.

2. 사용자 앱(편집 화면)
   - 이 PC: 관리 창의 [편집 화면 열기] 또는 user-app.bat (Edge·Chrome 의 주소창 없는 앱 창)
   - 다른 PC 의 참여자: 관리 창의 [참여자용 앱 → 내려받기]로 받은 작은 ZIP(서버 주소가 들어 있음, 설치 없음)을 전달합니다.
     참여자는 hwpx-cowork.bat 또는 make-shortcut.bat 로 만든 바탕 화면 아이콘으로 엽니다. 서버를 켜고 끌 수는 없습니다.

3. 콘솔로 켜기(관리자 앱 없이)
   start-server.bat — 창 하나에서 서버만 켭니다. 끄기는 Ctrl+C·창 닫기·stop-server.bat

4. 폴더
   admin-app.bat / user-app.bat / start-server.bat / stop-server.bat / install-node.bat
   app\        서버·편집기·엔진·운영 의존성(고치지 않습니다 — 업데이트 때 통째로 바뀝니다)
   userdata\   첫 실행 때 생김: config.json(계정·토큰·설정), data\(문서·기록) — 백업은 서버를 끄고 이 폴더를 복사
   runtime\    Node.js(포함판이거나 install-node 로 받았을 때만)
   NOTICES\    제삼자 라이선스 고지
   업데이트: 서버를 끄고 새 ZIP 의 app\·*.bat 를 덮어씁니다. userdata\ 는 그대로 둡니다.

5. 다른 사람과 함께 쓰기
   - 처음에는 이 PC 에서만 접속됩니다(127.0.0.1). 편집 화면 [관리자]에서 접속 범위를 LAN 으로 저장·재시작하면
     같은 네트워크의 PC 가 관리 창의 '같은 망' 주소로 접속합니다(Windows 방화벽 허용 필요).
   - 인터넷 공유·ChatGPT 연결에는 HTTPS 주소가 필요합니다. 기관 서버(Ubuntu + Caddy)를 권장합니다.

6. AI 연결(MCP 주소는 관리 창에 표시)
   - ChatGPT 웹: 설정에서 사용자 지정 MCP 커넥터(앱)를 추가합니다 — 주소 https://도메인/mcp, 인증 OAuth.
     연결 화면에서 본인 hwpx 토큰으로 승인합니다. 메뉴 이름은 계정·버전에 따라 다르고, 워크스페이스 관리자가
     사용자 지정 커넥터를 허용해야 합니다. ChatGPT 는 인터넷에서 닿는 HTTPS 주소만 연결합니다(localhost 불가).
   - Claude Code:  claude mcp add --transport http hwpx http://localhost:8787/mcp --header "Authorization: Bearer <내 토큰>"
   - Codex CLI·Claude Desktop 등 다른 MCP 클라이언트도 같은 주소와 본인 토큰을 씁니다.
   - 요청을 자동으로 처리하려면 별도 배포물 'hwpx-ai-worker'(개인 AI 실행기)를 참여자 PC 에서 켭니다.

7. 선택 기능
   - 차트 그림 만들기: Python 3 + matplotlib (python 명령이 PATH 에 있어야 함, 또는 HWPX_COWORK_PYTHON)
   - 한글 프로그램 클립보드 붙여넣기 도우미: Python 3 (이 PC 의 한글과 같은 PC 에서만)
   - 둘 다 없어도 문서 편집·검토·AI 제안은 동작합니다.

8. 사양
   - 디스크: 프로그램 약 0.12 GB(+ Node 0.09 GB) + 문서 데이터(문서 수에 따라 증가, 버전 기록 포함)
   - 메모리: 서버 약 0.15 GB(대기)~0.35 GB(59쪽 보고서를 편집기로 연 순간 최고치, 실측). 앱 창(브라우저)은 별도

자세한 운영 설명서는 편집 화면의 [사용 설명서] 또는 http://localhost:8787/help.html 에 있습니다.
