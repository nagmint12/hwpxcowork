// '글꼴에 어울리는 빈칸'(charPr useFontSpace) 공백 폭 시험지(2026-11-16).
// 고등교육법 의안원문(한양신명조 HFT 14pt, useFontSpace=1)에서 엔진은 공백을 대체 TTF(HY신명조) 폭 ≈0.325em 으로 재어
// 한/글보다 한 줄에 글자를 더 넣었다. 한/글이 HFT 글꼴의 공백을 몇 HU 로 재는지 줄 끝 위치(재저장 textpos)로 잰다.
//
// 칸: 글꼴(HFT) × 크기 × useFontSpace(1/0 — 0 은 반각 대조군) × 자리(본문 문단 / 표 칸 안 문단) × 오른쪽 여백 20단계.
// 글: ("가 " × K) + "나" × N — 글자 단위 줄 나눔(HWPX breakNonLatinWord="KEEP_WORD" = 글자 단위). 첫 줄의 "나" 개수 n 이
//     n·H ≤ W − K·(H+s) < (n+1)·H 를 주므로 공백 폭 s 가 폭 H/K 구간에 들고, 여백을 H/20 씩 옮긴 20칸을 겹치면 H/(20K) 로 좁혀진다.
//     K=0 칸(글자만)은 글자 폭 H 를 따로 잰다(가정 없이).
//
//   node scripts/layout-probe-fontspace.mjs                       → tests/fixtures/layout/fontspace-20261116/fontspace.hwpx + _cases.json
//   python -I tests/hangul_page_images.py <fontspace.hwpx> <out> --save   (숨은 한/글 COM — 재저장본 saved.hwpx)
//   node scripts/layout-probe-fontspace.mjs --read <saved.hwpx>   → _hangul.json(칸마다 한/글 첫 줄 글자 수·구간)
//   node scripts/layout-probe-fontspace.mjs --engine [pkg]        → 같은 시험지를 엔진으로 — 한/글과 다른 칸
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = path.join(root, 'tests', 'fixtures', 'layout', 'fontspace-20261116');
const outFile = path.join(dir, 'fontspace.hwpx');
const casesFile = path.join(dir, 'fontspace_cases.json');
const hangulFile = path.join(dir, 'fontspace_hangul.json');
const tpl = path.join(root, 'testdata', fs.readdirSync(path.join(root, 'testdata')).find((n) => n.includes('매크로테스트용_저장') && n.endsWith('.hwpx')));

const W0 = 42520; // 틀(A4, 좌우 여백 8504)의 본문 폭
const STEPS = 20;
const FONTS = [
  { face: '한양신명조', sizes: [10, 12, 14] },
  { face: '한양중고딕', sizes: [10, 14] },
  { face: '한양견명조', sizes: [10, 14] },
];
const K_OF = (H) => Math.floor((W0 / H - 4) / 1.6); // s=0.6em·여백 1em 에서도 첫 줄에 "나" 3개 이상

let uid = 1970000000;
const id = () => String(uid++);

function plan() {
  const cases = [];
  for (const f of FONTS) for (const pt of f.sizes) {
    const H = pt * 100;
    for (let j = 0; j < STEPS; j++) cases.push({ face: f.face, pt, fontSpace: null, place: 'body', K: 0, j, R: Math.round(j * H / STEPS) });
    for (const fontSpace of [1, 0]) for (const place of ['body', 'table']) for (let j = 0; j < STEPS; j++) {
      cases.push({ face: f.face, pt, fontSpace, place, K: K_OF(H), j, R: Math.round(j * H / STEPS) });
    }
  }
  return cases;
}

async function make() {
  const cases = plan();
  const zin = await JSZip.loadAsync(fs.readFileSync(tpl));
  let header = await zin.file('Contents/header.xml').async('string');
  // 글꼴: 언어 7칸 모두에 HFT 글꼴을 더한다(언어마다 번호가 다르다).
  const fontIds = {}; // face → {lang: id}
  for (const f of FONTS) fontIds[f.face] = {};
  header = header.replace(/<hh:fontface lang="(\w+)" fontCnt="(\d+)">([\s\S]*?)<\/hh:fontface>/g, (m, lang, cnt, body) => {
    let n = +cnt; let add = '';
    for (const f of FONTS) {
      fontIds[f.face][lang] = n;
      add += `<hh:font id="${n}" face="${f.face}" type="HFT" isEmbedded="0"><hh:typeInfo familyType="FCAT_MYUNGJO" weight="0" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font>`;
      n++;
    }
    return `<hh:fontface lang="${lang}" fontCnt="${n}">${body}${add}</hh:fontface>`;
  });
  // 글자 모양: 글꼴 × 크기 × useFontSpace(K=0 칸은 0). 번호는 틀의 마지막 다음부터 이어서.
  const charCount = +header.match(/<hh:charProperties itemCnt="(\d+)"/)[1];
  const c0 = header.match(/<hh:charPr id="0"[\s\S]*?<\/hh:charPr>/)[0];
  const charPrs = []; const charId = {};
  const LANGS = { hangul: 'HANGUL', latin: 'LATIN', hanja: 'HANJA', japanese: 'JAPANESE', other: 'OTHER', symbol: 'SYMBOL', user: 'USER' };
  for (const f of FONTS) for (const pt of f.sizes) for (const fs1 of [1, 0]) {
    const cid = charCount + charPrs.length;
    charId[`${f.face}/${pt}/${fs1}`] = cid;
    const ref = Object.entries(LANGS).map(([k, L]) => `${k}="${fontIds[f.face][L]}"`).join(' ');
    charPrs.push(c0.replace('id="0"', `id="${cid}"`).replace(/height="\d+"/, `height="${pt * 100}"`).replace(/useFontSpace="\d"/, `useFontSpace="${fs1}"`)
      .replace(/<hh:fontRef [^>]*\/>/, `<hh:fontRef ${ref}/>`));
  }
  header = header.replace(/(<hh:charProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (+n + charPrs.length) + b)
    .replace('</hh:charProperties>', charPrs.join('') + '</hh:charProperties>');
  // 문단 모양: 오른쪽 여백 R 마다 하나(왼쪽 맞춤, 글자 단위, 공백 최소 0%, 160%). case 는 HwpUnitChar 값, default 는 그 두 배(한/글 관례).
  const paraCount = +header.match(/<hh:paraProperties itemCnt="(\d+)"/)[1];
  const p28 = header.match(/<hh:paraPr id="28"[\s\S]*?<\/hh:paraPr>/)[0];
  const paraPrs = []; const paraId = {};
  const mkPara = (R) => {
    if (paraId[R] != null) return paraId[R];
    const pid = paraCount + paraPrs.length;
    paraId[R] = pid;
    let x = p28.replace('id="28"', `id="${pid}"`).replace(/condense="\d+"/, 'condense="0"').replace(/snapToGrid="\d"/, 'snapToGrid="0"')
      .replace('horizontal="JUSTIFY"', 'horizontal="LEFT"').replace(/breakLatinWord="\w+"/, 'breakLatinWord="KEEP_WORD"').replace(/breakNonLatinWord="\w+"/, 'breakNonLatinWord="KEEP_WORD"')
      .replace(/type="PERCENT" value="\d+"/g, 'type="PERCENT" value="160"');
    const [cs, ce] = [x.indexOf('<hp:case'), x.indexOf('</hp:case>')];
    const caseXml = x.slice(cs, ce).replace(/<hc:right value="-?\d+"/, `<hc:right value="${R}"`);
    const defXml = x.slice(ce).replace(/<hc:right value="-?\d+"/, `<hc:right value="${2 * R}"`);
    paraPrs.push(x.slice(0, cs) + caseXml + defXml);
    return pid;
  };
  const hostPara = mkPara(0);
  for (const c of cases) c.paraPr = mkPara(c.R);
  header = header.replace(/(<hh:paraProperties itemCnt=")(\d+)(")/, (m, a, n, b) => a + (+n + paraPrs.length) + b)
    .replace('</hh:paraProperties>', paraPrs.join('') + '</hh:paraProperties>');
  if (paraPrs.length && !header.includes(`<hh:paraPr id="${paraCount}"`)) throw new Error('문단 모양 번호가 이어지지 않는다');

  const text = (c) => {
    const H = c.pt * 100;
    const cap = Math.ceil(W0 / H) + 6;
    return '가 '.repeat(c.K) + '나'.repeat(cap);
  };
  const p = (pp, cp, t) => `<hp:p id="${id()}" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${cp}"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  const blocks = [];
  for (const c of cases) {
    c.charPr = charId[`${c.face}/${c.pt}/${c.fontSpace ?? 0}`];
    c.text = text(c);
    if (c.place === 'body') { blocks.push(p(c.paraPr, c.charPr, c.text)); continue; }
    const sub = '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">';
    blocks.push(`<hp:p id="${id()}" paraPrIDRef="${hostPara}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">`
      + `<hp:tbl id="${id()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">`
      + `<hp:sz width="${W0}" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/>`
      + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
      + '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>'
      + `<hp:tr><hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">${sub}${p(c.paraPr, c.charPr, c.text)}</hp:subList>`
      + `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${W0}" height="2000"/>`
      + '<hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr></hp:tbl><hp:t/></hp:run></hp:p>');
  }
  const sec = await zin.file('Contents/section0.xml').async('string');
  let depth = 0; let firstEnd = -1;
  for (const m of sec.matchAll(/<(\/?)hp:p\b[^>]*?(\/?)>/g)) {
    if (m[2]) continue;
    if (!m[1]) depth++;
    else if (--depth === 0) { firstEnd = m.index + m[0].length; break; }
  }
  const xml = sec.slice(0, firstEnd) + blocks.join('') + sec.slice(sec.lastIndexOf('</hs:sec>'));
  zin.file('Contents/header.xml', header);
  zin.file('Contents/section0.xml', xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outFile, await zin.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  cases.forEach((c, i) => { c.index = i; c.para = i + 1; delete c.text; });
  fs.writeFileSync(casesFile, JSON.stringify({ W0, steps: STEPS, cases }, null, 0).replace(/\},\{/g, '},\n{'));
  console.log(`${outFile} — 칸 ${cases.length}개(문단 모양 ${paraPrs.length}·글자 모양 ${charPrs.length})`);
}

// 재저장본에서 칸마다 첫 줄 글자 수(둘째 줄 textpos) — 본문 문단은 구역의 (i+1)번째 최상위 문단, 표 칸은 그 문단 안 셀 문단.
function firstLineChars(xml) {
  const out = []; // 최상위 문단 차례마다 [textpos...] (표 칸이면 셀 문단의 것)
  let depth = 0; let cur = null; let cellLines = null;
  const re = /<hp:p\b[^>]*>|<\/hp:p>|<hp:lineseg\b[^>]*\/>/g; let m;
  while ((m = re.exec(xml))) {
    const t = m[0];
    if (t.startsWith('<hp:p')) { depth++; if (depth === 1) { cur = { top: [], cell: [] }; out.push(cur); } }
    else if (t === '</hp:p>') depth--;
    else { const tp = +t.match(/textpos="(\d+)"/)[1]; (depth === 1 ? cur.top : cur.cell).push(tp); }
  }
  return out;
}

async function read(saved) {
  const { cases } = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const z = await JSZip.loadAsync(fs.readFileSync(saved));
  const paras = firstLineChars(await z.file('Contents/section0.xml').async('string'));
  const rows = cases.map((c) => {
    const p = paras[c.para];
    const lines = c.place === 'body' ? p?.top : p?.cell;
    return { index: c.index, lines: lines ?? null };
  });
  fs.writeFileSync(hangulFile, JSON.stringify({ source: 'hangul 2022 COM resave (tests/hangul_page_images.py --save)', rows }, null, 0).replace(/\},\{/g, '},\n{'));
  console.log(hangulFile, rows.filter((r) => r.lines?.length >= 2).length, '/', rows.length, '칸에 둘째 줄');
}

// 첫 줄 글자 수 → "나" 개수 n → 구간. 글자만(K=0): H ∈ (W/(n+1), W/n]. 공백 칸: s ∈ ((W − K·H − (n+1)H)/K, (W − K·H − nH)/K].
export function analyze(cases, firstChars) {
  const groups = new Map();
  const H = new Map(); // face/pt → [lo, hi]
  for (const c of cases) {
    const fc = firstChars[c.index];
    if (fc == null) continue;
    const W = W0 - c.R;
    if (c.K === 0) {
      const n = fc; const key = `${c.face}/${c.pt}`;
      const [lo, hi] = H.get(key) ?? [-Infinity, Infinity];
      H.set(key, [Math.max(lo, W / (n + 1)), Math.min(hi, W / n)]);
    }
  }
  for (const c of cases) {
    const fc = firstChars[c.index];
    if (fc == null || c.K === 0) continue;
    const key = `${c.face}/${c.pt}/${c.fontSpace}/${c.place}`;
    const h = H.get(`${c.face}/${c.pt}`); const Hm = h ? (h[0] + h[1]) / 2 : c.pt * 100;
    const W = W0 - c.R;
    const n = fc - 2 * c.K; // "가 " K번 = 2K 글자
    if (n < 0) { groups.set(key, { ...(groups.get(key) ?? {}), bad: true }); continue; }
    const lo = (W - c.K * Hm - (n + 1) * Hm) / c.K; const hi = (W - c.K * Hm - n * Hm) / c.K;
    const g = groups.get(key) ?? { lo: -Infinity, hi: Infinity, n: 0 };
    g.lo = Math.max(g.lo, lo); g.hi = Math.min(g.hi, hi); g.n++;
    groups.set(key, g);
  }
  return { H, groups };
}

async function engine(pkgArg) {
  const pkg = path.resolve(pkgArg || process.env.RHWP_PKG || path.join(root, 'vendor', 'rhwp', 'pkg'));
  const { cases } = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const hangul = fs.existsSync(hangulFile) ? JSON.parse(fs.readFileSync(hangulFile, 'utf8')).rows : null;
  globalThis.measureTextWidth ??= (f, t) => t.length * 10;
  const mod = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
  mod.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
  const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(outFile)));
  doc.convertToEditable();
  // 문단(최상위)마다 첫 줄 글자 수: 본문은 TextLine(pi), 표 칸은 Table(pi) 안의 첫 TextLine.
  const first = new Map();
  for (let pg = 0; pg < doc.pageCount(); pg++) {
    const tree = JSON.parse(doc.getPageRenderTree(pg));
    const lineText = (n) => (n.children || []).filter((c) => c.type === 'TextRun').map((r) => r.text ?? '').join('');
    (function walk(n, table) {
      if (n.type === 'Table' && n.pi != null) table = n.pi;
      if (n.type === 'TextLine') {
        const key = table != null ? `t${table}` : `b${n.children?.find((c) => c.type === 'TextRun' && c.pi != null)?.pi ?? n.pi}`;
        const arr = first.get(key) ?? []; arr.push({ y: n.bbox.y, page: pg, t: lineText(n) }); first.set(key, arr);
        return;
      }
      for (const c of n.children || []) walk(c, table);
    })(tree, null);
  }
  doc.free();
  const engFirst = cases.map((c) => {
    const arr = first.get(`${c.place === 'body' ? 'b' : 't'}${c.para}`);
    if (!arr?.length) return null;
    arr.sort((a, b) => a.page - b.page || a.y - b.y);
    return [...arr[0].t].length;
  });
  const hFirst = hangul ? hangul.map((r) => (r.lines?.length >= 2 ? r.lines[1] : null)) : null;
  const report = (label, fc) => {
    const { H, groups } = analyze(cases, fc);
    console.log(`\n[${label}] 글자 폭 H(HU):`, [...H].map(([k, [lo, hi]]) => `${k} ${lo.toFixed(1)}~${hi.toFixed(1)}`).join(' · '));
    for (const [k, g] of groups) {
      const [face, pt] = k.split('/'); const em = +pt * 100;
      console.log(`  ${k.padEnd(22)} 공백 ${g.bad ? '(줄 나눔 가정 깨짐)' : `${g.lo.toFixed(1)}~${g.hi.toFixed(1)} HU = ${(g.lo / em).toFixed(4)}~${(g.hi / em).toFixed(4)} em`}`);
    }
  };
  if (hFirst) report('한/글', hFirst);
  report(`엔진 ${path.basename(path.dirname(pkg))}/${path.basename(pkg)}`, engFirst);
  if (hFirst) {
    const diff = cases.filter((c, i) => hFirst[i] != null && engFirst[i] !== hFirst[i]);
    const by = {};
    for (const c of diff) { const k = `${c.face}/${c.pt}/${c.fontSpace ?? 'K0'}/${c.place}`; by[k] = (by[k] || 0) + 1; }
    console.log(`\n한/글과 첫 줄 글자 수가 다른 칸: ${diff.length} / ${cases.filter((c, i) => hFirst[i] != null).length}`, by);
  }
}

const argv = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv[0] === '--read') await read(path.resolve(argv[1]));
  else if (argv[0] === '--engine') await engine(argv[1]);
  else await make();
}
