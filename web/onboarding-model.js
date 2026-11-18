// 시작 안내의 선택은 안내에만 쓴다. 사용자·서버 설정과 로그인 토큰은 바꾸지 않는다.
export const DEPLOYMENTS = [
  { id: 'personal', title: '개인용', detail: '내 PC의 HWPX 문서를 열고 편집합니다.', icon: 'personal' },
  { id: 'shared', title: '공동 작업용', detail: '서버를 열어 동료와 문서를 함께 편집합니다.', icon: 'shared' },
];
export const SUBSCRIPTIONS = [
  { id: 'chatgpt', title: 'ChatGPT 구독', detail: 'Codex를 연결합니다.', icon: 'chatgpt' },
  { id: 'claude', title: 'Claude 구독', detail: 'Claude Code를 연결합니다.', icon: 'claude' },
  { id: 'none', title: '나중에 연결', detail: '문서 편집부터 시작합니다.', icon: 'none' },
];
export const CLI_AI = { chatgpt: 'codex', claude: 'claude-code', none: 'none' };

// WHATWG URL 정규화 뒤에도 같은 사이트인 경로만 허용한다(역슬래시·제어 문자 우회 포함).
export function safeNext(raw, origin = 'https://hwpx.invalid') {
  if (typeof raw !== 'string' || !raw.startsWith('/') || /[\\\u0000-\u0020]/.test(raw)) return '/';
  try {
    const url = new URL(raw, origin);
    return url.origin === new URL(origin).origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch { return '/'; }
}

export function appDestination(next, intent, origin = 'https://hwpx.invalid') {
  const url = new URL(safeNext(next, origin), origin);
  url.searchParams.set('teaser', '0');
  url.searchParams.set('welcome', intent === 'tutorial' ? 'tutorial' : 'start');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function setupPlan(deployment, subscription) {
  if (!DEPLOYMENTS.some(x => x.id === deployment) || !SUBSCRIPTIONS.some(x => x.id === subscription)) throw new Error('시작 방법을 먼저 선택해 주세요.');
  const personal = deployment === 'personal';
  const ai = subscription === 'chatgpt' ? 'Codex' : subscription === 'claude' ? 'Claude Code' : '';
  const installCli = subscription === 'none' ? '' : ' --install-cli'; // 저장소의 Mac·Linux 고급 설치에만 사용
  const command = `.\\scripts\\setup-user.bat --mode ${deployment} --ai ${CLI_AI[subscription]} --start`;
  return {
    title: `${personal ? '개인 서버' : '공동 서버'}${ai ? ` + ${ai}로` : '에서 AI 없이'} 시작해요`,
    command,
    commandNode: `node scripts/setup-personal.mjs --mode ${deployment} --ai ${CLI_AI[subscription]}${installCli} --start`,
    installerUrl: `/download/windows-setup.zip?mode=${deployment}&ai=${CLI_AI[subscription]}`,
    installerName: `hwpx-setup-${deployment}-${CLI_AI[subscription]}.zip`,
    // Windows 설치 묶음(2026-11-16): 운영 방식마다 ZIP 하나. AI 는 설치 뒤 'AI 연결.bat' 에서 고르고 본인 계정으로 로그인한다
    target: `windows-${deployment}`,
    aiChoice: ai ? `AI 연결.bat → ${subscription === 'chatgpt' ? '1) ChatGPT 구독(Codex)' : '2) Claude 구독(Claude Code)'}` : '',
    needsLogin: subscription !== 'none',
    steps: [
      `${personal ? '개인용' : '공동 작업용'} ZIP을 받아 압축을 풉니다.`,
      '시작.bat을 실행합니다. 처음 한 번 Node.js와 라이브러리를 인터넷으로 받습니다(관리자 권한 필요 없음).',
      ai ? `AI 연결.bat을 실행해 ${ai}를 고르고 본인 ${subscription === 'chatgpt' ? 'ChatGPT' : 'Claude'} 계정으로 로그인합니다.` : (personal ? '문서함 [PC 폴더 연결]로 문서 폴더를 연결합니다.' : '[관리자] → [사용자]에서 참여자를 추가하고 외부 접속 열기.bat의 주소를 전달합니다.'),
    ],
    aiNote: ai ? `${ai} 로그인과 AI 요청에는 인터넷이 필요합니다. 최초 로그인·동의는 직접 진행하며 API 키·유료 API로 바꾸지 않습니다.` : 'AI 연결은 나중에 AI 연결.bat으로 할 수 있습니다.',
    help: personal ? '/help.html#local' : '/manual.md',
  };
}

// 로그인 성공 시에만 한 번 소비한다. 토큰별 튜토리얼 완료 상태는 그대로 둔다.
export function consumeWelcomeIntent(location, history) {
  const url = new URL(location.href);
  const intent = url.searchParams.get('welcome');
  if (intent !== 'tutorial' && intent !== 'start') return null;
  url.searchParams.delete('welcome');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return intent;
}
