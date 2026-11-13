// Also executed against the real WASM in native_paste_format.test.mjs.
export function pasteWithParagraphFormat(doc, Document, sec, para, path, offset, bytes) {
  // The core retains complete source styles/sections in a truly empty document.
  // Its decision also protects private clipboard ids and nonempty master pages.
  if (typeof doc.canAdoptDocumentFragment === 'function' && doc.canAdoptDocumentFragment(sec, para, path, offset)) {
    return doc.pasteDocumentFragment(sec, para, path, offset, bytes);
  }
  const cells = JSON.parse(path);
  const length = cells.length ? doc.getCellParagraphLengthByPath(sec, para, path) : doc.getParagraphLength(sec, para);
  const codes = JSON.parse(doc.getCodeControls(JSON.stringify({ sec, para, cellPath: cells })));
  if (offset === 0 && length === 0 && codes.length === 0) {
    // An empty destination has no paragraph formatting to retain. Import the
    // source's first paragraph before insertion, including its direct overrides.
    // Existing text/codes retain their destination paragraph formatting.
    const source = new Document(bytes);
    try {
      const brush = source.exportFormatBrush(0, 0, '[]', 0);
      const info = JSON.parse(source.getFormatBrushInfo(0, 0, '[]', 0));
      const targets = JSON.stringify([{ sec, para, path: cells.map(c => Array.isArray(c) ? c : [c.controlIndex, c.cellIndex, c.cellParaIndex]), start: 0, end: 0 }]);
      if (info.hasParagraphStyle) doc.applyFormatBrush(targets, brush, 'paragraphStyle');
      doc.applyFormatBrush(targets, brush, 'paragraph');
    } finally { source.free(); }
  }
  return doc.pasteDocumentFragment(sec, para, path, offset, bytes);
}
