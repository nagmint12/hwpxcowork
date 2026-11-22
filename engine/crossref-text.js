import { Section } from './section.js';
import { EngineError } from './errors.js';
import { charOps } from './diff.js';

const conflict = () => new EngineError('CROSSREF_CONFLICT', '상호참조가 가리키는 글을 교정 뒤에 한 곳으로 특정할 수 없습니다. 참조를 유지하고 앞뒤 문구를 나누어 고쳐 주세요.');

// 그림·표 번호만 필드 안에 있고 '<표 I-'와 '>'는 평문인 한/글 문서가 있다.
// 괄호 안 이름 전체로 찾으면 문단에 우연히 등장한 같은 숫자를 참조로 오인하지 않는다.
function labelOf(chars, lo, hi) {
  const left = chars.slice(0, lo).join('').match(/([<〈《\[])\s*[^<>〈〉《》\[\]\n]{0,64}$/u)?.[0];
  if (left) {
    const close = { '<': '>', '〈': '〉', '《': '》', '[': ']' }[left[0]];
    const right = chars.slice(hi, hi + 65).join('').match(/^[^<>〈〉《》\[\]\n]{0,64}([>〉》\]])/u)?.[0];
    if (right?.endsWith(close)) return { label: left + chars.slice(lo, hi).join('') + right, prefix: [...left].length };
  }
  const display = chars.slice(lo, hi).join('');
  const before = chars.slice(Math.max(0, lo - 64), lo).join('');
  const prefix = before.match(/(?:(?:그림|표|수식|식|부록|도표|장|절|figure|fig\.|table|equation|appendix|chapter|section)[ \t]*(?:[\p{L}\d]+[-.–])?|[\p{L}\d]+[-.–])$/iu)?.[0] ?? '';
  return { label: prefix + display, prefix: [...prefix].length };
}

export function crossrefFields(p, fc) {
  const markers = Section.fieldCtrls(p);
  const fields = [];
  for (const a of markers) {
    if (a.inner !== 'hp:fieldBegin' || a.innerAttrs.get('type') !== 'CROSSREF') continue;
    const id = a.innerAttrs.get('id');
    const b = markers.find(m => m.start >= a.end && m.inner === 'hp:fieldEnd' && m.innerAttrs.get('beginIDRef') === id);
    if (!b) continue;
    const offset = m => { const i = fc.findIndex(c => c.raw[0] >= m.end); return i < 0 ? fc.length : i; };
    fields.push({ begin: a, end: b, lo: offset(a), hi: offset(b) });
  }
  return fields;
}

export function crossrefOps(p, fc, start, end, text) {
  const fields = crossrefFields(p, fc).filter(f => start < f.hi && f.lo < end);
  if (!fields.length) return null;
  const chars = fc.map(c => c.ch);
  const newChars = [...chars.slice(0, start), ...text, ...chars.slice(end)];
  const after = newChars.join('');
  const newEnd = start + [...text].length;
  let from = start, to = start;
  const ops = [];
  const gap = (oldEnd, next) => {
    const before = chars.slice(from, oldEnd).join('');
    const replacement = newChars.slice(to, next).join('');
    for (const op of charOps(before, replacement)) ops.push({ start: from + op.start, end: from + op.end, text: op.text });
  };
  for (const f of fields) {
    if (f.lo < from || f.hi > end) throw conflict();
    const { label, prefix } = labelOf(chars, f.lo, f.hi);
    if (!label) throw conflict();
    const candidates = [];
    for (let i = after.indexOf(label); i !== -1; i = after.indexOf(label, i + 1)) {
      const at = [...after.slice(0, i)].length + prefix;
      if (at >= start && at + f.hi - f.lo <= newEnd) candidates.push(at);
    }
    let at = candidates[0];
    if (candidates.length > 1) {
      // 이미 같은 이름이 여러 번 나오는 경우, 교정 전부터 그대로인 앞/뒤 구간에서만 신원을 이어받는다.
      const original = chars.join('');
      if (original.split(label).length !== after.split(label).length) throw conflict();
      const fixed = candidates.filter(pos =>
        (pos === f.lo && chars.slice(0, f.hi).join('') === newChars.slice(0, f.hi).join('')) ||
        (pos === f.lo + newChars.length - chars.length && chars.slice(f.lo).join('') === newChars.slice(pos).join('')));
      if (fixed.length !== 1) throw conflict();
      at = fixed[0];
    }
    if (at === undefined || at < to) throw conflict();
    gap(f.lo, at);
    from = f.hi; to = at + f.hi - f.lo;
  }
  gap(end, newEnd);
  return ops;
}
