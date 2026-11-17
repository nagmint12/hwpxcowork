// 데스크톱 앱의 운영 방식(2026-11-17): 혼자 쓰기(personal) · 여러 사람과 함께 쓰기(shared).
// 앱 설정 폴더의 desktop-app.json 에 두고, 방식마다 설정·문서 기록 폴더를 따로 쓴다(<앱 설정>/personal · <앱 설정>/shared).
import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['personal', 'shared'];
export const MODE_CHOICE = Object.freeze({
  message: 'Hwpx Cowork를 어떻게 쓰시겠어요?',
  detail: '혼자 쓰기 — 이 PC의 한글 문서를 혼자 열고 고칩니다. PC 폴더를 바로 연결할 수 있습니다.\n\n'
    + '여러 사람과 함께 쓰기 — 이 PC가 공동 작업 서버가 됩니다. 참여자를 추가하고, 외부 접속 주소를 열어 다른 PC에서도 함께 고칩니다.\n\n'
    + '나중에 [Hwpx Cowork → 운영 방식 바꾸기]에서 바꿀 수 있습니다. 두 방식의 문서와 설정은 따로 보관됩니다.',
  buttons: ['혼자 쓰기', '여러 사람과 함께 쓰기'],
  modes: ['personal', 'shared'],
});

/** 명령줄 --mode personal|shared(바로 가기·시험용) → 방식 또는 null */
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
