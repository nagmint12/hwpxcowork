import JSZip from 'jszip';

const isZip = (data) => data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
const utf16be = (text) => Buffer.from(text, 'utf16le').swap16();

const advancedTutorialDoc = 'tutorial/AI 활용 심화 — 연습 보고서.hwpx';
// The recorded @para anchors include the first two characters of the department name.
const neutralTutorialName = (text) => text.replaceAll('대학혁신센터', '대학정책팀');

// Keep the exercise's bibliography and the recorded AI comments in sync.
export function publicOnboardingText(relative, text) {
  if (relative === 'tutorial/ai-advanced-answers.json') return neutralTutorialName(text);
  if (relative === 'docs/manuals/manifest.json') return text.replaceAll('대학혁신센터 표준서식', '표준서식');
  return text;
}

// Scan extracted bytes too: an archive's compressed bytes cannot establish that its contents are safe.
export async function inspectPublicBytes(data, { patterns = [], values = [], logoHashes = new Set(), hash, scrubAuthors = false } = {}, location = '', depth = 0) {
  const findings = [];
  const add = (category) => findings.push({ category, file: location });
  if (depth > 12) { add('archive-depth'); return { data, findings, changed: false }; }
  let changed = false;
  if (isZip(data)) {
    let zip;
    try { zip = await JSZip.loadAsync(data); } catch { add('archive-invalid'); return { data, findings, changed }; }
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    const bodies = new Map();
    for (const entry of entries) {
      for (const pattern of patterns) if (new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(entry.name)) add('archive-entry-name');
      let raw = await entry.async('nodebuffer');
      if (scrubAuthors && entry.name === 'Contents/content.hpf') {
        const text = raw.toString('utf8');
        const next = text.replace(/(<(?:\w+:)?meta\b[^>]*\bname=["'](?:creator|lastsaveby)["'][^>]*>)[^<]*(<\/(?:\w+:)?meta>)/g, '$1hwpx-cowork$2');
        if (text !== next) { raw = Buffer.from(next); changed = true; }
      }
      if (location === advancedTutorialDoc && entry.name === 'Contents/section1.xml') {
        const text = raw.toString('utf8');
        const next = neutralTutorialName(text);
        if (text !== next) { raw = Buffer.from(next); changed = true; }
      }
      const result = await inspectPublicBytes(raw, { patterns, values, logoHashes, hash, scrubAuthors }, `${location}!${entry.name}`, depth + 1);
      bodies.set(entry.name, result.data); findings.push(...result.findings); changed ||= result.changed;
    }
    if (changed) {
      const next = new JSZip();
      next.comment = zip.comment;
      for (const entry of entries) next.file(entry.name, bodies.get(entry.name), {
        date: entry.date, comment: entry.comment, unixPermissions: entry.unixPermissions, dosPermissions: entry.dosPermissions,
        createFolders: false,
        compression: entry.name === 'mimetype' || entry._data?.compression?.magic === '\x00\x00' ? 'STORE' : 'DEFLATE',
      });
      data = await next.generateAsync({ type: 'nodebuffer', compressionOptions: { level: 6 } });
    }
    // ZIP comments and other uncompressed container metadata are covered by the byte checks below.
  }
  if (hash && logoHashes.has(hash(data))) add('institution-logo');
  for (const encoding of ['utf8', 'utf16le']) {
    const text = data.toString(encoding);
    for (const pattern of patterns) if (new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(text)) add('identifying-text');
  }
  for (const value of values) {
    if (!value) continue;
    if ([Buffer.from(value), Buffer.from(value, 'utf16le'), utf16be(value)].some((needle) => data.includes(needle))) add('private-value');
  }
  return { data, findings, changed };
}
