/**
 * [hwpx-cowork] 한/글 2022 편집·입력 — DOM 없는 순수 규칙(2026-11-11).
 *
 * - 대/소문자 바꾸기(ConvertCase)·전각/반각 바꾸기(ConvertFullHalfWidth)의 글자 변환
 * - 날짜/시간 문자열 형식
 * - 찾기 옵션 → 엔진 JSON
 * - 바뀐 글자 구간만 골라 문단에 적용할 조각(바뀌지 않은 글자·그 사이의 조판 부호를 건드리지 않게)
 *
 * 근거: 한/글 2022 COM 실측(`artifacts/h2022-edit/probe1.json`, 원장 `ledger_edit.md`).
 * 이 파일은 Node 시험(`tests/h2022_edit.test.mjs`)이 그대로 불러 쓴다 — 브라우저 API·다른 모듈을 쓰지 않는다.
 */

/**
 * 대/소문자 바꾸기 종류 — 값은 한/글 `ConvertCase` 파라미터 셋의 Type(실측, 원문 `hello World. abc DEF gHi`):
 * 0 → `HELLO WORLD. ABC DEF GHI`, 1 → `hello world. abc def ghi`, 2 → `HELLO wORLD. ABC def GhI`,
 * 3 → `Hello World. Abc Def Ghi`, 4 → `Hello World. Abc DEF gHi`, 5 → `Hello world. Abc def ghi`.
 */
export type CaseType = 0 | 1 | 2 | 3 | 4 | 5;

export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  0: '대문자로',
  1: '소문자로',
  2: '대/소문자 서로 바꾸기',
  3: '낱말 첫 글자만 대문자로',
  4: '문장 첫 글자만 대문자로(나머지 그대로)',
  5: '문장 첫 글자만 대문자로(나머지 소문자)',
};

const isLetter = (c: string): boolean => c.toLowerCase() !== c.toUpperCase();
const upper1 = (c: string): string => { const u = c.toUpperCase(); return [...u].length === 1 ? u : c; };
const lower1 = (c: string): string => { const l = c.toLowerCase(); return [...l].length === 1 ? l : c; };

/** 글자 수를 바꾸지 않는 대/소문자 바꾸기(한 글자가 여러 글자로 펴지는 경우는 그대로 둔다). */
export function convertCase(text: string, type: CaseType): string {
  const chars = [...text];
  const out: string[] = [];
  // 문장 머리: 글 처음, 또는 . ! ? 다음에 빈칸이 온 뒤
  let sentenceStart = true;
  let pendingEnd = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const prev = i > 0 ? chars[i - 1] : '';
    let r = c;
    if (isLetter(c)) {
      switch (type) {
        case 0: r = upper1(c); break;
        case 1: r = lower1(c); break;
        case 2: r = c === upper1(c) ? lower1(c) : upper1(c); break;
        case 3: r = prev && isLetter(prev) ? lower1(c) : upper1(c); break;
        case 4: r = sentenceStart ? upper1(c) : c; break;
        case 5: r = sentenceStart ? upper1(c) : lower1(c); break;
      }
      sentenceStart = false;
      pendingEnd = false;
    } else if (/[.!?]/.test(c)) {
      pendingEnd = true;
    } else if (/\s/.test(c)) {
      if (pendingEnd) sentenceStart = true;
    } else if (/\d/.test(c)) {
      sentenceStart = false;
      pendingEnd = false;
    }
    out.push(r);
  }
  return out.join('');
}

export interface FullHalfFlags {
  number: boolean;
  alpha: boolean;
  symbol: boolean;
  /** 가타카나 */
  gata: boolean;
  /** 한글 자모 */
  jamo: boolean;
}

export const FULL_HALF_DEFAULT_FLAGS: FullHalfFlags = { number: true, alpha: true, symbol: true, gata: true, jamo: true };

const HALF_KANA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const FULL_KANA = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
const HALF_KANA_PUNCT = '｡｢｣､･';
const FULL_KANA_PUNCT = '。「」、・';
/** 탁음·반탁음이 붙는 전각 가타카나 → (바탕 글자, 붙는 표) */
const VOICED: Record<string, [string, string]> = {};
{
  const base = 'カキクケコサシスセソタチツテトハヒフヘホウ';
  const voiced = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボヴ';
  for (let i = 0; i < base.length; i++) VOICED[voiced[i]] = [base[i], 'ﾞ'];
  const semi = 'ハヒフヘホ';
  const semiV = 'パピプペポ';
  for (let i = 0; i < semi.length; i++) VOICED[semiV[i]] = [semi[i], 'ﾟ'];
}
const VOICED_BACK: Record<string, string> = {};
for (const [v, [b, mark]] of Object.entries(VOICED)) VOICED_BACK[b + mark] = v;

function isFullAscii(cp: number): boolean { return cp >= 0xFF01 && cp <= 0xFF5E; }
function asciiKind(c: string): 'number' | 'alpha' | 'symbol' {
  if (/[0-9]/.test(c)) return 'number';
  if (/[A-Za-z]/.test(c)) return 'alpha';
  return 'symbol';
}

/**
 * 전각/반각 바꾸기. toFull=false 가 한/글 Type 0(반각으로), true 가 Type 1(전각으로).
 * 한/글 실측(원문 `ABC abc 123 !?#() ｱｲｳ アイ ㄱㄴ 가 ＡＢＣ１２３！ ㈜ ﾞ`):
 * - 반각으로(모두 켬): `ＡＢＣ１２３！`→`ABC123!`, `アイ`→`ｱｲ`, `ㄱㄴ`·`가`·`㈜` 그대로.
 * - 전각으로(모두 켬): 빈칸까지 `　`(U+3000, 기호로 셈), `ｱｲｳ`→`アイウ`, 홀로 선 `ﾞ`→U+3099.
 * - 숫자만 켜면 숫자만 바뀐다.
 * 한글 자모: 한/글은 반각으로 바꿀 때 호환 자모(ㄱ)를 반각 자모로 바꾸지 않았다(실측). 전각으로는 반각 자모(U+FFA1…)를 호환 자모로 —
 * 이 방향은 실측하지 않았다(원장).
 */
export function convertFullHalf(text: string, toFull: boolean, flags: FullHalfFlags = FULL_HALF_DEFAULT_FLAGS): string {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const cp = c.codePointAt(0)!;
    if (toFull) {
      if (cp >= 0x21 && cp <= 0x7E) {
        out.push(flags[asciiKind(c)] ? String.fromCodePoint(cp - 0x21 + 0xFF01) : c);
        continue;
      }
      if (c === ' ') { out.push(flags.symbol ? '　' : c); continue; }
      if (flags.gata) {
        const k = HALF_KANA.indexOf(c);
        if (k >= 0) {
          const next = chars[i + 1];
          const full = FULL_KANA[k];
          if ((next === 'ﾞ' || next === 'ﾟ') && VOICED_BACK[full + next]) { out.push(VOICED_BACK[full + next]); i++; continue; }
          out.push(full);
          continue;
        }
        const p = HALF_KANA_PUNCT.indexOf(c);
        if (p >= 0) { out.push(FULL_KANA_PUNCT[p]); continue; }
        if (c === 'ﾞ') { out.push('゙'); continue; }
        if (c === 'ﾟ') { out.push('゚'); continue; }
      }
      if (flags.jamo && cp >= 0xFFA0 && cp <= 0xFFDC) {
        // 반각 한글 자모 → 호환 자모(U+3164 채움 문자부터 차례가 같다 — 빈 칸 몇 개는 유니코드 표대로)
        const map = halfJamoToCompat(cp);
        out.push(map ?? c);
        continue;
      }
      out.push(c);
    } else {
      if (isFullAscii(cp)) {
        const a = String.fromCodePoint(cp - 0xFF01 + 0x21);
        out.push(flags[asciiKind(a)] ? a : c);
        continue;
      }
      if (c === '　') { out.push(flags.symbol ? ' ' : c); continue; }
      if (flags.gata) {
        const k = FULL_KANA.indexOf(c);
        if (k >= 0) { out.push(HALF_KANA[k]); continue; }
        if (VOICED[c]) { const [b, m] = VOICED[c]; out.push(HALF_KANA[FULL_KANA.indexOf(b)] + m); continue; }
        const p = FULL_KANA_PUNCT.indexOf(c);
        if (p >= 0) { out.push(HALF_KANA_PUNCT[p]); continue; }
      }
      out.push(c);
    }
  }
  return out.join('');
}

/** 반각 한글 자모(U+FFA0~FFDC) → 호환 자모(U+3164~318E). 유니코드 반각 자모 표의 빈 자리는 null. */
function halfJamoToCompat(cp: number): string | null {
  if (cp === 0xFFA0) return 'ㅤ';
  if (cp >= 0xFFA1 && cp <= 0xFFBE) return String.fromCodePoint(0x3131 + (cp - 0xFFA1));
  const vowels: Record<number, number> = {
    0xFFC2: 0x314F, 0xFFC3: 0x3150, 0xFFC4: 0x3151, 0xFFC5: 0x3152, 0xFFC6: 0x3153, 0xFFC7: 0x3154,
    0xFFCA: 0x3155, 0xFFCB: 0x3156, 0xFFCC: 0x3157, 0xFFCD: 0x3158, 0xFFCE: 0x3159, 0xFFCF: 0x315A,
    0xFFD2: 0x315B, 0xFFD3: 0x315C, 0xFFD4: 0x315D, 0xFFD5: 0x315E, 0xFFD6: 0x315F, 0xFFD7: 0x3160,
    0xFFDA: 0x3161, 0xFFDB: 0x3162, 0xFFDC: 0x3163,
  };
  return vowels[cp] ? String.fromCodePoint(vowels[cp]) : null;
}

/**
 * 옛 글과 새 글의 다른 구간들(코드포인트 자리) — 같은 길이면 글자마다 바뀐 구간, 길이가 다르면 앞뒤 같은 부분을 뺀 가운데 하나.
 * 적용은 뒤에서부터 한다(앞 자리가 밀리지 않게).
 */
export function changedSegments(before: string, after: string): Array<{ start: number; length: number; text: string }> {
  const a = [...before];
  const b = [...after];
  if (a.length === b.length) {
    const out: Array<{ start: number; length: number; text: string }> = [];
    let i = 0;
    while (i < a.length) {
      if (a[i] === b[i]) { i++; continue; }
      const s = i;
      while (i < a.length && a[i] !== b[i]) i++;
      out.push({ start: s, length: i - s, text: b.slice(s, i).join('') });
    }
    return out;
  }
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return [{ start: p, length: a.length - p - q, text: b.slice(p, b.length - q).join('') }];
}

/** 찾기 대화상자 옵션 → 엔진 `searchTextEx`·`replaceAllEx` 의 JSON. */
export interface FindOptionValues {
  matchCase: boolean;
  wholeWord: boolean;
  wildcard: boolean;
  severalWords: boolean;
  ignoreSpace: boolean;
  jaso: boolean;
}

export const FIND_OPTION_LABELS: Record<keyof FindOptionValues, string> = {
  matchCase: '대소문자 구별',
  wholeWord: '온전한 낱말',
  severalWords: '여러 단어 찾기',
  ignoreSpace: '띄어쓰기 무시',
  wildcard: '아무개 문자',
  jaso: '자소 단위 찾기',
};

export const FIND_OPTION_TITLES: Record<keyof FindOptionValues, string> = {
  matchCase: '영문 대문자와 소문자를 가려 찾습니다',
  wholeWord: '앞뒤가 다른 글자와 붙지 않은 낱말만 찾습니다(조사가 붙은 낱말은 찾지 않음)',
  severalWords: '쉼표(,)나 쌍반점(;)으로 나눈 낱말을 모두 찾습니다',
  ignoreSpace: '찾을 말의 빈칸은 본문에 빈칸이 없거나 한 칸일 때 모두 찾습니다',
  wildcard: '? 는 아무 글자 하나, * 는 띄어쓰기 없는 아무 글자들',
  jaso: '자음·모음 단위로 찾습니다(ㅎ → 학·한 …)',
};

export function findOptionsJson(o: Partial<FindOptionValues>): string {
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(FIND_OPTION_LABELS) as Array<keyof FindOptionValues>) if (o[k]) out[k] = true;
  return JSON.stringify(out);
}

/** 찾을 방향 — 한/글 FindReplace Direction: 0 아래쪽, 1 위쪽, 2 문서 전체. */
export type FindDirection = 'down' | 'up' | 'all';

/**
 * 한 방향 찾기에서 엔진이 문서 끝을 돌아 처음 매치를 낸 경우(wrapped)를 어떻게 다룰지.
 * 'all' 은 그대로 돈다. 'down'·'up' 은 한/글처럼 끝에 닿았다고 알리고, 같은 찾기를 한 번 더 누르면 그때 돈다.
 */
export function wrapDecision(direction: FindDirection, wrapped: boolean, confirmedWrap: boolean): 'move' | 'ask' {
  if (!wrapped || direction === 'all' || confirmedWrap) return 'move';
  return 'ask';
}

/**
 * 일어 바꾸기(ConvertHiraGata · ConvertHiraToGata 셋 Type: 0 가타카나로, 1 히라가나로 — 공식 파라미터 표).
 * 전각 히라가나 U+3041~3096·ゝゞ ↔ 가타카나 U+30A1~30F6·ヽヾ(유니코드 차례 차이 0x60). 반각 가타카나는 건드리지 않는다.
 * 한/글 결과와의 대조는 실측하지 않았다(원장).
 */
export function convertKana(text: string, toKatakana: boolean): string {
  let out = '';
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    if (toKatakana && ((cp >= 0x3041 && cp <= 0x3096) || cp === 0x309D || cp === 0x309E)) out += String.fromCodePoint(cp + 0x60);
    else if (!toKatakana && ((cp >= 0x30A1 && cp <= 0x30F6) || cp === 0x30FD || cp === 0x30FE)) out += String.fromCodePoint(cp - 0x60);
    else out += c;
  }
  return out;
}

// ── 날짜/시간 ──

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 날짜/시간 형식. 한/글 2022 '날짜/시간 문자열'(Ctrl+K,D)의 기본은 `YYYY년 M월 D일`(실측 `2026년 11월 11일`, 날짜 코드의
 * DateFormat 도 같은 글). 나머지는 '날짜/시간 형식' 창에서 고를 수 있게 둔 흔한 꼴이다 — 한/글 창의 목록 전체는 실측하지 않았다(원장).
 * 기호: YYYY 해, YY 해 두 자리, M/MM 달, D/DD 날, dddd 요일(월요일), ddd 요일 한 글자, A 오전/오후, h 12시간, H/HH 24시간, m/mm 분, s/ss 초.
 */
export const DATE_FORMATS: readonly string[] = [
  'YYYY년 M월 D일',
  'YYYY년 M월 D일 dddd',
  'YYYY년 M월 D일 (ddd)',
  'YYYY. M. D.',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YY. M. D.',
  'M월 D일',
  'M월 D일 dddd',
  'A h시 m분',
  'HH:mm',
  'HH:mm:ss',
  'YYYY년 M월 D일 A h시 m분',
  'YYYY-MM-DD HH:mm',
];

export function formatDate(date: Date, format: string): string {
  const tokens: Array<[RegExp, () => string]> = [
    [/^YYYY/, () => String(date.getFullYear())],
    [/^YY/, () => pad(date.getFullYear() % 100)],
    [/^MM/, () => pad(date.getMonth() + 1)],
    [/^M/, () => String(date.getMonth() + 1)],
    [/^DD/, () => pad(date.getDate())],
    [/^D/, () => String(date.getDate())],
    [/^dddd/, () => `${WEEK[date.getDay()]}요일`],
    [/^ddd/, () => WEEK[date.getDay()]],
    [/^A/, () => (date.getHours() < 12 ? '오전' : '오후')],
    [/^HH/, () => pad(date.getHours())],
    [/^H/, () => String(date.getHours())],
    [/^h/, () => String(date.getHours() % 12 === 0 ? 12 : date.getHours() % 12)],
    [/^mm/, () => pad(date.getMinutes())],
    [/^m/, () => String(date.getMinutes())],
    [/^ss/, () => pad(date.getSeconds())],
    [/^s/, () => String(date.getSeconds())],
  ];
  let out = '';
  let rest = format;
  outer: while (rest) {
    for (const [re, fn] of tokens) {
      const m = re.exec(rest);
      if (m) { out += fn(); rest = rest.slice(m[0].length); continue outer; }
    }
    out += rest[0];
    rest = rest.slice(1);
  }
  return out;
}

// ── 글자 겹치기 ──

/**
 * 글자 겹치기 모양(엔진 shape 0~13 = HWPX circleType: 0 CHAR(모양 없음), 1 원, 2 반전 원, 3 사각형, 4 반전 사각형,
 * 5 삼각형, 6 반전 삼각형, 7 해, 8 마름모, 9 반전 마름모, 10 둥근 사각형, 11~13 순환 삼각형). 한/글 ChCompose CircleType 1→SHAPE_CIRCLE,
 * 3→SHAPE_RECTANGLE 실측.
 */
export const COMPOSE_SHAPES: ReadonlyArray<[number, string]> = [
  [0, '모양 없음(글자끼리 겹치기)'], [1, '○ 원'], [2, '● 반전 원'], [3, '□ 사각형'], [4, '■ 반전 사각형'],
  [5, '△ 삼각형'], [6, '▲ 반전 삼각형'], [7, '☼ 해'], [8, '◇ 마름모'], [9, '◆ 반전 마름모'],
  [10, '▢ 둥근 사각형'], [11, '빈 순환 삼각형'], [12, '얇은 순환 삼각형'], [13, '굵은 순환 삼각형'],
];

/**
 * 글자 겹치기 '글자 크기 조절'. 한/글 ChCompose CharSize 는 -6 ~ +2(공식 표: 40%~120%)이고 저장값 charSz 가 그 값 그대로다
 * (실측: 0 → charSz="0", -3 → "-3"; 기본값 -3). 표시는 공식 표의 비율(100% + 10%×값)을 따른다.
 */
export const COMPOSE_SIZE_MIN = -6;
export const COMPOSE_SIZE_MAX = 2;
export const COMPOSE_SIZE_DEFAULT = -3;
export const composeSizePercent = (v: number): number => 100 + 10 * v;
