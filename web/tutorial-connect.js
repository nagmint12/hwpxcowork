// 'AI 연결' 안내의 내용 — 화면 튜토리얼(web/tutorial-modules/ai-connections.js)과 내려받는 한/글 가이드
// (scripts/build-tutorial-connection.mjs → tutorial/AI 연결 — 사용자 가이드.hwpx)가 같은 글을 쓴다.
// 연결 우선순위(2026-11-13 결정, 앱 전체 같음):
//   ① 내 PC의 구독 AI · 기본 · 추가 비용 없음 — Codex·Claude Code 를 MCP로, 요청을 바로 처리
//   ② ChatGPT 앱 연결 · 선택(주소 + OAuth)   ③ 내 AI 키 · 선택 · 사용료 별도
// 이름표는 앱 화면과 같은 글(내 PC의 구독 AI · 기본 · 추가 비용 없음 / ChatGPT 앱 연결 · 선택 / 내 AI 키 · 선택 · 사용료 별도), 도움말은 /help.html#agents.
// 붙여넣을 내용은 blocks(복사 상자), 사람에게 하는 말은 text 에 짧게 둔다. 화면 밖 모듈이라 DOM·location 을 쓰지 않는다.
export const CONNECT_CHECKED = '2026-11-13';
export const EXAMPLE_MCP_URL = 'https://your-server.example/mcp';
// 2026-11-13 확인: Codex 는 config.toml 의 url·bearer_token_env_var(CLI·IDE 확장이 같은 설정, 확장은 ⚙ → MCP servers),
// Claude Code 는 .mcp.json 의 type http·headers 안 ${환경 변수}
export const CONNECT_HELP = '/help.html#agents';   // 앱 안 사용 설명서의 '내 PC의 구독 AI' 절
export const CONNECT_SOURCES = {
  codex: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
  claude: 'https://code.claude.com/docs/en/mcp',
  channels: 'https://code.claude.com/docs/en/channels',
  chatgpt: 'https://learn.chatgpt.com/docs/extend/mcp',
};
const psQuote = (text) => `'${String(text).replaceAll("'", "''")}'`;

/** 연결 단계 셋(기본·선택·사용료 별도). 화면의 고르기 단추와 한/글 가이드의 장 제목이 쓴다 — 앱의 연결 화면과 같은 이름표 */
export const CONNECT_TIERS = [
  { id: 'agent', choice: '내 PC의 구독 AI · 기본', chapter: '내 PC의 구독 AI · 기본 · 추가 비용 없음', note: 'Codex·Claude Code를 이미 쓰는 구독 요금제 그대로 연결해, 요청을 바로 처리합니다.' },
  { id: 'chatgpt', choice: 'ChatGPT 앱 연결 · 선택', chapter: 'ChatGPT 앱 연결 · 선택', note: '공개 HTTPS 주소가 있는 서버에서만 됩니다. 처리할 때마다 대화에서 시킵니다.' },
  { id: 'api', choice: '내 AI 키 · 선택 · 사용료 별도', chapter: '내 AI 키 · 선택 · 사용료 별도', note: '쓰는 만큼 사용료가 따로 듭니다. 꼭 필요할 때만 씁니다.' },
];

/**
 * 연결 안내 단계 — { id, tier, title, text, blocks?: [{ label, value }] }.
 * mcpUrl: 이 문서 서버의 MCP 주소(화면은 지금 서버 주소, 한/글 가이드는 예시 주소)
 */
export function connectGuide(mcpUrl = EXAMPLE_MCP_URL) {
  const codexUrl = `${mcpUrl}?agent=Codex`;
  const claudeUrl = `${mcpUrl}?agent=Claude%20Code`;
  const claudeJson = JSON.stringify({ mcpServers: { hwpx: { type: 'http', url: claudeUrl, headers: { Authorization: 'Bearer ${HWPX_COWORK_TOKEN}' } } } }, null, 2);
  return [
    { id: 'token', tier: 'agent', title: '내 개인 토큰 저장',
      text: '내 AI가 내 이름으로 문서 서버에 들어가도록, 이 서버에 로그인할 때 쓰는 개인 토큰을 PC에 한 번 저장합니다.\n따옴표 안을 내 토큰으로 바꿔 실행한 뒤, VS Code와 터미널을 다시 엽니다.',
      blocks: [{ label: 'PowerShell에 붙여넣을 내용 — 한 번만', value: 'setx HWPX_COWORK_TOKEN "내-개인-토큰"' }] },
    { id: 'vscode', tier: 'agent', title: 'VS Code에 MCP 서버 등록',
      text: 'VS Code 대화창에서도 요청을 처리하려면 MCP 서버를 한 번 등록합니다. 쓰는 AI의 상자만 붙여 넣으면 됩니다. 실행기만 쓸 때는 등록을 건너뛰어도 됩니다.\nCodex는 CLI와 VS Code 확장이 같은 설정 파일(~/.codex/config.toml)을 씁니다. 확장의 ⚙ → MCP servers에서 추가해도 됩니다. Claude Code는 VS Code로 연 작업 폴더의 .mcp.json을 읽습니다. 파일이 이미 있으면 hwpx 부분만 더합니다. 토큰은 파일에 적지 않습니다.',
      blocks: [
        { label: 'VS Code에 붙여넣을 내용 — Codex 설정 파일 config.toml', value: `[mcp_servers.hwpx]\nurl = "${codexUrl}"\nbearer_token_env_var = "HWPX_COWORK_TOKEN"` },
        { label: 'VS Code에 붙여넣을 내용 — Claude Code 작업 폴더의 .mcp.json', value: claudeJson },
      ] },
    // 2026-11-17: 실행기 bat(start-codex-agent·start-claude-worker)을 지웠다(사용자 결정) — Windows 앱 [AI → 실행기 관리…] 또는 명령줄 npm run worker
    //   (scripts/ai-worker.mjs — 기본 새 MCP 연결 --mcp 2). 개인 실행기 ZIP 도 같은 npm run worker 로 켠다
    { id: 'codex', tier: 'agent', title: 'Codex — 요청 바로 처리',
      text: 'ChatGPT 요금제 계정으로 Codex에 한 번 로그인합니다(VS Code 확장 또는 터미널).\nWindows 앱은 [AI → 실행기 관리…]에서 Codex 실행기를 켭니다. 앱 없이 켤 때는 프로그램 폴더에서 아래 명령을 실행해 창을 켜 두면, 웹에서 보낸 요청을 바로 가져가 처리합니다. 끝에 --check를 붙이면 연결만 점검합니다. 창을 닫으면 멈춥니다.',
      blocks: [
        { label: '터미널에 붙여넣을 내용 — 처음 한 번 로그인', value: 'codex login' },
        { label: '프로그램 폴더의 PowerShell에 붙여넣을 내용 — 앱 없이 실행기 켜기', value: `npm.cmd run worker -- --provider codex --url ${psQuote(mcpUrl)}` },
      ] },
    // 2026-11-13: 채널 없는 Claude Code 실행기(ai-worker --provider claude-code) — 요청마다 claude 를 띄워 처리, 채널은 다른 길
    { id: 'claude', tier: 'agent', title: 'Claude Code — 요청 바로 처리',
      text: '최신 Claude Code를 설치하고 Claude 구독 계정으로 한 번 로그인합니다.\nWindows 앱은 [AI → 실행기 관리…]에서 Claude Code 실행기를 켭니다. 앱 없이 켤 때는 프로그램 폴더에서 아래 명령을 실행해 창을 켜 두면, 웹에서 보낸 요청마다 Claude Code가 처리합니다. API 키·채널 설정 없이 구독 사용 한도 안에서 처리하고, MCP 연결은 실행기가 준비합니다. 끝에 --check를 붙이면 연결만 점검합니다. 창을 닫으면 멈춥니다.\n개인 실행기 ZIP을 풀고 npm.cmd install을 한 뒤에도 같은 명령으로 켭니다. 채널(start-agent.bat)로 띄워 두는 방법도 됩니다.',
      blocks: [
        { label: '터미널에 붙여넣을 내용 — 처음 한 번 로그인', value: 'claude auth login' },
        { label: '프로그램 폴더의 PowerShell에 붙여넣을 내용 — 앱 없이 실행기 켜기', value: `npm.cmd run worker -- --provider claude-code --url ${psQuote(mcpUrl)}` },
      ] },
    { id: 'check', tier: 'agent', title: '연결 확인과 사용',
      text: '문서 화면 위에 ● Codex나 ● Claude Code가 보이면 연결된 것입니다. 글을 골라 [AI에게 맡기기]로 보내면 내 AI가 처리하고, 결과는 제안으로 돌아옵니다. 반영은 내가 정합니다.\n실행기를 켜지 않았다면 AI 대화에 아래 문장을 붙여 넣습니다. 더 자세한 안내는 앱의 사용 설명서에 있습니다.',
      blocks: [{ label: 'Codex·Claude Code 대화에 붙여넣을 내용', value: 'hwpx 대기열을 처리해 줘' }] },
    { id: 'chatgpt-add', tier: 'chatgpt', title: 'ChatGPT 웹 — 앱 추가',
      text: 'ChatGPT 앱 연결은 선택입니다. 이 서버에 공개 HTTPS 주소가 있어야 합니다.\nChatGPT에 로그인해 Plugins를 열고, 오른쪽 위 Add → Add custom MCP server를 고릅니다. 계정·워크스페이스 정책에 따라 메뉴가 다를 수 있습니다.' },
    { id: 'chatgpt-form', tier: 'chatgpt', title: 'ChatGPT 웹 — 주소와 OAuth',
      text: 'Name은 HWPX 공동 검토, Server URL은 아래 주소, Authentication은 OAuth로 고르고 [Create as a plugin]을 누릅니다. Client ID·Secret은 만들지 않습니다(자동 등록).\n이어지는 서버 허용 화면에서 내 개인 토큰으로 인증합니다.',
      blocks: [{ label: 'ChatGPT에 붙여넣을 내용 — Server URL', value: mcpUrl }] },
    { id: 'chatgpt-use', tier: 'chatgpt', title: 'ChatGPT 웹 — 요청 처리',
      text: 'ChatGPT 웹은 요청을 스스로 가져가지 않습니다. 처리할 때마다 새 대화에서 플러그인을 고르고 아래 문장을 보냅니다.',
      blocks: [{ label: 'ChatGPT에 붙여넣을 내용', value: '내 문서의 대기 중인 요청을 확인하고 처리해 줘' }] },
    { id: 'api', tier: 'api', title: '내 AI 키 — 사용료 별도',
      text: '내 AI 키(API 키)는 쓰는 만큼 사용료가 따로 듭니다(ChatGPT·Claude 구독과 별개).\n꼭 필요할 때만 제공업체 관리 화면에서 키를 만들어 문서함의 [내 AI 키]에 붙여 넣고, 모델을 고른 뒤 [연결 확인]을 누릅니다. 키는 채팅이나 화면 캡처에 넣지 않습니다.' },
  ];
}
