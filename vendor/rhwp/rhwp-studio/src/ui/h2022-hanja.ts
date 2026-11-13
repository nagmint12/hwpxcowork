/**
 * [hwpx-cowork] 한/글 2022 '한자로 바꾸기(F9)'·'한글로 바꾸기(Alt+F9)' — 글자 단위 규칙(2026-11-12).
 *
 * 자료: Unicode Unihan(kHangul·KS X 1001·교육용·인명용)에서 `scripts/gen-hanja-table.mjs` 가 만든 `generated/h2022-hanja-data.ts`
 * (Unicode License v3 — 같은 폴더 고지). 처음 쓸 때만 불러온다(동적 import → 편집기 번들에서 따로 떨어진 조각).
 * 이 파일의 규칙 함수는 DOM 을 쓰지 않는다 — Node 시험(`tests/h2022_edit.test.mjs`)이 그대로 부른다.
 *
 * 한/글과의 관계(원장 `ledger_edit.md`):
 * - 한/글은 낱말 사전으로 바꾸고, 음이 여럿인 한자는 '한글 선택하여 바꾸기' 창에서 사람이 고른다(COM 실측 2026-11-12).
 *   여기서는 글자 단위만 — 음이 여럿이면 교육용 본음(E)을 고르고 두음 법칙을 적용한다(한/글 도움말 문구 '두음법칙을 고려하여').
 * - 한자로 바꾸기 입력 형식은 한/글 대화상자 정의(Hnc.Office.UxXml.Dlg.dll ConvertHanjaDlg)의 보이는 세 가지: 漢字 · 漢字(한글) · 한글(漢字).
 */

export interface HanjaReading { r: string; e: boolean; n: boolean }
export interface HanjaEntry { c: string; ks: boolean; edu: boolean; name: boolean; readings: HanjaReading[] }
export interface HanjaTable { byHanja: Map<string, HanjaEntry>; bySyllable: Map<string, HanjaEntry[]> }

export type HanjaFormat = 'hanja' | 'hanjaHangul' | 'hangulHanja';
export const HANJA_FORMAT_LABELS: Record<HanjaFormat, string> = { hanja: '漢字', hanjaHangul: '漢字(한글)', hangulHanja: '한글(漢字)' };

export function parseHanjaData(data: string): HanjaTable {
  const byHanja = new Map<string, HanjaEntry>();
  const bySyllable = new Map<string, HanjaEntry[]>();
  for (const line of data.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = [...line.slice(0, colon)];
    const c = head[0];
    const cls = head.slice(1).join('');
    const readings = line.slice(colon + 1).split(',').map((x) => {
      const m = /^(.+?)([EN]*)$/.exec(x)!;
      return { r: m[1], e: m[2].includes('E'), n: m[2].includes('N') };
    });
    const entry: HanjaEntry = { c, ks: cls.includes('k'), edu: cls.includes('e'), name: cls.includes('n'), readings };
    byHanja.set(c, entry);
    for (const rd of readings) {
      const list = bySyllable.get(rd.r) ?? [];
      list.push(entry);
      bySyllable.set(rd.r, list);
    }
  }
  return { byHanja, bySyllable };
}

let loading: Promise<HanjaTable> | null = null;
/** 표를 처음 쓸 때 한 번 불러온다(편집기 번들에서 떨어진 조각). */
export function loadHanjaTable(): Promise<HanjaTable> {
  loading ??= import('./generated/h2022-hanja-data').then((m) => parseHanjaData(m.HANJA_DATA));
  return loading;
}

export const isHangulSyllable = (ch: string): boolean => { const c = ch.codePointAt(0) ?? 0; return c >= 0xAC00 && c <= 0xD7A3; };
export const isHanja = (ch: string, t: HanjaTable): boolean => t.byHanja.has(ch);

/**
 * 음절의 한자 후보 — 그 음이 본음(E)인 한자를 먼저(KS X 1001 차례 — 자료 차례), 다음은 그 음을 다른 음으로 가진 한자
 * (두음 법칙 꼴·이름 음 등 — 예: '이' 의 李·理). 한/글의 낱말 빈도 차례는 자료가 없어 따르지 못한다.
 */
export function hanjaCandidates(t: HanjaTable, syllable: string): HanjaEntry[] {
  const all = t.bySyllable.get(syllable) ?? [];
  const main = all.filter((x) => x.readings.some((r) => r.r === syllable && r.e));
  const rest = all.filter((x) => !main.includes(x));
  const rank = (x: HanjaEntry) => (x.ks ? 0 : 1);
  return [...main.sort((a, b) => rank(a) - rank(b)), ...rest.sort((a, b) => rank(a) - rank(b))];
}

const CHO = 588;
const JUNG = 28;
/** 두음 법칙(한글 맞춤법 제10~12항): 첫소리 ㄹ → ㅣ·ㅑ·ㅕ·ㅖ·ㅛ·ㅠ 앞이면 ㅇ, 그 밖은 ㄴ / 첫소리 ㄴ → ㅣ·ㅑ·ㅕ·ㅖ·ㅛ·ㅠ 앞이면 ㅇ. */
export function dueum(syllable: string): string {
  const code = (syllable.codePointAt(0) ?? 0) - 0xAC00;
  if (code < 0 || code > 11171) return syllable;
  const cho = Math.floor(code / CHO);
  const jung = Math.floor((code % CHO) / JUNG);
  const jong = code % JUNG;
  // 중성 번호: ㅑ 2 · ㅒ 3 · ㅕ 6 · ㅖ 7 · ㅛ 12 · ㅠ 17 · ㅣ 20
  const front = [2, 3, 6, 7, 12, 17, 20].includes(jung);
  let to = cho;
  if (cho === 5) to = front ? 11 : 2; // ㄹ → ㅇ | ㄴ
  else if (cho === 2 && front) to = 11; // ㄴ → ㅇ
  return to === cho ? syllable : String.fromCodePoint(0xAC00 + to * CHO + jung * JUNG + jong);
}

/** 받침 없는 음절이거나 받침 ㄴ 인가(렬·률 → 열·율, 한글 맞춤법 제11항 붙임 1) */
function vowelOrNieun(syllable: string | undefined): boolean {
  if (!syllable || !isHangulSyllable(syllable)) return false;
  const jong = ((syllable.codePointAt(0) ?? 0) - 0xAC00) % JUNG;
  return jong === 0 || jong === 4;
}

/** 한자 하나의 한글 음 — 본음(E, 없으면 첫 음), 낱말 첫머리면 두음 법칙 꼴(자료에 그 음이 있을 때). */
export function readingOf(t: HanjaTable, hanja: string, initial: boolean, prevHangul?: string): string | null {
  const e = t.byHanja.get(hanja);
  if (!e) return null;
  const base = (e.readings.find((r) => r.e) ?? e.readings[0]).r;
  const has = (r: string) => e.readings.some((x) => x.r === r);
  if (initial) {
    const d = dueum(base);
    if (d !== base && has(d)) return d;
    return base;
  }
  // 렬·률 은 모음·ㄴ 받침 뒤에서 열·율(比率 비율, 先烈 선열)
  if ((base === '렬' || base === '률') && vowelOrNieun(prevHangul)) {
    const d = dueum(base);
    if (has(d)) return d;
  }
  return base;
}

const isWordChar = (ch: string, t: HanjaTable) => isHangulSyllable(ch) || t.byHanja.has(ch) || /[\p{L}\p{N}]/u.test(ch);

/**
 * 한글로 바꾸기(글자 단위). format 'hangul' = 漢字를 한글로, 'hanjaHangul' = 漢字를 漢字(한글)로(이어진 한자 묶음마다 괄호).
 */
export function hanjaToHangul(t: HanjaTable, text: string, format: 'hangul' | 'hanjaHangul' = 'hangul'): string {
  const chars = [...text];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (!t.byHanja.has(chars[i])) { out += chars[i]; i++; continue; }
    let j = i;
    let run = '';
    let read = '';
    while (j < chars.length && t.byHanja.has(chars[j])) {
      const prev = j > 0 ? chars[j - 1] : '';
      const initial = j === i && !(prev && isWordChar(prev, t));
      const prevHangul = j === i ? prev : read.slice(-1);
      run += chars[j];
      read += readingOf(t, chars[j], initial, prevHangul) ?? chars[j];
      j++;
    }
    out += format === 'hangul' ? read : `${run}(${read})`;
    i = j;
  }
  return out;
}

/** 한자로 바꾸기 입력 형식으로 넣을 글 */
export function formatHanja(hanja: string, hangul: string, format: HanjaFormat): string {
  if (format === 'hanjaHangul') return `${hanja}(${hangul})`;
  if (format === 'hangulHanja') return `${hangul}(${hanja})`;
  return hanja;
}
