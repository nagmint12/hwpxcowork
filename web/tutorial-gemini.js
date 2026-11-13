// Gemini 연결 절차(웹·CLI). 2026-11-13 'AI 연결' 코스를 내 PC의 Codex·Claude Code 먼저로 줄이면서 화면·한/글 가이드에서는 뺐다 —
// Gemini 안내를 다시 넣을 때 이 목록을 쓴다(메뉴 번호를 글에 넣지 않는다).
export const GEMINI_SOURCES = {
  web: 'https://support.google.com/gemini/answer/17209137?hl=en-12',
  mcp: 'https://geminicli.com/docs/tools/mcp-server/',
  install: 'https://geminicli.com/docs/get-started/installation/',
  auth: 'https://geminicli.com/docs/get-started/authentication/',
};
export const GEMINI_CHECKED = '2026-11-04';
const psQuote = text => `'${String(text).replaceAll("'", "''")}'`;

export function geminiGuide(mcpUrl = 'https://your-server.example/mcp') {
  return [
    { title: 'Gemini 연결 방식 고르기',
      text: 'Gemini를 사용할 사람만 진행하면 됩니다. 웹에서 연결하거나 PC의 Gemini CLI에서 같은 문서 서버에 연결할 수 있습니다. 2026-11-04 Google 공식 안내 기준, 웹의 Custom apps는 미국 거주 만 18세 이상·개인 Google 계정·영어·Keep Activity 켜짐 조건으로 제공됩니다. 학교·직장 계정이나 국내 환경에서 메뉴가 없으면 Gemini CLI 안내를 선택하세요. CLI도 본인 계정의 이용 가능 여부와 조직 정책을 따릅니다.',
      links: [['Gemini 웹 연결 조건 확인 ↗', GEMINI_SOURCES.web]] },
    { title: 'Gemini 웹 — Connected Apps 열기',
      text: 'PC에서 Gemini 웹에 본인 Google 계정으로 로그인합니다. Settings → Connected Apps를 엽니다. 해당 메뉴가 Personal Intelligence 아래에 보이면 그 안으로 들어갑니다. Custom apps에서 Add a custom app 또는 앱 링크를 넣는 입력란을 찾습니다. 메뉴가 없으면 앞 단계의 이용 조건을 확인하거나 Gemini CLI 안내로 이동하세요.',
      links: [['Gemini 웹 열기 ↗', 'https://gemini.google.com/'], ['Google 공식 연결 안내 ↗', GEMINI_SOURCES.web]] },
    { title: 'Gemini 웹 — MCP 주소와 OAuth 허용',
      text: '아래 공개 HTTPS MCP 주소를 Custom apps의 서버 주소에 넣고 Next를 누릅니다. 본인 문서 서버의 인증 화면이 열리면 HWPX에서 쓰는 본인 접속 토큰으로 확인하고 허용합니다. 이 서버는 DCR 자동 등록을 지원하므로 별도 안내가 없으면 Client ID·Secret을 직접 만들지 않습니다. Google 로그인과 문서 서버의 사용자 인증은 각각 진행합니다. 아래는 입력 예시이며 실제 연결을 제출하지 않습니다.',
      fields: [{ label: 'MCP server URL', value: mcpUrl }, { label: '문서 서버 인증', value: '본인 HWPX 접속 토큰으로 확인' }] },
    { title: 'Gemini 웹 — 대기 요청 처리와 반영',
      text: '연결 뒤 Gemini 대화에서 @를 입력해 연결한 HWPX 앱을 선택합니다. 튜토리얼 연습 문서나 본인의 일반 문서에서 보낼 곳을 대기열로 선택해 요청을 보낸 뒤, 아래 문장을 Gemini에 입력합니다. 연결 등록만으로 새 요청이 자동 처리되지는 않습니다. Gemini가 제안을 남기면 HWPX의 AI 작업에서 결과를 보고 [반영]·[거절]을 정합니다. Gemini가 도구 사용 확인을 요청하면 내용을 확인한 뒤 진행합니다.',
      commands: [{ label: 'Gemini에 요청할 문장', value: 'HWPX 공동 검토에서 내 대기 요청을 확인하고 처리해 줘. 수정 제안과 의견을 남기고 완료해 줘. 문서 반영은 내가 검토한 뒤 할게.' }] },
    { title: 'Gemini CLI — 설치와 Google 로그인',
      text: 'PC에서 명령을 입력해 연결하려면 Gemini CLI를 사용합니다. 공식 설치 조건인 Node.js 20 이상을 준비하고, PowerShell이나 터미널에서 아래 설치 명령을 실행합니다. 설치 후 gemini를 실행해 Login with Google을 선택합니다. 학교·직장 계정은 Gemini Code Assist 사용 권한이나 Google Cloud 프로젝트 설정이 필요할 수 있으므로 공식 인증 안내를 확인합니다.',
      commands: [{ label: '터미널에서 설치 후 실행', value: 'npm install -g @google/gemini-cli\ngemini' }],
      links: [['Gemini CLI 설치 안내 ↗', GEMINI_SOURCES.install], ['Google 로그인·조직 계정 안내 ↗', GEMINI_SOURCES.auth]] },
    { title: 'Gemini CLI — 문서 서버 등록',
      text: 'Gemini 대화를 끝내거나 새 PowerShell 창을 열고 아래 명령으로 HWPX 서버를 등록합니다. 현재 문서 서버의 MCP 주소가 들어 있습니다. http는 MCP 통신 방식 이름이며 서버 주소는 https:// 그대로 사용합니다. 접속 토큰이나 API 키를 명령에 적을 필요는 없습니다. 이 화면의 복사 버튼은 명령만 복사합니다.',
      commands: [{ label: 'PowerShell에서 MCP 서버 등록', value: `gemini mcp add --scope user --transport http hwpx ${psQuote(mcpUrl)}` }],
      links: [['Gemini CLI 공식 MCP 안내 ↗', GEMINI_SOURCES.mcp]] },
    { title: 'Gemini CLI — 문서 서버 인증',
      text: '터미널에서 gemini를 실행하고, Gemini 대화 안에 /mcp auth hwpx를 입력합니다. 브라우저의 HWPX 허용 화면에서 본인 접속 토큰으로 인증합니다. 이는 Gemini의 Google 로그인과 별개입니다. 허용을 마친 뒤 Gemini 대화로 돌아와 /mcp list로 hwpx의 연결 상태와 문서 도구가 보이는지 확인합니다.',
      commands: [{ label: '터미널에서 Gemini 실행', value: 'gemini' }, { label: '실행 중인 Gemini 대화 안에서 입력', value: '/mcp auth hwpx\n/mcp list' }] },
    { title: 'Gemini CLI — 대기 요청 처리와 반영',
      text: '튜토리얼 연습 문서나 본인의 일반 문서에서 보낼 곳을 대기열로 선택해 요청을 보냅니다. 연결한 Gemini CLI 대화에 아래 문장을 입력하면 본인 권한으로 요청을 가져와 처리합니다. 연결만 등록한 CLI가 새 요청을 계속 자동 처리하는 것은 아닙니다. 결과가 준비되면 HWPX의 AI 작업에서 제안을 확인하고 [반영]·[거절]을 정합니다. 자동 처리가 필요한 경우에는 별도의 개인 실행기를 사용합니다.',
      commands: [{ label: 'Gemini CLI 대화에 요청할 문장', value: 'HWPX 공동 검토에서 내 대기 요청을 확인하고 처리해 줘. 수정 제안과 의견을 남기고 완료해 줘. 문서 반영은 내가 검토한 뒤 할게.' }] },
    { title: 'Gemini — 연결 점검과 사용 중지',
      text: 'CLI가 연결되지 않으면 /mcp list로 상태를 보고, 인증이 필요하면 /mcp auth hwpx를 다시 실행합니다. 웹 연결을 그만 쓰려면 Connected Apps에서 해당 앱을 끄거나 삭제합니다. CLI 등록을 지우려면 아래 명령을 실행합니다. Gemini 이용 한도·비용은 본인의 Google 계정과 선택한 인증 방식에 따릅니다. 연결을 끊어도 HWPX에 저장된 요청·제안 기록은 남습니다.',
      commands: [{ label: '필요할 때만 PowerShell에서 CLI 등록 삭제', value: 'gemini mcp remove --scope user hwpx' }],
      links: [['웹 연결 관리 ↗', GEMINI_SOURCES.web], ['CLI 인증 안내 ↗', GEMINI_SOURCES.auth]] },
  ];
}
