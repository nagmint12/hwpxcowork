// 이 PC 에 설치된 글꼴 파일의 글자 전진폭(hmtx)을 읽어 rhwp 엔진의 "설치 글꼴 폭 표"를 만든다.
//   node scripts/gen-font-metrics.mjs            → vendor/rhwp/src/renderer/font_metrics_local.rs (+ 같은 이름 .json 목록)
//   node scripts/gen-font-metrics.mjs --dir <폴더> [--dir …]   기본 글꼴 폴더 대신/더해 읽을 폴더
//   node scripts/gen-font-metrics.mjs --all      한글 글꼴·흔한 영문 글꼴만이 아니라 읽을 수 있는 글꼴 전부
//   node scripts/gen-font-metrics.mjs --common-only  이전의 한글/흔한 영문 필터(기본은 전체)
// 표에 오른 글꼴은 한/글과 같은 셈법(4 HWPUNIT 격자 — renderer/local_font_width.rs)으로 글자 폭을 잰다.
// 끝나면 npm run build:engine → npm run build:studio. 글꼴을 새로 설치했거나 지웠으면 다시 돌린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_RS = path.join(root, 'vendor', 'rhwp', 'src', 'renderer', 'font_metrics_local.rs');
const OUT_JSON = OUT_RS.replace(/\.rs$/, '.json');

const args = process.argv.slice(2);
// [hwpx-cowork] All installed SFNT faces participate in special-character matching.
// The former Korean/common-Latin filter silently omitted decorative and symbol faces.
const all = !args.includes('--common-only');
const extraDirs = args.flatMap((a, i) => (a === '--dir' ? [args[i + 1]] : [])).filter(Boolean);

// 한글 글꼴이 아니어도 한국 문서에 흔히 쓰이는 영문 글꼴(가족 이름, 소문자·공백 무시)
const COMMON_LATIN = new Set(['arial', 'arialnarrow', 'timesnewroman', 'calibri', 'calibrilight', 'cambria', 'consolas',
  'couriernew', 'verdana', 'tahoma', 'segoeui', 'georgia', 'garamond', 'bookantiqua', 'centurygothic', 'trebuchetms',
  'palatinolinotype', 'lucidaconsole', 'franklingothicbook', 'franklingothicmedium']);

function fontDirs() {
  if (extraDirs.length && !args.includes('--with-default')) return extraDirs;
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
    // 한/글이 함께 설치하는 글꼴(한컴바탕·함초롬·HY·휴먼 등 — 설치 글꼴이 없을 때 한/글이 대신 쓰는 글꼴도 여기 있다).
    // 같은 이름이면 위의 설치 글꼴이 먼저, 한/글은 새 판이 먼저.
    for (const pf of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
      const hnc = path.join(pf, 'HNC');
      let offices = [];
      try { offices = fs.readdirSync(hnc).sort().reverse(); } catch { continue; }
      for (const office of offices) {
        let subs = [];
        try { subs = fs.readdirSync(path.join(hnc, office)); } catch { continue; }
        for (const sub of subs) dirs.push(path.join(hnc, office, sub, 'Shared', 'TTF'));
      }
    }
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local', 'share', 'fonts'));
  }
  return [...dirs, ...extraDirs];
}

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) yield p;
  }
}

// ── sfnt 읽기(필요한 표만) ─────────────────────────────────────────
function tables(buf, off) {
  const n = buf.readUInt16BE(off + 4);
  const t = {};
  for (let i = 0; i < n; i++) {
    const r = off + 12 + i * 16;
    t[buf.toString('latin1', r, r + 4)] = { off: buf.readUInt32BE(r + 8), len: buf.readUInt32BE(r + 12) };
  }
  return t;
}

function readNames(buf, t) {
  const out = [];
  if (!t.name) return out;
  const b = t.name.off;
  const count = buf.readUInt16BE(b + 2);
  const strOff = b + buf.readUInt16BE(b + 4);
  for (let i = 0; i < count; i++) {
    const r = b + 6 + i * 12;
    const platform = buf.readUInt16BE(r), encoding = buf.readUInt16BE(r + 2), lang = buf.readUInt16BE(r + 4);
    const nameId = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), o = strOff + buf.readUInt16BE(r + 10);
    if (![1, 2, 4].includes(nameId)) continue;
    let s = null;
    if (platform === 3 || platform === 0) {
      const u = Buffer.alloc(len);
      for (let k = 0; k + 1 < len; k += 2) { u[k] = buf[o + k + 1]; u[k + 1] = buf[o + k]; }
      s = u.toString('utf16le');
    } else if (platform === 1 && encoding === 0) {
      s = buf.toString('latin1', o, o + len);
    }
    if (s && s.trim()) out.push({ nameId, lang, s: s.replace(/\0/g, '').trim() });
  }
  return out;
}

function readCmap(buf, t) {
  const b = t.cmap.off;
  const n = buf.readUInt16BE(b + 2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const r = b + 4 + i * 8;
    subs.push({ platform: buf.readUInt16BE(r), encoding: buf.readUInt16BE(r + 2), off: b + buf.readUInt32BE(r + 4) });
  }
  const pick = (p, e) => subs.find((s) => s.platform === p && s.encoding === e);
  const sub = pick(3, 10) || pick(0, 4) || pick(0, 6) || pick(3, 1) || pick(0, 3) || pick(0, 1) || pick(0, 0) || pick(3, 0);
  if (!sub) return { symbol: !!pick(3, 0), map: new Map() };
  const map = new Map();
  const fmt = buf.readUInt16BE(sub.off);
  if (fmt === 4) {
    const segX2 = buf.readUInt16BE(sub.off + 6);
    const ends = sub.off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2);
      const delta = buf.readInt16BE(deltas + s * 2), roAt = ranges + s * 2, ro = buf.readUInt16BE(roAt);
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xFFFF;
        else {
          g = buf.readUInt16BE(roAt + ro + (c - start) * 2);
          if (g !== 0) g = (g + delta) & 0xFFFF;
        }
        if (g !== 0) map.set(c, g);
      }
    }
  } else if (fmt === 12) {
    const groups = buf.readUInt32BE(sub.off + 12);
    for (let i = 0; i < groups; i++) {
      const r = sub.off + 16 + i * 12;
      const s = buf.readUInt32BE(r), e = buf.readUInt32BE(r + 4), g0 = buf.readUInt32BE(r + 8);
      for (let c = s; c <= e; c++) if (g0 + (c - s) !== 0) map.set(c, g0 + (c - s));
    }
  }
  const symbol = sub.platform === 3 && sub.encoding === 0;
  if (symbol) {
    // Windows symbol charset maps byte U+00xx to cmap U+F0xx (e.g. Wingdings '.').
    // This is a font-specific charset mapping, never Unicode punctuation substitution.
    for (const [cp, glyph] of [...map]) {
      if (cp >= 0xF000 && cp <= 0xF0FF && !map.has(cp & 0xFF)) map.set(cp & 0xFF, glyph);
    }
  }
  return { symbol, map };
}

function readFace(buf, off, file, index) {
  const t = tables(buf, off);
  if (!t.head || !t.hhea || !t.hmtx || !t.cmap) return null;
  const upm = buf.readUInt16BE(t.head.off + 18);
  const nMetrics = buf.readUInt16BE(t.hhea.off + 34);
  const advance = (g) => buf.readUInt16BE(t.hmtx.off + Math.min(g, nMetrics - 1) * 4);
  const os2 = t['OS/2'];
  const weight = os2 ? buf.readUInt16BE(os2.off + 4) : 400;
  const fsSel = os2 && os2.len >= 64 ? buf.readUInt16BE(os2.off + 62) : 0;
  const names = readNames(buf, t);
  const { symbol, map } = readCmap(buf, t);
  const sub = names.filter((n) => n.nameId === 2).map((n) => n.s.toLowerCase());
  const italic = !!(fsSel & 1) || sub.some((s) => /italic|oblique/.test(s));
  const bold = !!(fsSel & 0x20) || sub.some((s) => /^bold|bold$/.test(s));
  return { file, index, upm, weight, italic, bold, symbol, names, map, advance };
}

function readFontFile(file) {
  const buf = fs.readFileSync(file);
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const n = buf.readUInt32BE(8);
    return Array.from({ length: n }, (_, i) => readFace(buf, buf.readUInt32BE(12 + i * 4), file, i)).filter(Boolean);
  }
  if (tag === '\0\x01\0\0' || tag === 'OTTO' || tag === 'true') return [readFace(buf, 0, file, 0)].filter(Boolean);
  return [];
}

const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

// ── 글꼴 모으기 ────────────────────────────────────────────────────
const faces = [];
const seenFiles = new Set();
for (const dir of fontDirs()) {
  for (const file of walk(dir)) {
    const key = path.basename(file).toLowerCase();
    if (seenFiles.has(file.toLowerCase())) continue;
    seenFiles.add(file.toLowerCase());
    let list;
    try { list = readFontFile(file); } catch (e) { console.warn(`[gen-font-metrics] 건너뜀 ${key}: ${e.message}`); continue; }
    for (const f of list) {
      if (!f.map.size) continue;
      let hangul = 0;
      for (let c = 0xAC00; c <= 0xD7A3; c++) if (f.map.has(c)) hangul++;
      const fam = f.names.filter((n) => n.nameId === 1).map((n) => norm(n.s));
      const common = fam.some((n) => COMMON_LATIN.has(n));
      if (!all && hangul < 2000 && !common) continue;
      faces.push({ ...f, hangul });
    }
  }
}

// 가족 이름(nameID 1)은 그 가족의 '보통' 글꼴에 — 한/글은 진하게·기울임 속성에서도 보통 글꼴의 폭으로 전진한다
// (2026-10-27 한글 보정 실측: 맑은 고딕 진하게 = 보통 글꼴 hmtx). 전체 이름(nameID 4)은 그 파일 자신에.
// [hwpx-cowork] 전체 face 이름은 진하게·기울임 파일도 자기 cmap/hmtx를 보존한다.
const nameMap = new Map(); // norm → { face, rank }
const rank = (f) => (f.italic ? 2 : 0) + (f.bold ? 1 : 0) + Math.abs(f.weight - 400) / 1000;
for (const f of faces) {
  for (const n of f.names) {
    if (n.nameId !== 1) continue;
    const k = norm(n.s);
    const cur = nameMap.get(k);
    if (!cur || rank(f) < cur.rank || (rank(f) === cur.rank && f.hangul > cur.face.hangul)) nameMap.set(k, { face: f, rank: rank(f), display: n.s });
  }
}
for (const f of faces) {
  for (const n of f.names) {
    if (n.nameId !== 4) continue;
    const k = norm(n.s);
    if (!nameMap.has(k)) nameMap.set(k, { face: f, rank: -1, display: n.s });
  }
}
const used = [...new Set([...nameMap.values()].map(v => v.face))];
used.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
const faceIndex = new Map(used.map((f, i) => [f, i]));

// 한국어 문서에 나오는 블록만 싣는다(라틴·그리스·키릴·문장부호·기호·도형·한글·한자·전각).
const BLOCKS = [[0x0020, 0x024F], [0x0370, 0x03FF], [0x0400, 0x045F], [0x1100, 0x11FF], [0x2000, 0x27BF],
  [0x2E80, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA960, 0xA97F], [0xAC00, 0xD7FF], [0xF900, 0xFAFF], [0xFE30, 0xFE4F], [0xFF00, 0xFFEF]];
const inBlocks = (c) => BLOCKS.some(([a, b]) => c >= a && c <= b);

// 같은 폭이 이어지는 코드 구간으로 줄인다. 한자 블록은 빠진 글자를 건너 이어 붙인다(KS X 1001 한자처럼
// 띄엄띄엄 든 블록이 구간 수천 개로 쪼개지지 않게 — 빠진 한자는 드물고 같은 폭일 가능성이 크다).
const isHanja = (c) => (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF);
function runs(f) {
  const cps = [...f.map.keys()].filter((c) => inBlocks(c) && !(c >= 0xAC00 && c <= 0xD7A3)).sort((a, b) => a - b);
  const out = [];
  for (const c of cps) {
    const w = f.advance(f.map.get(c));
    const last = out[out.length - 1];
    const joinable = last && last[2] === w && (last[1] === c - 1 || (isHanja(c) && isHanja(last[1]) && c - last[1] < 4096));
    if (joinable && c - last[0] < 65536) last[1] = c;
    else out.push([c, c, w]);
  }
  return out;
}
// 한글 음절 11172자: 폭이 하나뿐이면 [폭], 아니면 음절마다(빠진 음절 0). 2350자만 든 글꼴도 고르면 [폭].
function hangul(f) {
  const ws = new Set();
  const all = [];
  for (let c = 0xAC00; c <= 0xD7A3; c++) {
    const g = f.map.get(c);
    const w = g ? f.advance(g) : 0;
    all.push(w);
    if (w) ws.add(w);
  }
  const zero = { cho: Array(19).fill(0), jung: Array(21).fill(0), jong: Array(28).fill(0), nj: 1, nk: 1 };
  if (ws.size === 0) return { ...zero, widths: [] };
  if (ws.size === 1) return { ...zero, widths: [...ws] };
  // 초·중·종성별로 같은 폭 단면을 한 묶음으로 — 폭 = widths[(초묶음 × 중묶음수 + 중묶음) × 종묶음수 + 종묶음] (정확)
  const at = (a, b, c) => all[a * 588 + b * 28 + c];
  const classes = (n, slice) => {
    const seen = new Map();
    return Array.from({ length: n }, (_, i) => {
      const k = slice(i).join(',');
      if (!seen.has(k)) seen.set(k, seen.size);
      return seen.get(k);
    });
  };
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const cho = classes(19, (a) => range(21).flatMap((b) => range(28).map((c) => at(a, b, c))));
  const jung = classes(21, (b) => range(19).flatMap((a) => range(28).map((c) => at(a, b, c))));
  const jong = classes(28, (c) => range(19).flatMap((a) => range(21).map((b) => at(a, b, c))));
  const nc = Math.max(...cho) + 1, nj = Math.max(...jung) + 1, nk = Math.max(...jong) + 1;
  const widths = Array(nc * nj * nk).fill(0);
  for (let a = 0; a < 19; a++) for (let b = 0; b < 21; b++) for (let c = 0; c < 28; c++) widths[(cho[a] * nj + jung[b]) * nk + jong[c]] = at(a, b, c);
  return { cho, jung, jong, nj, nk, widths };
}

let rs = '';
rs += '//! [hwpx-cowork] 설치 글꼴 폭 표 — `scripts/gen-font-metrics.mjs` 가 이 PC 의 글꼴 파일(hmtx·cmap)을 읽어 만든다.\n';
rs += '//! 손으로 고치지 않는다. 글꼴을 새로 설치·삭제했으면 `node scripts/gen-font-metrics.mjs` 로 다시 만든다.\n';
rs += '//! 쓰는 곳: `local_font_width.rs`(한/글 4 HWPUNIT 격자 셈법).\n';
rs += `//! 만든 때: ${new Date().toISOString().slice(0, 10)} · 글꼴 ${used.length}개 · 이름 ${nameMap.size}개\n\n`;
rs += '/// 글꼴 파일 하나(TTC 는 그 안의 한 글꼴).\n';
rs += 'pub(crate) struct LocalFontFace {\n    /// 파일 이름(진단용)\n    pub file: &\'static str,\n    /// unitsPerEm\n    pub upm: u16,\n';
rs += '    /// 한글 음절(U+AC00–D7A3) 전진폭\n    pub hangul: LocalHangul,\n';
rs += '    /// 그 밖의 글자 (첫 코드, 개수-1, 전진폭) — 코드 오름차순, 겹치지 않음\n    pub runs: &\'static [(u32, u16, u16)],\n}\n\n';
rs += '/// 한글 음절 폭 = `widths[(cho[초] × nj + jung[중]) × nk + jong[종]]` (0 = 빠진 음절, `widths` 가 비면 음절 없음).\n';
rs += 'pub(crate) struct LocalHangul {\n    pub cho: [u8; 19],\n    pub jung: [u8; 21],\n    pub jong: [u8; 28],\n    pub nj: u8,\n    pub nk: u8,\n    pub widths: &\'static [u16],\n}\n\n';
let bytes = 0;
const hangulLit = [];
used.forEach((f, i) => {
  const r = runs(f);
  const h = hangul(f);
  bytes += r.length * 8 + h.widths.length * 2 + 68;
  rs += `static RUNS_${i}: [(u32, u16, u16); ${r.length}] = [`;
  rs += r.map(([a, b, w]) => `(${a},${b - a},${w})`).join(',');
  rs += '];\n';
  rs += `static HANGUL_${i}: [u16; ${h.widths.length}] = [${h.widths.join(',')}];\n`;
  hangulLit.push(`LocalHangul { cho: [${h.cho}], jung: [${h.jung}], jong: [${h.jong}], nj: ${h.nj}, nk: ${h.nk}, widths: &HANGUL_${i} }`);
});
rs += `\npub(crate) static LOCAL_FONT_FACES: [LocalFontFace; ${used.length}] = [\n`;
used.forEach((f, i) => {
  const label = path.basename(f.file) + (f.index ? `#${f.index}` : '');
  rs += `    LocalFontFace { file: ${JSON.stringify(label)}, upm: ${f.upm}, hangul: ${hangulLit[i]}, runs: &RUNS_${i} },\n`;
});
console.log(`[gen-font-metrics] 표 크기 약 ${(bytes / 1024).toFixed(0)} KB`);
rs += '];\n\n';
const names = [...nameMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
rs += '/// (정규화 이름 — 공백 없앰·소문자, 글꼴 번호). 이름 오름차순(이진 탐색).\n';
rs += `pub(crate) static LOCAL_FONT_NAMES: [(&str, u16); ${names.length}] = [\n`;
for (const [k, v] of names) rs += `    (${JSON.stringify(k)}, ${faceIndex.get(v.face)}),\n`;
rs += '];\n';

fs.writeFileSync(OUT_RS, rs.replace(/\r?\n/g, '\r\n'));
fs.writeFileSync(OUT_JSON, JSON.stringify({
  generatedAt: new Date().toISOString(),
  dirs: fontDirs(),
  faces: used.map((f) => ({ file: f.file, index: f.index, upm: f.upm, hangul: f.hangul,
    names: names.filter(([, v]) => v.face === f).map(([, v]) => v.display) })),
}, null, 1) + '\n');
console.log(`[gen-font-metrics] 글꼴 ${used.length}개 · 이름 ${names.length}개 → ${path.relative(root, OUT_RS)} (${(rs.length / 1024).toFixed(0)} KB)`);
const wordMetrics = spawnSync(process.execPath, [
  path.join(root, 'vendor', 'rhwp', 'scripts', 'gen-word-font-metrics.mjs'),
], { cwd: root, stdio: 'inherit' });
if (wordMetrics.status !== 0) throw new Error('Word line metrics regeneration failed');
// [hwpx-cowork] FontDB styles refer to this exact face inventory. Keep the
// generated index/style metadata synchronized when fonts are installed/removed.
if (fs.existsSync(path.join(root, 'FontDB', 'fontinfo.dat'))) {
  const r = spawnSync('python', ['-X', 'utf8', path.join(root, 'scripts', 'gen-hancom-fontdb.py')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('FontDB regeneration failed after font metrics');
}
