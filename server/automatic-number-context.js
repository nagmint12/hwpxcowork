// 자동 번호는 hp:t의 글자가 아니다. 정확한 find/서식 오프셋은 그대로 두고 읽기 자료에 별도로 싣는다.
// @num은 저장된 값이며 한/글이 다시 계산하는 최종 조판 번호라고 단정하지 않는다.
import { Section } from '../engine/section.js';
import { attrs } from '../engine/xmlscan.js';
export { automaticNumberReadNote } from './editor-instructions.js';

export function automaticNumberFields(doc, ref, view = 'final') {
  const { sec, p } = doc.resolve(ref);
  const automaticNumbers = [];
  for (const a of p.anchors) {
    if (a.kind !== 'ctrl' || a.inner !== 'hp:autoNum' || !Section.visibleObject(a, view)) continue;
    let format;
    for (let i = a.innerTok + 1; i < sec.tokens.length && sec.tokens[i].start < a.end; i++) {
      const t = sec.tokens[i];
      if (t.name === 'hp:autoNumFormat' && (t.type === 'open' || t.type === 'selfclose')) { format = Object.fromEntries(attrs(sec.xml, t)); break; }
    }
    const offset = Section.visibleChars({ chars: p.chars.slice(0, a.pos) }, view).length;
    automaticNumbers.push({ ...(view === 'final' ? { offset } : {}),
      type: a.innerAttrs.get('numType') ?? null, storedNumber: a.innerAttrs.get('num') ?? null,
      ...(format ? { format } : {}) });
  }
  return automaticNumbers.length ? { automaticNumbers } : {};
}

export function tableAutomaticNumbers(doc, table) {
  if (!table.caption) return table;
  const fields = automaticNumberFields(doc, table.caption.ref);
  return Object.keys(fields).length ? { ...table, caption: { ...table.caption, ...fields } } : table;
}
