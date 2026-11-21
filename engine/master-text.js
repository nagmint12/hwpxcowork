// 바탕쪽 원문은 구역 XML 밖의 HWPX 파트에 있다. 구역이 참조하는 순서와
// 문단의 구조 주소로 연결하여 서버에만 있는 글·그림·글자 모양을 보존한다.
import { Section } from './section.js';
import { attr, escapeText, scan } from './xmlscan.js';
import { charOps } from './diff.js';
import { EngineError } from './errors.js';

const owners = new WeakMap();
const parts = new WeakMap();

function masterOwners(doc) {
  const hpf = doc.container.files.get('Contents/content.hpf');
  const cached = owners.get(doc);
  if (cached?.manifest === hpf && cached.sections.length === doc.sections.length
    && cached.sections.every((s, i) => s === doc.sections[i].xml)) return cached.result;
  const result = new Map();
  if (doc.container.order.some(n => /masterpage/i.test(n)) || doc.sections.some(s => s.xml.includes('<hp:masterPage'))) {
    const manifest = doc.container.getText('Contents/content.hpf') || '';
    const entries = new Map();
    for (const token of scan(manifest)) {
      if (token.name === 'opf:item' && token.type !== 'close') {
        entries.set(attr(manifest, token, 'id'), attr(manifest, token, 'href'));
      }
    }
    for (const [section, sec] of doc.sections.entries()) {
      let slot = 0;
      for (const token of sec.tokens) {
        if (token.name !== 'hp:masterPage' || token.type === 'close') continue;
        const name = entries.get(attr(sec.xml, token, 'idRef'));
        if (name && doc.container.files.has(name)) result.set(`${section}/${slot}`, name);
        slot++;
      }
    }
  }
  owners.set(doc, { manifest: hpf, sections: doc.sections.map(s => s.xml), result });
  return result;
}

function readPart(doc, name) {
  const bytes = doc.container.files.get(name);
  if (!bytes) return null;
  let part = parts.get(bytes);
  if (!part) {
    part = new Section(doc.container.getText(name), 0);
    parts.set(bytes, part);
  }
  return part;
}

export function masterTextChanges(base, head) {
  const next = masterOwners(head);
  const changes = [];
  for (const [owner, name] of masterOwners(base)) {
    const otherName = next.get(owner);
    if (!otherName) continue;
    const a = readPart(base, name);
    const b = readPart(head, otherName);
    if (a === b || a.xml === b.xml) continue;
    const [section, slot] = owner.split('/').map(Number);
    for (const p of a.paras) {
      if (p.alt || p.hidden) continue;
      const q = b.byRef(p.ref);
      if (!q || p.container !== q.container) continue;
      const before = Section.text(p, 'final');
      const after = Section.text(q, 'final');
      if (before !== after) changes.push({ type: 'masterText', ref: `s${section}/p0`, headRef: `s${section}/p0`,
        master: { section, slot, ref: p.ref, container: p.container ?? null }, baseText: before, newText: after, cell: null });
    }
  }
  return changes;
}

function locate(doc, address) {
  if (!address) return null;
  const name = masterOwners(doc).get(`${address.section}/${address.slot}`);
  const part = name && readPart(doc, name);
  const p = part?.byRef(address.ref);
  return p && (p.container ?? null) === address.container ? { name, part, p } : null;
}

export function masterTextAt(doc, address) {
  const found = locate(doc, address);
  return found ? Section.text(found.p, 'final') : null;
}

// 원문 범위만 고친다. 다른 run·셀·글상자·그림·스타일 ID는 서버 문서의 것을 쓴다.
export function writeMasterText(doc, address, text, applyEdits, source, sourceAddress = address) {
  const found = locate(doc, address);
  if (!found) throw new EngineError('NO_PARAGRAPH', '바탕쪽 문단을 찾을 수 없습니다.');
  const { name, part, p } = found;
  const before = Section.text(p, 'final');
  if (before === text) return false;
  const chars = Section.visibleChars(p, 'final');
  const changes = [];
  for (const op of charOps(before, text)) {
    for (const char of chars.slice(op.start, op.end)) changes.push({ start: char.raw[0], end: char.raw[1], insert: '' });
    if (!op.text) continue;
    const literal = escapeText(op.text);
    const pos = chars[op.start]?.raw[0] ?? chars[op.start - 1]?.raw[1];
    if (pos != null) changes.push({ pos, insert: literal });
    else {
      const t = p.ts[0];
      if (t?.selfclose) changes.push({ start: t.openStart, end: t.openEnd, insert: `<hp:t>${literal}</hp:t>` });
      else if (t) changes.push({ pos: t.openEnd, insert: literal });
      else if (p.runs.length) {
        const run = p.runs[0];
        const token = part.tokens[run.openTok];
        if (token.type === 'selfclose') {
          const open = part.xml.slice(token.start, token.end).replace(/\/\s*>$/, '>');
          changes.push({ start: token.start, end: token.end, insert: `${open}<hp:t>${literal}</hp:t></hp:run>` });
        } else changes.push({ pos: token.end, insert: `<hp:t>${literal}</hp:t>` });
      } else {
        const close = part.xml.lastIndexOf('</hp:p>', p.end - 1);
        if (close < p.start) throw new EngineError('NO_PARAGRAPH', '바탕쪽 글을 넣을 문단을 찾을 수 없습니다.');
        changes.push({ pos: close, insert: `<hp:run charPrIDRef="0"><hp:t>${literal}</hp:t></hp:run>` });
      }
    }
  }
  // 같은 원문의 줄은 편집기가 계산한 줄을 보존한다. 서로 다른 두 편집을 합쳤으면
  // 이미 유효하지 않은 저장 줄을 비워 새 내용 폭에 맞춰 조판하도록 한다.
  const other = source && locate(source, sourceAddress);
  const lines = other && Section.text(other.p, 'final') === text ? other.p.lineseg : null;
  const lineXml = lines ? other.part.xml.slice(lines.start, lines.end) : '';
  if (p.lineseg) changes.push({ start: p.lineseg.start, end: p.lineseg.end, insert: lineXml });
  else if (lineXml) changes.push({ pos: part.tokens[p.closeTok].start, insert: lineXml });
  const updated = applyEdits(part.xml, changes);
  const parsed = new Section(updated, 0);
  const result = parsed.byRef(p.ref);
  if (!result || Section.text(result, 'final') !== text) throw new EngineError('MASTER_TEXT_MISMATCH', '바탕쪽 글을 보존할 수 없습니다.');
  doc.container.setText(name, updated);
  parts.set(doc.container.files.get(name), parsed);
  return true;
}
