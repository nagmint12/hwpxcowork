// 데스크톱 앱의 운영 방식(2026-11-17): 혼자 쓰기(personal) · 여러 사람과 함께 쓰기(shared) · AI 실행기만(runner).
// 앱 설정 폴더의 desktop-app.json 에 두고, 방식마다 설정·문서 기록 폴더를 따로 쓴다(<앱 설정>/personal · shared · runner).
// runner(같은 날 더함 — 실행기 bat 을 앱이 대신하면서): 이 PC 에 서버를 두지 않고 다른 서버(운영 서버·공동 작업 서버)에 내 구독 AI 실행기만 붙인다.
//   운영 서버를 따로 돌리는 관리자 PC 와 공동 작업 서버의 참여자 PC 에서, 쓰지 않는 개인 서버·문서함을 띄우지 않으려고.
import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['personal', 'shared', 'runner'];
/** 메뉴·확인 창에 쓰는 이름 */
export const MODE_LABELS = Object.freeze({ personal: '혼자 쓰기(개인용)', shared: '여러 사람과 함께 쓰기(공동 작업용)', runner: 'AI 실행기만(다른 서버에 연결)' });
export function savePersonalTransport(dir, transport) {
  if (!['stdio', 'loopback'].includes(transport)) throw Error('지원하지 않는 개인 연결 방식입니다.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'personal-connection.json');
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ transport }) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function personalTransport(dir) {
  const file = path.join(dir, 'personal-connection.json');
  if (fs.existsSync(file)) {
    const { transport } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (['stdio', 'loopback'].includes(transport)) return transport;
    throw Error('개인 연결 방식 설정을 확인해 주세요.');
  }
  const transport = fs.existsSync(path.join(dir, 'config.json')) ? 'loopback' : 'stdio';
  savePersonalTransport(dir, transport);
  return transport;
}
export const MODE_CHOICE = Object.freeze({
  message: 'HWPX Cowork를 어떻게 쓰시겠어요?',
  detail: '혼자 쓰기 — 내 PC 폴더를 연결하고 포트 없이 편집합니다. 개인 연결 메뉴에서 브라우저용 서버로도 열 수 있습니다.\n\n'
    + '여러 사람과 함께 쓰기 — 앱에서 공동 작업 서버를 켜고 끕니다. 참여자를 추가하고 외부 접속 주소를 열 수 있습니다.\n\n'
    + 'AI 실행기만 — 이 PC에 서버를 두지 않고, 이미 있는 서버(공동 작업 서버 등)에 내 구독 AI만 연결합니다. 문서는 그 서버의 웹 화면에서 엽니다.\n\n'
    + '나중에 [HWPX Cowork → 운영 방식 바꾸기]에서 바꿀 수 있습니다. 방식마다 문서와 설정은 따로 보관됩니다.',
  buttons: ['혼자 쓰기', '여러 사람과 함께 쓰기', 'AI 실행기만'],
  modes: ['personal', 'shared', 'runner'],
});

/** 명령줄 --mode personal|shared|runner(바로 가기·시험용) → 방식 또는 null */
export function modeFromArgs(argv) {
  const at = argv.indexOf('--mode');
  const value = at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith('--mode='))?.slice(7);
  return MODES.includes(value) ? value : null;
}

/** 저장한 방식 → 방식 또는 null(처음 실행). 방식을 고르기 전 판(개인용만 있던 앱)의 설치는 개인용으로 본다 */
export function savedMode(dir) {
  try {
    const mode = JSON.parse(fs.readFileSync(path.join(dir, 'desktop-app.json'), 'utf8')).mode;
    if (MODES.includes(mode)) return mode;
  } catch { /* 처음 실행 또는 읽지 못함 */ }
  return fs.existsSync(path.join(dir, 'personal', 'config.json')) ? 'personal' : null;
}

export function saveMode(dir, mode) {
  if (!MODES.includes(mode)) throw new Error('지원하지 않는 운영 방식입니다.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'desktop-app.json'), JSON.stringify({ mode }) + '\n');
}

/** 다시 시작할 때 넘길 인자 — 저장한 방식이 쓰이도록 --mode 를 뺀다 */
export function relaunchArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') { i++; continue; }
    if (argv[i].startsWith('--mode=')) continue;
    out.push(argv[i]);
  }
  return out;
}
