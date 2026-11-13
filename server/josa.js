// 서버 글의 조사(을/를·이/가·은/는·과/와·으로/로) — web/util.js josa() 와 같은 규칙의 사본.
// web/util.js 는 브라우저 모듈(Vue import)이라 서버가 불러 쓸 수 없다 — 규칙을 바꾸면 두 곳을 같이 고친다(시험 사례: tests/util.test.mjs).
//   「${글}」를 찾지 못했습니다 · 제안 3 은(는) 처럼 한쪽으로 박거나 두 꼴을 함께 쓰지 않고 끝소리(받침)로 고른다.

// 받침이 있을 때 쓰는 꼴 → [받침 있음, 받침 없음]. '으로/로'는 ㄹ 받침 뒤에도 '로'
const JOSA = { 을: ['을', '를'], 를: ['을', '를'], 이: ['이', '가'], 가: ['이', '가'], 은: ['은', '는'], 는: ['은', '는'], 과: ['과', '와'], 와: ['과', '와'], 으로: ['으로', '로'], 로: ['으로', '로'] };
// 숫자를 한국어로 읽은 끝소리(0 영·1 일·2 이·3 삼·4 사·5 오·6 육·7 칠·8 팔·9 구): 받침 종류 — '' 없음, 'ㄹ', 그 밖은 'o'(있음)
const DIGIT_END = ['o', 'ㄹ', '', 'o', '', '', 'o', 'ㄹ', 'ㄹ', ''];
// 끝이 0 인 수: 0 이 몇 개냐로 읽는 끝 — 십(ㅂ)·백(ㄱ)·천(ㄴ)·만(ㄴ, 4~7개)·억(ㄱ, 8~11개)·조(없음, 12개~)
const ZEROS_END = (z) => (z === 1 || z === 2 || z === 3 || (z >= 4 && z <= 11) ? 'o' : '');
// 영문자는 글자 이름으로(엘·알 = ㄹ, 엠·엔 = 받침, 그 밖은 받침 없음 — 'AI가', 'URL을', 'PDF를')
const LATIN_END = { l: 'ㄹ', r: 'ㄹ', m: 'o', n: 'o' };
/**
 * 영문 끝소리. 줄임말(끝이 대문자 2자 이상 — AI·URL·ChatGPT)·대문자로만·한 글자·파일 확장자(.xlsx·.png)는 글자 이름(LATIN_END).
 * 그 밖의 영어 낱말은 흔한 끝만 소리로 읽는다: 홀소리 + r(-er·-or — Server 서버·Paper 페이퍼)은 받침 없음, -le(Google 구글·Table 테이블) = ㄹ,
 * -me·-ne·-ng(Game 게임·Line 라인·Meeting 미팅) = 받침. 나머지는 글자 이름과 같다(-l = ㄹ, -m·-n = 받침, 그 밖은 없음)
 */
function latinEnd(w) {
  const run = /[A-Za-z]+$/.exec(w)[0];
  const spelled = run.length === 1 || !/[a-z]/.test(run) || /[A-Z]{2,}$/.test(run) || /\.$/.test(w.slice(0, w.length - run.length));
  if (!spelled) {
    const s = run.toLowerCase();
    if (/[aeiouy]r$/.test(s)) return '';
    if (/le$/.test(s)) return 'ㄹ';
    if (/(?:me|ne|ng)$/.test(s)) return 'o';
  }
  return LATIN_END[run[run.length - 1].toLowerCase()] ?? '';
}
/** 낱말의 끝소리 받침: '' 없음 · 'ㄹ' · 'o' 그 밖 받침 · null 모름(기호·빈 글) */
function finalOf(word) {
  let w = String(word ?? '').replace(/[\s'"’”」』>》〉\]]+$/u, '');
  // 끝의 괄호 덧붙임은 건너뛴다: '변경 요청 #3(홍길동)' → '#3' 을 읽는다
  for (let k = 0; k < 3 && /\)$/.test(w); k++) w = w.replace(/\s*\([^()]*\)$/u, '').replace(/[\s'"’”」』]+$/u, '');
  const ch = Array.from(w).pop();
  if (!ch) return null;
  const c = ch.codePointAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) { const jong = (c - 0xAC00) % 28; return jong === 0 ? '' : jong === 8 ? 'ㄹ' : 'o'; }
  if (/[0-9]/.test(ch)) {
    const run = /([0-9]+)$/.exec(w)[1];
    if (/^0+$/.test(run)) return 'o';   // 영
    const z = /0*$/.exec(run)[0].length;
    return z ? ZEROS_END(z) : DIGIT_END[Number(ch)];
  }
  if (/[a-z]/i.test(ch)) return latinEnd(w);
  return null;
}
/**
 * 낱말 + 끝소리에 맞는 조사. pair = '을/를'·'이/가'·'은/는'·'과/와'·'으로/로'(어느 쪽을 앞에 써도 된다).
 *   josa('제안 #3', '을/를') → '제안 #3을'(삼) · josa('「문단」', '을/를') → '「문단」을' · josa('AI 작업 #2', '은/는') → 'AI 작업 #2는'
 * 숫자는 한국어로 읽은 소리, 영문 줄임말·확장자는 글자 이름, 영어 낱말은 흔한 끝소리로 본다. 끝을 읽을 수 없으면(기호 등) '을(를)' 꼴.
 */
export function josa(word, pair) {
  const [x, y] = String(pair || '').split('/');
  const [withF, noF] = JOSA[x] || JOSA[y] || [x || '', y || ''];
  const f = finalOf(word);
  const w = String(word ?? '');
  if (f === null) return `${w}${withF}(${noF})`;
  if (withF === '으로') return w + (f === '' || f === 'ㄹ' ? '로' : '으로');
  return w + (f === '' ? noF : withF);
}
