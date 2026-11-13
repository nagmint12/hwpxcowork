// 문서별 첨부함: data/docs/<id>/attachments/<aid><ext> 에 원본을, <aid>.text.txt 에 뽑은 글을 둔다.
// 사용자가 준 파일 이름은 표시용으로만 쓰고 경로에는 절대 쓰지 않는다(aid + 안전한 확장자).
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { removeFile } from './fs-safe.js';
import { skillText } from './skill-archive.js';

const KIND_BY_EXT = {
  '.skill': 'skill',
  '.xlsx': 'sheet', '.xlsm': 'sheet', '.csv': 'sheet', '.tsv': 'sheet',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.svg': 'text',   // SVG 는 글(원문)로 — 그림 제안(svg)의 원문·내려받기는 octet-stream
  '.docx': 'doc', '.pptx': 'doc', '.hwpx': 'doc',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
};
const MIME_BY_EXT = {
  '.skill': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.hwpx': 'application/vnd.hancom.hwpx', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

/** 확장자: 영문·숫자 1~8자만, 아니면 '' */
export function safeExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}
export function kindOf(ext) { return KIND_BY_EXT[ext] || 'other'; }
export function mimeOf(ext) { return MIME_BY_EXT[ext] || 'application/octet-stream'; }

/** 표시용 이름: 경로 조각·제어 문자 제거, 200자 */
export function displayName(name) {
  let s = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  if (!s || s === '.' || s === '..') s = 'file';
  return [...s].slice(0, 200).join('');
}

export class Attachments {
  constructor({ docsDir, cfg, docDir = null }) {
    this.docsDir = docsDir;
    this.docDir = docDir;
  }

  dir(docId) { return path.join(this.docDir ? this.docDir(docId) : path.join(this.docsDir, docId), 'attachments'); }
  filePath(docId, entry) { return path.join(this.dir(docId), path.basename(entry.file)); }
  textPath(docId, entry) { return path.join(this.dir(docId), `${path.basename(entry.aid)}.text.txt`); }

  /** 원본 저장 + 글 뽑기. 반환: meta.attachments 항목(by/at 은 호출자가 채움) */
  async save(docId, aid, name, bytes) {
    const ext = safeExt(name); const kind = kindOf(ext);
    const entry = { aid, name: displayName(name), size: bytes.length, mime: mimeOf(ext), kind, file: `${aid}${ext}`, text: null };
    fs.mkdirSync(this.dir(docId), { recursive: true });
    fs.writeFileSync(this.filePath(docId, entry), bytes);
    try {
      const r = await extractText(bytes, ext, { name: entry.name });
      if (r && r.text != null) {
        fs.writeFileSync(this.textPath(docId, entry), r.text, 'utf-8');
        entry.text = { chars: r.text.length, truncated: !!r.truncated };
        if (r.sheets) entry.text.sheets = r.sheets;
      }
      if (r && r.error) entry.error = r.error;
    } catch (e) { entry.error = `글을 뽑지 못했습니다: ${e.message}`; }
    return entry;
  }

  bytes(docId, entry) { return fs.readFileSync(this.filePath(docId, entry)); }

  /** 뽑아 둔 글(없으면 null). 호출자가 명시한 max만 적용한다. */
  readText(docId, entry, max) {
    if (!entry.text) return { text: null, truncated: false };
    let text;
    try { text = fs.readFileSync(this.textPath(docId, entry), 'utf-8'); } catch { return { text: null, truncated: false }; }
    const lim = max == null ? Infinity : Math.max(1, Number(max) || Infinity);
    const cut = text.length > lim;
    return { text: cut ? text.slice(0, lim) : text, truncated: cut || !!entry.text.truncated };
  }

  /** 과거에 잘린 캐시는 원본에서 복원한다. 조회 중 원본·캐시·메타데이터를 쓰지 않는다. */
  async fullText(docId, entry) {
    const cached = this.readText(docId, entry);
    if (cached.text != null && !cached.truncated) return { ...cached, ...(entry.text?.sheets ? { sheets: structuredClone(entry.text.sheets) } : {}) };
    try {
      const result = await extractText(this.bytes(docId, entry), safeExt(entry.file || entry.name), { maxChars: Infinity, name: entry.name });
      return { ...result, text: result?.text ?? null, truncated: !!result?.truncated };
    } catch (error) {
      return { text: null, truncated: false, error: `글을 뽑지 못했습니다: ${error.message}` };
    }
  }

  remove(docId, entry) {
    for (const f of [this.filePath(docId, entry), this.textPath(docId, entry)]) { try { removeFile(f); } catch { /* ignore */ } }
  }
}

// ───────── 글 뽑기 ─────────

/** 반환: { text, truncated, sheets? } | { text:null, error? } */
export async function extractText(bytes, ext, { maxChars = Infinity, name = '' } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let out;
  switch (ext) {
    case '.skill': out = await skillText(buf); break;
    case '.xlsx': case '.xlsm': out = await fromXlsx(buf); break;
    case '.csv': out = fromDelimited(decodeText(buf), ',', name); break;
    case '.tsv': out = fromDelimited(decodeText(buf), '\t', name); break;
    case '.txt': case '.md': case '.json': case '.svg': out = { text: decodeText(buf) }; break;
    case '.docx': out = await fromDocx(buf); break;
    case '.pptx': out = await fromPptx(buf); break;
    case '.hwpx': out = await fromHwpx(buf); break;
    case '.pdf': out = await fromPdf(buf); break;
    default: return { text: null };
  }
  if (!out || out.text == null) return out || { text: null };
  let text = out.text.replace(/\r\n?/g, '\n');
  let truncated = false;
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  return { ...out, text, truncated };
}

/** UTF-8(BOM 처리) → 깨지면 EUC-KR */
export function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* EUC-KR 재시도 */ }
  return new TextDecoder('euc-kr').decode(buf);
}

const pad2 = (n) => String(n).padStart(2, '0');
function ymd(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function num(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e10) / 1e10); }

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return ymd(v);
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if ('result' in v || 'formula' in v || 'sharedFormula' in v) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('');
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return String(v.error);
    return '';
  }
  return String(v);
}

const tsvCell = (s) => String(s).replace(/[\t\r\n]+/g, ' ');

function sheetBlock(name, grid) {
  // 끝의 빈 행·열은 뺀다
  let rows = grid.length; while (rows > 0 && !grid[rows - 1].some((c) => c !== '')) rows--;
  let cols = 0; for (let r = 0; r < rows; r++) { let c = grid[r].length; while (c > 0 && grid[r][c - 1] === '') c--; cols = Math.max(cols, c); }
  const lines = [`## 시트: ${name} (${rows}×${cols})`];
  for (let r = 0; r < rows; r++) { const row = grid[r].slice(0, cols); let c = row.length; while (c > 0 && row[c - 1] === '') c--; lines.push(row.slice(0, c).map(tsvCell).join('\t')); }
  return { text: lines.join('\n'), info: { name, rows, cols } };
}

async function fromXlsx(buf) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const blocks = []; const sheets = [];
  for (const ws of wb.worksheets) {
    const grid = [];
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell, cn) => {
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) return; // 합친 셀은 첫 칸에만
        cells[cn - 1] = cellText(cell.value);
      });
      grid[rn - 1] = Array.from(cells, (x) => x ?? '');
    });
    const full = Array.from(grid, (r) => r || []);
    const b = sheetBlock(ws.name, full); blocks.push(b.text); sheets.push(b.info);
  }
  return { text: blocks.join('\n\n'), sheets };
}

/** CSV/TSV → 시트 하나 */
function fromDelimited(text, delim, name) {
  const rows = parseDelimited(text, delim);
  const sheetName = String(name || '').replace(/\.[^.]+$/, '') || (delim === ',' ? 'CSV' : 'TSV');
  const b = sheetBlock(sheetName, rows);
  return { text: b.text, sheets: [b.info] };
}

export function parseDelimited(text, delim = ',') {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { q = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]));
}

/** docx: 문단 + 표(탭 구분) */
async function fromDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('word/document.xml'); if (!f) return { text: null, error: 'word/document.xml 이 없습니다' };
  const xml = await f.async('string');
  const out = []; const tables = []; let para = null; let inRun = 0; let inT = false;
  const cellOf = () => { const t = tables[tables.length - 1]; return t && t.cell; };
  const re = /<(\/?)(w:p|w:r|w:t|w:tab|w:br|w:cr|w:tbl|w:tr|w:tc)(?=[\s/>])[^>]*?(\/?)>|<[^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, close, name, self, txt] = m;
    if (txt != null) { if (inT && para !== null) para += unescapeXml(txt); continue; }
    if (!name) continue;
    const opening = !close; const selfClose = !!self;
    switch (name) {
      case 'w:p':
        if (opening && !selfClose) para = '';
        else if (!opening || selfClose) {
          const p = selfClose ? '' : (para ?? '');
          const cell = cellOf();
          if (cell) cell.push(p); else out.push(p);
          para = null;
        }
        break;
      case 'w:r': if (opening && !selfClose) inRun++; else if (!opening) inRun = Math.max(0, inRun - 1); break;
      case 'w:t': if (opening && !selfClose) inT = true; else if (!opening) inT = false; break;
      case 'w:tab': if (inRun && para !== null) para += cellOf() ? ' ' : '\t'; break;
      case 'w:br': case 'w:cr': if (inRun && para !== null) para += cellOf() ? ' ' : '\n'; break;
      case 'w:tbl':
        if (opening && !selfClose) tables.push({ rows: [], row: null, cell: null });
        else if (!opening) {
          const t = tables.pop();
          const lines = t.rows.map((r) => r.map(tsvCell).join('\t'));
          const parent = cellOf();
          if (parent) parent.push(lines.join(' / ')); else { out.push(...lines); }
        }
        break;
      case 'w:tr': { const t = tables[tables.length - 1]; if (!t) break; if (opening && !selfClose) t.row = []; else if (!opening && t.row) { t.rows.push(t.row); t.row = null; } break; }
      case 'w:tc': { const t = tables[tables.length - 1]; if (!t) break; if (opening && !selfClose) t.cell = []; else if (!opening && t.cell) { (t.row || (t.row = [])).push(t.cell.filter((x) => x !== '').join(' ')); t.cell = null; } break; }
      default: break;
    }
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** pptx: 슬라이드별 글 */
async function fromPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const blocks = [];
  for (const n of names) {
    const xml = await zip.file(n).async('string');
    const paras = [];
    for (const pm of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      let s = '';
      for (const tm of pm[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)) s += tm[1] != null ? unescapeXml(tm[1]) : '\n';
      if (s.trim()) paras.push(s);
    }
    blocks.push(`## 슬라이드 ${/(\d+)\.xml$/.exec(n)[1]}\n${paras.join('\n')}`);
  }
  return { text: blocks.join('\n\n') };
}

/** hwpx: 엔진으로 문단 글(표는 탭 구분 행) */
async function fromHwpx(buf) {
  const { HwpxDoc } = await import('../engine/doc.js');
  const doc = await HwpxDoc.load(buf);
  const paras = doc.paragraphs({ view: 'final', nested: true });
  let tables = [];
  try { tables = typeof doc.tables === 'function' ? doc.tables() : []; } catch { tables = []; }
  const byRef = new Map();
  for (const t of tables) { if (!byRef.has(t.ref)) byRef.set(t.ref, []); byRef.get(t.ref).push(t); }
  const inTable = new Set(tables.flatMap((t) => [...(t.cells || []).flatMap((c) => c.refs || []), ...(t.caption ? [t.caption.ref] : [])]));
  const lines = [];
  for (const p of paras) {
    if (inTable.has(p.ref)) continue;
    if (p.where === '본문' || !tables.length) { if (p.text.trim() || p.where === '본문') lines.push(p.text); }
    for (const t of byRef.get(p.ref) || []) {
      if (t.caption?.text) lines.push(t.caption.text);
      const grid = Array.from({ length: t.rows || 0 }, () => Array(t.cols || 0).fill(''));
      for (const c of t.cells || []) if (grid[c.row] && c.col < grid[c.row].length) grid[c.row][c.col] = c.text || '';
      for (const r of grid) lines.push(r.map(tsvCell).join('\t'));
    }
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** pdf: unpdf(pdf.js) 로 쪽별 글. 글이 없으면(스캔본) text=null */
async function fromPdf(buf) {
  let mod;
  try { mod = await import('unpdf'); } catch { return { text: null, error: 'PDF 글 뽑기 모듈(unpdf)이 없습니다' }; }
  try {
    const pdf = await mod.getDocumentProxy(new Uint8Array(buf));
    const r = await mod.extractText(pdf, { mergePages: false });
    const pages = Array.isArray(r.text) ? r.text : [String(r.text || '')];
    if (!pages.some((t) => t.trim())) return { text: null, error: 'PDF 에서 글을 찾지 못했습니다(스캔본일 수 있음)' };
    return { text: pages.map((t, i) => `## 쪽 ${i + 1}\n${t.trim()}`).join('\n\n') };
  } catch (e) { return { text: null, error: `PDF 를 읽지 못했습니다: ${e.message}` }; }
}
