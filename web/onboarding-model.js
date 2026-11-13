// 시작 안내의 선택은 안내에만 쓴다. 사용자·서버 설정과 로그인 토큰은 바꾸지 않는다.
export const DEPLOYMENTS = [
  { id: 'personal', title: '개인 서버 운영', detail: '내 문서를 중심으로, 나만의 작업 공간을 만듭니다.', icon: 'personal' },
  { id: 'shared', title: '공동 서버 운영', detail: '동료와 함께 쓸 서버를 PC나 클라우드에 준비합니다.', icon: 'shared' },
];
export const SUBSCRIPTIONS = [
  { id: 'chatgpt', title: '개인 ChatGPT 구독', detail: 'ChatGPT 계정으로 Codex에 로그인합니다.', icon: 'chatgpt' },
  { id: 'claude', title: '개인 Claude 구독', detail: 'Claude 계정으로 Claude Code에 로그인합니다.', icon: 'claude' },
  { id: 'none', title: '구독 없음 · 연결 안 함', detail: 'AI 연결 없이 문서 편집과 공동 검토부터 시작합니다.', icon: 'none' },
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
  const installCli = subscription === 'none' ? '' : ' --install-cli';
  const command = `.\\scripts\\setup-user.bat --mode ${deployment} --ai ${CLI_AI[subscription]}${installCli} --start`;
  return {
    title: `${personal ? '개인 서버' : '공동 서버'}${ai ? ` + ${ai}로` : '에서 AI 없이'} 시작해요`,
    command,
    commandNode: `node scripts/setup-personal.mjs --mode ${deployment} --ai ${CLI_AI[subscription]}${installCli} --start`,
    prompt: `이 프로그램을 ${personal ? '개인' : '공동'} 서버로 설치해 줘. ${ai ? `내 ${subscription === 'chatgpt' ? 'ChatGPT' : 'Claude'} 구독으로 ${ai}를 연결해 줘.` : 'AI는 연결하지 않고 시작할게.'} scripts 폴더가 있는 프로그램 위치(설치형 ZIP은 app 폴더)를 찾아 Windows에서는 ${command} 명령을 실행해 줘. 다른 운영체제라면 같은 옵션으로 node scripts/setup-personal.mjs를 실행해 줘. 기존 운영 설정과 문서는 건드리지 말고, 새 설치의 설정·토큰·빈 포트는 도우미가 준비하게 해 줘. 구독 로그인이 필요하면 도우미가 출력하는 로그인 명령을 안내하고 내 로그인을 기다려 줘. API 키나 별도 유료 API로 대체하지 말고, 끝나면 서버 주소와 실제 연결 상태를 알려 줘.`,
    needsLogin: subscription !== 'none',
    steps: [
      personal ? '받은 프로그램 ZIP을 내 PC에 풀거나, 접근 권한이 있는 저장소의 프로그램 폴더를 엽니다.' : '받은 ZIP이나 접근 권한이 있는 저장소로, 서버로 쓸 PC·클라우드에 프로그램 폴더를 준비합니다.',
      'scripts 폴더가 있는 위치를 VS Code에서 엽니다. 설치형 ZIP에서는 app 폴더입니다. 아래 요청을 AI 대화창에 붙여넣거나 터미널 명령을 직접 실행합니다.',
      personal ? '자동으로 열린 문서함에서 시작합니다. 다시 접속할 서버 주소는 터미널에 표시됩니다.' : '자동으로 열린 문서함에서 시작합니다. 관리자 화면에서 동료별 토큰을 만들어 서버 주소와 함께 나눕니다.',
    ],
    aiNote: ai ? `${ai}로 내 요청을 내 구독 안에서 처리합니다. 처음에는 공식 CLI에서 계정 로그인·동의를 직접 한 번 진행합니다. 터미널에 표시된 로그인 명령을 실행한 뒤 시작 명령을 다시 실행하세요. API 키나 별도 유료 API로 자동 전환하지 않습니다.` : 'AI 없이 바로 편집·메모·변경 검토를 사용할 수 있습니다. AI 연결은 나중에 선택할 수 있습니다.',
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
