/**
 * [hwpx-cowork] 문자열을 표로 / 표를 문자열로 — 나누기 규칙(DOM·엔진 없는 순수 로직, 2026-11-11, h2022 표 영역).
 *
 * 한/글 2022 액션 TableStringToTable(ParameterSet TableStrToTbl: DelimiterType 탭·쉼표·공백, UserDefine/DelimiterEtc 기타 문자,
 * AutoOrDefine 자동/지정, KeepSeperator 구분자 유지)·TableTableToString(TableTblToStr: DelimiterType, UserDefine).
 * COM 실측(기본값 = 자동/탭): 탭으로 나눈 문단 3개 → 3×3 표(짧은 줄은 빈 칸), 표 → 줄마다 문단 하나·칸 사이 탭·빈 칸은 탭만.
 * '자동'은 탭 문서로만 쟀다 — 탭이 없으면 쉼표, 그것도 없으면 줄 전체를 한 칸으로 두는 것은 이 편집기의 판단이다(미실측).
 */

export type TableTextDelimiter = 'auto' | 'tab' | 'comma' | 'space' | 'other';

export interface TableTextOptions {
  delimiter: TableTextDelimiter;
  /** delimiter === 'other' 일 때의 기타 문자열 */
  other?: string;
  /** 문자열을 표로: 구분 기호를 칸 글에 남긴다(한/글 KeepSeperator) */
  keepSeparator?: boolean;
}

export function delimiterString(options: TableTextOptions, lines: readonly string[] = []): string | null {
  switch (options.delimiter) {
    case 'tab': return '\t';
    case 'comma': return ',';
    case 'space': return ' ';
    case 'other': return options.other ? options.other : null;
    case 'auto':
      if (lines.some((l) => l.includes('\t'))) return '\t';
      if (lines.some((l) => l.includes(','))) return ',';
      return null;
  }
}

/** 문단 글들 → 칸 글 행렬(열 수 = 가장 긴 줄, 짧은 줄은 빈 칸). */
export function linesToCells(lines: readonly string[], options: TableTextOptions): string[][] {
  const sep = delimiterString(options, lines);
  const rows = lines.map((line) => {
    if (!sep) return [line];
    const parts = line.split(sep);
    return options.keepSeparator ? parts.map((p, i) => (i < parts.length - 1 ? p + sep : p)) : parts;
  });
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array(cols - r.length).fill('')]);
}

/** 칸 글 행렬 → 줄(문단) 글들. 기본(자동)은 탭. */
export function cellsToLines(rows: readonly (readonly string[])[], options: TableTextOptions): string[] {
  const sep = options.delimiter === 'auto' ? '\t' : delimiterString(options) ?? '\t';
  return rows.map((r) => r.join(sep));
}
