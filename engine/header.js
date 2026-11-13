// header.xml 조작: 변경 추적 작성자·항목, 추적 켜기/끄기, 메모 스타일 조회.
import { scan, attr, attrs, escapeAttr } from './xmlscan.js';

export class Header {
  constructor(xml) { this.xml = xml; }

  // ── 변경 추적 작성자 ──
  authors() {
    const out = [];
    const re = /<hh:trackChangeAuthor\b([^>]*)\/?>/g; let m;
    while ((m = re.exec(this.xml))) {
      const a = Object.fromEntries([...m[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
      out.push({ id: parseInt(a.id, 10), name: a.name, mark: parseInt(a.mark ?? '0', 10) });
    }
    return out;
  }

  // 한글은 작성자·변경 항목을 '목록의 순서(1부터)'로 찾는다(id 속성이 아니라 위치). 그래서 항상 id 를
  // 1..n 연속으로 두고, 새 항목은 맨 뒤에 붙이며, 항목을 지우면 다시 번호를 매긴다(doc.js 의 _renumberChanges).
  ensureAuthor(name) {
    const found = this.authors().find((a) => a.name === name);
    if (found) return found.id;
    const list = this.authors();
    const id = list.length + 1;
    // mark 는 색 번호가 아니라 '표시 여부' 플래그로 보인다(1 이 아니면 한글이 그 작성자의 변경을 표시하지 않음)
    const el = `<hh:trackChangeAuthor name="${escapeAttr(name)}" mark="1" id="${id}"/>`;
    if (/<hh:trackChangeAuthors\b/.test(this.xml)) {
      this.xml = this.xml.replace(/<hh:trackChangeAuthors\b([^>]*?)(\/?)>/, (all, a, sc) => {
        const attrsFixed = a.replace(/itemCnt="\d+"/, `itemCnt="${id}"`);
        return sc ? `<hh:trackChangeAuthors${attrsFixed}>${el}</hh:trackChangeAuthors>` : `<hh:trackChangeAuthors${attrsFixed}>`;
      });
      if (!/<hh:trackChangeAuthors\b[^>]*\/>/.test(this.xml) && !this.xml.includes(el)) this.xml = this.xml.replace('</hh:trackChangeAuthors>', `${el}</hh:trackChangeAuthors>`);
    } else {
      const block = `<hh:trackChangeAuthors itemCnt="1">${el}</hh:trackChangeAuthors>`;
      this.xml = this.xml.replace('</hh:refList>', `${block}</hh:refList>`);
    }
    return id;
  }

  // ── 변경 추적 항목 ──
  changes() {
    const out = [];
    const re = /<hh:trackChange\b([^>]*)\/?>/g; let m;
    while ((m = re.exec(this.xml))) {
      const a = Object.fromEntries([...m[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
      out.push({ id: parseInt(a.id, 10), type: a.type, date: a.date, authorID: parseInt(a.authorID, 10), hide: a.hide === '1' });
    }
    return out;
  }

  addChange(type, authorId, date = new Date()) {
    const list = this.changes();
    const id = list.length + 1;
    const iso = (date || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const el = `<hh:trackChange type="${type}" date="${iso}" authorID="${authorId}" hide="0" id="${id}"/>`;
    if (/<hh:trackChanges\b[^>]*\/>/.test(this.xml)) {
      this.xml = this.xml.replace(/<hh:trackChanges\b([^>]*?)\/>/, (all, a) => `<hh:trackChanges${a.replace(/itemCnt="\d+"/, 'itemCnt="1"')}>${el}</hh:trackChanges>`);
    } else if (/<hh:trackChanges\b/.test(this.xml)) {
      this.xml = this.xml.replace(/<hh:trackChanges\b([^>]*?)>/, (all, a) => `<hh:trackChanges${a.replace(/itemCnt="\d+"/, `itemCnt="${id}"`)}>`);
      this.xml = this.xml.replace('</hh:trackChanges>', `${el}</hh:trackChanges>`);
    } else {
      const block = `<hh:trackChanges itemCnt="1">${el}</hh:trackChanges>`;
      // 한글 순서: styles → trackChanges → trackChangeAuthors
      if (/<hh:trackChangeAuthors\b/.test(this.xml)) this.xml = this.xml.replace(/<hh:trackChangeAuthors\b/, `${block}<hh:trackChangeAuthors`);
      else this.xml = this.xml.replace('</hh:refList>', `${block}</hh:refList>`);
    }
    return id;
  }

  removeChange(id) {
    const before = this.xml;
    this.xml = this.xml.replace(new RegExp(`<hh:trackChange\\b[^>]*\\bid="${id}"[^>]*/>`), '');
    if (this.xml === before) return false;
    this.rewriteChanges(this.changes());
    return true;
  }

  /** 변경 항목 목록을 주어진 순서·id 로 다시 쓴다(비면 블록 제거). */
  rewriteChanges(list) {
    const body = list.map((c) => `<hh:trackChange type="${c.type}" date="${c.date}" authorID="${c.authorID}" hide="${c.hide ? 1 : 0}" id="${c.id}"/>`).join('');
    const block = list.length ? `<hh:trackChanges itemCnt="${list.length}">${body}</hh:trackChanges>` : '';
    if (/<hh:trackChanges\b/.test(this.xml)) this.xml = this.xml.replace(/<hh:trackChanges\b[^>]*\/>|<hh:trackChanges\b[^>]*>.*?<\/hh:trackChanges>/s, block);
    else if (block) {
      if (/<hh:trackChangeAuthors\b/.test(this.xml)) this.xml = this.xml.replace(/<hh:trackChangeAuthors\b/, `${block}<hh:trackChangeAuthors`);
      else this.xml = this.xml.replace('</hh:refList>', `${block}</hh:refList>`);
    }
  }

  // ── 추적 상태 플래그 (hh:trackchageConfig — 한컴 철자 그대로) ──
  trackingEnabled() {
    const m = /<hh:trackchageConfig\b[^>]*\bflags="(\d+)"/.exec(this.xml);
    return m ? (parseInt(m[1], 10) & 1) === 1 : false;
  }

  setTracking(on) {
    const m = /<hh:trackchageConfig\b[^>]*\bflags="(\d+)"/.exec(this.xml);
    if (m) {
      const v = (parseInt(m[1], 10) & ~1) | (on ? 1 : 0);
      this.xml = this.xml.replace(/(<hh:trackchageConfig\b[^>]*\bflags=")\d+(")/, `$1${v}$2`);
    } else {
      this.xml = this.xml.replace('</hh:head>', `<hh:trackchageConfig flags="${on ? 57 : 56}"/></hh:head>`);
    }
  }

  // ── 메모 스타일(한글 기본 서식의 '메모' 스타일) ──
  memoStyle() {
    const m = /<hh:style\b[^>]*engName="Memo"[^>]*>/.exec(this.xml) || /<hh:style\b[^>]*name="메모"[^>]*>/.exec(this.xml);
    if (!m) return { styleId: '0', paraPr: '0', charPr: '0' };
    const g = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[0]) || [])[1];
    return { styleId: g('id') ?? '0', paraPr: g('paraPrIDRef') ?? '0', charPr: g('charPrIDRef') ?? '0' };
  }

  /** 스타일(영문 이름 또는 id) → {styleId, paraPr, charPr} | null */
  style({ engName, name, id } = {}) {
    const re = /<hh:style\b[^>]*>/g; let m;
    while ((m = re.exec(this.xml))) {
      const g = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[0]) || [])[1];
      if ((engName != null && g('engName') === engName) || (name != null && g('name') === name) || (id != null && g('id') === String(id))) {
        return { styleId: g('id') ?? '0', paraPr: g('paraPrIDRef') ?? '0', charPr: g('charPrIDRef') ?? '0' };
      }
    }
    return null;
  }

  // ── 모양 목록(charProperties·paraProperties·borderFills) ──
  // 새 항목은 목록 끝에 '가장 큰 id + 1' 로 붙이고 itemCnt 를 실제 항목 수로 맞춘다(한글은 위치·id 가 같기를 기대).
  // 같은 내용(id 만 다른) 항목이 이미 있으면 새로 만들지 않고 그 id 를 쓴다(표를 여러 번 넣어도 목록이 불어나지 않게).

  /** <hh:tag id="id" …>…</hh:tag> 블록 */
  block(tag, id) {
    if (this._blockXml !== this.xml) {
      this._blockXml = this.xml; this._blockIndex = new Map(); const stack = [];
      for (const token of scan(this.xml)) {
        if (token.type === 'open') stack.push(token);
        else if (token.type === 'selfclose') {
          const key = attr(this.xml, token, 'id');
          if (key !== undefined) this._blockIndex.set(`${token.name}/${key}`, [token.start, token.end]);
        } else if (token.type === 'close') {
          const begin = stack.pop();
          if (begin?.name !== token.name) continue;
          const key = attr(this.xml, begin, 'id');
          if (key !== undefined) this._blockIndex.set(`${begin.name}/${key}`, [begin.start, token.end]);
        }
      }
    }
    const range = this._blockIndex.get(`hh:${tag}/${id}`);
    return range ? this.xml.slice(...range) : null;
  }

  /** 항목 xml(id 는 무엇이든)을 목록에 넣고 id 를 돌려준다. 같은 내용이 있으면 그 id. */
  addItem(listTag, tag, xml) {
    const norm = (s) => s.replace(new RegExp(`^(<hh:${tag}\\b[^>]*?\\bid=)["']\\d+["']`), '$1""');
    const want = norm(xml);
    const ids = scan(this.xml).filter(t => t.name === `hh:${tag}` && (t.type === 'open' || t.type === 'selfclose')).map(t => Number(attr(this.xml, t, 'id')));
    for (const id of ids) { const b = this.block(tag, id); if (b && norm(b) === want) return String(id); }
    const id = ids.length ? Math.max(...ids) + 1 : (tag === 'borderFill' ? 1 : 0);
    const el = xml.replace(new RegExp(`^(<hh:${tag}\\b[^>]*?\\bid=)["']\\d+["']`), `$1"${id}"`);
    const close = `</hh:${listTag}>`;
    // A valid empty HWPX can omit unused definition lists. Create a missing
    // standard refList collection before adding an imported style or numbering.
    if (!new RegExp(`<hh:${listTag}\\b`).test(this.xml)) {
      const order = ['fontfaces', 'borderFills', 'charProperties', 'tabProperties', 'numberings', 'bullets', 'paraProperties', 'styles', 'memoProperties', 'trackChanges', 'trackChangeAuthors'];
      const at = order.indexOf(listTag);
      if (at >= 0 && this.xml.includes('</hh:refList>')) {
        const later = new Set(order.slice(at + 1).map(name => `hh:${name}`));
        const next = scan(this.xml).find(t => later.has(t.name) && (t.type === 'open' || t.type === 'selfclose'));
        const pos = next?.start ?? this.xml.indexOf('</hh:refList>');
        this.xml = this.xml.slice(0, pos) + `<hh:${listTag} itemCnt="0"/>` + this.xml.slice(pos);
      }
    }
    if (this.xml.includes(close)) this.xml = this.xml.replace(close, el + close);
    else if (new RegExp(`<hh:${listTag}\\b[^>]*/>`).test(this.xml)) this.xml = this.xml.replace(new RegExp(`<hh:${listTag}\\b([^>]*?)/>`), `<hh:${listTag}$1>${el}${close}`);
    else throw new Error(`header.xml 에 ${listTag} 목록이 없습니다`);
    const n = (this.xml.match(new RegExp(`<hh:${tag}\\b`, 'g')) || []).length;
    this.xml = this.xml.replace(new RegExp(`(<hh:${listTag}\\b[^>]*?\\bitemCnt=")\\d+(")`), `$1${n}$2`);
    return String(id);
  }

  isBold(charPrId) { const b = this.block('charPr', charPrId); return !!b && b.includes('<hh:bold'); }

  /** 굵은 글자 모양(원본 charPr 복제 + <hh:bold/>). 이미 굵으면 그대로. */
  boldCharPr(charPrId) {
    const src = this.block('charPr', charPrId);
    if (!src || src.includes('<hh:bold')) return String(charPrId);
    // 한글 순서: … offset → (italic) → bold → underline …
    let xml = src.replace(/(<hh:offset\b[^>]*\/>(?:<hh:italic\/>)?)/, '$1<hh:bold/>');
    if (xml === src) xml = src.includes('<hh:underline') ? src.replace('<hh:underline', '<hh:bold/><hh:underline') : src.replace('</hh:charPr>', '<hh:bold/></hh:charPr>');
    return this.addItem('charProperties', 'charPr', xml);
  }

  /** 문단 모양 변형(정렬·들여쓰기 0). 바뀔 것이 없으면 원본 id. */
  paraPrVariant(paraPrId, { align = null, noIndent = false } = {}) {
    const src = this.block('paraPr', paraPrId);
    if (!src) return String(paraPrId);
    let xml = src;
    if (align) xml = xml.replace(/<hh:align horizontal="\w+"/, `<hh:align horizontal="${align}"`);
    if (noIndent) xml = xml.replace(/<hc:(intent|left|right) value="-?\d+"/g, '<hc:$1 value="0"');
    return xml === src ? String(paraPrId) : this.addItem('paraProperties', 'paraPr', xml);
  }

  /** 변마다 선을 정한 borderFill. sides = { left, right, top, bottom: { type, width, color } }, face = 바탕색(없으면 바탕 없음). 반환: id */
  borderFill({ left, right, top, bottom }, { face = null } = {}) {
    const side = (s, v) => `<hh:${s}Border type="${v.type}" width="${v.width}" color="${v.color}"/>`;
    // 바탕은 hc:fillBrush(한글이 쓰는 꼴 — hh:fillBrush 로 쓰면 음영이 사라진다, 서식명세 §3)
    const fill = face && /xmlns:hc=/.test(this.xml) ? `<hc:fillBrush><hc:winBrush faceColor="${face}" hatchColor="#000000" alpha="0"/></hc:fillBrush>` : '';
    const xml = '<hh:borderFill id="0" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>'
      + `${side('left', left)}${side('right', right)}${side('top', top)}${side('bottom', bottom)}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill}</hh:borderFill>`;
    return this.addItem('borderFills', 'borderFill', xml);
  }

  /** baseId 테두리에서 왼쪽·오른쪽 선만 다른 borderFill(left·right id)의 것으로 바꾼 항목. 바뀔 것이 없으면 baseId */
  borderFillSides(baseId, { left = null, right = null } = {}) {
    const src = this.block('borderFill', baseId);
    if (!src) return String(baseId);
    let xml = src;
    for (const [s, id] of [['left', left], ['right', right]]) {
      const re = new RegExp(`<hh:${s}Border\\b[^>]*/>`);
      const from = id != null ? re.exec(this.block('borderFill', id) || '') : null;
      if (from) xml = xml.replace(re, from[0]);
    }
    return xml === src ? String(baseId) : this.addItem('borderFills', 'borderFill', xml);
  }

  charHeight(charPrId) { const b = this.block('charPr', charPrId); const m = b && /\bheight="(\d+)"/.exec(b); return m ? parseInt(m[1], 10) : 1000; }
}

function decode(s) { return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
