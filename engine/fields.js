// [hwpx-cowork] 누름틀(CLICK_HERE 필드) 읽기·채우기 — 2026-11-12 편집 범위 맞추기(research/edit-preservation-20261112/range).
//
// HWPX 의 누름틀은 한 문단 안의 <hp:ctrl><hp:fieldBegin type="CLICK_HERE" …/></hp:ctrl> … <hp:ctrl><hp:fieldEnd beginIDRef/></hp:ctrl>
// 사이 글이다. 메모도 fieldBegin(type="MEMO")을 쓰므로 여기서는 CLICK_HERE 만 다룬다(engine/doc.js 의 메모 처리와 섞지 않는다).
//
// 규칙의 근거(코드에 구현된 것):
//  - 이름: fieldBegin@name(비어 있지 않으면) → Command 의 Name: → 안내문(Direction:) — rhwp src/model/control.rs field_name()·
//    parser/hwpx/section.rs(name 을 ctrl_data_name 으로).
//  - 안내문 자리 글: 한/글 2022 는 아직 채우지 않은 누름틀을 저장할 때 안내문을 필드 안 글(빨간 글자 모양)로 함께 쓰고 dirty="0" 으로 둔다
//    (이 PC 한/글 2022 12.0.0.3146 이 다시 저장한 tests/fixtures/field_fill_seed.hwpx 실측). rhwp 는 dirty 가 0 이고 글이 안내문과 같으면
//    (끝 공백 무시) 값이 없는 것으로 본다 — src/document_core/commands/document/initial_fields.rs process_para.
//  - 채우기: rhwp set_field_value_by_name_at 은 필드 안 글을 값으로 바꾸고(안내문 자리 글은 지움) 필드 앞 글자 모양으로 쓰며 dirty="1" 로 저장한다
//    (편집기 엔진 setFieldValueByName → exportHwpx 실측). 여기서는 같은 결과를 변경 추적(지움·넣음)으로 만든다 — 반영은 사람이 한다.
//  - 같은 이름이 여러 번이면 'occurrence'(0부터, 문서 차례)로 고른다 — rhwp '이름[N]'(parse_field_key) 와 같은 차례.
import { Section } from './section.js';
import { EngineError } from './errors.js';
import { escapeText, decodeEntities } from './xmlscan.js';
import { applyEdits } from './doc.js';

/** fieldBegin 의 Command 같은 'Key:wstring:N:값' 에서 값(N = UTF-16 단위 수) */
function wstringValue(command, key) {
  const at = command.indexOf(key);
  if (at < 0) return null;
  const m = /^wstring:(\d+):/.exec(command.slice(at + key.length).replace(/^\s*/, ''));
  if (!m) return null;
  const rest = command.slice(at + key.length).replace(/^\s*/, '').slice(m[0].length);
  return rest.slice(0, Number(m[1]));
}

function paramText(xml, name) {
  const m = new RegExp(`<hp:stringParam\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</hp:stringParam>`).exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

/** 한 문단의 누름틀(시작·끝 짝이 같은 문단에 있는 것) */
function paragraphFields(sec, p) {
  const out = [];
  const ctrls = Section.fieldCtrls(p);
  const fc = Section.visibleChars(p, 'final');
  const finalAt = (pos) => { let n = 0; for (let i = 0; i < pos && i < p.chars.length; i++) if (!p.chars[i].del) n++; return n; };
  for (const a of ctrls) {
    if (a.inner !== 'hp:fieldBegin' || a.innerAttrs?.get('type') !== 'CLICK_HERE' || a.del) continue;
    const id = a.innerAttrs.get('id') ?? '';
    const end = ctrls.find((b) => b.inner === 'hp:fieldEnd' && b.start > a.start && (b.innerAttrs?.get('beginIDRef') ?? '') === id && !b.del);
    const beginXml = sec.xml.slice(a.start, a.end);
    const command = paramText(beginXml, 'Command') || '';
    const guide = wstringValue(command, 'Direction:') ?? paramText(beginXml, 'Direction') ?? '';
    const attrName = decodeEntities(a.innerAttrs.get('name') || '');
    const name = attrName || wstringValue(command, 'Name:') || guide || '';
    const dirty = a.innerAttrs.get('dirty') === '1';
    const editable = a.innerAttrs.get('editable') !== '0';
    const start = finalAt(a.pos);
    const stop = end ? finalAt(end.pos) : null;
    const content = stop == null ? '' : fc.slice(start, stop).map((c) => c.ch).join('');
    const isGuide = !dirty && content !== '' && guide !== '' && (content === guide || content.trimEnd() === guide);
    out.push({ id, name, guide, editable, dirty, start, end: stop, content, value: isGuide ? '' : content, isGuide, closed: !!end, begin: a, endAnchor: end || null, baseCharPr: a.run?.charPr ?? null });
  }
  return out;
}

/**
 * 문서의 누름틀 목록(문서 차례 — 구역 → 문단(본문·표 칸·글상자 안 중첩 문단을 전위 차례로)).
 * 반환: [{ name, occurrence, total, ref, start, end, value, guide, isGuide, editable, id }]
 *   start/end = 그 문단 최종본 글에서 필드 안 글의 범위(코드포인트), value = 안내문 자리 글이면 ''.
 *   시작·끝이 다른 문단에 걸친 누름틀은 closed=false 로 싣고 채우지 않는다.
 */
export function listFields(doc) {
  const out = [];
  for (const sec of doc.sections) {
    for (const p of sec.paras) {
      if (p.container === 'hp:fieldBegin') continue;          // 메모 본문
      if (!Section.visibleParagraph(p, 'final')) continue;    // 지운 개체 안 문단
      for (const f of paragraphFields(sec, p)) out.push({ ...f, ref: p.ref });
    }
  }
  const total = new Map(); for (const f of out) total.set(f.name, (total.get(f.name) || 0) + 1);
  const seen = new Map();
  return out.map((f) => {
    const occurrence = seen.get(f.name) || 0; seen.set(f.name, occurrence + 1);
    return { name: f.name, occurrence, total: total.get(f.name), ref: f.ref, start: f.start, end: f.end, value: f.value, guide: f.guide, isGuide: f.isGuide,
      editable: f.editable, id: f.id, ...(f.closed ? {} : { closed: false }) };
  });
}

/**
 * 한/글 차례 문법 '이름{{n}}'(0부터 — 한/글 GetFieldList(1,…)·PutFieldText·GetFieldText 와 같은 꼴)을 이름·차례로 가른다.
 * 이름 끝이 {{숫자}} 가 아니면 이름 그대로(차례 없음). occurrence 인자와 함께 주면 둘이 같아야 한다
 */
export function parseFieldKey(name, occurrence = null) {
  const key = String(name ?? '');
  const m = /^([\s\S]*)\{\{(\d+)\}\}$/.exec(key);
  if (!m) return { name: key, occurrence };
  const k = Number(m[1] === '' ? NaN : m[2]);
  if (!Number.isSafeInteger(k)) return { name: key, occurrence };
  if (occurrence != null && occurrence !== k) throw new EngineError('BAD_FIELD', `누름틀 「${key}」의 차례와 occurrence(${occurrence})가 다릅니다`);
  return { name: m[1], occurrence: k };
}

/**
 * 채울 누름틀 하나를 고른다(차례 없이 고르면 첫 칸 — 한/글 GetFieldText("이름") 이 첫 칸 값). 없음·차례 넘침은 NOT_FOUND
 * (한/글 PutFieldText 는 그때 아무것도 바꾸지 않는다 — 우리는 그 항목을 실패로 알린다). 이름이 같은 칸 '모두'는 expandFieldFill 이 칸마다 나눈다
 */
export function pickField(doc, { name, occurrence = null }) {
  const parsed = parseFieldKey(name, occurrence);
  const key = parsed.name;
  if (!key) throw new EngineError('BAD_FIELD', '누름틀 이름(name)이 필요합니다');
  const all = listFields(doc).filter((f) => f.name === key);
  if (!all.length) throw new EngineError('NOT_FOUND', `누름틀 「${key}」이(가) 문서에 없습니다(list_fields 로 이름을 확인하세요)`);
  const k = parsed.occurrence == null ? 0 : parsed.occurrence;
  const f = all[k];
  if (!f) throw new EngineError('NOT_FOUND', `누름틀 「${key}」의 ${k}번째(0부터)가 없습니다 — ${all.length}개`);
  if (f.closed === false) throw new EngineError('FIELD_SPAN', `누름틀 「${key}」은(는) 문단을 넘어 걸쳐 있어 채울 수 없습니다`);
  return f;
}

/**
 * 채우기 항목(제안 입력 { fieldFill: { name, occurrence }, replace, … }) → 칸마다 항목. 한/글 2022 PutFieldText("이름", 값) 은 이름이 같은 칸
 * **모두**에 넣고 "이름{{n}}" 은 그 칸만 넣는다(research/edit-preservation-20261112/range/hangul_same_name.md). 차례 없는 이름이면 그 이름의
 * 칸마다 occurrence 를 단 항목으로 나누고, 이미 그 값인 칸은 뺀다(한/글도 바뀌는 것이 없다 — 모든 칸이 그 값이면 첫 칸 하나로 두어 SAME 으로 알린다).
 * 없는 이름은 그대로 하나(→ NOT_FOUND)
 */
export function expandFieldFill(doc, item) {
  const ff = item?.fieldFill;
  if (!ff) return [item];
  let parsed;
  try { parsed = parseFieldKey(ff.name, ff.occurrence ?? null); } catch { return [item]; }
  if (parsed.occurrence != null) return [{ ...item, fieldFill: { ...ff, name: parsed.name, occurrence: parsed.occurrence } }];
  const all = listFields(doc).filter((f) => f.name === parsed.name);
  if (all.length < 2) return [{ ...item, fieldFill: { ...ff, name: parsed.name, occurrence: null } }];
  const value = String(item.replace ?? '');
  const todo = all.filter((f) => f.value !== value);
  return (todo.length ? todo : all.slice(0, 1)).map((f) => ({ ...item, fieldFill: { ...ff, name: parsed.name, occurrence: f.occurrence } }));
}

/** 문단 ref 안 필드 id 의 지금 모습 */
export function fieldAt(doc, ref, id) {
  const { sec, p } = doc.resolve(ref);
  return paragraphFields(sec, p).find((f) => f.id === String(id)) || null;
}

/**
 * 누름틀 채우기를 변경 추적으로: 필드 안 글(값 또는 안내문 자리 글)을 지움으로, 새 값을 필드 안 넣음으로 표시한다.
 * 넣은 글은 필드 앞 글자 모양(fieldBegin 이 든 run) — 편집기 엔진(rhwp set_field_value_by_name_at)과 같다. dirty 를 1 로(채움 표시).
 * 반환: { changeIds, dirtyBefore }
 */
export function fillFieldTracked(doc, ref, id, value, { author, date } = {}) {
  if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new EngineError('BAD_VALUE', '누름틀 값에는 줄바꿈을 넣을 수 없습니다(한 문단 안 글)');
  const f = fieldAt(doc, ref, id);
  if (!f || !f.closed) throw new EngineError('STALE', `문단 ${ref} 에서 누름틀(id ${id})을 찾지 못했습니다(문서가 바뀌었을 수 있음)`);
  const dirtyBefore = f.dirty ? '1' : '0';
  const base = f.baseCharPr ?? '0';
  let ids = [];
  if (f.end > f.start) {
    // 필드 안 글이 있으면(값·안내문 자리 글) 그 범위를 바꾼다 — 넣을 글은 마지막 지운 글자 뒤(필드 끝 부호 앞)에 들어간다
    const res = doc.replaceTracked(ref, f.start, f.end, text, { author, date, ...(text ? { runs: [{ text, charPrId: String(base) }] } : {}) });
    ids = [...(res.deleteIds || [res.deleteId]), ...(res.insertIds || [res.insertId])].filter((x) => x != null).map(Number);
  } else if (text) {
    // 빈 누름틀: 최종본 자리(offset)로 넣으면 필드 시작 부호 앞(필드 밖)에 들어간다 — 시작 부호 바로 뒤(run 안)에 넣는다
    const { sec, p } = doc.resolve(ref);
    const authorId = doc.header.ensureAuthor(author);
    const cid = doc.header.addChange('Insert', authorId, date);
    if (!doc.header.trackingEnabled()) doc.header.setTracking(true);
    const xml = `<hp:t><hp:insertBegin Id="${cid}" TcId="${cid}"/>${escapeText(text).replace(/\t/g, '<hp:tab/>')}<hp:insertEnd Id="${cid}" TcId="${cid}" paraend="0"/></hp:t>`;
    const edits = [{ pos: f.begin.end, insert: xml }];
    for (const ls of Section.linesegs(p)) edits.push({ start: ls.start, end: ls.end, insert: '' });
    sec.load(applyEdits(sec.xml, edits));
    ids = [Number(cid)];
  }
  setFieldDirty(doc, ref, id, '1');
  return { changeIds: ids, dirtyBefore };
}

/** fieldBegin@dirty 를 바꾼다(없으면 더한다). 반환: 바꿨으면 true */
export function setFieldDirty(doc, ref, id, value) {
  const f = fieldAt(doc, ref, id);
  if (!f) return false;
  const { sec } = doc.resolve(ref);
  const a = f.begin;
  const tag = sec.xml.slice(a.innerStart, a.innerEnd);
  const next = /\sdirty="[^"]*"/.test(tag) ? tag.replace(/\sdirty="[^"]*"/, ` dirty="${value}"`) : tag.replace(/^<hp:fieldBegin\b/, `<hp:fieldBegin dirty="${value}"`);
  if (next === tag) return false;
  sec.load(applyEdits(sec.xml, [{ start: a.innerStart, end: a.innerEnd, insert: next }]));
  return true;
}

/** 제안 꼴: 채울 누름틀 → replace 제안 입력(ref·start·end·replace + field) */
export function fieldFillInput(doc, { name, occurrence = null, value }) {
  const f = pickField(doc, { name, occurrence });
  if (!f.editable) throw new EngineError('NOT_EDITABLE', `누름틀 「${f.name}」은(는) 양식 모드에서 고칠 수 없는 칸(editable=0)입니다`);
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new EngineError('BAD_VALUE', '누름틀 값에는 줄바꿈을 넣을 수 없습니다(한 문단 안 글)');
  if (text === f.value) throw new EngineError('SAME', `누름틀 「${f.name}」은(는) 이미 그 값입니다`);
  return { ref: f.ref, start: f.start, end: f.end, replace: text, field: { id: f.id, name: f.name, occurrence: f.occurrence, guide: f.isGuide } };
}
