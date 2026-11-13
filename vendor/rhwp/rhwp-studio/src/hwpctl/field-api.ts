/**
 * [hwpx-cowork] 한컴 호환 누름틀 API(PutFieldText·GetFieldText·GetFieldList(number, option))의 몸통 — 한/글 2022 실측과 같게 (2026-11-12).
 *
 * 근거: 한/글 2022 12.0.0.3146 COM 실측 — hwpx-cowork `research/edit-preservation-20261112/range/hangul_same_name.md`
 *   - 같은 이름 누름틀은 만들 수 있다(CreateField·RenameField 가 막지 않고, 저장해도 이름이 남는다).
 *   - PutFieldText("이름", v): 같은 이름 칸 **모두**에 v. "이름{{n}}"(0부터): 그 칸만. v = "": 모두 비움.
 *   - 없는 이름·차례 넘침(`이름{{9}}`)·잘못된 꼴(`이름{1}` — 그런 이름이 없음): 아무것도 바꾸지 않고 오류도 없다.
 *   - "a\x02b" 목록: 이름마다 위 규칙(같은 이름이 두 번이면 뒤 값이 남는다).
 *   - GetFieldText("이름"): 첫 칸 값, "이름{{n}}": 그 칸, 없으면 "". 목록이면 \x02 로 이어 붙인다. 안내문만 있는 칸은 "".
 *   - GetFieldList(number, option): 이름을 \x02 로 이은 글. number 1 = 이름 뒤 `{{차례}}`(이름마다 0부터),
 *     number 2 = 이름마다 한 번 `{{개수}}`. option 0 = 전부, 비트 1 = 셀 필드, 비트 2 = 누름틀(옵션 2 결과 = 옵션 0, 셀 필드 없는 문서).
 * 엔진(Rust `set_field_value_by_name`)의 '첫 칸만' 의미는 다른 호출자(편집 기록·CLI)가 쓰므로 바꾸지 않고, 칸마다 필드 번호로 쓴다.
 * 문서를 바꾸는 호출은 이 파일에 두지 않는다 — 쓰기는 호출자(index.ts PutFieldText)가 콜백 `set(fieldId, value)` 로 넘긴다
 * (편집기 뮤테이션 원장 tests/mutation-routing-guard.test.ts 가 hwpctl/index.ts 의 사이트를 센다).
 * 이 파일은 import 가 없다(Node 시험이 바로 연다 — hwpx-cowork tests/hwpctl_put_field_text.test.mjs).
 */

export const FIELD_SEP = String.fromCharCode(2);

/** 엔진 getFieldList 항목(쓰는 것만) */
export interface FieldEntry {
  fieldId: number;
  name: string;
  value?: string;
  cellField?: boolean;
}

interface FieldDoc {
  getFieldList(): string;
}

/** 칸 하나에 값 쓰기(엔진 setFieldValue 의 JSON 결과 글을 돌려준다) — 호출자가 넘긴다 */
export type FieldWriter = (fieldId: number, value: string) => string;

/** 문서 차례(엔진 collect_all_fields 차례 — 한/글 GetFieldList 의 `{{n}}` 차례와 같은 seed 에서 확인) */
export function fieldEntries(doc: FieldDoc): FieldEntry[] {
  try {
    const parsed = JSON.parse(doc.getFieldList());
    const list = Array.isArray(parsed) ? parsed : (parsed?.fields ?? []);
    return list.filter((f: any) => f && typeof f.name === 'string');
  } catch {
    return [];
  }
}

/** "이름{{n}}" → { name, occurrence: n }. 그 밖의 꼴(`이름{1}`·`이름{{-1}}` 포함)은 이름 그대로(그런 이름이 없으면 아무 칸도 아니다) */
export function parseFieldToken(token: string): { name: string; occurrence: number | null } {
  const m = /^([\s\S]+)\{\{(\d+)\}\}$/.exec(token);
  if (m) return { name: m[1], occurrence: Number(m[2]) };
  return { name: token, occurrence: null };
}

/** 토큰 하나가 가리키는 칸들(이름만 = 그 이름 칸 모두, {{n}} = 그 칸, 없으면 []) */
export function fieldsForToken(entries: FieldEntry[], token: string): FieldEntry[] {
  const { name, occurrence } = parseFieldToken(token);
  const same = entries.filter((f) => f.name === name);
  if (occurrence == null) return same;
  return same[occurrence] ? [same[occurrence]] : [];
}

/**
 * PutFieldText — 한/글처럼 칸 모두/그 칸에 넣는다. 던지지 않는다.
 * 반환: 칸 하나라도 바꿨으면 true(hwpctl 기존 계약 — 한/글 PutFieldText 는 반환값이 없다. 없는 이름·차례 넘침은 한/글처럼 아무것도 바꾸지 않고 false)
 */
export function putFieldText(doc: FieldDoc, fieldlist: string, textlist: string, set: FieldWriter): boolean {
  if (typeof fieldlist !== 'string' || !fieldlist) return false;
  const names = fieldlist.split(FIELD_SEP);
  const values = typeof textlist === 'string' ? textlist.split(FIELD_SEP) : [];
  let changed = false;
  names.forEach((token, i) => {
    const value = values[i] ?? '';
    const entries = fieldEntries(doc);
    for (const f of fieldsForToken(entries, token)) {
      // 엔진의 필드 번호 쓰기는 그 번호의 **첫** 칸에 쓴다. 셀 이름 필드의 번호((컨트롤<<16)|셀)는 문서 전체에서 겹칠 수 있어,
      // 그 번호의 첫 칸이 이 칸이 아니면 엉뚱한 칸에 쓰지 않게 건너뛴다(그런 문서는 한/글과 다를 수 있음 — 미검증)
      if (entries.find((e) => e.fieldId === f.fieldId) !== f) {
        console.warn(`[hwpctl] PutFieldText("${token}"): 필드 번호 ${f.fieldId} 가 겹쳐 이 칸을 건너뜀`);
        continue;
      }
      try {
        const r = JSON.parse(set(f.fieldId, value));
        if (r?.ok === true) changed = true;
      } catch (e) {
        console.warn(`[hwpctl] PutFieldText("${token}") 칸 ${f.fieldId}: ${e}`);
      }
    }
  });
  return changed;
}

/** GetFieldText — 이름만 = 첫 칸 값, {{n}} = 그 칸, 없으면 ''. 목록이면 \x02 로 잇는다 */
export function getFieldText(doc: FieldDoc, fieldlist: string): string {
  if (typeof fieldlist !== 'string' || !fieldlist) return '';
  const entries = fieldEntries(doc);
  return fieldlist.split(FIELD_SEP).map((token) => fieldsForToken(entries, token)[0]?.value ?? '').join(FIELD_SEP);
}

/** GetFieldList(number, option) — 한/글 꼴 글 */
export function fieldListText(doc: FieldDoc, number = 0, option = 0): string {
  const wantCell = option === 0 || (option & 1) !== 0;
  const wantClick = option === 0 || (option & 2) !== 0;
  const picked = fieldEntries(doc).filter((f) => (f.cellField ? wantCell : wantClick));
  if (number === 2) {
    const counts = new Map<string, number>();
    for (const f of picked) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    return [...counts].map(([n, c]) => `${n}{{${c}}}`).join(FIELD_SEP);
  }
  const seen = new Map<string, number>();
  return picked.map((f) => {
    const k = seen.get(f.name) ?? 0; seen.set(f.name, k + 1);
    return number === 1 ? `${f.name}{{${k}}}` : f.name;
  }).join(FIELD_SEP);
}
