// 쪽 나눔 조합 시험지(B 묶음) — 흐름 개체(자리차지·어울림·글자처럼 표·그림)가 쪽 경계 근처에 놓일 때 한/글과 같은 쪽·자리로 가는가.
// 문제 정의·축·기준은 docs/LAYOUT_PAGESPLIT_2026-11-03.md. 개체를 "어디에 어떻게 놓나"(A 묶음, layout-matrix.mjs)와 따로 둔다.
//
//   node scripts/layout-pagesplit.mjs                → tests/fixtures/layout/pagesplit/pagesplit_<자리>.hwpx + cases.json
//   node scripts/layout-pagesplit.mjs --hangul       → 위 + 한/글 COM 으로 열어(인쇄 없이) 쪽 그림(CreatePageImage)·문단 쪽 번호·재저장본을 받아
//                                                      pagesplit_<자리>_hangul.json(기준) 과 pagesplit_<자리>_saved.hwpx(저장 조판 경로 입력)를 남긴다.
//   node --test tests/layout_pagesplit.test.mjs      → 기준과 rhwp 를 두 경로(엔진 새 조판 / 한/글 저장 조판)로 견준다.
//
// 사례 하나 = 머리 문단 "[Pnnn]"(새 쪽) + 채움 줄 K 개 + 앵커 문단(시험 개체) + 뒤 글 문단 + 채움 2줄.
// 문단에는 저장 줄을 넣지 않는다 — 생성본은 엔진이 직접 조판하는 경로, 한/글 재저장본은 저장 조판을 쓰는 경로다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
export const OUT = path.join(root, 'tests', 'fixtures', 'layout', 'pagesplit');

// ── 서식(기본 서식 testdata/매크로테스트용_저장.hwpx) ─────────────────────
const PARA_PLAIN = 28;   // 양쪽, 180%, 위·아래 간격 0
const PARA_PREV = 60;    // PARA_PLAIN + 문단 위 간격 830HU(#8518 의 앵커 문단과 같은 값) — header.xml 에 덧붙인다
const CHAR_BODY = 8;
const BORDER_MARK = 20;  // 표식 색 칸(실선 + 채움 #FFC8E6) — header.xml 에 덧붙인다
export const TABLE_COLOR = '#FFC8E6';
export const PIC_COLOR = '#2E8B57';
const PREV_SPACING = 830;
export const LINE = 1100 + 880;    // 11pt · 180% 한 줄
export const BODY_HEIGHT = 65762;  // 본문 높이 → 한 쪽(한 단)에 33줄
const LINES_PER_COL = Math.floor((BODY_HEIGHT - 1100) / LINE) + 1;

// ── 축 ──────────────────────────────────────────────────────────────
export const AXES = {
  ctx: [['body', '본문', 1], ['column', '다단 본문(2단)', 2]],
  obj: [['tblCell', '표(셀 나눔)'], ['tblNone', '표(나누지 않음)'], ['pic', '그림']],
  wrap: [['TOP_AND_BOTTOM', '자리차지'], ['SQUARE', '어울림'], ['TAC', '글자처럼']],
  // 앵커 문단 앞 줄 수(머리 문단 포함, 한 단 기준) — 쪽(단)에 33줄이 든다
  at: [['top', '쪽 첫머리', LINES_PER_COL], ['mid', '중간', 10], ['straddle', '쪽 끝에 걸림', 25], ['next', '다음 쪽으로 넘어감', 32]],
  host: [['empty0', '빈 문단 · 위 간격 0', false, 0], ['emptyPrev', '빈 문단 · 위 간격 있음', false, PREV_SPACING], ['text0', '글 있음 · 위 간격 0', true, 0], ['textPrev', '글 있음 · 위 간격 있음', true, PREV_SPACING]],
};
// 표 10행 × 3000HU = 30000HU(한 쪽 남은 높이보다 크게 — 걸림·넘어감에서 나뉘거나 옮겨 가게), 그림 20000HU.
const ROWS = 10, ROW_H = 3000, PIC_H = 20000;

let uid = 1960000000;
const nextId = () => String(uid++);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SUB = (inner, v = 'TOP') => `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${v}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>`;
const para = ({ pageBreak = false, runs = [], paraPr = PARA_PLAIN } = {}) => `<hp:p id="${nextId()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${runs.length ? runs.join('') : `<hp:run charPrIDRef="${CHAR_BODY}"/>`}</hp:p>`;
const textRun = (t) => `<hp:run charPrIDRef="${CHAR_BODY}"><hp:t>${esc(t)}</hp:t></hp:run>`;
const text = (t, o = {}) => para({ ...o, runs: [textRun(t)] });
const pos = (tac) => `<hp:pos treatAsChar="${tac ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`;

function table(w, wrap, split) {
  const tac = wrap === 'TAC';
  const cw = w >> 1;
  const cell = (r, c) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${BORDER_MARK}">${SUB(text(`칸 ${r}-${c}`), 'CENTER')}`
    + `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cw}" height="${ROW_H}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
  const rows = Array.from({ length: ROWS }, (_, r) => `<hp:tr>${cell(r, 0)}${cell(r, 1)}</hp:tr>`).join('');
  return `<hp:tbl id="${nextId()}" zOrder="0" numberingType="TABLE" textWrap="${tac ? 'TOP_AND_BOTTOM' : wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="${split ? 'CELL' : 'NONE'}" repeatHeader="0" rowCnt="${ROWS}" colCnt="2" cellSpacing="0" borderFillIDRef="${BORDER_MARK}" noAdjust="0">`
    + `<hp:sz width="${cw * 2}" widthRelTo="ABSOLUTE" height="${ROWS * ROW_H}" heightRelTo="ABSOLUTE" protect="0"/>${pos(tac)}<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="141" right="141" top="141" bottom="141"/>${rows}</hp:tbl>`;
}
function pic(w, wrap) {
  const tac = wrap === 'TAC', h = PIC_H;
  return `<hp:pic id="${nextId()}" zOrder="1" numberingType="PICTURE" textWrap="${tac ? 'TOP_AND_BOTTOM' : wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${nextId()}" reverse="0">`
    + `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>`
    + `<hp:rotationInfo angle="0" centerX="${w >> 1}" centerY="${h >> 1}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>`
    + `<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
    + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hp:effects/>`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>${pos(tac)}<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`;
}

/** 축을 모두 곱한 사례 목록(자리별). id 는 P + 자리 안 순번. */
export function buildCases() {
  const out = [];
  for (const [ctx, ctxKo, cols] of AXES.ctx) {
    let n = 0;
    for (const [obj, objKo] of AXES.obj) for (const [wrap, wrapKo] of AXES.wrap) for (const [at, atKo, lines] of AXES.at) for (const [host, hostKo, hasText, prev] of AXES.host) {
      n++;
      out.push({ id: `${ctx === 'body' ? 'B' : 'C'}${String(n).padStart(3, '0')}`, ctx, obj, wrap, at, host, cols, lines, hasText, prev,
        label: [ctxKo, objKo, wrapKo, atKo, hostKo].join(' · ') });
    }
  }
  return out;
}

/** 사례 → 문단들. 앞 줄 수는 단 하나 기준이므로 2단이면 첫 단을 다 채운 뒤 둘째 단에서 센다(쪽 끝 = 둘째 단 끝). */
function caseParas(c) {
  const w = c.cols === 2 ? 9000 : 20000; // 어울림 글이 옆으로 흐를 자리가 남게 단 폭의 절반 아래
  const before = (c.cols === 2 ? LINES_PER_COL : 0) + c.lines - 1; // 머리 문단 뒤 채움 줄 수
  const paras = [text(`[${c.id}]`, { pageBreak: true })];
  for (let i = 0; i < before; i++) paras.push(text(`채움 ${i + 1}`));
  const obj = c.obj === 'pic' ? pic(w, c.wrap) : table(w, c.wrap, c.obj === 'tblCell');
  paras.push(para({ paraPr: c.prev ? PARA_PREV : PARA_PLAIN, runs: [`<hp:run charPrIDRef="${CHAR_BODY}">${obj}<hp:t>${c.hasText ? '앵커 글' : ''}</hp:t></hp:run>`] }));
  paras.push(text(`[${c.id}] 뒤 글`), text('채움 뒤 1'), text('채움 뒤 2'));
  return { paras, host: 1 + before, next: 2 + before };
}

function solidPng(w, h, hex) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** header.xml 에 위 간격 문단 모양(60)과 표식 칸 테두리(20)를 덧붙인다. */
function patchHeader(xml) {
  const pp = xml.match(new RegExp(`<hh:paraPr id="${PARA_PLAIN}"[\\s\\S]*?</hh:paraPr>`))[0];
  const prev = pp.replace(`id="${PARA_PLAIN}"`, `id="${PARA_PREV}"`).replace(/<hc:prev value="0"/g, `<hc:prev value="${PREV_SPACING}"`);
  const line = (side) => `<hh:${side}Border type="SOLID" width="0.12 mm" color="#000000"/>`;
  const bf = `<hh:borderFill id="${BORDER_MARK}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`
    + `${line('left')}${line('right')}${line('top')}${line('bottom')}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="${TABLE_COLOR}" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill>`;
  const cnt = (tag, s) => s.replace(new RegExp(`<hh:${tag} itemCnt="(\\d+)"`), (m, n) => `<hh:${tag} itemCnt="${Number(n) + 1}"`);
  if (xml.includes(`<hh:paraPr id="${PARA_PREV}"`) || xml.includes(`<hh:borderFill id="${BORDER_MARK}"`)) throw new Error('기본 서식에 이미 같은 번호가 있다 — PARA_PREV/BORDER_MARK 를 바꾼다');
  return cnt('borderFills', cnt('paraProperties', xml.replace('</hh:paraProperties>', prev + '</hh:paraProperties>').replace('</hh:borderFills>', bf + '</hh:borderFills>')));
}

export async function buildDoc(templatePath, outPath, cases) {
  const zin = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const section = await zin.file('Contents/section0.xml').async('string');
  const start = section.indexOf('<hp:p ');
  const colEnd = section.indexOf('</hp:ctrl>', section.indexOf('</hp:secPr>')) + '</hp:ctrl>'.length;
  let first = section.slice(start, colEnd).replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${PARA_PLAIN}"`);
  if (cases[0].cols === 2) first = first.replace(/colCount="\d+"/, 'colCount="2"').replace(/sameGap="\d+"/, 'sameGap="1134"');
  const body = [];
  let pi = 1;
  const index = cases.map((c) => {
    const { paras, host, next } = caseParas(c);
    body.push(...paras);
    const r = { ...c, head: pi, hostPara: pi + host, nextPara: pi + next, endPara: pi + paras.length };
    pi += paras.length;
    return r;
  });
  const xml = section.slice(0, start) + first + `</hp:run>${textRun('쪽 나눔 조합 시험지 — 사례마다 새 쪽')}</hp:p>` + body.join('') + '</hs:sec>';
  const out = new JSZip();
  out.file('mimetype', await zin.file('mimetype').async('uint8array'), { compression: 'STORE' });
  for (const [name, f] of Object.entries(zin.files)) {
    if (f.dir || name === 'mimetype' || /^Preview\//.test(name)) continue;
    if (name === 'Contents/section0.xml') out.file(name, xml);
    else if (name === 'Contents/header.xml') out.file(name, patchHeader(await f.async('string')));
    else if (/^BinData\/image\d+\.png$/.test(name)) out.file(name, solidPng(320, 320, PIC_COLOR));
    else out.file(name, await f.async('uint8array'));
  }
  fs.writeFileSync(outPath, await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return index;
}

// ── 한/글 기준 ───────────────────────────────────────────────────────
const HU_PER_PX = 75;
/** 한/글 쪽 그림의 표식 색 덩어리 → 사례의 개체 조각(쪽마다 하나로 합침). 쪽은 사례 머리 쪽 기준 상대값. */
export function hangulParts(images, c, headPage, endPage) {
  const color = c.obj === 'pic' ? PIC_COLOR : TABLE_COLOR;
  const parts = [];
  for (let pg = headPage; pg <= endPage; pg++) {
    const bs = images[pg]?.colors?.[color] || [];
    if (!bs.length) continue;
    parts.push({ page: pg - headPage, x0: Math.min(...bs.map((b) => b[0])), y0: Math.min(...bs.map((b) => b[1])), x1: Math.max(...bs.map((b) => b[2])), y1: Math.max(...bs.map((b) => b[3])) });
  }
  return parts;
}

async function measureHangul(file, cases, saveSavedTo) {
  const { hangulLayout } = await import('./layout-trace.mjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'layout_pagesplit_'));
  const paras = cases.flatMap((c) => [c.head, c.hostPara, c.nextPara]);
  const listFile = path.join(work, 'paras.json');
  fs.writeFileSync(listFile, JSON.stringify(paras));
  execFileSync('python', ['-I', path.join(root, 'tests', 'hangul_page_images.py'), file, work, '--colors', `${TABLE_COLOR},${PIC_COLOR}`, '--save', '--para-pages', listFile], { timeout: 3600000, maxBuffer: 256 << 20 });
  const pi = JSON.parse(fs.readFileSync(path.join(work, 'page_images.json'), 'utf8'));
  if (!pi.open || !fs.existsSync(path.join(work, 'saved.hwpx'))) throw new Error(`한/글 열기 실패: ${file} (${work})`);
  fs.copyFileSync(path.join(work, 'saved.hwpx'), saveSavedTo);
  // 줄 자리(vpos)는 한/글 재저장본의 저장 줄, 쪽은 한/글이 알려 준 문단 쪽(KeyIndicator)
  const saved = await hangulLayout(saveSavedTo);
  const sec = saved.sections[0];
  const pageOf = (p) => pi.paraPages?.[String(p)];
  const line0 = (p) => sec.paragraphs[p]?.lines?.[0];
  const res = cases.map((c, i) => {
    const headPage = pageOf(c.head), endPage = (i + 1 < cases.length ? pageOf(cases[i + 1].head) : pi.pages) - 1;
    return {
      id: c.id,
      pages: endPage - headPage + 1,
      host: { page: pageOf(c.hostPara) - headPage, vpos: line0(c.hostPara)?.vpos ?? null },
      next: { page: pageOf(c.nextPara) - headPage, vpos: line0(c.nextPara)?.vpos ?? null },
      parts: hangulParts(pi.images, c, headPage, endPage),
    };
  });
  return { pages: pi.pages, work, cases: res, paraCount: sec.paragraphs.length };
}

// ── rhwp 와 견주기 ──────────────────────────────────────────────────
export const TOL_VPOS = 150; // HU(2px) — 줄 자리
export const TOL_PX = 3;     // 개체 조각 가장자리(쪽 그림은 래스터라 1px 번짐이 있다)

/** rhwp 로 file 을 조판해 사례마다 [쪽 수, 개체 조각, 뒤 글 첫 줄, 앵커 글 줄] 을 뽑는다. 쪽은 사례 머리 쪽 기준 상대값. */
export async function measureRhwp(file, cases, pkgDir = path.join(root, 'vendor', 'rhwp', 'pkg')) {
  const { rhwpLayout } = await import('./layout-trace.mjs');
  const lay = await rhwpLayout(file, pkgDir);
  const bodyTop = (pg) => lay.pages[pg]?.body?.y ?? 0;
  const firstLine = (p) => lay.drawn.get(`0/${p}`)?.lines?.[0] ?? null;
  const want = (c) => (c.obj === 'pic' ? ['Image'] : ['Table']);
  return cases.map((c, i) => {
    const head = firstLine(c.head)?.page;
    const nextHead = i + 1 < cases.length ? firstLine(cases[i + 1].head)?.page : lay.pageCount;
    const line = (p) => { const l = firstLine(p); return l ? { page: l.page - head, vpos: Math.round((l.y - bodyTop(l.page)) * HU_PER_PX) } : null; };
    const byPage = new Map();
    for (const o of lay.drawn.get(`0/${c.hostPara}`)?.objects || []) {
      if (!want(c).includes(o.type)) continue;
      const b = byPage.get(o.page);
      byPage.set(o.page, b ? { x0: Math.min(b.x0, o.x), y0: Math.min(b.y0, o.y), x1: Math.max(b.x1, o.x + o.w), y1: Math.max(b.y1, o.y + o.h) } : { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h });
    }
    const parts = [...byPage].sort((a, b) => a[0] - b[0]).map(([pg, b]) => ({ page: pg - head, ...b }));
    return { id: c.id, pages: head == null || nextHead == null ? null : nextHead - head, next: line(c.nextPara), hostText: c.hasText ? line(c.hostPara) : null, parts };
  });
}

/** 한/글 기준(h)과 rhwp(r) 사례 하나 → 다른 칸 목록. 빈 목록이면 같다. */
export function diffCase(c, h, r) {
  const d = [];
  if (h.pages !== r.pages) d.push(`쪽 수 ${h.pages}↔${r.pages}`);
  if (!r.next || h.next.page !== r.next.page) d.push(`뒤 글 쪽 ${h.next.page}↔${r.next?.page}`);
  else if (Math.abs(h.next.vpos - r.next.vpos) > TOL_VPOS) d.push(`뒤 글 y ${h.next.vpos}↔${r.next.vpos}HU`);
  if (c.hasText && h.host) {
    if (!r.hostText || h.host.page !== r.hostText.page) d.push(`앵커 글 쪽 ${h.host.page}↔${r.hostText?.page}`);
    else if (Math.abs(h.host.vpos - r.hostText.vpos) > TOL_VPOS) d.push(`앵커 글 y ${h.host.vpos}↔${r.hostText.vpos}HU`);
  }
  const hp = h.parts.map((p) => p.page).join(','), rp = r.parts.map((p) => p.page).join(',');
  if (hp !== rp) d.push(`개체 쪽 [${hp}]↔[${rp}]`);
  else h.parts.forEach((p, k) => {
    const q = r.parts[k];
    const e = ['x0', 'y0', 'x1', 'y1'].filter((s) => Math.abs(p[s] - q[s]) > TOL_PX);
    if (e.length) d.push(`개체 ${p.page}쪽 ${e.map((s) => `${s} ${p[s]}↔${q[s].toFixed(0)}`).join(' ')}px`);
  });
  return d;
}

/** 기준 JSON 하나를 두 경로로 견준다: A = 생성본(엔진 새 조판), B = 한/글 재저장본(저장 조판). */
export async function comparePagesplit(oracle, cases, pkgDir) {
  const out = {};
  for (const [pathKey, rel] of [['A', oracle.doc], ['B', oracle.saved]]) {
    const r = await measureRhwp(path.join(root, rel), cases, pkgDir);
    out[pathKey] = cases.map((c, i) => ({ id: c.id, label: c.label, diffs: diffCase(c, oracle.cases[i], r[i]) }));
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const template = args.includes('--template') ? args[args.indexOf('--template') + 1] : path.join(root, 'testdata', '매크로테스트용_저장.hwpx');
  fs.mkdirSync(OUT, { recursive: true });
  const all = buildCases();
  const index = {};
  for (const [ctx] of AXES.ctx) {
    const cases = all.filter((c) => c.ctx === ctx);
    const file = path.join(OUT, `pagesplit_${ctx}.hwpx`);
    index[ctx] = await buildDoc(template, file, cases);
    console.log(`${path.relative(root, file)}: 사례 ${cases.length}`);
  }
  fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(index, null, 1));
  if (args.includes('--hangul')) {
    for (const [ctx] of AXES.ctx) {
      const file = path.join(OUT, `pagesplit_${ctx}.hwpx`);
      const t0 = Date.now();
      const h = await measureHangul(file, index[ctx], path.join(OUT, `pagesplit_${ctx}_saved.hwpx`));
      const oracle = { doc: path.relative(root, file).replace(/\\/g, '/'), saved: `tests/fixtures/layout/pagesplit/pagesplit_${ctx}_saved.hwpx`, oracle: 'Hancom CreatePageImage 96dpi(인쇄 없음) + 재저장본 저장 줄 + KeyIndicator 문단 쪽', pages: h.pages, measuredAt: new Date().toISOString().slice(0, 10), cases: h.cases };
      fs.writeFileSync(path.join(OUT, `pagesplit_${ctx}_hangul.json`), JSON.stringify(oracle, null, 1));
      console.log(`  한/글 기준: 쪽 ${h.pages} · ${((Date.now() - t0) / 1000).toFixed(0)}초 · ${h.work}`);
    }
  }
}
