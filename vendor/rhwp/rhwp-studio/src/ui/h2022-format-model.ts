/**
 * [hwpx-cowork] 한/글 2022 서식·쪽 대화상자의 값 ↔ 엔진 JSON 변환 (2026-11-11, h2022-format).
 * DOM·별칭 import 가 없는 순수 모듈이라 Node 시험(tests/h2022_format.test.mjs)이 그대로 불러 쓴다.
 * 근거: 한/글 2022 ParameterSet PageNumPos·PageHiding·ColDef(official/ParameterSetTable_2504.pdf),
 * COM 실측 artifacts/h2022-format/com/result*.json.
 */

export const HWPUNIT_PER_MM = 7200 / 25.4;
/** 한/글 ColDef WidthGap 의 비율 기준(영역 전체 폭 = 32768) */
export const COLUMN_RATIO_BASE = 32768;

/** 쪽 번호 위치(PageNumPos DrawPos) — 한/글 창의 번호 위치 단추 차례 */
export const PAGE_NUM_POSITIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '없음' },
  { value: 1, label: '왼쪽 위' },
  { value: 2, label: '가운데 위' },
  { value: 3, label: '오른쪽 위' },
  { value: 7, label: '바깥쪽 위' },
  { value: 9, label: '안쪽 위' },
  { value: 4, label: '왼쪽 아래' },
  { value: 5, label: '가운데 아래' },
  { value: 6, label: '오른쪽 아래' },
  { value: 8, label: '바깥쪽 아래' },
  { value: 10, label: '안쪽 아래' },
];

/** 쪽 번호 모양(PageNumPos NumberFormat) — ParameterSet 표에 적힌 9가지 */
export const PAGE_NUM_FORMATS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '1, 2, 3' },
  { value: 1, label: '①, ②, ③' },
  { value: 2, label: 'Ⅰ, Ⅱ, Ⅲ' },
  { value: 3, label: 'ⅰ, ⅱ, ⅲ' },
  { value: 4, label: 'A, B, C' },
  { value: 8, label: '가, 나, 다' },
  { value: 13, label: '一, 二, 三' },
  { value: 15, label: '갑, 을, 병' },
  { value: 16, label: '甲, 乙, 丙' },
];

export interface PageNumberingValue {
  position: number;
  format: number;
  dash: boolean;
  /** 시작 번호(1..). 한/글: 새 번호가 없고 1 이면 아무것도 넣지 않는다. */
  startNumber: number;
}

/** getPageNumbering 결과 → 창 값. 한/글 기본값: 위치 없음, 1,2,3, 줄표 넣기, 시작 번호 1 */
export function pageNumberingFromEngine(info: Record<string, unknown> | null | undefined): PageNumberingValue {
  const exists = !!info && info.exists === true;
  const start = info && typeof info.startNumber === 'number' && info.startNumber > 0 ? info.startNumber : 1;
  if (!exists) return { position: 0, format: 0, dash: true, startNumber: start };
  return {
    position: Number(info!.position) || 0,
    format: Number(info!.format) || 0,
    dash: info!.dash === true,
    startNumber: start,
  };
}

export const HIDE_FIELDS = [
  { key: 'hideHeader', label: '머리말', bit: 0x01 },
  { key: 'hideFooter', label: '꼬리말', bit: 0x02 },
  { key: 'hideMasterPage', label: '바탕쪽', bit: 0x04 },
  { key: 'hideBorder', label: '테두리', bit: 0x08 },
  { key: 'hideFill', label: '배경', bit: 0x10 },
  { key: 'hidePageNum', label: '쪽 번호', bit: 0x20 },
] as const;

export type HideKey = typeof HIDE_FIELDS[number]['key'];
export type HideFlags = Record<HideKey, boolean>;

/** getPageHide 결과 → 여섯 칸 */
export function hideFlagsFromEngine(info: Record<string, unknown> | null | undefined): HideFlags {
  const out = {} as HideFlags;
  for (const f of HIDE_FIELDS) out[f.key] = !!info && info.exists === true && info[f.key] === true;
  return out;
}

/** 여섯 칸 → 한/글 PageHiding Fields 비트 */
export function hideFlagsToBits(flags: HideFlags): number {
  let bits = 0;
  for (const f of HIDE_FIELDS) if (flags[f.key]) bits |= f.bit;
  return bits;
}

/** setPageHide 위치 인자 차례(머리말, 꼬리말, 바탕쪽, 테두리, 배경, 쪽 번호) */
export function hideFlagsToArgs(flags: HideFlags): [boolean, boolean, boolean, boolean, boolean, boolean] {
  return [flags.hideHeader, flags.hideFooter, flags.hideMasterPage, flags.hideBorder, flags.hideFill, flags.hidePageNum];
}

/** 단 구분선 종류(엔진 separator_type → HWPX colLine type). 0 = 없음 */
export const COLUMN_LINE_TYPES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '없음' },
  { value: 1, label: '실선' },
  { value: 2, label: '긴 점선' },
  { value: 3, label: '점선' },
  { value: 4, label: '-.-.-.-.' },
  { value: 5, label: '-..-..-..' },
  { value: 6, label: '긴 파선' },
  { value: 7, label: '원형 점선' },
];

/** 단 구분선 굵기(엔진 separator_width 차례 → mm). 한/글 실측 LineWidth 4 = 0.25 mm */
export const COLUMN_LINE_WIDTHS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0.1 mm' }, { value: 1, label: '0.12 mm' }, { value: 2, label: '0.15 mm' },
  { value: 3, label: '0.2 mm' }, { value: 4, label: '0.25 mm' }, { value: 5, label: '0.3 mm' },
  { value: 6, label: '0.4 mm' }, { value: 7, label: '0.5 mm' }, { value: 8, label: '0.6 mm' },
  { value: 9, label: '0.7 mm' }, { value: 10, label: '1.0 mm' }, { value: 11, label: '1.5 mm' },
  { value: 12, label: '2.0 mm' }, { value: 13, label: '3.0 mm' }, { value: 14, label: '4.0 mm' },
  { value: 15, label: '5.0 mm' },
];

export interface ColumnDialogValue {
  count: number;
  type: number;
  direction: number;
  sameWidth: boolean;
  /** 같은 너비일 때 단 사이 간격(mm) */
  spacingMm: number;
  /** 단별 너비(mm) — count 개 */
  widthsMm: number[];
  /** 단별 뒤 간격(mm) — count 개, 마지막은 0 */
  gapsMm: number[];
  lineType: number;
  lineWidth: number;
  lineColor: string;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 같은 너비 단들의 너비(mm) */
export function equalWidthsMm(bodyWidthHu: number, count: number, spacingMm: number): number[] {
  const n = Math.max(1, count);
  const bodyMm = bodyWidthHu / HWPUNIT_PER_MM;
  const w = (bodyMm - spacingMm * (n - 1)) / n;
  return Array.from({ length: n }, () => round1(Math.max(0, w)));
}

/** getColumnDefAt 결과 → 창 값 */
export function columnDialogFromEngine(def: Record<string, any>): ColumnDialogValue {
  const count = Math.max(1, Number(def.columnCount) || 1);
  const body = Number(def.bodyWidth) || 0;
  const spacingMm = round1((Number(def.spacing) || 0) / HWPUNIT_PER_MM);
  const sameWidth = def.sameWidth !== false || !Array.isArray(def.widths) || def.widths.length !== count;
  let widthsMm: number[];
  let gapsMm: number[];
  if (!sameWidth) {
    const widths: number[] = def.widths.map(Number);
    const gaps: number[] = Array.isArray(def.gaps) ? def.gaps.map(Number) : [];
    const total = widths.reduce((a, b) => a + b, 0) + gaps.slice(0, count).reduce((a, b) => a + b, 0);
    const scale = total > 0 ? body / total / HWPUNIT_PER_MM : 0;
    widthsMm = widths.map((w) => round1(w * scale));
    gapsMm = Array.from({ length: count }, (_, i) => (i < count - 1 ? round1((gaps[i] || 0) * scale) : 0));
  } else {
    widthsMm = equalWidthsMm(body, count, spacingMm);
    gapsMm = Array.from({ length: count }, (_, i) => (i < count - 1 ? spacingMm : 0));
  }
  return {
    count,
    type: Number(def.columnType) || 0,
    direction: Number(def.direction) || 0,
    sameWidth,
    spacingMm,
    widthsMm,
    gapsMm,
    lineType: Number(def.separatorType) || 0,
    lineWidth: Number(def.separatorWidth) || 0,
    lineColor: typeof def.separatorColor === 'string' ? def.separatorColor : '#000000',
  };
}

/**
 * 창 값 → setColumnDefAt JSON. 단별 너비는 한/글 ColDef WidthGap 처럼 영역 전체 = 32768 비율로 바꾼다
 * (엔진 조판은 비율 합으로 나눠 쓰므로 단위와 상관없이 같은 폭이 된다).
 */
export function columnDialogToEngine(v: ColumnDialogValue): Record<string, unknown> {
  const count = Math.max(1, Math.min(255, Math.round(v.count)));
  const out: Record<string, unknown> = {
    columnCount: count,
    columnType: v.type,
    direction: v.direction,
    sameWidth: v.sameWidth || count === 1,
    spacing: Math.max(0, Math.min(32767, Math.round(v.spacingMm * HWPUNIT_PER_MM))),
    separatorType: v.lineType,
    separatorWidth: v.lineWidth,
    separatorColor: v.lineColor,
  };
  if (!out.sameWidth) {
    const widths = Array.from({ length: count }, (_, i) => Math.max(0, v.widthsMm[i] || 0));
    const gaps = Array.from({ length: count }, (_, i) => (i < count - 1 ? Math.max(0, v.gapsMm[i] || 0) : 0));
    const total = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    if (total <= 0) return { ...out, sameWidth: true };
    const ratio = (mm: number) => Math.round((mm / total) * COLUMN_RATIO_BASE);
    const rw = widths.map(ratio);
    const rg = gaps.map(ratio);
    // 반올림 끝수는 마지막 단에 몰아 합을 32768 로 맞춘다
    const sum = rw.reduce((a, b) => a + b, 0) + rg.reduce((a, b) => a + b, 0);
    rw[count - 1] += COLUMN_RATIO_BASE - sum;
    out.widths = rw;
    out.gaps = rg;
  }
  return out;
}

/**
 * 단 '왼쪽'·'오른쪽' 프리셋 — 왼쪽 = 좁은 단이 왼쪽(1:2), 오른쪽 = 좁은 단이 오른쪽(2:1).
 * 미실측: 한/글 MultiColumnLeft/Right 는 COM 액션이 아니라(com_result ok:false) 비율을 재지 못했다.
 * 1:2 는 한/글 단 단추 그림(sm_columnleft)의 모양을 따른 가정이다 — 원장 ledger_format.md ⑤.
 */
export function columnPreset(kind: 'left' | 'right', bodyWidthHu: number, spacingMm: number): ColumnDialogValue {
  const bodyMm = bodyWidthHu / HWPUNIT_PER_MM;
  const usable = Math.max(0, bodyMm - spacingMm);
  const narrow = round1(usable / 3);
  const wide = round1(usable - narrow);
  const widthsMm = kind === 'left' ? [narrow, wide] : [wide, narrow];
  return {
    count: 2, type: 0, direction: 0, sameWidth: false, spacingMm,
    widthsMm, gapsMm: [spacingMm, 0], lineType: 0, lineWidth: 1, lineColor: '#000000',
  };
}

// ─── 문단 번호 사용자 정의(h2022-format 2026-11-12) ───

/** 번호 모양 코드(HWP 표 43 = HWPX numFormat) */
export const NUMBER_SHAPES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '1, 2, 3' }, { value: 1, label: '①, ②, ③' }, { value: 2, label: 'Ⅰ, Ⅱ, Ⅲ' },
  { value: 3, label: 'ⅰ, ⅱ, ⅲ' }, { value: 4, label: 'A, B, C' }, { value: 5, label: 'a, b, c' },
  { value: 6, label: 'Ⓐ, Ⓑ, Ⓒ' }, { value: 7, label: 'ⓐ, ⓑ, ⓒ' }, { value: 8, label: '가, 나, 다' },
  { value: 9, label: '㉮, ㉯, ㉰' }, { value: 10, label: 'ㄱ, ㄴ, ㄷ' }, { value: 11, label: '㉠, ㉡, ㉢' },
  { value: 12, label: '일, 이, 삼' }, { value: 13, label: '一, 二, 三' }, { value: 14, label: '㊀, ㊁, ㊂' },
  { value: 15, label: '갑, 을, 병' }, { value: 16, label: '甲, 乙, 丙' },
];

export interface NumberingLevelRow {
  format: string;
  numFormat: number;
  start: number;
  /** 0 왼쪽 · 1 가운데 · 2 오른쪽 */
  align: number;
  useInstWidth: boolean;
  autoIndent: boolean;
  /** 너비 조정(HWPUNIT) */
  widthAdjust: number;
  /** 0 = 본문과의 거리 % · 1 = HWPUNIT */
  textOffsetType: number;
  textOffset: number;
}

const ROMAN = (n: number): string => {
  const v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const s = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let out = ''; let x = n;
  for (let i = 0; i < v.length; i++) while (x >= v[i]) { out += s[i]; x -= v[i]; }
  return out;
};
const pick = (chars: string, n: number): string => (n >= 1 && n <= [...chars].length ? [...chars][n - 1] : String(n));

/** 번호 n 을 번호 모양 code 로 쓴 글자(미리 보기용 — 표 43 의 앞쪽 범위만) */
export function formatNumberShape(n: number, code: number): string {
  switch (code) {
    case 1: return pick('①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳', n);
    case 2: return n >= 1 && n <= 12 ? pick('ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ', n) : ROMAN(n);
    case 3: return n >= 1 && n <= 12 ? pick('ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ', n) : ROMAN(n).toLowerCase();
    case 4: return pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ', n);
    case 5: return pick('abcdefghijklmnopqrstuvwxyz', n);
    case 6: return pick('ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ', n);
    case 7: return pick('ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ', n);
    case 8: return pick('가나다라마바사아자차카타파하', n);
    case 9: return pick('㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻', n);
    case 10: return pick('ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ', n);
    case 11: return pick('㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭', n);
    case 12: return pick('일이삼사오육칠팔구십', n);
    case 13: return pick('一二三四五六七八九十', n);
    case 14: return pick('㊀㊁㊂㊃㊄㊅㊆㊇㊈㊉', n);
    case 15: return pick('갑을병정무기경신임계', n);
    case 16: return pick('甲乙丙丁戊己庚辛壬癸', n);
    default: return String(n);
  }
}

/** 수준 level(0부터)의 번호 서식을 그 수준까지의 시작 번호로 펼친 미리 보기('^1.^2' 꼴의 상위 수준 참조도 바꾼다) */
export function previewLevel(rows: NumberingLevelRow[], level: number): string {
  return (rows[level]?.format ?? '').replace(/\^(\d+)/g, (m, k) => {
    const i = Number(k) - 1;
    const r = rows[i];
    return r && i <= level ? formatNumberShape(Math.max(0, r.start), r.numFormat) : m;
  });
}

/** getNumberingDetail 결과 → 창 줄(7수준) */
export function numberingRowsFromEngine(detail: { levels?: Array<Record<string, any>> } | null | undefined, count = 7): NumberingLevelRow[] {
  return Array.from({ length: count }, (_, i) => {
    const l = detail?.levels?.[i] ?? {};
    return {
      format: typeof l.format === 'string' ? l.format : `^${i + 1}.`,
      numFormat: Number(l.numFormat) || 0,
      start: Number.isFinite(Number(l.start)) ? Number(l.start) : 1,
      align: Number(l.align) || 0,
      useInstWidth: l.useInstWidth !== false,
      autoIndent: l.autoIndent !== false,
      widthAdjust: Number(l.widthAdjust) || 0,
      textOffsetType: Number(l.textOffsetType) === 1 ? 1 : 0,
      textOffset: Number.isFinite(Number(l.textOffset)) ? Number(l.textOffset) : 50,
    };
  });
}

/** 프리셋(서식 문자열·번호 모양) → 창 줄 */
export function numberingRowsFromPreset(levelFormats: string[], numberFormats: number[], start = 1): NumberingLevelRow[] {
  return Array.from({ length: 7 }, (_, i) => ({
    format: levelFormats[i] || `^${i + 1}.`, numFormat: numberFormats[i] ?? 0, start,
    align: 0, useInstWidth: true, autoIndent: true, widthAdjust: 0, textOffsetType: 0, textOffset: 50,
  }));
}

/** 창 줄 → createNumberingEx JSON */
export function numberingRowsToEngine(rows: NumberingLevelRow[]): Record<string, unknown> {
  return {
    levels: rows.map((r) => ({
      format: r.format, numFormat: r.numFormat, start: Math.max(0, Math.round(r.start)),
      align: r.align, useInstWidth: r.useInstWidth, autoIndent: r.autoIndent,
      widthAdjust: Math.round(r.widthAdjust), textOffsetType: r.textOffsetType, textOffset: Math.round(r.textOffset),
    })),
  };
}

// ─── 형광펜 이동(h2022-format 3차) ───

/** 형광펜 이동(MarkPenNext/Prev) — 본문 범위 목록에서 기준 자리 다음/이전 범위. 끝에 닿으면 처음/마지막으로 돌아간다(한/글 실측). */
export function pickMarkpenRange(
  ranges: Array<{ sec: number; para: number; start: number; end: number }>,
  at: { sec: number; para: number; offset: number },
  dir: 1 | -1,
): { sec: number; para: number; start: number; end: number } | null {
  if (!ranges.length) return null;
  const cmp = (r: { sec: number; para: number; start: number }) =>
    r.sec - at.sec || r.para - at.para || r.start - at.offset;
  if (dir > 0) return ranges.find((r) => cmp(r) > 0) ?? ranges[0];
  for (let i = ranges.length - 1; i >= 0; i--) if (cmp(ranges[i]) < 0) return ranges[i];
  return ranges[ranges.length - 1];
}
