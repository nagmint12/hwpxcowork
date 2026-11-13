// 한/글 기준(오라클) — 인쇄(PDF)를 거치지 않고 한/글 COM CreatePageImage 쪽 그림 + 재저장본 저장 줄 + 문단 쪽 번호로 잰다.
// 조판 시험지·조판 추적(layout-trace·layout-probe·layout-matrix·layout-pagesplit)이 함께 쓴다. 기준을 정한 까닭은 docs/LAYOUT_PAGESPLIT_2026-11-03.md §2.
//
// 쪽 그림에서 개체를 알아보는 방법: 문서의 그림마다 고유 표식 색 그림으로 바꾼 사본(표식 사본)을 한/글로 연다. 그림의 화소는 조판에
// 영향을 주지 않으므로(크기는 sz/curSz 로 정해진다) 표식 사본의 조판 = 원본의 조판이다. rhwp 는 원본을 그대로 연다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export function solidPng(w, h, hex) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 표식 색 n 개 — 채도 높은 색상환에서 고르고, 글자(검정)·바탕(흰색)·회색과 겹치지 않게. 다른 시험지 표식 색과도 피한다. */
const RESERVED = new Set(['#FFC8E6', '#2E8B57', '#D6E6FF', '#FFF7D6', '#E3F5DA', '#F5DADA', '#C00000', '#1F4E9E']);
export function markerColors(n) {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const h = (i * 137.508) % 360, s = 0.85, v = i % 2 ? 0.75 : 0.95;
    const f = (k) => { const kk = (k + h / 60) % 6; return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1)); };
    const hex = '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0').toUpperCase()).join('');
    if (!RESERVED.has(hex) && !out.includes(hex)) out.push(hex);
  }
  return out;
}

/**
 * 표식 사본: 모든 그림(hp:pic)의 binaryItemIDRef 를 그림마다 새 표식 그림(BinData/mkN.png)으로 바꾼다.
 * tables 면 표마다 칸 채움을 표식 색으로 바꾼다(테두리 없음 + 채움 — 칸 크기는 cellSz 로 정해져 조판은 같다).
 * 반환 instances[i] = { kind: 'pic'|'tbl', color, file(section·masterpage 파일), section, para(최상위 문단 번호, 본문 구역만), nested(표 칸·글상자 안) }.
 */
export async function markerCopy(src, out, { tables = false } = {}) {
  const zin = await JSZip.loadAsync(fs.readFileSync(src));
  const names = Object.keys(zin.files).filter((n) => /^Contents\/(section|masterpage)\d+\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const xmls = {};
  let count = 0;
  for (const n of names) { xmls[n] = await zin.file(n).async('string'); count += (xmls[n].match(/<hc:img [^>]*binaryItemIDRef="|<hp:tbl\b/g) || []).length; }
  const colors = markerColors(count);
  const header = await zin.file('Contents/header.xml').async('string');
  const bfBase = Math.max(0, ...[...header.matchAll(/<hh:borderFill id="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const instances = [];
  let k = 0, pics = 0, tableCount = 0;
  for (const n of names) {
    const sec = /section(\d+)/i.exec(n);
    // 최상위 문단 번호와 중첩 깊이: <hs:sec> 바로 아래 <hp:p> 를 센다. 표 칸(tc)·글상자(drawText)·머리말 등 subList 안이면 nested.
    let para = -1, depth = 0, sub = 0;
    const tblStack = [];
    xmls[n] = xmls[n].replace(/<(\/?)hp:(p|subList|tbl)\b([^>]*?)(\/?)>|<hp:tc\b([^>]*?)borderFillIDRef="\d+"|<hc:img ([^>]*?)binaryItemIDRef="([^"]*)"/g, (m, close, tag, attrs, self, tcPre, pre, ref) => {
      const where = () => ({ file: n, section: sec ? Number(sec[1]) : null, para: sec ? para : null, nested: sub > 0 || !sec });
      if (tag === 'p') { if (close) depth--; else if (!self) { depth++; if (depth === 1 && sub === 0) para++; } return m; }
      if (tag === 'subList') { if (close) sub--; else if (!self) sub++; return m; }
      if (tag === 'tbl') {
        if (close) { tblStack.pop(); return m; }
        if (!tables) { tblStack.push(null); return m; }
        // 한/글은 borderFill 참조를 목록 순서로 읽는다. 그림도 증가시키는 색 번호(k)를
        // 쓰면 표·그림 혼합 문서에서 ID가 건너뛰어 뒤 표의 채움이 다른 색/없음으로 바뀐다.
        const bf = bfBase + tableCount++;
        instances.push({ kind: 'tbl', color: colors[k++], bf, ...where() });
        tblStack.push(bf);
        return m;
      }
      if (tcPre != null) { const bf = tblStack[tblStack.length - 1]; return bf == null ? m : `<hp:tc${tcPre}borderFillIDRef="${bf}"`; }
      instances.push({ kind: 'pic', color: colors[k++], id: `mk${pics}`, ref, ...where() });
      return `<hc:img ${pre}binaryItemIDRef="mk${pics++}"`;
    });
  }
  const picList = instances.filter((i) => i.kind === 'pic');
  const tblList = instances.filter((i) => i.kind === 'tbl');
  const none = (side) => `<hh:${side}Border type="NONE" width="0.12 mm" color="#000000"/>`;
  const markHeader = tblList.length ? header
    .replace('</hh:borderFills>', tblList.map((t) => `<hh:borderFill id="${t.bf}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`
      + `${none('left')}${none('right')}${none('top')}${none('bottom')}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="${t.color}" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill>`).join('') + '</hh:borderFills>')
    .replace(/<hh:borderFills itemCnt="(\d+)"/, (m, c) => `<hh:borderFills itemCnt="${Number(c) + tblList.length}"`) : header;
  const zout = new JSZip();
  zout.file('mimetype', await zin.file('mimetype').async('uint8array'), { compression: 'STORE' });
  for (const [name, f] of Object.entries(zin.files)) {
    if (f.dir || name === 'mimetype' || /^Preview\//.test(name)) continue;
    if (xmls[name] != null) zout.file(name, xmls[name]);
    else if (name === 'Contents/header.xml') zout.file(name, markHeader);
    else if (name === 'Contents/content.hpf') {
      const hpf = await f.async('string');
      zout.file(name, hpf.replace('</opf:manifest>', picList.map((p) => `<opf:item id="${p.id}" href="BinData/${p.id}.png" media-type="image/png" isEmbeded="1"/>`).join('') + '</opf:manifest>'));
    } else zout.file(name, await f.async('uint8array'));
  }
  // 크게 만들어 줄여 그리게 한다 — 늘려 그리면 가장자리가 번져 표식 색 상자가 1~2px 줄어든다.
  picList.forEach((p) => zout.file(`BinData/${p.id}.png`, solidPng(1600, 1600, p.color)));
  fs.writeFileSync(out, await zout.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { instances, colors };
}

/**
 * 한/글로 재기: 표식 사본을 만들어 tests/hangul_page_images.py 로 연다(쪽 그림·문단 쪽 번호·재저장본). 결과 폴더를 돌려준다.
 * extraColors: 시험지가 개체에 직접 칠한 표식 색(도형 채움·표 칸 채움 등). tables: 표마다 칸 채움을 표식 색으로(시험지가 표를 직접 칠하지 않을 때).
 */
export function runHangulOracle(file, { extraColors = [], keepImages = false, dir = null, tables = false } = {}) {
  const out = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'hangul_oracle_'));
  return (async () => {
    const marked = path.join(out, 'marked.hwpx');
    const { instances } = await markerCopy(file, marked, { tables });
    const colors = [...new Set([...instances.map((i) => i.color), ...extraColors])];
    // 다른 세션이 한/글을 쓰고 있으면 COM 연결이 실패할 수 있다 — 몇 번 다시 해 본다.
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('python', ['-I', path.join(root, 'tests', 'hangul_page_images.py'), marked, out, '--colors', colors.join(','), '--save', '--para-pages', 'all', ...(keepImages ? ['--keep-images'] : [])], { timeout: 3600000, maxBuffer: 256 << 20 });
      } catch (err) {
        // COM 실패는 Python도 실패 코드로 알린다. 결과 JSON이 있으면 아래에서 재시도 여부를 판단한다.
        if (!fs.existsSync(path.join(out, 'page_images.json'))) throw err;
      }
      const pi = JSON.parse(fs.readFileSync(path.join(out, 'page_images.json'), 'utf8'));
      if (pi.ok && pi.open && pi.saved && fs.existsSync(path.join(out, 'saved.hwpx'))) break;
      if (attempt === 3) throw new Error(`한/글 열기 실패: ${file} (${out}/page_images.json)`);
      await new Promise((ok) => setTimeout(ok, 10000));
    }
    fs.writeFileSync(path.join(out, 'markers.json'), JSON.stringify({ src: path.resolve(file), tablesMeasured: tables, instances }, null, 1));
    return out;
  })();
}

/** 결과 폴더 → { pages, images·tables: 쪽마다 최상위 그림·표 상자 [x0,y0,x1,y1] (위→아래, 왼쪽→오른쪽), colorBoxes, paraPages, instances } */
export function readHangulOracle(dir) {
  const pi = JSON.parse(fs.readFileSync(path.join(dir, 'page_images.json'), 'utf8'));
  const markers = JSON.parse(fs.readFileSync(path.join(dir, 'markers.json'), 'utf8'));
  const { instances } = markers;
  const tablesMeasured = markers.tablesMeasured ?? instances.some((i) => i.kind === 'tbl');
  const perPage = (kind) => {
    const top = new Set(instances.filter((i) => (i.kind || 'pic') === kind && !i.nested).map((i) => i.color));
    return pi.images.map((p) => {
      const bs = [];
      for (const [c, parts] of Object.entries(p.colors || {})) {
        if (!top.has(c) || !parts.length) continue;
        // 한 개체가 글자에 가리거나 칸 테두리로 나뉘어 여러 덩어리가 된다 — 같은 색은 쪽마다 하나로 합친다.
        bs.push([Math.min(...parts.map((b) => b[0])), Math.min(...parts.map((b) => b[1])), Math.max(...parts.map((b) => b[2])), Math.max(...parts.map((b) => b[3]))]);
      }
      return bs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    });
  };
  return { pages: pi.pages, images: perPage('pic'), tables: tablesMeasured ? perPage('tbl') : null, tablesMeasured, colorBoxes: pi.images.map((p) => p.colors || {}), paraPages: pi.paraPages || {}, paraSections: pi.paraSections || {}, instances, saved: path.join(dir, 'saved.hwpx') };
}

/** 한/글이 알려 준 문단 쪽 번호로 저장 줄의 쪽(되감김으로 어림한 쪽)을 바로잡는다. 문단 번호는 구역을 지나도 이어진다. */
export function alignPagesWithParaPages(hangul, paraPages) {
  let g = 0;
  for (const sec of hangul.sections) {
    for (const p of sec.paragraphs) {
      const want = paraPages[String(g++)];
      if (want == null || !p.lines.length) continue;
      const delta = want - p.lines[0].page;
      if (delta) for (const l of p.lines) l.page += delta;
    }
  }
  hangul.pageCount = Math.max(1, ...hangul.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.lines.map((l) => l.page + 1))));
}
