// [hwpx-cowork] 서버에서 편집기 엔진(rhwp WASM, vendor/rhwp/pkg)으로 차례 새로 고침·줄 수 재기(2026-10-30).
// 차례 항목의 쪽 번호는 조판(쪽 나누기)이 있어야 정해지므로 서버 엔진(engine/ — 글·XML)만으로는 못 한다. 편집기가 쓰는 같은 엔진을
// Node 에서 읽어(initSync — 한 번) 문서 HWPX 를 열고 차례 필드를 고친 뒤 HWPX 로 내보낸다. 모두 동기(제안 적용 _applyCore 안에서 쓴다).
// 엔진이 없으면(빌드 전) 오류 NOT_READY. 글자 폭은 엔진 안 글꼴 폭 표로 잰다(그리기용 measureTextWidth 는 쓰지 않으니 스텁).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { containerFromBytesSync } from '../engine/toc.js';
import { writeZipSync } from '../engine/zip-sync.js';
import { scan, attr, escapeAttr } from '../engine/xmlscan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(root, process.env.HWPX_COWORK_ENGINE_PKG || path.join('vendor', 'rhwp', 'pkg'));
let mod = null; let loadError = null;
try { mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href); } catch (e) { loadError = e; }

class TocEngineError extends Error { constructor(code, message) { super(message); this.code = code; } }

function engine() {
  if (!mod || typeof mod.HwpDocument !== 'function') throw new TocEngineError('NOT_READY', `편집기 엔진(vendor/rhwp/pkg)을 읽지 못했습니다 — npm run build:engine${loadError ? ` (${loadError.message})` : ''}`);
  const ready = (globalThis.__rhwpEngineReady ??= new Set());
  if (!ready.has(pkgDir)) {
    globalThis.measureTextWidth ??= (font, text) => String(text).length * 10;
    mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });
    ready.add(pkgDir);
  }
  return mod;
}

/** 엔진에 차례 API 가 있는가(빌드가 낡으면 없다) */
export function tocEngineReady() {
  try { return typeof engine().HwpDocument.prototype.updateTableOfContents === 'function'; } catch { return false; }
}

function open(bytes) {
  const m = engine();
  const d = new m.HwpDocument(new Uint8Array(bytes));
  if (typeof d.updateTableOfContents !== 'function') { d.free?.(); throw new TocEngineError('NOT_READY', '편집기 엔진에 차례 새로 고침이 없습니다 — npm run build:engine'); }
  return d;
}

const parse = (s, what) => { try { return JSON.parse(s); } catch { throw new TocEngineError('ENGINE', `편집기 엔진 응답을 읽지 못했습니다(${what})`); } };

// 표준서식의 붙여 쓴 차례 이름도 엔진이 알아보게 한다. 임시 입력/출력에서 이름만 왕복하고,
// 원본 ID·스타일 정의는 바꾸지 않는다. 기존 공백 이름/영문 TOC 스타일이 있으면 중복 별칭을 만들지 않는다.
function tocStyleAliases(bytes) {
  const container = containerFromBytesSync(bytes); const decoder = new TextDecoder(); const encoder = new TextEncoder();
  const header = decoder.decode(container.files.get('Contents/header.xml'));
  const styles = scan(header).filter(t => t.name === 'hh:style' && t.type !== 'close').map(t => ({ t, name: attr(header, t, 'name'), engName: attr(header, t, 'engName') }));
  const aliases = [];
  for (const s of styles) {
    const level = /^차례(\d+)$/.exec(s.name || '');
    const canonical = s.name === '차례제목' ? '차례 제목' : level ? `차례 ${level[1]}` : null;
    if (!canonical || styles.some(q => q !== s && (q.name === canonical || (level && q.engName === `TOC ${level[1]}`)))) continue;
    aliases.push({ name: s.name, canonical, t: s.t });
  }
  if (!aliases.length) return { bytes, restore: out => out, count: 0 };
  let changed = header;
  for (const a of [...aliases].sort((a, b) => b.t.start - a.t.start)) {
    const tag = header.slice(a.t.start, a.t.end).replace(/\bname="[^"]*"/, `name="${escapeAttr(a.canonical)}"`);
    changed = changed.slice(0, a.t.start) + tag + changed.slice(a.t.end);
  }
  container.files.set('Contents/header.xml', encoder.encode(changed));
  return { bytes: writeZipSync(container), count: aliases.length, restore(out) {
    const result = containerFromBytesSync(out); let xml = decoder.decode(result.files.get('Contents/header.xml'));
    const edits = scan(xml).filter(t => t.name === 'hh:style' && t.type !== 'close').map(t => ({ t, alias: aliases.find(a => attr(xml, t, 'name') === a.canonical) })).filter(e => e.alias);
    for (const { t, alias } of edits.sort((a, b) => b.t.start - a.t.start)) xml = xml.slice(0, t.start) + xml.slice(t.start, t.end).replace(/\bname="[^"]*"/, `name="${escapeAttr(alias.name)}"`) + xml.slice(t.end);
    result.files.set('Contents/header.xml', encoder.encode(xml));
    return Buffer.from(writeZipSync(result));
  } };
}

/**
 * 차례 새로 고침: 문서(HWPX 바이트)의 (sec, para — 물리 문단 번호, 차례 안 아무 문단) 차례를 필드 설정대로 다시 만든다
 * → { bytes(새로 고친 HWPX), sec, start, end(새 차례 물리 문단 번호), entries, options(필드 설정) }
 */
export function refreshTocInEngine(bytes, { sec, para }) {
  const aliases = tocStyleAliases(bytes);
  const d = open(aliases.bytes);
  try {
    const at = parse(d.getTableOfContentsAt(JSON.stringify({ sec, para })), 'getTableOfContentsAt');
    if (!at.found) throw new TocEngineError('NO_TOC', '그 자리에 차례 필드가 없습니다');
    let r;
    try { r = parse(d.updateTableOfContents(JSON.stringify({ sec, para: at.start })), 'updateTableOfContents'); }
    catch (e) { if (e instanceof TocEngineError) throw e; throw new TocEngineError('ENGINE', `차례를 새로 고치지 못했습니다: ${e?.message || e}`); }
    if (!r.ok) throw new TocEngineError('ENGINE', '차례를 새로 고치지 못했습니다');
    return { bytes: aliases.restore(Buffer.from(d.exportHwpx())), sec: r.sec, start: r.start, end: r.end, entries: r.entries ?? null, options: at.options || null, styleAliases: aliases.count };
  } finally { d.free?.(); }
}

/** 빈 문단을 차례 필드로 바꾼 사본. 호출자는 차례 영역만 원본에 import한다. */
export function createTocInEngine(bytes, { sec, para, collectStyles = [] }) {
  const aliases = tocStyleAliases(bytes);
  const d = open(aliases.bytes);
  try {
    if (typeof d.makeTableOfContents !== 'function') throw new TocEngineError('NOT_READY', '편집기 엔진에 차례 만들기가 없습니다');
    const options = { field: true, title: true, outline: true, table: true, picture: true, equation: false,
      ...(collectStyles.length ? { useStyles: true, styles: collectStyles } : {}) };
    const r = parse(d.makeTableOfContents(JSON.stringify({ sec, para, options })), 'makeTableOfContents');
    if (!r.ok) throw new TocEngineError('ENGINE', '차례를 만들지 못했습니다');
    const at = parse(d.getTableOfContentsAt(JSON.stringify({ sec, para })), 'getTableOfContentsAt');
    if (!at.found) throw new TocEngineError('NO_TOC', '만든 차례 필드를 찾지 못했습니다');
    return { bytes: aliases.restore(Buffer.from(d.exportHwpx())), sec, start: at.start, end: at.end, entries: r.entries ?? null, options };
  } finally { d.free?.(); }
}

/** 구역 sec 의 물리 문단 [from, to] 마다 편집기 엔진이 나눈 줄 수 → number[] */
export function lineCountsInEngine(bytes, sec, from, to) {
  const d = open(bytes);
  try {
    const out = [];
    for (let i = from; i <= to; i++) {
      // 검증 실패를 한 줄 성공으로 간주하면 oneLine 사후검증을 통과한 것처럼 보인다.
      let n;
      try { n = parse(d.getLineInfo(sec, i, 0), 'getLineInfo').lineCount; }
      catch (e) { throw new TocEngineError('ENGINE', `차례 문단 ${i}의 줄 수를 확인하지 못했습니다: ${e?.message || e}`); }
      if (!Number.isSafeInteger(n) || n < 1) throw new TocEngineError('ENGINE', `차례 문단 ${i}의 줄 수 응답이 올바르지 않습니다`);
      out.push(n);
    }
    return out;
  } finally { d.free?.(); }
}

// [hwpx-cowork] 차트 작업도 같은 WASM 인스턴스를 쓴다(중복 initSync 는 살아 있는 문서를 무효화한다).
export { TocEngineError, engine as editorEngine };
