// HWPX 필수 요소 정적 검사기(2026-11-04 5차 save — 원본 artifacts/layout-fix-20261103/scratch/r5-save/required.mjs).
// 한/글 2022 가 열지 않는 문서(변수 검정 var-sweep-20261104 의 열기 거부 사례)를 미리 잡는다.
//   checkHwpx(bytes) → [{ rule, file, at, msg }] — HARD_RULES 에 든 규칙은 한/글 2022 가 문서를 열지 않는 것(실측).
// 규칙(근거 = 한/글 열기 거부 실측):
//   PIC_IMGCLIP     hp:pic 에 hp:imgClip 없음            (picture 보고서 12)
//   RENDERINGINFO   그림·도형에 hp:renderingInfo 없음      (picture 12, shapes d4_03·d4_08)
//   RECT_PT         hp:rect 에 hc:pt0~pt3 없음            (shapes d4_10)
//   TBL_ROWCNT      hp:tbl rowCnt 없음·0·실제 hp:tr 수와 다름 (table T137·T138·T141·T142)
//   TBL_EMPTY_TR    칸(hp:tc) 없는 빈 hp:tr               (5차 save: 엔진 rowCnt≠tr 왕복본·JS 표 합치기 결과)
//   COLPR_COUNT     hp:colPr colCount 없음·0             (host sec 단 묶음)
// 그 밖에 --survey 로 찾은 '한/글 저장본에 늘 있는 자식'(EMP_*)은 경고로 낸다.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

/** 아주 작은 XML 나무(태그·속성·자식). 글은 버린다. */
export function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.\-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue;
    if (m[1]) { // 닫는 태그
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === m[2]) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([A-Za-z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    const node = { tag: m[2], attrs, kids: [], parent: stack[stack.length - 1] };
    stack[stack.length - 1].kids.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

function* walk(n) { yield n; for (const k of n.kids) yield* walk(k); }
const has = (n, tag) => n.kids.some((k) => k.tag === tag);
function where(n) {
  const p = []; let x = n;
  while (x && x.tag !== '#root') { const sib = x.parent ? x.parent.kids.filter((k) => k.tag === x.tag) : []; p.unshift(`${x.tag}${sib.length > 1 ? `[${sib.indexOf(x)}]` : ''}`); x = x.parent; }
  return p.slice(-4).join('/');
}

// 그림·도형 개체(ShapeComponent) — 한/글 저장본에서 renderingInfo 가 늘 있는 태그(--survey 로 확인).
export const SHAPE_COMPONENTS = ['hp:pic', 'hp:rect', 'hp:line', 'hp:ellipse', 'hp:arc', 'hp:polygon', 'hp:curve', 'hp:connectLine', 'hp:container', 'hp:ole', 'hp:textart'];

/** 한 XML(구역·바탕쪽 등)에서 규칙 위반을 찾는다. */
export function checkXml(xml, file = '', { empirical = null } = {}) {
  const out = [];
  const root = parseXml(xml);
  const add = (rule, n, msg) => out.push({ rule, file, at: where(n), msg });
  for (const n of walk(root)) {
    if (n.tag === 'hp:pic') {
      if (!has(n, 'hp:imgClip')) add('PIC_IMGCLIP', n, 'hp:imgClip 없음');
      if (!has(n, 'hp:imgRect')) add('PIC_IMGRECT', n, 'hp:imgRect 없음');
    }
    if (SHAPE_COMPONENTS.includes(n.tag) && !has(n, 'hp:renderingInfo')) add('RENDERINGINFO', n, `${n.tag} 에 hp:renderingInfo 없음`);
    if (n.tag === 'hp:rect') {
      const miss = ['hc:pt0', 'hc:pt1', 'hc:pt2', 'hc:pt3'].filter((t) => !has(n, t));
      if (miss.length) add('RECT_PT', n, `hp:rect 꼭짓점 없음: ${miss.join(',')}`);
    }
    if (n.tag === 'hp:tbl') {
      const trs = n.kids.filter((k) => k.tag === 'hp:tr').length;
      const rc = n.attrs.rowCnt;
      if (rc == null) add('TBL_ROWCNT', n, `rowCnt 없음(tr ${trs})`);
      else if (!(Number(rc) > 0)) add('TBL_ROWCNT', n, `rowCnt=${rc}(tr ${trs})`);
      else if (Number(rc) !== trs) add('TBL_ROWCNT', n, `rowCnt=${rc} ≠ tr ${trs}`);
      const empty = n.kids.filter((k) => k.tag === 'hp:tr' && !has(k, 'hp:tc')).length;
      if (empty) add('TBL_EMPTY_TR', n, `칸 없는 빈 hp:tr ${empty}개`);
      const cc = n.attrs.colCnt;
      if (!(Number(cc) > 0)) add('TBL_COLCNT', n, `colCnt=${cc}`);
    }
    if (n.tag === 'hp:colPr' && !(Number(n.attrs.colCount) > 0)) add('COLPR_COUNT', n, `colCount=${n.attrs.colCount}`);
    if (empirical && empirical[n.tag]) {
      for (const t of empirical[n.tag].kids) if (!has(n, t)) add('EMP_CHILD', n, `${n.tag} 에 ${t} 없음(한/글 저장본엔 늘 있음)`);
      for (const a of empirical[n.tag].attrs) if (n.attrs[a] == null) add('EMP_ATTR', n, `${n.tag} 에 @${a} 없음(한/글 저장본엔 늘 있음)`);
    }
  }
  return out;
}

export const HARD_RULES = new Set(['PIC_IMGCLIP', 'RENDERINGINFO', 'RECT_PT', 'TBL_ROWCNT', 'TBL_EMPTY_TR', 'COLPR_COUNT']);

export async function checkHwpx(bytes, opts = {}) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/(section|masterpage)\d+\.xml$/i.test(n) || /^Contents\/header\.xml$/i.test(n));
  const out = [];
  if (!zip.file('mimetype')) out.push({ rule: 'PKG_MIMETYPE', file: '', at: '', msg: 'mimetype 없음' });
  if (!zip.file('Contents/content.hpf')) out.push({ rule: 'PKG_HPF', file: '', at: '', msg: 'content.hpf 없음' });
  for (const n of names) out.push(...checkXml(await zip.file(n).async('string'), n, opts));
  return out;
}

/** 한/글 저장본 묶음에서 태그별 '늘 있는 자식·속성'(모든 사례에 있음, 사례 minN 개 이상). */
export async function survey(files, { minN = 20, tags = null } = {}) {
  const st = {};
  for (const f of files) {
    let zip; try { zip = await JSZip.loadAsync(fs.readFileSync(f)); } catch { continue; }
    for (const n of Object.keys(zip.files).filter((x) => /^Contents\/(section|masterpage)\d+\.xml$/i.test(x))) {
      for (const e of walk(parseXml(await zip.file(n).async('string')))) {
        if (e.tag === '#root' || (tags && !tags.includes(e.tag))) continue;
        const s = (st[e.tag] ??= { n: 0, kids: {}, attrs: {}, docs: new Set() });
        s.n++; s.docs.add(f);
        for (const t of new Set(e.kids.map((k) => k.tag))) s.kids[t] = (s.kids[t] || 0) + 1;
        for (const a of Object.keys(e.attrs)) s.attrs[a] = (s.attrs[a] || 0) + 1;
      }
    }
  }
  const out = {};
  for (const [tag, s] of Object.entries(st)) {
    if (s.n < minN || s.docs.size < 3) continue;
    out[tag] = { n: s.n, docs: s.docs.size, kids: Object.keys(s.kids).filter((t) => s.kids[t] === s.n).sort(), attrs: Object.keys(s.attrs).filter((a) => s.attrs[a] === s.n).sort() };
  }
  return out;
}
