/**
 * [hwpx-cowork] 표 자동 채우기(한/글 2022 TableAutoFill) 규칙 — DOM·엔진 없는 순수 로직(2026-11-12, h2022 표).
 *
 * 한/글 2022 COM 실측(`artifacts/h2022-table/com/probe2.py` autofill2·autofill3, 셀 블록 + TableAutoFill):
 * - 방향: 블록의 줄 수 > 칸 수면 세로(칸마다 위→아래), 아니면 가로(줄마다 왼쪽→오른쪽). (3×3·2×5·3×6 가로, 5×2·6×3 세로)
 * - 시작 값 = 그 줄(칸)의 앞에서부터 이어진 글 있는 칸들. 시작 값 뒤 칸을 채운다. 첫 칸만 빈 줄은 그대로(['',1] 그대로),
 *   통째로 빈 줄은 앞 줄을 받는다(3×3 블록의 빈 셋째 줄이 둘째 줄 5,5,5 — 한 사례뿐).
 * - 시작 값 하나 → 그대로 되풀이('1'→1,1,1 · '월'→월,월 · '1월'→1월,1월).
 * - 숫자 둘 이상: 차이가 같으면 등차(1,3→5,7 · 10,7→4,1,-2 · 1.5,2→2.5,3 · 1,1→1), 셋 이상이 비가 같으면 등비(1,2,4→8,16).
 * - 같은 앞뒤 글 + 숫자(제1장·1분기·A1·1월): 숫자를 등차로(제1장,제2장→제3장). [12월,1월 은 한/글이 -10월,-8월… — 규칙 불명, 미재현]
 * - 목록에서 바로 다음(한 칸씩)인 시작 값: 그 목록을 잇는다 — 요일(월~일, 돌아감: 토,일→월), 요일 이름, 가~하(돌지 않음: 하,가→되풀이),
 *   갑을병정…, ㄱㄴㄷ…, A~Z·a~z(돌아감: x,y→z,a), 子丑寅卯…, Mon~Sun, January~.
 * - 그 밖(월,수 · 가,다 · ①,② · 2026-11-12,2026-11-13 · abc,abd · Z,AA · 1,가): 시작 값들을 되풀이.
 * 한/글의 사용자 정의 채우기 목록(도구 > 환경 설정)은 범위 밖이다.
 */

type FillList = { items: string[]; cyclic: boolean };

const range = (from: string, to: string) => {
  const out: string[] = [];
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c += 1) out.push(String.fromCharCode(c));
  return out;
};

export const AUTOFILL_LISTS: FillList[] = [
  { items: ['월', '화', '수', '목', '금', '토', '일'], cyclic: true },
  { items: ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'], cyclic: true },
  { items: ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'], cyclic: false },
  { items: ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'], cyclic: true },
  { items: ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'], cyclic: true },
  { items: range('A', 'Z'), cyclic: true },
  { items: range('a', 'z'), cyclic: true },
  { items: ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'], cyclic: true },
  { items: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], cyclic: true },
  { items: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], cyclic: true },
];

const NUM = /^-?\d+(\.\d+)?$/;
const AFFIX = /^(\D*?)(\d+)(\D*)$/;

function fmt(n: number): string {
  const r = Math.round(n * 1e10) / 1e10;
  return String(Object.is(r, -0) ? 0 : r);
}

function constantStep(nums: number[]): number | null {
  const d = nums[1] - nums[0];
  return nums.every((v, i) => i === 0 || Math.abs(v - nums[i - 1] - d) < 1e-9) ? d : null;
}

function constantRatio(nums: number[]): number | null {
  if (nums.length < 3 || nums.some((v) => v === 0)) return null;
  const q = nums[1] / nums[0];
  return nums.every((v, i) => i === 0 || Math.abs(v / nums[i - 1] - q) < 1e-9) ? q : null;
}

/** 시작 값(seed)으로 길이 count 의 한 줄을 만든다(앞부분은 seed 그대로). seed 가 비면 null(그대로 둠). */
export function autofillLine(seed: readonly string[], count: number): string[] | null {
  if (!seed.length) return null;
  const out = [...seed];
  const repeat = () => { while (out.length < count) out.push(seed[(out.length) % seed.length]); return out.slice(0, count); };
  if (seed.length === 1) return repeat();
  // 숫자
  if (seed.every((s) => NUM.test(s))) {
    const nums = seed.map(Number);
    const d = constantStep(nums);
    if (d !== null) { while (out.length < count) out.push(fmt(nums[0] + d * out.length)); return out.slice(0, count); }
    const q = constantRatio(nums);
    if (q !== null) { while (out.length < count) out.push(fmt(nums[0] * q ** out.length)); return out.slice(0, count); }
    return repeat();
  }
  // 목록
  for (const list of AUTOFILL_LISTS) {
    const idx = seed.map((s) => list.items.indexOf(s));
    if (idx.some((i) => i < 0)) continue;
    const n = list.items.length;
    const next = (i: number) => (list.cyclic ? (i + 1) % n : i + 1);
    if (!idx.every((v, i) => i === 0 || v === next(idx[i - 1]))) continue;
    let cur = idx[idx.length - 1];
    while (out.length < count) {
      cur = next(cur);
      if (cur >= n) return repeat(); // 돌지 않는 목록 끝(미실측) — 되풀이로
      out.push(list.items[cur]);
    }
    return out.slice(0, count);
  }
  // 앞뒤 글 + 숫자
  const parts = seed.map((s) => AFFIX.exec(s));
  if (parts.every(Boolean) && parts.every((m) => m![1] === parts[0]![1] && m![3] === parts[0]![3])) {
    const nums = parts.map((m) => Number(m![2]));
    const d = constantStep(nums);
    if (d !== null) {
      while (out.length < count) out.push(`${parts[0]![1]}${fmt(nums[0] + d * out.length)}${parts[0]![3]}`);
      return out.slice(0, count);
    }
  }
  return repeat();
}

export interface AutofillPlanCell { row: number; col: number; text: string }

/**
 * 블록 칸 글(행렬, range 기준) → 채울 칸 목록. 방향은 줄 수 > 칸 수면 세로, 아니면 가로.
 * 시작 값 뒤 칸 중 글이 바뀌는 칸만 돌려준다(이미 같으면 손대지 않음).
 */
export function planAutofill(block: string[][]): AutofillPlanCell[] {
  const rows = block.length;
  const cols = rows ? block[0].length : 0;
  const vertical = rows > cols;
  const lines = vertical ? cols : rows;
  const len = vertical ? rows : cols;
  const at = (line: number, k: number) => (vertical ? block[k][line] : block[line][k]);
  const out: AutofillPlanCell[] = [];
  let prev: string[] | null = null;
  for (let line = 0; line < lines; line += 1) {
    const seed: string[] = [];
    for (let k = 0; k < len && at(line, k) !== ''; k += 1) seed.push(at(line, k));
    const current = Array.from({ length: len }, (_, k) => at(line, k));
    let filled: string[] | null;
    let from = seed.length;
    if (seed.length === len) {
      filled = current;
    } else if (seed.length === 0) {
      // 시작 값 없는 줄: 통째로 빈 줄이면 앞 줄을 그대로 받는다(한/글 3×3 실측 — 셋째 줄이 둘째 줄 5,5,5). 아니면 그대로.
      filled = prev && current.every((v) => v === '') ? [...prev] : null;
      from = 0;
    } else {
      filled = autofillLine(seed, len);
    }
    if (!filled) { prev = current; continue; }
    for (let k = from; k < len; k += 1) {
      if (filled[k] === at(line, k)) continue;
      out.push(vertical ? { row: k, col: line, text: filled[k] } : { row: line, col: k, text: filled[k] });
    }
    prev = filled;
  }
  return out;
}
