// 시험 받침: 글이 본문 흐름이 아니라 쪽 좌표의 글상자 조각으로, 표 선이 가는 사각형으로 그려진 문서(PDF 를 옮긴 문서 꼴)를 만든다.
// 빈 문서 본보기(server/templates/blank.hwpx)에 쪽마다 구역 하나를 두고 그 첫 문단에 도형 XML 을 넣는다 — 실제 사용자 문서를 쓰지 않는다.
//   const doc = await floatingDoc({ pages: [{ title: '제목', table: { cols: [6000, 14000, 20000], rows: [['가', '나', '다 라'], …], header: true, merge: [[1, 0, 2]] }, pageNumber: '1' }] });
//   const bytes = await doc.save();
// engine/layout.js·engine/flow.js(개체 → 본문) 시험과 새 MCP 연결 시험(tests/mcp_v2_flow.test.mjs)이 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpxDoc } from '../../engine/doc.js';
import { Section } from '../../engine/section.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HEAD = (w, h) => `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${w >> 1}" centerY="${h >> 1}" rotateimage="0"/>`
  + '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
  + '<hp:lineShape color="#000000" width="0" style="NONE" endCap="ROUND" headStyle="NORMAL" tailStyle="NORMAL" headfill="0" tailfill="0" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/>';
const TAIL = (x, y, w, h) => `<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/><hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
  + `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="${y}" horzOffset="${x}"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>`;
const OPEN = (id) => `<hp:rect id="${id}" zOrder="${id}" numberingType="NONE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}" ratio="0">`;

/** 글상자 하나(한 문단) */
export const textBox = (id, x, y, w, h, text) => `${OPEN(id)}${HEAD(w, h)}<hp:drawText lastWidth="${w}" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
  + `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${esc(text)}</hp:t></hp:run></hp:p></hp:subList><hp:textMargin left="0" right="0" top="0" bottom="0"/></hp:drawText>${TAIL(x, y, w, h)}</hp:rect>`;
/** 글 없는 사각형(가늘면 괘선, 넓으면 면) */
export const box = (id, x, y, w, h, color = '#000000') => `${OPEN(id)}${HEAD(w, h)}<hc:fillBrush><hc:winBrush faceColor="${color}" hatchColor="#000000" alpha="0"/></hc:fillBrush>${TAIL(x, y, w, h)}</hp:rect>`;

const CHAR_W = 520; const LINE_H = 1000; const ROW_H = 1460; const RULE = 36;

/**
 * 여러 문단·여러 줄 글상자(PDF 변환기가 한 열·여러 줄 글을 한 글상자에 쌓는 꼴). paras: [{ lines: [{ text, vp(글상자 위에서 줄 위까지), hp?(줄 시작 — 글상자 왼쪽에서) }] }].
 * 문단 글 = 줄 글을 그대로 이은 것(줄 사이에 빈칸을 넣지 않는다 — 줄 끝 빈칸은 줄 글에 넣는다). segs=false 면 저장된 줄 배치(linesegarray)를 쓰지 않는다
 */
export function linesBox(id, x, y, w, h, paras, { segs = true, lineH = LINE_H } = {}) {
  const ps = paras.map((p) => {
    let tp = 0;
    const ls = p.lines.map((l) => { const hp = l.hp ?? 0; const s = `<hp:lineseg textpos="${tp}" vertpos="${l.vp}" vertsize="${lineH}" textheight="${lineH}" baseline="${Math.round(lineH * 0.85)}" spacing="0" horzpos="${hp}" horzsize="${w - hp}" flags="393216"/>`; tp += [...l.text].length; return s; });
    return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${esc(p.lines.map((l) => l.text).join(''))}</hp:t></hp:run>${segs ? `<hp:linesegarray>${ls.join('')}</hp:linesegarray>` : ''}</hp:p>`;
  }).join('');
  return `${OPEN(id)}${HEAD(w, h)}<hp:drawText lastWidth="${w}" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
    + `${ps}</hp:subList><hp:textMargin left="0" right="0" top="0" bottom="0"/></hp:drawText>${TAIL(x, y, w, h)}</hp:rect>`;
}

/**
 * 쪽 하나의 도형 XML 을 만든다 → { xml, next(다음 id) }.
 * page: { title?, table?: { x?(왼쪽 5800), y?(위 12600), cols: [칸 너비…], rows: [[칸 글…]…](칸 글의 '\n' = 칸 안 줄바꿈, 낱말마다 조각 하나 — 뒤 빈칸 포함),
 *         header?(첫 줄 배경색), merge?: [[줄, 칸, 줄 수]…](세로로 합친 칸 — 그 사이 가로선을 긋지 않는다),
 *         outer?(false = 바깥 세로선 없음), rowRules?(false = 행 사이 가로선 없음), columnBox?: { col, groups? }(그 열을 글상자 하나에 쌓음) },
 *       pageNumber?, lines?: [{ x, y, text }], paras?: [{ x, y, width, lines: [줄 글…], next?, bullet?, pitch? }](양쪽 맞춘 낱말 글상자 문단),
 *       boxes?: [{ x, y, w, h?, paras: [[줄 글…]…], segs?, hp?, pitch?, gap? }](여러 문단 글상자), extra?(도형 XML 을 더) }
 */
export function pageShapes(page, startId = 1) {
  let id = startId; const out = [];
  const words = (x, y, text) => {
    // 낱말마다 글상자 하나: 뒤에 빈칸이 있던 낱말은 그 빈칸까지(변환기가 내는 꼴)
    const parts = String(text).split(/(?<= )/);
    let cx = x;
    for (const part of parts) { if (!part) continue; const w = Math.max(300, [...part].length * CHAR_W); out.push(textBox(id++, cx, y, w, LINE_H, part)); cx += w; }
  };
  if (page.title) words(5900, 10600, page.title);
  for (const l of page.lines || []) words(l.x, l.y, l.text);
  // 낱말 글상자로 놓인 문단(줄바꿈된 본문): 마지막 줄 말고는 오른쪽 끝에 맞춰 낱말 사이를 벌린다(양쪽 맞춤). next = 둘째 줄부터의 왼쪽(내어쓰기·들여쓰기),
  // bullet = 첫 줄 x 에 놓는 글머리 글자(첫 줄 글은 next 에서 시작 — 글머리 뒤 내어쓰기)
  for (const p of page.paras || []) {
    if (p.bullet) out.push(textBox(id++, p.x, p.y, Math.max(300, [...p.bullet].length * CHAR_W), LINE_H, p.bullet));
    p.lines.forEach((line, i) => {
      const lx = i === 0 && !p.bullet ? p.x : (p.next ?? p.x); const y = p.y + i * (p.pitch ?? LINE_H + 700);
      const parts = String(line).split(/(?<= )/).filter(Boolean); const ws = parts.map((s) => Math.max(300, [...s].length * CHAR_W));
      const spare = i + 1 < p.lines.length && parts.length > 1 ? Math.max(0, p.x + p.width - lx - ws.reduce((s, v) => s + v, 0)) / (parts.length - 1) : 0;
      let cx = lx;
      parts.forEach((s, k) => { out.push(textBox(id++, Math.round(cx), y, ws[k], LINE_H, s)); cx += ws[k] + spare; });
    });
  }
  // 여러 문단 글상자: paras = [[줄 글…]…](문단마다 줄 목록) — 줄 간격 pitch, 문단 사이 gap 더
  for (const b of page.boxes || []) {
    let vp = 0;
    const paras = b.paras.map((lines) => { const p = { lines: lines.map((text) => { const l = { text, vp, hp: b.hp ?? 0 }; vp += b.pitch ?? LINE_H + 500; return l; }) }; vp += b.gap ?? 400; return p; });
    out.push(linesBox(id++, b.x, b.y, b.w, b.h ?? vp, paras, { segs: b.segs !== false }));
  }
  if (page.table) {
    const t = page.table; const x0 = t.x ?? 5800; const y0 = t.y ?? 12600;
    const xs = [x0]; for (const w of t.cols) xs.push(xs[xs.length - 1] + w);
    const nRows = t.rows.length; const heights = t.rows.map((r) => ROW_H * Math.max(1, ...r.map((c) => String(c).split('\n').length)));
    const ys = [y0]; for (const h of heights) ys.push(ys[ys.length - 1] + h);
    const merged = new Set();   // '줄,칸' — 이 줄 위쪽 가로선을 긋지 않는 칸
    for (const [r, c, n] of t.merge || []) for (let k = r + 1; k < r + n; k++) merged.add(`${k},${c}`);
    // outer=false: 바깥 세로선(좌우 테두리)을 긋지 않는다 — 가로선은 표 폭 그대로
    xs.forEach((x, i) => { if (t.outer === false && (i === 0 || i === xs.length - 1)) return; out.push(box(id++, x - RULE / 2, y0, RULE, ys[nRows] - y0)); });
    for (let r = 0; r <= nRows; r++) {
      // rowRules=false: 행 사이 가로선 없이 머리·머리 아래·바닥선만
      if (t.rowRules === false && !(r === 0 || r === nRows || (t.header && r === 1))) continue;
      // 합친 칸이 있는 줄은 그 칸을 뺀 구간마다 가로선을 긋는다
      let c = 0;
      while (c < t.cols.length) {
        if (r > 0 && r < nRows && merged.has(`${r},${c}`)) { c++; continue; }
        let e = c; while (e + 1 < t.cols.length && !(r > 0 && r < nRows && merged.has(`${r},${e + 1}`))) e++;
        out.push(box(id++, xs[c], ys[r] - RULE / 2, xs[e + 1] - xs[c], RULE));
        c = e + 1;
      }
    }
    if (t.header) out.push(box(id++, x0, y0, xs[xs.length - 1] - x0, heights[0], '#D6D6D6'));
    // columnBox: { col, groups?: [[줄 번호…]…] } — 그 열의 칸 글을 낱말 글상자 대신 글상자 하나에 쌓는다(변환기 꼴). 글상자는 옆 열까지 넓게 걸쳐
    // 가운데 점이 다른 열에 놓이고, 칸 줄마다 저장된 줄 배치로 제 행 자리에 놓인다. groups 의 행들은 한 문단(행 사이 빈칸 없이 줄만 바뀜)
    const cb = t.columnBox; const colLines = [];
    t.rows.forEach((row, r) => row.forEach((cell, c) => {
      const span = (t.merge || []).find((m) => m[0] === r && m[1] === c);
      // 합친 칸의 글은 합친 높이 가운데에 놓인다
      const top = span ? (ys[r] + ys[r + span[2]]) / 2 - LINE_H / 2 : ys[r] + 200;
      String(cell).split('\n').forEach((line, k) => {
        if (!line) return;
        const ly = Math.round(top + k * (LINE_H + 100));
        if (cb && cb.col === c) colLines.push({ r, text: line, y: ly }); else words(xs[c] + 300, ly, line);
      });
    }));
    if (cb) {
      const bx = xs[cb.col] - 14000; const bw = xs[cb.col + 1] + 3000 - bx; const by = ys[0]; const bh = ys[nRows] - ys[0];
      const groupOf = (r) => (cb.groups || []).findIndex((g) => g.includes(r));
      const paras = [];
      for (const l of colLines) {
        const g = groupOf(l.r); const last = paras[paras.length - 1];
        const line = { text: l.text, vp: l.y - by, hp: xs[cb.col] + 300 - bx };
        if (last && ((g >= 0 && last.g === g) || last.r === l.r)) { last.lines.push(line); last.r = l.r; } else paras.push({ g, r: l.r, lines: [line] });
      }
      out.push(linesBox(id++, bx, by, bw, bh, paras));
    }
  }
  if (page.pageNumber != null) out.push(textBox(id++, 0, 78800, 59500, 995, String(page.pageNumber)));
  if (page.extra) out.push(page.extra);
  return { xml: out.join(''), next: id };
}

/**
 * 떠 있는 글상자 문서를 만든다(쪽마다 구역 하나). opts.zeroMargins(기본 true): 변환기처럼 쪽 여백을 모두 0 으로.
 * opts.body: 구역 첫 문단 뒤에 넣을 본문 문단 글(쪽마다 배열) — 보통 문단과 섞인 문서 시험용
 */
export async function floatingDoc({ pages, zeroMargins = true } = {}) {
  const doc = await HwpxDoc.load(fs.readFileSync(path.join(root, 'server', 'templates', 'blank.hwpx')));
  let base = doc.sections[0].xml;
  if (zeroMargins) base = base.replace(/<hp:margin\b[^>]*\/>/, '<hp:margin header="0" footer="0" gutter="0" left="0" right="0" top="0" bottom="0"/>');
  const first = doc.sections[0].bodyParas[0];
  const para = doc.sections[0].xml.slice(first.start, first.end);
  const paraBase = zeroMargins ? para.replace(/<hp:margin\b[^>]*\/>/, '<hp:margin header="0" footer="0" gutter="0" left="0" right="0" top="0" bottom="0"/>') : para;
  const head = base.slice(0, base.indexOf(paraBase)); const tail = '</hs:sec>';
  let id = 1; const sections = [];
  pages.forEach((page, i) => {
    const shapes = pageShapes(page, id); id = shapes.next;
    // 구역 첫 문단의 마지막 run 에 도형을 넣는다
    const at = paraBase.lastIndexOf('<hp:t/></hp:run>');
    const p = `${paraBase.slice(0, at)}${shapes.xml}<hp:t/></hp:run>${paraBase.slice(at + '<hp:t/></hp:run>'.length)}`;
    const more = (page.body || []).map((t) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${esc(t)}</hp:t></hp:run></hp:p>`).join('');
    sections.push(new Section(`${head}${p}${more}${tail}`, i));
  });
  doc.sections = sections;
  doc._rewriteSectionFiles();
  return doc;
}
