// 새 MCP 연결(server/mcp2.js — docs/MCP_REDESIGN_2026-11-16.md)의 읽기 보기: 글과 주소만 짧게 준다(서식은 물을 때 따로 — view=format).
//   · 본문 보기(text): 본문 문단 한 줄, 표는 줄마다 한 줄(칸 주소는 표 열쇠·줄·칸), 글상자가 많은 문단은 한 줄 요약(layout 보기로 안내)
//   · 배치 보기(layout): 떠 있는 글상자·괘선을 좌표로 줄·표로 묶은 것(engine/layout.js) — 요약(문단마다 한 줄)과 자세히
//   · 얼개(map)·제목(outline)
// 모두 문서(engine HwpxDoc)만 읽는 순수 함수다. 길이는 줄 단위로 자르고 이어 읽을 자리(줄 번호)를 돌려준다.
import { analyzeLayout, layoutHosts } from '../../engine/layout.js';
import { pageBackgroundCount } from '../../engine/flow.js';
import { tsvTableLines } from './tsv-view.js';

const n = (v) => Number(v).toLocaleString('ko-KR');
const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ');
const clip = (s, max) => { const t = [...String(s ?? '')]; return t.length > max ? `${t.slice(0, max).join('')}…` : t.join(''); };

/** 범위 글('s0/p3' · 's0/p3..s0/p20' · 's0/p3..p20' · 's2' · 's1..s3' · 생략) → 본문 문단을 고르는 함수 | null(전체). 잘못된 글이면 던진다 */
export function rangePicker(at) {
  if (at == null || at === '' || at === '*') return null;
  const one = (s, side) => {
    let m = /^s(\d+)$/.exec(s); if (m) return [Number(m[1]), side === 'from' ? 0 : Infinity];
    m = /^s(\d+)\/p(\d+)(?:[/#].*)?$/.exec(s); if (m) return [Number(m[1]), Number(m[2])];
    return null;
  };
  const parts = String(at).split('..');
  if (parts.length > 2) throw Object.assign(new Error(`범위가 올바르지 않습니다: ${at}`), { code: 'BAD_RANGE' });
  const a = one(parts[0].trim(), 'from');
  let b;
  if (parts.length === 2) {
    const t = parts[1].trim();
    b = /^p\d+$/.test(t) && a ? [a[0], Number(t.slice(1))] : one(t, 'to');
  } else b = one(parts[0].trim(), 'to');
  if (!a || !b) throw Object.assign(new Error(`범위가 올바르지 않습니다: ${at} — 's0/p3' · 's0/p3..s0/p20' · 's2' 꼴`), { code: 'BAD_RANGE' });
  const cmp = (x, y) => x[0] - y[0] || x[1] - y[1];
  return (sec, body) => cmp([sec, body], a) >= 0 && cmp([sec, body], b) <= 0;
}

/** 문단 스타일 번호 → 이름 */
function styleNames(doc) { return new Map(doc.formattingCatalog().styles.map((s) => [String(s.id), s.name])); }
function styleIdOf(doc, ref) {
  try { const { sec, p } = doc.resolve(ref); return (/\sstyleIDRef="(\d+)"/.exec(sec.xml.slice(p.start, p.start + 400)) || [])[1] ?? null; } catch { return null; }
}

/**
 * 본문 문단이 직접 가진 그림의 놓임 표지(글자처럼 취급이 아닌 그림만) — [{ bin(그림 파일), mark('글 앞'|'글 뒤'|null) }] (문서 차례).
 * 2026-11-17: 개체 → 본문 미리 보기(dry_run 의 after)에서 쪽 배경 그림이 '▣ 그림 210×297mm' 로만 보여, 글 앞에 남아 글을 덮는지 알 수 없었다
 */
function pictureMarks(doc, ref) {
  try {
    const { sec, p } = doc.resolve(ref);
    return doc._ownObjectAnchors(p).filter((a) => a.name === 'hp:pic').map((a) => {
      const xml = sec.xml.slice(a.start, a.end);
      const wrap = (/^<[^>]*\stextWrap="([^"]*)"/.exec(xml) || [])[1];
      const tac = /treatAsChar="1"/.test((/<hp:pos\b[^>]*>/.exec(xml) || [''])[0]);
      return { bin: (/binaryItemIDRef="([^"]+)"/.exec(xml) || [])[1] ?? null, mark: tac ? null : wrap === 'IN_FRONT_OF_TEXT' ? '글 앞' : wrap === 'BEHIND_TEXT' ? '글 뒤' : null };
    });
  } catch { return []; }
}

/** 문단이 가진 개체를 이름별로 센 글('글상자 207 · 사각형 52') */
function objectTally(doc, ref) {
  const tally = new Map();
  for (const o of doc.ownObjects(ref)) tally.set(o.name, (tally.get(o.name) || 0) + 1);
  return [...tally].map(([name, c]) => `${name} ${n(c)}`).join(' · ');
}

/**
 * 문단이 이만큼 이상인 칸은 표 줄 아래에 문단마다 주소와 함께 보인다(글을 담는 칸 — 회의록·보고 서식의 내용 칸). 그보다 적으면 줄 안에서 ¶ 로만 가른다.
 * 2026-11-19(docs/MCP_REDESIGN_2026-11-16.md §17): 칸 안 문단 나눔과 문단 안 줄바꿈을 모두 ⏎ 로 보여, 실제 Codex 실행 3건이 문단 21개인 칸을 '줄바꿈이 든 한 문단'으로
 * 읽고 새 글을 줄바꿈으로 한 문단에 몰아 넣었다. 칸 문단의 주소도 본문 보기에 없었다(서식 보기에서만 알 수 있었다)
 */
export const CELL_LIST_MIN = 3;

/**
 * 표를 줄마다 한 줄로: '| a | b |' — 합친 칸은 왼쪽 위에 글, 가려진 자리는 ↑(위 칸에 이어짐)·←(왼쪽 칸에 이어짐).
 * textOf(문단 주소 → 글)를 주면 칸 안 문단을 가른다: 문단 사이는 ¶(문단 안 줄바꿈은 ⏎), 문단이 CELL_LIST_MIN 개 이상인 칸은 줄에는 '(문단 N개 ↓)'만 두고
 * 그 줄 아래에 문단마다 '[주소] 글'을 싣는다. textOf 가 없으면(좌표로 읽은 배치 보기의 표 등) 칸 글 그대로.
 * → 글 줄 배열. rich:true 면 { text, kind: 'row'|'cell'|'para', ref? } 배열(본문 보기가 문단 줄에 주소를 단다)
 */
export function tableLines(t, { from = 0, to = Infinity, textOf = null, rich = false } = {}) {
  const grid = Array.from({ length: t.rows }, () => Array.from({ length: t.cols }, () => ''));
  const listed = new Map();   // 줄 번호 → 문단을 아래에 펼칠 칸들
  for (const c of t.cells) {
    const refs = textOf && Array.isArray(c.refs) ? c.refs : [];
    let shown;
    if (refs.length >= CELL_LIST_MIN) { shown = `(문단 ${refs.length}개 ↓)`; if (!listed.has(c.row)) listed.set(c.row, []); listed.get(c.row).push(c); }
    else if (refs.length > 1) shown = refs.map((r) => oneLine(textOf(r))).join(' ¶ ');
    else shown = oneLine(c.text);
    for (let r = c.row; r < Math.min(t.rows, c.row + (c.rowSpan || 1)); r++) for (let k = c.col; k < Math.min(t.cols, c.col + (c.colSpan || 1)); k++) {
      grid[r][k] = r === c.row && k === c.col ? shown.replace(/\|/g, '¦') : (r > c.row ? '↑' : '←');
    }
  }
  const out = [];
  for (let r = Math.max(0, from); r < Math.min(t.rows, to); r++) {
    out.push({ text: ` r${r} | ${grid[r].join(' | ')} |`, kind: 'row' });
    for (const c of listed.get(r) || []) {
      out.push({ text: `   ↳ r${c.row}·c${c.col} 칸의 문단 ${c.refs.length}개`, kind: 'cell' });
      for (const ref of c.refs) out.push({ text: `   [${ref}] ${oneLine(textOf(ref))}`.trimEnd(), kind: 'para', ref });
    }
  }
  return rich ? out : out.map((x) => x.text);
}

/**
 * 표 칸 하나의 문단 줄(read 의 at 이 칸 주소 {table,row,col} 이거나 칸 문단 주소일 때 — server/mcp2/service.js agentRead): 문단마다 '[주소] 글', mark = 물어본 문단(앞에 *).
 * → { head, lines: [{ text, ref }] }
 */
export function cellLines(doc, t, c, { mark = null } = {}) {
  const lines = c.refs.map((ref) => { let text = ''; try { text = doc.text(ref, 'final'); } catch { text = ''; } return { text: `${mark ? (ref === mark ? '*' : ' ') : ''}[${ref}] ${oneLine(text)}`.trimEnd(), ref }; });
  return { head: `표 ${t.key} 의 r${c.row}·c${c.col} 칸 — 문단 ${c.refs.length}개(칸 주소 at:{table:'${t.key}',row:${c.row},col:${c.col}} = 이 문단 전체)`, lines };
}

/**
 * 문서 얼개(한두 줄): 구역·본문 문단·글자 수·표·그림·떠 있는 개체. 글 대부분이 글상자 안에 있으면 배치 보기를 권한다.
 * → { text, stats: { sections, body, chars, boxChars, tables, figures, shapes, floatingHosts } }
 */
export function docMap(doc, { title = '' } = {}) {
  const paras = doc.paragraphs({ view: 'final', nested: true });
  let body = 0; let chars = 0; let boxChars = 0;
  for (const p of paras) {
    if (!p.parent) body++;
    const len = [...p.text.replace(/\s+/g, '')].length; chars += len;
    if (p.where === '글상자' || p.where === '개체') boxChars += len;
  }
  const tables = doc.tables().length; const figures = typeof doc.figures === 'function' ? doc.figures().length : 0;
  const tally = new Map(); let shapes = 0;
  for (const sec of doc.sections) for (const p of sec.bodyParas) for (const o of doc.ownObjects(p.ref)) { if (o.kind !== 'shape') continue; shapes++; tally.set(o.name, (tally.get(o.name) || 0) + 1); }
  const hosts = layoutHosts(doc).length;
  const lines = [`문서${title ? ` 「${clip(title, 40)}」` : ''}: 구역 ${doc.sections.length} · 본문 문단 ${n(body)} · 글 ${n(chars)}자 · 표 ${n(tables)} · 그림 ${n(figures)}${shapes ? ` · 도형 ${n(shapes)}(${[...tally].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${n(v)}`).join(' · ')})` : ''}`];
  const floating = chars > 0 && boxChars / chars >= 0.5 && shapes >= 10;
  if (floating) lines.push(`⚠ 글의 ${Math.round((boxChars / chars) * 100)}%가 떠 있는 글상자 안에 있다(쪽 좌표에 놓인 조각 — PDF 를 옮긴 문서에 흔하다). 본문 보기(text)로는 조각만 보인다. 배치 보기(read view='layout')가 좌표로 줄·표 구조를 묶어 보여 주고, edit 의 objects_to_body 가 진짜 문단·표로 옮긴다(글을 다시 치지 않는다).`);
  return { text: lines.join('\n'), stats: { sections: doc.sections.length, body, chars, boxChars, tables, figures, shapes, floatingHosts: hosts, floating } };
}

/**
 * 본문 보기의 줄 목록. 줄마다 { text, body(문서 전체 본문 차례) }.
 * opts: pick(구역, 구역 안 문단 번호, 문서 전체 본문 차례 → 포함?), styles(스타일 이름을 바뀔 때마다 〔 〕 로 — 기본 true), boxLimit(글상자 안 문단을 줄마다 보일 한도 — 넘으면 한 줄 요약, 기본 12)
 */
export function textLines(doc, { pick = null, styles = true, boxLimit = 12, surface = 'v2' } = {}) {
  const paras = doc.paragraphs({ view: 'final', nested: true });
  const tables = doc.tables(); const tablesAt = new Map();
  for (const t of tables) {
    // v3에서는 같은 본문 안의 표를 XML 순서로 둔다(바깥 표 A → A 속 표 → 형제 표 B).
    const host = surface === 'v3' ? t.ref.split('/', 2).join('/') : t.ref;
    if (!tablesAt.has(host)) tablesAt.set(host, []);
    tablesAt.get(host).push(t);
  }
  const figures = typeof doc.figures === 'function' ? doc.figures() : []; const figuresAt = new Map();
  for (const f of figures) { if (!figuresAt.has(f.ref)) figuresAt.set(f.ref, []); figuresAt.get(f.ref).push(f); }
  const names = styles ? styleNames(doc) : null;
  const out = []; let lastStyle = null; let body = -1; let empties = null;
  const flushEmpties = () => {
    if (!empties) return;
    out.push({ text: empties.count === 1 ? `[${empties.first}]` : `[${empties.first}..p${empties.lastBody}] (빈 문단 ${empties.count}개)`, body: empties.body });
    empties = null;
  };
  // 칸 안 문단 글(주소 → 글): 칸 문단 나눔 ¶ 와 문단 많은 칸의 문단별 주소 줄에 쓴다(tableLines)
  const byRef = new Map(paras.map((p) => [p.ref, p]));
  const textOf = (ref) => byRef.get(ref)?.text ?? '';
  // 표 줄의 kind: 'table'(표 머리 줄) · 'row'(줄) · 'cell'(문단을 펼친 칸의 머리) · 'para'(칸 문단 — ref 를 가진다). 찾기(read 의 find)가 표 머리 줄을 함께 싣는 데 쓴다
  const pushTable = (t, indent, b) => {
    if (surface === 'v3') {
      for (const line of tsvTableLines(t, byRef.get(t.ref)?.cell)) out.push({ ...line, body: b });
      return;
    }
    out.push({ text: `${indent}▦ ${t.key} 표 ${t.rows}×${t.cols}${t.caption?.text ? ` 「${clip(oneLine(t.caption.text), 80)}」` : ''}`, body: b, table: t.key, kind: 'table' });
    for (const line of tableLines(t, { textOf, rich: true })) out.push({ text: `${indent}${line.text}`, body: b, table: t.key, kind: line.kind, ...(line.ref ? { ref: line.ref } : {}) });
  };
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (p.parent) continue;
    body++;
    // 이 본문 문단에 딸린 중첩 문단(다음 본문 문단 전까지)
    let j = i + 1; const nested = [];
    while (j < paras.length && paras[j].parent) nested.push(paras[j++]);
    if (pick && !pick(p.section, p.body, body)) continue;
    const ownTables = tablesAt.get(p.ref) || []; const ownFigures = figuresAt.get(p.ref) || [];
    const boxes = nested.filter((q) => !q.cell && (q.where === '글상자' || q.where === '개체'));
    const others = nested.filter((q) => !q.cell && q.where !== '글상자' && q.where !== '개체' && q.where !== '표' && q.text.trim());
    const nestedTables = surface === 'v3' ? [] : nested.flatMap((q) => tablesAt.get(q.ref) || []);
    const hasObjects = ownTables.length || ownFigures.length || boxes.length || others.length || nestedTables.length;
    if (!p.text.trim() && !hasObjects) {
      // 빈 문단은 이어서 한 줄로(주소 범위만)
      if (empties && empties.section === p.section && empties.lastBody === p.body - 1) { empties.count++; empties.lastBody = p.body; }
      else { flushEmpties(); empties = { first: p.ref, section: p.section, lastBody: p.body, count: 1, body }; }
      continue;
    }
    flushEmpties();
    let mark = '';
    if (names) { const sid = styleIdOf(doc, p.ref); const name = sid != null ? names.get(sid) || sid : null; if (name && name !== lastStyle) { mark = ` 〔${name}〕`; lastStyle = name; } }
    out.push({ text: `[${p.ref}]${mark} ${oneLine(p.text)}`.trimEnd(), body, ref: p.ref });
    for (const t of ownTables) pushTable(t, ' ', body);
    // 글 앞·글 뒤 그림은 표지를 단다(같은 그림 파일이 여럿이면 차례로 짝짓는다)
    const marks = ownFigures.length ? pictureMarks(doc, p.ref) : [];
    for (const f of ownFigures) {
      const k = marks.findIndex((m) => m.bin === f.binId); const mark = k >= 0 ? marks.splice(k, 1)[0].mark : null;
      out.push({ text: ` ▣ 그림${f.n > 1 ? `#${f.n}` : ''}${f.caption?.text ? ` 「${clip(oneLine(f.caption.text), 80)}」` : ''} ${Math.round(f.width / 283.46)}×${Math.round(f.height / 283.46)}mm${mark ? `(${mark})` : ''}`, body });
    }
    if (boxes.length > boxLimit) {
      const chars = boxes.reduce((s, q) => s + [...q.text].length, 0);
      out.push({ text: ` ◰ 떠 있는 개체: ${objectTally(doc, p.ref)} — 글 조각 ${n(boxes.length)}개(${n(chars)}자)는 read view='layout' at='${p.ref}' 로 줄·표로 묶어 본다`, body });
    } else for (const q of boxes) if (q.text.trim()) out.push({ text: ` [${q.ref}] (${q.where}) ${oneLine(q.text)}`, body, ref: q.ref });
    for (const q of others) out.push({ text: ` [${q.ref}] (${q.where}) ${oneLine(q.text)}`, body, ref: q.ref });
    for (const t of nestedTables) pushTable(t, '  ', body);
  }
  flushEmpties();
  return { lines: out, bodyTotal: body + 1 };
}

/** 줄 목록을 글자 한도까지 잘라 준다 → { text, from, to(다음 줄 번호), total, done } */
export function pageLines(lines, { from = 0, maxChars = 20000 } = {}) {
  const out = []; let chars = 0; let i = Math.max(0, from);
  for (; i < lines.length; i++) {
    const len = lines[i].text.length + 1;
    if (out.length && chars + len > maxChars) break;
    out.push(lines[i].text); chars += len;
  }
  return { text: out.join('\n'), from, to: i, total: lines.length, done: i >= lines.length };
}

/**
 * 배치 보기(떠 있는 글상자·괘선을 좌표로 묶음).
 * detail=false: 문단마다 한 줄 요약 + 이어 붙인 결과(표·문단·버릴 줄). detail=true: 줄(L 번호)과 표 줄을 모두.
 * → { lines: [{ text }], plan(analyzeLayout 결과) }
 */
export function layoutLines(doc, { refs = null, detail = false, options = {} } = {}) {
  const plan = analyzeLayout(doc, { ...options, refs });
  const out = [];
  if (!plan.hosts.length) return { lines: [{ text: '떠 있는 글상자·도형을 가진 문단이 없습니다(본문 흐름 문서 — read view=\'text\').' }], plan };
  for (const h of plan.hosts) {
    const c = h.counts;
    const tally = [c.text ? `글상자 ${n(c.text)}` : '', c.rule ? `선 ${n(c.rule)}` : '', c.fill ? `면 ${n(c.fill)}` : '', c.figure ? `그림 ${n(c.figure)}` : '', c.table ? `표 ${n(c.table)}` : '', c.complex ? `복합 글상자 ${n(c.complex)}` : '', c.other + c.inline ? `그 밖 ${n(c.other + c.inline)}` : ''].filter(Boolean).join(' · ');
    if (!detail) {
      const parts = h.blocks.map((b) => {
        if (b.type === 'grid') {
          const head = Array.from({ length: b.cols }, (_, k) => clip(b.cells.find((q) => q.r === 0 && q.c === k)?.text ?? '', 16)).join(' | ');
          return `표 ${b.rows}×${b.cols}(${b.headerRows ? `머리 ${b.headerRows}줄` : '머리행 없음'} — 첫 줄: ${head})`;
        }
        return b.lines.map((l) => `${l.id} "${clip(l.text, 40)}"${l.role === 'page_number' ? '(쪽 번호)' : ''}`).join(' · ');
      });
      out.push({ text: `[${h.ref}] ${tally} → ${parts.join(' · ') || '(글 없음)'}` });
      continue;
    }
    out.push({ text: `[${h.ref}] ${tally}` });
    for (const b of h.blocks) {
      if (b.type === 'lines') { for (const l of b.lines) out.push({ text: ` ${l.id} ${l.text}${l.role === 'page_number' ? '  ← 쪽 번호로 보임(옮길 때 버림)' : ''}` }); continue; }
      out.push({ text: ` 표 ${b.rows}×${b.cols}${b.headerRows ? ` (머리 ${b.headerRows}줄)` : ''}` });
      const t = { rows: b.rows, cols: b.cols, cells: b.cells.map((q) => ({ row: q.r, col: q.c, rowSpan: q.rs, colSpan: q.cs, text: q.text })) };
      for (const line of tableLines(t)) out.push({ text: ` ${line}` });
    }
  }
  // 옮기면 어떻게 되는가(쪽을 넘는 표 잇기까지)
  const tables = plan.tables.map((t, i) => `${'①②③④⑤⑥⑦⑧⑨⑩'[i] || `(${i + 1})`} ${t.hosts.length > 1 ? `${t.hosts[0]}~${t.hosts[t.hosts.length - 1]}` : t.host} ${t.rows}줄×${t.cols}칸${t.merges.length ? `(합친 칸 ${t.merges.length})` : ''}`);
  const paras = plan.flow.reduce((s, f) => s + f.items.filter((x) => x.type === 'para').length, 0);
  const why = [...new Set(plan.dropped.map((d) => d.why))].join('·');
  // 옮긴 글상자·선은 objects_to_body 가 지운다 — 그 수와, 옮기지 못해 남는 개체 수를 미리 알려 모델이 개체 지우기를 따로 내지 않게 한다
  const moving = plan.hosts.filter((h) => h.used.size);
  // 쪽 배경 그림(engine/flow.js — 2026-11-17): 기본(background 'remove')으로 무늬 없는 바탕은 지우고 내용으로 보이는 것은 글 뒤로 — 남는 개체 수에서 지울 것을 뺀다
  const bg = options.background === 'behind' ? { plain: 0, content: 0, behind: pageBackgroundCount(doc, moving) } : pageBackgroundCount(doc, moving);
  const gone = moving.reduce((s, h) => s + h.used.size, 0); const stay = moving.reduce((s, h) => s + h.kept, 0) - bg.plain;
  const bgNote = bg.behind ? (bg.behind.plain + bg.behind.content ? ` · 쪽 배경 그림 ${n(bg.behind.plain + bg.behind.content)}장은 글 뒤로` : '')
    : `${bg.plain ? ` · 쪽 배경 그림 ${n(bg.plain)}장은 지움(남기려면 background:'behind')` : ''}${bg.content ? ` · 내용으로 보이는 쪽 그림 ${n(bg.content)}장은 글 뒤로` : ''}`;
  // 쪽을 넘어 이은 표(join_pages 기본 true — engine/layout.js): 되풀이 머리행은 버릴 줄(why '되풀이 머리행')에 든다
  const joined = plan.tables.filter((t) => t.hosts.length > 1).length;
  out.push({ text: `objects_to_body 로 옮기면: 표 ${plan.tables.length}개${tables.length ? ` — ${tables.slice(0, 10).join(' / ')}${tables.length > 10 ? ' …' : ''}` : ''} · 문단 ${paras}개${plan.dropped.length ? ` · 버릴 줄 ${plan.dropped.length}개(${why})` : ''}`
    + ` · 옮긴 글상자·선 ${n(gone)}개는 함께 지워짐${bgNote} · ${stay ? `남는 개체 ${n(stay)}개(그림·표·회전한 도형 등 — 지우려면 remove_rest)` : '남는 개체 없음'}`
    + `${joined ? ` · 쪽을 넘는 표 ${joined}개는 한 표로 이음(쪽마다 따로는 join_pages:false)` : ''}` });
  return { lines: out, plan };
}

const HEADING = /^(?:제\s*\d+\s*[장절편조]|[IVXⅠ-Ⅹ]+[.)]\s|\d+(?:\.\d+)*[.)]?\s|[가-하][.)]\s|\(\d+\)\s|[■□◆◇○●▶]\s)/;

/** 제목 스타일 이름인가(제목·개요·차례·'본문 1.' 같은 번호 단계 — 표·그림·주석·머리말 스타일은 아님) */
const headingStyle = (name) => /제목|개요|heading|title|차례|목차|본문\s*\d|[장절]$/i.test(name) && !/표|그림|캡션|주석|단위|머리말|꼬리말|쪽/.test(name);

/** 제목 얼개: 제목 스타일의 문단, 또는 번호(제1장·1.·가.·(1) …)로 시작하는 짧은 문단 → 줄 목록 */
export function outlineLines(doc, { pick = null, max = 400 } = {}) {
  const names = styleNames(doc);
  const out = [];
  for (const p of doc.paragraphs({ view: 'final', nested: false })) {
    if (pick && !pick(p.section, p.body)) continue;
    const text = p.text.trim(); if (!text) continue;
    const sid = styleIdOf(doc, p.ref); const name = names.get(String(sid)) || '';
    const len = [...text].length;
    if (!((headingStyle(name) && len <= 120) || (HEADING.test(text) && len <= 60))) continue;
    out.push({ text: `[${p.ref}] 〔${name || sid}〕 ${clip(oneLine(text), 100)}` });
    if (out.length >= max) { out.push({ text: `… (제목 후보가 ${max}개를 넘어 줄임 — at 으로 범위를 좁히세요)` }); break; }
  }
  if (!out.length) out.push({ text: '(제목으로 보이는 문단이 없습니다 — read view=\'text\' 로 본문을 읽으세요)' });
  return out;
}
