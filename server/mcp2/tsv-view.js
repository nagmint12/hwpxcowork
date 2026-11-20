// MCP v3 본문. 표의 읽기 표현만 만든다. 편집 주소·서식은 원래 HWPX에서 조회한다.
function tsvField(value) {
  return /[\t\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

export function tsvTableLines(t, parentCell = null) {
  const caption = t.caption?.text || '';
  const title = [...caption.replace(/\s+/g, ' ').trim()];
  const longCaption = title.length > 80;
  const parent = parentCell ? ` · 상위 ${parentCell.table} r${parentCell.row}c${parentCell.col}` : '';
  const label = `▦ ${t.key} 표 ${t.rows}×${t.cols}${title.length && !longCaption ? ` 「${title.join('')}」` : ''}${parent}`;
  const anchors = new Map();
  const merges = [];
  for (const c of t.cells) {
    if (!Number.isInteger(c.row) || !Number.isInteger(c.col) || c.row < 0 || c.row >= t.rows || c.col < 0 || c.col >= t.cols) continue;
    if (!anchors.has(c.row)) anchors.set(c.row, []);
    anchors.get(c.row).push(c);
    if (c.rowSpan > 1 || c.colSpan > 1) {
      merges.push(`r${c.row}c${c.col}:r${c.row + c.rowSpan - 1}c${c.col + c.colSpan - 1}`);
    }
  }
  const out = [];
  if (longCaption) out.push({ text: `${label} · 캡션 ${caption}`, table: t.key, kind: 'caption' });
  // 병합과 빈 칸은 TSV에서는 모두 빈 필드다. 병합의 양 끝만 별도 줄에 둔다.
  for (let i = 0; i < merges.length; i += 16) {
    out.push({ text: `${label} · 병합 ${merges.slice(i, i + 16).join(', ')}`, table: t.key, kind: 'merges' });
  }
  for (let row = 0; row < t.rows; row++) {
    const cells = anchors.get(row) || [];
    const fields = Array(t.cols).fill('');
    for (const c of cells) fields[c.col] = tsvField(c.text);
    out.push({ text: fields.join('\t'), table: t.key, kind: 'tsv', label, row, cells });
  }
  if (!out.length) out.push({ text: `${label} · TSV (빈 표)`, table: t.key });
  return out;
}

/** 검색은 TSV의 인용 부호를 씌우기 전 셀 원문으로 한다. 떨어진 적중 행은 각자 원래 행 번호를 받는다. */
export function findTsvLines(lines, find) {
  const needle = find.toLowerCase();
  const out = [];
  let lastTable = null;
  for (const line of lines) {
    if (line.kind !== 'tsv') {
      if (line.text.toLowerCase().includes(needle)) out.push(line);
      continue;
    }
    const matches = line.cells.some(cell => cell.text.toLowerCase().includes(needle));
    if (!matches && lastTable !== line.table && line.label.toLowerCase().includes(needle)) out.push({ text: line.label, table: line.table });
    if (matches) out.push(line);
    lastTable = line.table;
  }
  return out;
}

/** 연속한 행은 한 TSV 블록. 보통 행 경계에서만 쪽을 나눈다. 한 행 자체가 한도를 넘으면
 * 원래 직렬화한 행의 UTF-16 오프셋을 남겨, 조각을 그대로 이어 붙이면 인용 부호와 탭까지 되살아난다. */
export function pageTsvLines(lines, { from = 0, offset = 0, maxChars = 20000 } = {}) {
  const out = [];
  let used = 0;
  let i = from;
  let group = null;
  const append = value => { if (out.length) used++; used += value.length; out.push(value); };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const row = line.kind === 'tsv';
    const continues = row && group?.table === line.table && group.last + 1 === line.row;
    const startRow = continues ? group.first : line.row;
    const header = row ? `${line.label} · TSV r${startRow}..r${line.row}` : '';
    const headerCost = continues ? header.length - out[group.index].length : row ? header.length + 1 : 0;
    const size = (out.length ? 1 : 0) + headerCost + line.text.length;
    if (!offset && used + size <= maxChars) {
      if (continues) {
        used += headerCost;
        out[group.index] = header;
        group.last = line.row;
      } else {
        group = row ? { table: line.table, first: line.row, last: line.row, index: out.length } : null;
        if (row) append(header);
      }
      append(line.text);
      continue;
    }
    if (out.length) break;
    // 이 항목만으로도 한 쪽을 넘었다. 조각은 항상 단독으로 내고 TSV 구분자를 새로 끼우지 않는다.
    const prefix = row ? `${header} · 행 조각` : `${line.ref ? `[${line.ref}] ` : ''}본문 조각`;
    const total = line.text.length;
    const digits = String(total).length;
    const room = Math.max(2, maxChars - prefix.length - 5 - String(offset).length - 2 * digits);
    let end = Math.min(total, offset + room);
    if (end < total && /[\uD800-\uDBFF]/.test(line.text[end - 1])) end--;
    append(`${prefix} ${offset}..${end}/${total}`);
    append(line.text.slice(offset, end));
    offset = end < total ? end : 0;
    if (!offset) i++;
    break;
  }
  return { text: out.join('\n'), from, to: i, offset, total: lines.length, done: i >= lines.length };
}
