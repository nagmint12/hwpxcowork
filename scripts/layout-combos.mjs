// 개체 배치 조합 세기 — HWPX 들을 읽기만 해서 "놓인 자리 × 개체 종류 × 배치 속성" 조합이 몇 건 쓰이는지 센다.
// 조판 시험지(layout-matrix.mjs)를 실제로 쓰이는 조합부터 만들기 위한 목록이다. 문서는 고치지 않는다.
//
//   node scripts/layout-combos.mjs --corpus real=data,문제문서.hwpx,testdata --corpus rhwp=<rhwp samples 폴더> --out <json>
//
// 문서 단위: data/docs/<id>/ 아래 판(current·versions)은 한 문서로 본다(개체 수는 판 중 가장 많은 판의 수).
// 같은 내용 파일(Contents/*.xml 해시 같음)은 한 번만 센다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';

// 개체 종류. 글상자는 drawText 를 가진 도형(대개 rect).
const SHAPES = new Set(['rect', 'ellipse', 'arc', 'polygon', 'curve', 'connectLine', 'line', 'pic', 'ole', 'equation', 'tbl', 'container', 'textart', 'chart', 'video', 'btn', 'checkBtn', 'radioBtn', 'comboBox', 'edit', 'listBox', 'scrollBar']);
const KIND_KO = { tbl: '표', pic: '그림', textbox: '글상자', rect: '사각형', ellipse: '타원', arc: '호', polygon: '다각형', curve: '곡선', connectLine: '연결선', line: '선', ole: 'OLE', chart: '차트', equation: '수식', container: '묶음', textart: '글맵시', video: '동영상', form: '양식 개체' };
const FORM = new Set(['btn', 'checkBtn', 'radioBtn', 'comboBox', 'edit', 'listBox', 'scrollBar']);
// 놓인 자리
const CTX_KO = { body: '본문', column: '다단 본문', cell: '표 셀', textbox: '글상자', header: '머리말', footer: '꼬리말', footNote: '각주', endNote: '미주', master: '바탕쪽', group: '묶음 안', caption: '캡션' };
const sign = (v) => { const n = Number(v || 0); return n === 0 ? '0' : n > 0 ? '+' : '-'; };

/** section/masterpage XML 하나에서 개체 목록을 뽑는다. */
function scanXml(xml, { section, master }) {
  const out = [];
  const p = new SaxesParser();
  const stack = []; // { name, ctx?, obj? }
  let colCount = 1;
  let topPara = -1;
  let cur = null;
  const ctxPath = () => stack.filter((e) => e.ctx).map((e) => e.ctx);
  p.on('opentag', (t) => {
    const name = t.name.replace(/^[a-z0-9]+:/, '');
    const a = t.attributes;
    const parent = stack[stack.length - 1];
    const e = { name };
    if (name === 'p' && !stack.some((x) => x.name === 'p')) topPara++;
    if (name === 'colPr' && !stack.some((x) => x.ctx)) colCount = Number(a.colCount || 1);
    if (name === 'tc') e.ctx = 'cell';
    else if (name === 'drawText') { e.ctx = 'textbox'; const o = stack.findLast((x) => x.obj); if (o) o.obj.textbox = true; }
    else if (name === 'header' || name === 'footer' || name === 'footNote' || name === 'endNote') e.ctx = name;
    else if (name === 'caption') e.ctx = 'caption';
    if (SHAPES.has(name)) {
      const path0 = ctxPath();
      const inGroup = parent && parent.name === 'container';
      const base = master ? 'master' : colCount > 1 ? 'column' : 'body';
      const chain = [base, ...path0, ...(inGroup ? ['group'] : [])];
      e.obj = { kind: FORM.has(name) ? 'form' : name, tag: name, ctx: chain[chain.length - 1], chain: chain.join('>'), section, para: topPara,
        textWrap: a.textWrap || '', textFlow: a.textFlow || '', pageBreak: a.pageBreak || '', pos: null, outMargin: null, caption: null };
      if (name === 'container') e.ctx = 'group';
      cur = e.obj;
    }
    const owner = parent && parent.obj;
    if (owner) {
      if (name === 'pos') owner.pos = { tac: a.treatAsChar === '1', vertRelTo: a.vertRelTo, horzRelTo: a.horzRelTo, vertAlign: a.vertAlign, horzAlign: a.horzAlign,
        vOff: sign(a.vertOffset), hOff: sign(a.horzOffset), flow: a.flowWithText, overlap: a.allowOverlap, hold: a.holdAnchorAndSO, affect: a.affectLSpacing };
      else if (name === 'outMargin') owner.outMargin = ['left', 'right', 'top', 'bottom'].some((k) => Number(a[k] || 0) !== 0) ? '있음' : '0';
      else if (name === 'caption') owner.caption = a.side || 'BOTTOM';
    }
    stack.push(e);
  });
  p.on('closetag', () => { const e = stack.pop(); if (e.obj) out.push(e.obj); });
  p.write(xml).close();
  void cur;
  return out;
}

async function scanFile(file) {
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/(section\d+|masterpage\d+)\.xml$/i.test(n)).sort();
  const h = crypto.createHash('sha1');
  const objs = [];
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    h.update(n).update(xml);
    const m = /section(\d+)/i.exec(n);
    objs.push(...scanXml(xml, { section: m ? Number(m[1]) : -1, master: /masterpage/i.test(n) }));
  }
  return { hash: h.digest('hex'), objs };
}

function walk(p, acc = []) {
  if (!fs.existsSync(p)) return acc;
  const st = fs.statSync(p);
  if (st.isFile()) { if (/\.hwpx$/i.test(p)) acc.push(p); return acc; }
  for (const n of fs.readdirSync(p)) if (n !== 'node_modules') walk(path.join(p, n), acc);
  return acc;
}

/** 문서 열쇠: data/docs/<id>/... 는 id, 그 밖은 파일 경로. */
const docKey = (f) => { const m = /[\\/]docs[\\/]([a-z0-9]{10,})[\\/]/i.exec(f); return m ? `doc:${m[1]}` : f; };

// 조합 열쇠(값 = 사람 읽는 이름). 글자처럼 개체는 가로·세로·배치 칸이 없다.
const kindOf = (o) => (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'polygon') && o.textbox ? 'textbox' : o.kind;
export function comboKeys(o) {
  const k = kindOf(o);
  const ctx = o.ctx;
  const ps = o.pos;
  const keys = [];
  const base = `${ctx}|${k}`;
  if (!ps) { keys.push(['자리', `${base}|위치없음`]); return keys; }
  if (ps.tac) {
    keys.push(['자리', `${base}|글자처럼`]);
    keys.push(['글자처럼', `${base}|여백${o.outMargin}|캡션${o.caption || '없음'}`]);
    return keys;
  }
  keys.push(['자리', `${base}|떠있음`]);
  // 전체 조합(속성을 모두 곱한 한 칸) — 목록에는 싣지 않고, 시험지에서 다른 속성의 기본값(그 자리·개체에서 가장 흔한 조합)으로 쓴다.
  keys.push(['전체', [base, o.textWrap, o.textFlow, ps.vertRelTo, ps.vertAlign, ps.vOff, ps.horzRelTo, ps.horzAlign, ps.hOff, o.outMargin, ps.flow, ps.overlap, o.pageBreak || '-'].join('|')]);
  keys.push(['가로', `${base}|${ps.horzRelTo}|${ps.horzAlign}|오프셋${ps.hOff}|여백${o.outMargin}`]);
  keys.push(['세로', `${base}|${ps.vertRelTo}|${ps.vertAlign}|오프셋${ps.vOff}|여백${o.outMargin}`]);
  const flow = ['SQUARE', 'TIGHT', 'THROUGH'].includes(o.textWrap) ? o.textFlow : '-';
  keys.push(['배치', `${base}|${o.textWrap}|${flow}`]);
  keys.push(['이동·겹침', `${base}|글과이동${ps.flow}|겹침${ps.overlap}`]);
  if (k === 'tbl') keys.push(['표 나눔', `${base}|${o.pageBreak}|${o.textWrap}`]);
  return keys;
}

export async function countCorpus(paths, { onError } = {}) {
  const files = [...new Set(paths.flatMap((p) => walk(p)))];
  const seen = new Set();
  const perDoc = new Map(); // docKey → Map(comboKey → {n, ex})
  let read = 0, dup = 0, bad = 0;
  for (const f of files) {
    let r;
    try { r = await scanFile(f); } catch (e) { bad++; onError?.(f, e); continue; }
    if (seen.has(r.hash)) { dup++; continue; }
    seen.add(r.hash); read++;
    const key = docKey(f);
    const local = new Map();
    for (const o of r.objs) for (const [dim, c] of comboKeys(o)) {
      const id = `${dim}§${c}`;
      const v = local.get(id) || { n: 0, ex: null };
      v.n++; if (!v.ex) v.ex = { file: f, section: o.section, para: o.para, chain: o.chain };
      local.set(id, v);
    }
    const acc = perDoc.get(key) || new Map();
    for (const [id, v] of local) { const old = acc.get(id); if (!old || old.n < v.n) acc.set(id, v); }
    perDoc.set(key, acc);
  }
  const combos = new Map();
  for (const [doc, m] of perDoc) for (const [id, v] of m) {
    const c = combos.get(id) || { docs: 0, objs: 0, ex: v.ex, docList: [] };
    c.docs++; c.objs += v.n; if (c.docList.length < 5) c.docList.push(doc);
    combos.set(id, c);
  }
  return { files: files.length, read, dup, bad, docs: perDoc.size, combos };
}

export const labels = { KIND_KO, CTX_KO };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const corpora = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--corpus') { const [name, list] = args[++i].split('='); corpora.push({ name, paths: list.split(',') }); }
  const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const result = {};
  for (const c of corpora) {
    const t0 = Date.now();
    const r = await countCorpus(c.paths, { onError: (f, e) => console.error('읽기 실패', f, e.message) });
    // 예시 파일 경로: 저장소 안이면 저장소 기준, 밖(내려받은 시료)이면 '<말뭉치 이름>:' + 그 폴더 기준.
    const base = path.resolve(c.paths[0]);
    for (const v of r.combos.values()) { const abs = path.resolve(v.ex.file); const rel = path.relative(process.cwd(), abs); v.ex.file = (rel.startsWith('..') || path.isAbsolute(rel) ? `${c.name}:${path.relative(base, abs)}` : rel).replace(/\\/g, '/'); }
    result[c.name] = { files: r.files, read: r.read, dup: r.dup, bad: r.bad, docs: r.docs, ms: Date.now() - t0,
      combos: Object.fromEntries([...r.combos].sort((a, b) => b[1].docs - a[1].docs || b[1].objs - a[1].objs)) };
    console.log(`${c.name}: 파일 ${r.files} (같은 내용 ${r.dup}, 실패 ${r.bad}) · 문서 ${r.docs} · 조합 ${r.combos.size} · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
}
