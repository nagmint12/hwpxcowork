// HWPX 문서 — 메모(MEMO 필드)·변경 추적(insert/delete 표식)·문단 글 조회/수정의 공개 API.
// 모든 수정은 구역 XML 문자열을 잘라 붙인 뒤 다시 파싱한다(원문 보존, 한글 호환 우선).
import { HwpxContainer } from './container.js';
import { Section, anchorTag, isObjectAnchor } from './section.js';
import { objectWhat, objectChangeLabel, OBJECT_TRACK, breakChangeLabel, BREAK_TRACK } from './track-objects.js';
import { Header } from './header.js';
import { EngineError } from './errors.js';
export { EngineError } from './errors.js';
import { escapeText, escapeAttr, decodeEntities } from './xmlscan.js';
import { scanTables, sectionTextWidth, sectionTextHeight, tableXml, stripCaptionNumber, isNumericCell, numericColumns } from './table.js';
import { editTableXml, restoreTableXml } from './table-edit.js';
import { imageInfo, scanPictures, pictureXml, PX, MM } from './picture.js';
import { importChartParts, releaseChartParts, chartPartKey, fixSwitchIds, pruneChartParts, syncSwitchCopies } from './chart-parts.js';
import { SHAPE_TAGS, shapeProps, shapePrintText, shapeChange, shapeKey, pairShapes, patchShape, shapeName, shapeFlowsText } from './shapes.js';
import { planBody, planBodyAnchored, charOps, entryKind, foldOwners } from './diff.js';
import { inspectFormatting, formattingCatalog, formatRange, formatParagraphs, undoFormatting, validateTextFormatting, formattingTransaction, applyInsertedFormatting, replacementShapes, formattingFingerprint, formattingChanged, copyFormattingFrom, copyFormattingBatch, copyStyleDefinitionsFrom, normalizedInsertedText, importFormattingRefs, formattingPartsFor, breakChangeLabels } from './formatting.js';
export { validateFormatSpec } from './formatting.js';

const SUBLIST_ATTRS = 'id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"';

import { masterTextAt, masterTextChanges, writeMasterText } from './master-text.js';

export class HwpxDoc {
  masterText(address) { return masterTextAt(this, address); }
  writeMasterText(address, text, source, sourceAddress) { return writeMasterText(this, address, text, applyEdits, source, sourceAddress); }

  static async load(buffer) { return new HwpxDoc(await HwpxContainer.load(buffer)); }

  // 붙여넣기·수정본 병합의 비교와 적용이 같은 단위의 서식 정의를 보게 한다.
  // 판본이 같은 경로와 이미 저장한 문단 지문은 그대로 사용한다.
  inFormattingUnitsOf(target) {
    const converted = formattingPartsFor(this, target);
    if (!converted) return this;
    const container = new HwpxContainer(new Map(this.container.files), [...this.container.order]);
    if (converted.versionXml === null) container.remove('version.xml');
    else container.setText('version.xml', converted.versionXml);
    container.setText('Contents/header.xml', converted.header.xml);
    this.sections.forEach((section, i) => container.setText(this.sectionNames[i], section.xml));
    return new HwpxDoc(container);
  }

  constructor(container) {
    this.container = container;
    this.header = new Header(container.getText('Contents/header.xml') || '');
    this.sectionNames = container.sectionNames();
    this.sections = this.sectionNames.map((n, i) => new Section(container.getText(n), i));
    this.normalized = this._normalizeChanges();
    this.repaired = this._repairLostBegins();
  }

  /**
   * [hwpx-cowork] 한/글 저장 버그 고치기(2026-10-30 실측 — scratchpad track_hangul RESULTS §3·§4): 같은 run 에서 글 바로 뒤에 온 개체의 넣음·지움을
   * 한/글이 저장하면 시작 표식을 버리고 개체 바로 뒤의 끝 표식만 남긴다(한/글도 다시 열면 그 변경을 풀지 못한다). 짝 없는 끝 표식(문서 어디에도 같은 번호
   * 시작 없음, 머리 항목 있음, paraend 0)이 개체 바로 뒤(사이에 글자·다른 부호 없이 빈 hp:t 경계만)에 있으면 그 개체 앞에 시작 표식을 되살린다
   * (OBJECT_TRACK 꼴 — 빈 hp:t 안). 그러면 웹에서 수락·거절할 수 있고 한/글도 그 파일의 변경을 푼다 → 되살린 수
   */
  _repairLostBegins() {
    const re = /<hp:(insert|delete)Begin\b[^>]*\bId="(\d+)"/g;
    const begins = new Set();
    for (const sec of this.sections) for (const m of sec.xml.matchAll(re)) begins.add(`${m[1]}:${m[2]}`);
    const heads = new Set(this.header.changes().map((c) => String(c.id)));
    let n = 0;
    for (const sec of this.sections) {
      if (!sec.xml.includes('<hp:insertEnd') && !sec.xml.includes('<hp:deleteEnd')) continue;
      const edits = [];
      for (const p of sec.paras) {
        if (p.alt) continue; // [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 사본의 표식은 변경이 아니다(_normalizeChanges)
        for (const e of p.anchors) {
          if (e.kind !== 'change' || (e.name !== 'hp:insertEnd' && e.name !== 'hp:deleteEnd')) continue;
          const kind = e.name === 'hp:insertEnd' ? 'insert' : 'delete';
          if (e.id == null || begins.has(`${kind}:${e.id}`) || !heads.has(String(e.id)) || e.attrs?.get('paraend') === '1') continue;
          let prev = null;
          for (const a of p.anchors) if (a !== e && a.end <= e.start && (!prev || a.end > prev.end)) prev = a;
          if (!prev || !isObjectAnchor(prev) || prev.pos !== e.pos) continue;
          if (!/^(?:<\/hp:t>|<hp:t>|<hp:t\/>|<\/hp:run>|<hp:run\b[^>]*>|\s)*$/.test(sec.xml.slice(prev.end, e.start))) continue;
          edits.push({ pos: prev.start, insert: `<hp:t><hp:${kind}Begin Id="${e.id}" TcId="${e.id}"/></hp:t>` });
          begins.add(`${kind}:${e.id}`);
        }
      }
      if (edits.length) { sec.load(applyEdits(sec.xml, edits)); n += edits.length; }
    }
    return n;
  }

  /**
   * 한글이 다시 저장한 파일은 같은 (종류·작성자·분) 변경을 헤더 항목 하나로 묶고(여러 표식이 TcId 공유),
   * 표식 Id 는 문서 순서로 따로 매긴다. 엔진은 '표식 Id = TcId = 헤더 id = 목록 위치' 1:1 모형을 쓰므로,
   * 읽을 때 변경(Id)마다 헤더 항목을 하나씩 두는 모양으로 펼친다(작성자·시각·종류는 TcId 가 가리키는 항목에서).
   * 한글은 이 모양도 그대로 연다(우리 파일이 늘 이 모양). 반환: 펼친 변경 수(이미 1:1 이면 0)
   */
  _normalizeChanges() {
    const re = /<hp:(insertBegin|insertEnd|deleteBegin|deleteEnd)\b([^>]*)\/>/g;
    const marks = [];
    // [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 사본(alt) 안 표식은 세지도 고치지도 않는다 — 한/글 2022 가 그 사본에 머리 항목 없이(TcId="0") 쓰는
    // 표식이다(차트 대체 OLE 캡션, COM 실측). 세면 머리 항목이 생겨 한/글에 없는 유령 변경이 된다
    const altSpans = this.sections.map((sec) => sec.paras.filter((p) => p.alt && !p.parent?.alt).map((p) => [p.start, p.end]));
    const inAlt = (si, at) => altSpans[si].some(([s, e]) => s <= at && at < e);
    for (const [si, sec] of this.sections.entries()) for (const m of sec.xml.matchAll(re)) {
      if (inAlt(si, m.index)) continue;
      const id = /\bId="(\d+)"/.exec(m[2])?.[1] ?? null; const tc = /\bTcId="(\d+)"/.exec(m[2])?.[1] ?? null;
      marks.push({ name: m[1], id: id ?? tc, tc: tc ?? id });
    }
    if (!marks.length) return 0;
    const head = this.header.changes();
    const byId = new Map(head.map((c) => [String(c.id), c]));
    if (marks.every((m) => m.id != null && m.id === m.tc && byId.has(m.id))) return 0;
    const ids = [...new Set(marks.map((m) => m.id).filter((x) => x != null))].sort((a, b) => Number(a) - Number(b));
    const map = new Map(ids.map((id, i) => [id, String(i + 1)]));
    const entries = ids.map((id, i) => {
      const ms = marks.filter((m) => m.id === id); const b = ms.find((m) => m.name.endsWith('Begin')) || ms[0];
      const src = byId.get(b.tc) || head[Number(b.tc) - 1] || byId.get(id) || {};
      return { id: i + 1, type: b.name.startsWith('insert') ? 'Insert' : 'Delete', date: src.date || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), authorID: src.authorID ?? 1, hide: !!src.hide };
    });
    this.header.rewriteChanges(entries);
    for (const [si, sec] of this.sections.entries()) {
      const xml = sec.xml.replace(re, (all, name, a, at) => {
        if (inAlt(si, at)) return all;
        const id = /\bId="(\d+)"/.exec(a)?.[1] ?? /\bTcId="(\d+)"/.exec(a)?.[1]; const n = map.get(id) ?? id;
        let b = a.replace(/\bId="\d+"/, `Id="${n}"`).replace(/\bTcId="\d+"/, `TcId="${n}"`);
        if (!/\bId="/.test(b)) b = ` Id="${n}"${b}`; if (!/\bTcId="/.test(b)) b = b.replace(/\bId="\d+"/, (x) => `${x} TcId="${n}"`);
        return `<hp:${name}${b}/>`;
      });
      if (xml !== sec.xml) sec.load(xml);
    }
    return ids.length;
  }

  async save() {
    // [hwpx-cowork] 아무도 안 쓰는 차트 부분·차트 대체 OLE 를 거둔다(engine/chart-parts.js — 한/글 저장본처럼)
    pruneChartParts(this);
    // [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 캡션 사본을 첫 갈래 글에 맞춘다(engine/chart-parts.js — 최종본 글이 다를 때만)
    syncSwitchCopies(this);
    this.container.setText('Contents/header.xml', this.header.xml);
    this.sections.forEach((s, i) => this.container.setText(this.sectionNames[i], memoZorderFix(s.xml)));
    return this.container.save();
  }

  /** 같은 상태의 복제본(수락·평탄화용) */
  async clone() { return HwpxDoc.load(await this.save()); }

  // ───────── 조회 ─────────

  resolve(ref) {
    const m = /^s(\d+)\//.exec(ref || '');
    const sec = m ? this.sections[parseInt(m[1], 10)] : null;
    const p = sec ? sec.byRef(ref) : null;
    if (!p) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: ${ref}`);
    return { sec, p };
  }

  /**
   * 문단 목록. nested=true 이면 표 셀 등 중첩 문단도 포함(메모 본문은 제외).
   * 중첩 문단은 parent(부모 문단 ref)·container(담는 요소)를, 표 셀 문단은 cell{table,row,col,rowSpan,colSpan} 을 가진다.
   */
  paragraphs({ view = 'final', nested = true } = {}) {
    const out = [];
    for (const sec of this.sections) {
      const ti = nested ? this._tableIndex(sec) : null;
      for (const p of sec.paras) {
        if (p.container === 'hp:fieldBegin') continue; // 메모 본문
        if (!nested && p.parent) continue;
        // [hwpx-cowork] 보기에서 숨은 개체 안 문단(최종본: 변경 추적으로 지운 표·그림·도형 안, 원본: 넣은 개체 안)은 뺀다 — 최종본 ref = 작업본 ref
        if (!Section.visibleParagraph(p, view)) continue;
        const text = view === 'markup' ? Section.markupText(p) : Section.text(p, view);
        const c = ti ? ti.cellOf.get(p) : null;
        out.push({
          ref: p.ref, section: sec.index, body: p.body, where: Section.where(p), text,
          length: Section.visibleChars(p, 'final').length,
          changes: [...new Set(Section.changeMarks(p).map((a) => Number(a.id)))],
          memos: Section.fieldCtrls(p).filter((a) => a.inner === 'hp:fieldBegin' && a.innerAttrs?.get('type') === 'MEMO').map((a) => memoParamAt(sec.xml, a, 'ID')),
          parent: p.parent ? p.parent.ref : null,
          container: p.parent ? p.container : null,
          cell: c ? { table: c.table.key, row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan } : null,
          ...(p.hidden ? { hidden: true } : {}), // [hwpx-cowork] 'markup'·'all' 보기의 지운 개체 안 문단(ref '/d' — 고칠 수 없음)
        });
      }
    }
    return out;
  }

  /** 구역의 표 색인(구역 XML 이 바뀔 때만 다시 만든다) */
  _tableIndex(sec) {
    // [hwpx-cowork] 다시 읽을 때마다(stamp) 새로 — 색인이 문단 기록을 품으므로 같은 XML 로 돌아와도 지금 기록이어야 한다(구역 부분 다시 읽기는 뒤 기록을 그 자리에서 옮긴다, 2026-11-16)
    if (!sec._tables || sec._tables.stamp !== sec.stamp) sec._tables = { stamp: sec.stamp, data: scanTables(sec) };
    return sec._tables.data;
  }

  /**
   * 표 목록(문서 순서, 셀 안 중첩 표도 따로). cells 는 XML 순서.
   * → [{ key, ref, index, rows, cols, caption: {ref,text}|null, cells: [{row,col,rowSpan,colSpan,header,refs,text}] }]
   */
  tables() {
    const out = [];
    for (const sec of this.sections) {
      for (const t of this._tableIndex(sec).tables) {
        if (t.hidden) continue; // [hwpx-cowork] 최종본 보기 — 변경 추적으로 지운 표(와 지운 개체 안 표)는 없다
        const cap = t.captionParas.filter((p) => p.container !== 'hp:fieldBegin');
        out.push({
          key: t.key, ref: t.ref, index: t.index, rows: t.rows, cols: t.cols,
          caption: cap.length ? { ref: cap[0].ref, text: cap.map((p) => Section.text(p, 'final')).join('\n') } : null,
          cells: t.cells.map((c) => ({
            row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, header: c.header,
            refs: c.paras.map((p) => p.ref), text: c.paras.map((p) => Section.text(p, 'final')).join('\n'),
          })),
        });
      }
    }
    return out;
  }

  /**
   * [hwpx-cowork] 고칠 표 찾기: 표 열쇠('s1/p7#t0')·표를 품은 문단 ref(그 문단의 첫 표)·표 칸 문단 ref('s1/p7/n3' — 그 칸이 든 표) → { sec, t }.
   * 변경 추적으로 지운 표는 찾지 않는다
   */
  _tableTarget(target) {
    const s = String(target || '');
    const key = /^(s\d+\/p\d+[^#]*)#t(\d+)$/.exec(s);
    const ref = key ? key[1] : s;
    const { sec, p } = this.resolve(ref);
    const idx = this._tableIndex(sec);
    let t = null;
    if (key) t = idx.tables.find((x) => x.key === s && !x.hidden) || null;
    else t = idx.tables.find((x) => x.owner === p && !x.hidden) || idx.cellOf.get(p)?.table || idx.captionOf.get(p) || null;
    if (!t || t.hidden) throw new EngineError('NO_TABLE', `표를 찾지 못했습니다: ${s} (표 열쇠 's1/p7#t0', 표 문단 ref, 또는 표 칸 ref)`);
    return { sec, t };
  }

  /**
   * [hwpx-cowork] 있는 표를 고친다(한/글 표 명령 — engine/table-edit.js). 변경 추적 없이 바로(한/글도 표 구조·모양 바꾸기는 추적하지 않는다).
   * 표 크기가 바뀌면 표를 품은 문단의 줄 정보(linesegarray)를 지운다. → { key, ref, before(고치기 전 표 XML), after, rows, cols, labels, geometry }
   */
  editTable(target, ops, { dryRun = false } = {}) {
    const { sec, t } = this._tableTarget(target);
    const before = sec.xml.slice(t.start, t.end);
    const header = dryRun ? new Header(this.header.xml) : this.header;
    // [hwpx-cowork] 칸 안 새 표(cell_paragraphs 의 {table} — 2026-11-20 §22): 표 XML 은 여기서(머리·id·본보기 표가 필요하다)
    const wantsTable = ops.some((o) => o?.op === 'cell_paragraphs' && Array.isArray(o.paragraphs) && o.paragraphs.some((e) => e && typeof e === 'object' && e.table));
    const res = editTableXml(before, ops, { header, cellTable: wantsTable ? this._cellTableFactory(header) : null });
    const out = { key: t.key, ref: t.ref, before, after: res.xml, undo: res.undo, rows: res.rows, cols: res.cols, labels: res.labels, geometry: res.geometry };
    // [hwpx-cowork] 칸 문단 다시 짜기(cell_paragraphs — 2026-11-19): stamps = op 마다 사라질 문단의 글 지문(서비스가 제안의 op.expect 로 적어 둔다),
    // cellMoves = 그 칸 문단들의 중첩 주소 옮김표 [{ parent(칸 문단의 부모 문단 ref), first(칸 첫 문단의 '/n' 번호), map(옛 문단 k → 새 차례 | null), count(새 문단 수) }]
    // (서비스가 meta 의 주소를 옮긴다 — _remapCellMoves). 칸 문단 기록이 XML 문단 차례와 어긋나면(숨은 문단 등) 그 칸은 옮김표를 주지 않는다
    if (res.stamps) out.stamps = res.stamps;
    if (res.cellMoves) {
      out.cellMoves = res.cellMoves.map((mv) => {
        const cell = t.cells.find((c) => c.row != null && mv.row >= c.row && mv.row < c.row + c.rowSpan && mv.col >= c.col && mv.col < c.col + c.colSpan);
        const paras = cell?.paras || [];
        if (!paras.length || paras.length !== mv.map.length || !paras[0].parent || paras.some((p, i) => p.hidden || p.parent !== paras[0].parent || p.nested !== paras[0].nested + i)) return null;
        return { parent: paras[0].parent.ref, first: paras[0].nested, map: mv.map, count: mv.count };
      }).filter(Boolean);
    }
    // [hwpx-cowork] 한/글 2022 실측(2026-11-14): 글자처럼 표는 hp:pos.horzAlign만 바꿔도 x=113px 그대로이고,
    // 소유 문단을 CENTER로 바꿔야 x=227px가 된다. 떠 있는 표는 표 위치 속성을 그대로 쓴다.
    const align = ops.findLast(o => o.op === 'table' && o.align != null)?.align;
    const pos = /<hp:pos\b[^>]*\/>/.exec(res.xml)?.[0] || '';
    if (align && /\btreatAsChar="(?:1|true)"/.test(pos)) {
      const previous = this.inspectFormatting(t.ref).paragraph.align;
      if (previous !== align) {
        out.undo.paragraphAlign = { before: previous, after: align };
        out.geometry = true;
        out.labels = [...out.labels, '표를 품은 문단 정렬'];
      }
    }
    if (dryRun) return out;
    // 칸 문단 수가 바뀌면 표 높이가 달라질 수 있다 — 표를 품은 문단의 줄 정보도 지워 다시 재게 한다(relayout)
    this._putTableXml(sec, t, res.xml, out.geometry || !!res.relayout);
    if (out.undo.paragraphAlign) this.formatRange(t.ref, { start: 0, end: this.inspectFormatting(t.ref).length, paragraph: { align } });
    return out;
  }

  /**
   * [hwpx-cowork] editTable 되돌리기(undo = editTable 결과의 undo): 표(key)의 뼈대가 고친 뒤 그대로일 때만 고치기 전 구조·모양(before)으로 — 칸 글·캡션은
   * 지금 것을 살린다(engine/table-edit.js restoreTableXml). 그새 구조·모양이 바뀌었으면 STALE → true
   */
  restoreTable(key, before, undo) {
    const { sec, t } = this._tableTarget(key);
    // 둘 다 먼저 검사한다. 이후 사람이 바꾼 문단 정렬은 덮지 않고 표·문단을 함께 되돌린다.
    const xml = restoreTableXml(sec.xml.slice(t.start, t.end), before, undo);
    const paragraph = undo?.paragraphAlign;
    if (paragraph && this.inspectFormatting(t.ref).paragraph.align !== paragraph.after) {
      throw new EngineError('STALE', '표를 고친 뒤 그 문단의 정렬이 바뀌어 되돌릴 수 없습니다');
    }
    this._putTableXml(sec, t, xml, true);
    if (paragraph) this.formatRange(t.ref, { start: 0, end: this.inspectFormatting(t.ref).length, paragraph: { align: paragraph.before } });
    return true;
  }

  _putTableXml(sec, t, xml, geometry) {
    const seg = geometry && t.owner?.lineseg && t.owner.lineseg.start > t.end ? t.owner.lineseg : null;
    let out = sec.xml.slice(0, t.start) + xml + sec.xml.slice(t.end);
    if (seg) { const shift = xml.length - (t.end - t.start); out = out.slice(0, seg.start + shift) + out.slice(seg.end + shift); }
    sec.load(out);
  }

  text(ref, view = 'final') { const { p } = this.resolve(ref); return view === 'markup' ? Section.markupText(p) : Section.text(p, view); }

  inspectFormatting(ref) { return inspectFormatting(this, ref); }
  /** 여러 문단(문단 전체)의 스타일·글자모양·문단모양을 한 번에 — engine/formatting.js formatParagraphs */
  formatParagraphs(refs, input) { return formatParagraphs(this, refs, input); }
  formattingCatalog() { return formattingCatalog(this); }
  formatRange(ref, spec) { return formatRange(this, ref, spec); }
  undoFormatting(undo) { return undoFormatting(this, undo); }
  formattingFingerprint(ref) { return formattingFingerprint(this, ref); }
  copyFormattingFrom(sourceDoc, sourceRef, targetRef) { return copyFormattingFrom(this, sourceDoc, sourceRef, targetRef); }
  copyFormattingBatch(sourceDoc, pairs) { return copyFormattingBatch(this, sourceDoc, pairs); }
  copyStyleDefinitionsFrom(sourceDoc) { return copyStyleDefinitionsFrom(this, sourceDoc); }

  /** 문단 안에서 글(find)의 n번째 위치를 찾는다(최종본 기준). */
  find(ref, find, occurrence = 1) {
    const t = this.text(ref, 'final');
    let from = 0; let at = -1;
    for (let i = 0; i < occurrence; i++) { at = t.indexOf(find, from); if (at < 0) break; from = at + 1; }
    if (at < 0) return null;
    return { start: cpLen(t.slice(0, at)), end: cpLen(t.slice(0, at)) + cpLen(find) };
  }

  // ───────── 변경 추적 ─────────

  trackingEnabled() { return this.header.trackingEnabled(); }
  setTracking(on) { this.header.setTracking(!!on); }
  authors() { return this.header.authors(); }

  /**
   * 변경 목록(헤더 항목 + 본문에서 찾은 글).
   * [hwpx-cowork] 개체(표·그림·차트·도형)를 품은 범위는 kind 'object'(글 없음 — text '', start = end)·'mixed'(글과 개체), objects = [{ tag, what, name }],
   * label = '표 넣음'·'그림 2개 지움'·'글과 표 지움' …(engine/track-objects.js). 글만 든 범위는 예전 그대로(kind 없음)
   */
  changes() {
    const byId = new Map(this.header.changes().map((c) => [String(c.id), c]));
    const authors = new Map(this.header.authors().map((a) => [a.id, a.name]));
    const out = [];
    for (const sec of this.sections) for (const p of sec.paras) {
      // [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 사본(p.alt — 차트의 대체 OLE 캡션 등)의 표식은 변경이 아니다: 한/글 2022 는 그 사본을 첫 갈래에서
      // 새로 써 넣으며 캡션 전체를 TcId="0"(머리 항목 없음) 넣음으로 감싸고, 모두 수락한 뒤에도 그 표식을 남긴다(COM 실측) — 목록에 넣으면 유령 변경
      if (p.alt) continue;
      const marks = Section.changeMarks(p);
      for (const m of marks) {
        if (m.name !== 'hp:insertBegin' && m.name !== 'hp:deleteBegin') continue;
        const endName = m.name === 'hp:insertBegin' ? 'hp:insertEnd' : 'hp:deleteEnd';
        const end = marks.find((x) => x.name === endName && x.id === m.id && x.start > m.start);
        const chars = end ? p.chars.slice(m.pos, end.pos) : p.chars.slice(m.pos);
        const h = byId.get(String(m.id));
        const type = m.name === 'hp:insertBegin' ? 'Insert' : 'Delete';
        const item = {
          id: Number(m.id), type, ref: p.ref, where: Section.where(p),
          text: chars.map((c) => c.ch).join(''), author: h ? authors.get(h.authorID) || '?' : '?', date: h?.date || null,
          start: finalIndexAt(p, m.pos), end: end ? finalIndexAt(p, end.pos) : null, spansParagraph: !end,
        };
        if (end && m.objects?.length && end.objects === m.objects) {
          const objects = m.objects.map((o) => { const tag = anchorTag(o); return { tag, ...objectWhat(tag, tag === 'hp:rect' ? sec.xml.slice(o.start, o.end) : '') }; });
          const mixed = m.pos !== end.pos;
          Object.assign(item, { kind: mixed ? 'mixed' : 'object', objects, label: objectChangeLabel(type, objects, mixed) });
        }
        // [hwpx-cowork] 문단 나눔 변경(끝 표식 paraend="1"): paraEnd, 개체가 없으면 kind 'para'(폭 0 이면 start = end = 그 물리 문단 끝의 최종본 자리, ref = 묶음 ref)
        if (end?.paraEnd) {
          item.paraEnd = true;
          if (!item.kind) Object.assign(item, { kind: 'para', label: breakChangeLabel(type, m.pos !== end.pos) });
        }
        // [hwpx-cowork] 묶음에서 속성을 주지 않는(leader 아닌) member 의 글자를 모두 덮는 지움 = '지운 문단'(scope 'paragraph' — 웹이 나눔과 한 카드로 묶고,
        // 실시간 반영이 그 뒤 합친 문단 편집으로 되살리지 않는다)
        if (type === 'Delete' && end && p.members && !m.brk) {
          const k = Section.memberAtPos(p, m.start);
          if (k !== p.leader && k === Section.memberAtPos(p, end.start)) {
            const ms = p.members; const c1 = k + 1 < ms.length ? ms[k + 1].c0 : p.chars.length;
            if (c1 > ms[k].c0 && m.pos <= ms[k].c0 && end.pos >= c1) item.scope = 'paragraph';
          }
        }
        out.push(item);
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** 글 삽입(변경 추적). 최종본 기준 offset 에 text 를 넣는다. 반환: 변경 id */
  insertTracked(ref, offset, text, options = {}) {
    validateTextFormatting(text, options);
    return formattingTransaction(this, () => this._insertTracked(ref, offset, text, options));
  }

  _insertTracked(ref, offset, text, { author, date, format, runs } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    if (!text) throw new EngineError('EMPTY', '넣을 글이 없습니다');
    const { sec, p } = this.resolve(ref);
    const fc = Section.visibleChars(p, 'final');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > fc.length) throw new EngineError('RANGE', `위치가 문단 밖입니다 (0..${fc.length})`);
    const cp = fc[offset]?.run?.charPr ?? fc[offset - 1]?.run?.charPr ?? p.runs.at(-1)?.charPr ?? '0';
    const authorId = this.header.ensureAuthor(author);
    const id = this.header.addChange('Insert', authorId, date);
    if (!this.header.trackingEnabled()) this.header.setTracking(true);
    const edits = [insertEdit(sec, p, offset, `<hp:insertBegin Id="${id}" TcId="${id}"/>${inlineXml(text)}<hp:insertEnd Id="${id}" TcId="${id}" paraend="0"/>`)];
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, edits));
    applyInsertedFormatting(this, ref, offset, text, { format, runs }, Array.from(normalizedInsertedText(text), () => cp));
    return id;
  }

  /** 범위 삭제(변경 추적). [start,end) 는 최종본 코드포인트 오프셋. 반환: 변경 id */
  deleteTracked(ref, start, end, { author, date } = {}) {
    return this.replaceTracked(ref, start, end, '', { author, date });
  }

  /**
   * 범위 교체(변경 추적): 삭제 표식 + 삽입 표식. 반환: {deleteId, insertId}
   * 지울 범위 안에 개체(메모 시작·끝, 그림, 표, 필드 등 ctrl)가 끼면 그 자리에서 나눠 개체 앞뒤 글만 따로 지운다(V3_SPEC §4.3)
   * — 개체를 품은 삭제는 수락할 때 CTRL_INSIDE 가 나서 편집기용 최종본을 만들 수 없기 때문. 개체는 제자리에 남고,
   * 넣을 글은 첫 조각 뒤에 한 번만 들어간다(최종본에서 start 자리). 나뉘면 반환에 deleteIds(모든 삭제 id, 문서 순서)가 더해진다
   * (deleteId = 첫 조각; 번호는 첫 삭제 → 삽입 → 나머지 삭제 순). 변경 id 를 기억했다가 되돌리는(거절) 호출자는
   * deleteId 하나가 아니라 deleteIds 를 모두 담아야 한다(예: [...(r.deleteIds || [r.deleteId]), r.insertId]) — 첫 조각만 거절하면 나머지 삭제가 남는다.
   */
  replaceTracked(ref, start, end, text, options = {}) {
    validateTextFormatting(text, options);
    return formattingTransaction(this, () => this._replaceTracked(ref, start, end, text, options));
  }

  _replaceTracked(ref, start, end, text, { author, date, format, runs } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    const { sec, p } = this.resolve(ref);
    const fc = Section.visibleChars(p, 'final');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > fc.length || start > end) throw new EngineError('RANGE', `범위가 문단 밖입니다 (0..${fc.length})`);
    if (start === end) { if (!text) return {}; return { insertId: this.insertTracked(ref, start, text, { author, date, format, runs }) }; }
    const shapes = text ? replacementShapes(fc.slice(start, end), normalizedInsertedText(text), fc[start]?.run?.charPr ?? '0') : [];
    const ciA = p.chars.indexOf(fc[start]); const ciB = p.chars.indexOf(fc[end - 1]);
    assertNoOverlap(p, ciA, ciB);
    const segs = ctrlSplit(p, ciA, ciB);
    const authorId = this.header.ensureAuthor(author);
    const delIds = [this.header.addChange('Delete', authorId, date)];
    const insId = text ? this.header.addChange('Insert', authorId, date) : null;
    for (let k = 1; k < segs.length; k++) delIds.push(this.header.addChange('Delete', authorId, date));
    if (!this.header.trackingEnabled()) this.header.setTracking(true);
    const edits = [];
    segs.forEach(([a, b], k) => {
      const id = delIds[k];
      let tail = `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`;
      if (k === 0 && text) tail += `<hp:insertBegin Id="${insId}" TcId="${insId}"/>${inlineXml(text)}<hp:insertEnd Id="${insId}" TcId="${insId}" paraend="0"/>`;
      edits.push({ pos: afterChar(p, b), insert: tail });
      edits.push({ pos: beforeChar(p, a), insert: `<hp:deleteBegin Id="${id}" TcId="${id}"/>` });
    });
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, edits));
    if (text) applyInsertedFormatting(this, ref, start, text, { format, runs }, shapes);
    const out = { deleteId: delIds[0], insertId: insId };
    if (delIds.length > 1) out.deleteIds = delIds;
    return out;
  }

  /** 변경 수락 */
  acceptChange(id) { return this._resolveChange(id, 'accept'); }
  /** 변경 거절(되돌리기) */
  rejectChange(id) { return this._resolveChange(id, 'reject'); }
  /**
   * 모든 변경 수락. 번호가 다시 매겨지므로 큰 번호부터 처리한다(작은 번호는 흔들리지 않음 — resolveChanges 가 개체와 함께 지운 안쪽 변경의 번호 밀림도 따라간다).
   * tolerant=true 이면 던지지 않는다(V3_SPEC §4.3): 수락할 수 없는 변경(개체 아닌 부호가 낀 삭제 CTRL_INSIDE, 문단 경계에 걸친 변경
   * SPANS_PARAGRAPH 등)은 _acceptLoose 로 그 변경 표식만 지우고 글은 최종본 규칙대로 둔 뒤 나머지를 수락하고,
   * 끝에 남은 짝 없는 표식도 지운다(_sweepChangeMarks).
   * 반환: tolerant 일 때만 그렇게 처리한 것 [{ id, type, ref, code }](짝 없는 표식은 id null, code 'ORPHAN_MARK', mark = 표식 번호)
   */
  acceptAll(opts) {
    // [hwpx-cowork] 문단 나눔 변경(폭 0 나눔 표식과 지운 문단의 빈 run)은 먼저 구역마다 한 번에 — 변경 하나마다 구역을 다시 읽지 않는다(편집기 열기 viewerCopy)
    let back = null;
    try { back = this._acceptBreaksBatch(); } catch (e) { if (!opts?.tolerant && !(e instanceof EngineError)) throw e; back = null; }
    // [hwpx-cowork] (2026-11-03) 넣음(글·개체) 수락도 한 번에 — 표식만 지우는 변경이라 차례와 상관없다. 남은 것(지움·나뉜 범위 등)만 아래 하나씩
    let back2 = null;
    try { back2 = this._acceptInsertsBatch(); } catch (e) { if (!opts?.tolerant && !(e instanceof EngineError)) throw e; back2 = null; }
    if (!opts?.tolerant) { this.resolveChanges(this.changes().map((c) => c.id), 'accept'); return undefined; }
    const orig = (x) => { const y = back2 && back2.has(x) ? back2.get(x) : x; return back && back.has(y) ? back.get(y) : y; };
    let list = [];
    try { list = this.changes(); } catch { list = []; }
    const byId = new Map(list.map((c) => [c.id, c]));
    const r = this.resolveChanges(list.map((c) => c.id), 'accept', { tolerant: true, anyError: true });
    const out = r.detail.map((d) => ({ id: orig(d.id), type: byId.get(d.id)?.type, ref: byId.get(d.id)?.ref, code: d.code }));
    try { out.push(...this._sweepChangeMarks()); } catch { /* 보기용 사본 — 정리하지 못한 표식은 그대로 둔다 */ }
    return out;
  }
  rejectAll() { this.resolveChanges(this.changes().map((c) => c.id), 'reject'); }

  /**
   * [hwpx-cowork] 변경 여러 개를 수락(accept)·거절(reject) — 큰 번호부터 풀고, 다시 매김 기록(_renumberLog)을 따라 남은 변경의 지금 번호를 옮긴다
   * (안에 변경이 든 개체를 지우면 그 안 id 가 묶음 도중 지워지고 뒤 id 가 밀린다 — 옛 번호로 계속 풀면 엉뚱한 변경을 푼다). 기록은 비우지 않는다
   * (서비스가 takeRenumberLog 로 제안 changeIds 를 맞춘다).
   *  - tolerant(수락): 그대로 수락할 수 없으면(SPANS_PARAGRAPH·CTRL_INSIDE …) _acceptLoose(표식만 지우고 글은 최종본대로)
   *  - keepIfStuck(거절): 거절할 수 없으면 수락하고, 그것도 안 되면 _acceptLoose(실시간 '변경 추적으로'의 내 변경 다시 쓰기 — 서비스 옛 길과 같음)
   *  - 그 밖의 실패는 던진다(앞에서 푼 것은 그대로 — 예전 차례 호출과 같다). anyError = EngineError 가 아닌 것도 위 규칙으로(acceptAll tolerant)
   * @returns {{ done: number[], gone: number[], detail: Array<{ id: number, code: string }> }} 모두 원래 번호 — gone = 앞 변경이 개체째 지워 이미 없던 것,
   *   detail = 규칙대로 달리 처리한 것
   */
  resolveChanges(ids, mode = 'accept', { tolerant = false, keepIfStuck = false, anyError = false } = {}) {
    const accept = mode === 'accept';
    let want = [...new Set((ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => b - a);
    // [hwpx-cowork] 문단 나눔 변경은 다른 변경 뒤에 푼다 — 지운 문단의 글을 먼저 지워(넣은 문단의 글을 먼저 거절해) 나눔을 풀 때 합치는 물리 문단의
    // 비게 된 run 을 버린다(모두 수락 = 평탄화 사본, 모두 거절 = 원래 XML)
    const pe = this._paraEndIds();
    if (pe.size) want = [...want.filter((x) => !pe.has(x)), ...want.filter((x) => pe.has(x))];
    const cur = new Map(want.map((x) => [x, x]));
    const log = (this._renumberLog ??= []);
    const done = []; const gone = []; const detail = [];
    const engineErr = (e) => anyError || e instanceof EngineError;
    for (const orig of want) {
      const c = cur.get(orig);
      cur.delete(orig);
      if (c == null) { gone.push(orig); continue; }
      const from = log.length;
      try {
        this._resolveChange(c, accept ? 'accept' : 'reject');
      } catch (e) {
        if (!engineErr(e) || (accept ? !tolerant : !keepIfStuck)) throw e;
        if (!accept) {
          try { this._resolveChange(c, 'accept'); } catch (e2) { if (!engineErr(e2)) throw e2; this._acceptLoose(c); }
        } else {
          try { this._acceptLoose(c); } catch (e3) { if (!anyError) throw e3; /* 남은 표식은 _sweepChangeMarks 가 지운다 */ }
        }
        detail.push({ id: orig, code: e?.code || 'ERROR' });
      }
      done.push(orig);
      // 다시 매김 기록을 따라 남은 변경의 지금 번호를 옮긴다(서비스 _syncChangeIds 와 같은 규칙 — 지워진 번호는 없어짐)
      for (const entry of log.slice(from)) {
        for (const [o, n] of cur) {
          if (n == null) continue;
          cur.set(o, n === entry.removed ? null : (entry.map.has(n) ? entry.map.get(n) : n));
        }
      }
    }
    return { done, gone, detail };
  }

  /**
   * [hwpx-cowork] acceptAll 의 문단 나눔 묶음 처리(구역마다 applyEdits·다시 읽기 한 번, 머리 항목 다시 매김 한 번):
   *  - 폭 0 넣은 나눔·묶이지 않은 폭 0 지운 나눔: 표식만 지운다(표식만 든 hp:t 째)
   *  - 경계가 모두 폭 0 지운 나눔인 묶음: 물리 문단을 하나로(leader 의 여는 태그), 줄 정보를 지우고, leader 아닌 member 의 '모두 수락하면 빈 run'
   *    (보이는 글자·남는 부호가 없고 그 안 변경 표식의 짝이 모두 함께 버려지는 run)을 버린다 — 그 안의 지움(과 지운 개체)은 함께 수락된 것
   *  - 그 밖(a꼴 경계가 낀 묶음 등)은 그대로 — 뒤 resolveChanges 가 하나씩(나눔은 뒤에) 푼다
   * 실패하면 아무것도 바꾸지 않고 던진다. → 다시 매긴 번호 → 원래 번호 Map | null(한 것 없음)
   */
  _acceptBreaksBatch() {
    if (!this.sections.some((s) => s.xml.includes('paraend="1"'))) return null;
    const ids = new Set(); const objRemovals = []; const out = [];
    for (const sec of this.sections) {
      if (!sec.xml.includes('paraend="1"')) continue;
      const tok = sec.tokens; const xml = sec.xml;
      const edits = []; const marks = [];
      const groupBrk = new Set(); // 묶음 경계 나눔 표식(묶음째 처리하거나 뒤로 미룬 것)
      const droppedRuns = new Set(); // 묶음 member 의 '모두 수락하면 빈 run'으로 run 째 버리는 것
      // 구역의 변경 표식 id → 그 표식들(짝이 함께 버려지는가)
      const byId = new Map();
      for (const q of sec.paras) for (const a of q.anchors) if (a.kind === 'change' && a.id != null) { if (!byId.has(a.id)) byId.set(a.id, []); byId.get(a.id).push(a); }
      for (const p of sec.bodyParas) {
        if (!p.members) continue;
        const ms = p.members;
        const brks = ms.slice(0, -1).map((_, k) => Section.breakOf(p, k));
        for (const b of brks) if (b) { groupBrk.add(b.end); if (b.begin) groupBrk.add(b.begin); }
        if (!brks.every((b) => b && b.type === 'Delete' && b.zw && b.begin)) continue;
        const L = p.leader ?? 0;
        const brkSet = new Set(brks.flatMap((b) => [b.begin, b.end]));
        // leader 아닌 member 의 '모두 수락하면 빈 run' 후보
        const live = new Set();
        for (const c of p.chars) if (!c.del && c.run) live.add(c.run);
        for (const a of p.anchors) if (a.run && a.kind !== 'change' && !(isObjectAnchor(a) && a.del)) live.add(a.run);
        const lo = ms[L].r0; const hi = L + 1 < ms.length ? ms[L + 1].r0 : p.runs.length;
        const cand = new Set(p.runs.filter((r, i) => (i < lo || i >= hi) && !live.has(r)));
        const own = new Set(p.anchors);
        // 짝이 함께 버려지지 않는 표식이 든 run 은 남긴다(되풀이)
        for (let changed = true; changed;) {
          changed = false;
          for (const r of [...cand]) {
            const rm = p.anchors.filter((a) => a.run === r && a.kind === 'change' && !brkSet.has(a));
            if (rm.every((a) => (byId.get(a.id) || []).every((x) => brkSet.has(x) || (own.has(x) && x.run && cand.has(x.run))))) continue;
            cand.delete(r); changed = true;
          }
        }
        const dropRuns = [...cand];
        for (const r of dropRuns) droppedRuns.add(r);
        for (const r of dropRuns) for (const a of p.anchors) if (a.run === r && a.kind === 'change' && a.id != null && !brkSet.has(a)) ids.add(String(a.id));
        const dropObjs = outermostObjects(p.anchors.filter((a) => a.run && cand.has(a.run) && isObjectAnchor(a)));
        if (dropObjs.length) objRemovals.push({ sec, r: this._objectRemoval(sec, dropObjs) });
        if (L !== 0) edits.push({ start: tok[ms[0].openTok].start, end: tok[ms[0].openTok].end, insert: xml.slice(tok[ms[L].openTok].start, tok[ms[L].openTok].end) });
        for (let k = 0; k + 1 < ms.length; k++) edits.push({ start: tok[ms[k].closeTok].start, end: tok[ms[k + 1].openTok].end, insert: '' });
        dropLineseg(p, edits);
        for (const r of dropRuns) edits.push({ start: r.start, end: r.end, insert: '' });
        for (const b of brks) { ids.add(String(b.id)); if (!cand.has(b.begin.run)) marks.push(b.begin); if (!cand.has(b.end.run)) marks.push(b.end); }
      }
      // 묶음 경계가 아닌 폭 0 나눔(넣은 나눔·묶이지 않은 지운 나눔): 표식만
      for (const q of sec.paras) {
        for (let i = 0; i < q.anchors.length; i++) {
          const e = q.anchors[i];
          if (!e.brk || groupBrk.has(e) || (e.name !== 'hp:insertEnd' && e.name !== 'hp:deleteEnd')) continue;
          const bn = e.name === 'hp:insertEnd' ? 'hp:insertBegin' : 'hp:deleteBegin';
          let b = null;
          for (let j = i - 1; j >= 0; j--) { const x = q.anchors[j]; if (x.brk && x.name === bn && x.id === e.id) { b = x; break; } }
          if (!b || groupBrk.has(b)) continue;
          // (2026-11-03) 묶음 member 의 빈 run 째 버리는 표식(묶음 끝 member 에 붙여 넣은 넣은 나눔 등)은 그 run 과 함께 없어진다(id 는 위에서 ids 에).
          // 표식만 따로 지우면 run 지우기와 겹쳐 EDIT_OVERLAP — 묶음 전체가 하나씩 길로 밀려 편집기 열기가 수 분 걸렸다
          const gb = droppedRuns.has(b.run); const ge = droppedRuns.has(e.run);
          if (gb && ge) continue;
          if (!gb) marks.push(b);
          if (!ge) marks.push(e);
          ids.add(String(e.id));
          dropLineseg(q, edits);
        }
      }
      if (!edits.length && !marks.length) continue;
      edits.push(...markRemovalEdits(xml, marks));
      out.push({ sec, xml: applyEdits(xml, dedupe(edits)) });
    }
    if (!out.length) return null;
    for (const { r } of objRemovals) for (const x of r.ids) ids.add(String(x));
    const back = this._commitBatchAccept(ids, out);
    for (const { r } of objRemovals) this._afterObjectRemoval(r);
    return back;
  }

  /**
   * [hwpx-cowork] (2026-11-03) acceptAll 의 넣음(글·개체 — 문단 나눔이 아닌 것) 묶음: 넣음 수락 = 시작·끝 표식만 지운다(_resolvePair 의 넣음 수락과
   * 같은 편집 — markRemovalEdits·줄 정보). 문서에 표식이 그 짝 둘뿐인 변경만(나뉜 범위·문단 경계에 걸친 것·나눔 표식은 하나씩 길로). 구역마다 다시
   * 읽기 한 번, 머리 항목은 한 번에(_commitBatchAccept). 변경마다 구역을 다시 읽고 번호를 다시 매기던 것 — 변경 추적으로 큰 글을 붙인 문서의 편집기
   * 열기(작업본)가 수십 초~수 분이었다. 편집을 모두 만든 뒤에만 바꾼다(실패하면 아무것도 바꾸지 않고 던진다) → 다시 매긴 번호 → 원래 번호 Map | null
   */
  _acceptInsertsBatch() {
    const count = new Map(); const begins = [];
    for (const sec of this.sections) for (const p of sec.paras) {
      for (const a of p.anchors) {
        if (a.kind !== 'change' || a.id == null) continue;
        count.set(a.id, (count.get(a.id) || 0) + 1);
        if (a.name === 'hp:insertBegin') begins.push({ sec, p, begin: a });
      }
    }
    const per = new Map(); const ids = new Set();
    for (const { sec, p, begin } of begins) {
      if (count.get(begin.id) !== 2 || begin.brk) continue;
      const end = p.anchors.find((x) => x.kind === 'change' && x.name === 'hp:insertEnd' && x.id === begin.id && x.start > begin.start);
      if (!end || end.paraEnd || end.brk) continue;
      if (!per.has(sec)) per.set(sec, { marks: [], paras: new Set() });
      const s = per.get(sec); s.marks.push(begin, end); s.paras.add(p);
      ids.add(String(begin.id));
    }
    if (!ids.size) return null;
    const out = [];
    for (const [sec, { marks, paras }] of per) {
      const edits = markRemovalEdits(sec.xml, marks);
      for (const p of paras) dropLineseg(p, edits);
      out.push({ sec, xml: applyEdits(sec.xml, dedupe(edits)) });
    }
    return this._commitBatchAccept(ids, out);
  }

  /**
   * [hwpx-cowork] 묶음 수락의 마무리(_acceptBreaksBatch·_acceptInsertsBatch): 머리 항목 ids 를 한 번에 지우고 남은 번호를 다시 매겨(다시 매김 기록은
   * 큰 번호부터 하나씩 지운 것과 같게 — 셈으로) 새 구역 XML(out: [{ sec, xml }])과 손대지 않은 구역의 표식 번호를 맞춘다 → 다시 매긴 번호 → 원래 번호 Map
   */
  _commitBatchAccept(ids, out) {
    // 머리 항목: 한 번에 지우고 번호를 다시 매긴다(다시 매김 기록은 큰 번호부터 하나씩 지운 것과 같게 — 셈으로)
    const head = this.header.changes().sort((a, b) => a.id - b.id);
    const have = new Set(head.map((c) => String(c.id)));
    const removed = [...ids].filter((x) => have.has(x)).map(Number).sort((a, b) => b - a);
    let curIds = head.map((c) => c.id);
    const log = (this._renumberLog ??= []);
    const total = new Map(curIds.map((x) => [x, x]));
    for (const n of removed) {
      curIds = curIds.filter((x) => x !== n);
      const map = new Map(curIds.map((x, i) => [x, i + 1]));
      log.push({ removed: n, map });
      for (const [o, v] of total) { if (v == null) continue; total.set(o, v === n ? null : (map.get(v) ?? v)); }
      curIds = curIds.map((x, i) => i + 1);
    }
    const final = new Map([...total].filter(([, v]) => v != null).map(([o, v]) => [String(o), String(v)]));
    const renum = (x) => x.replace(/<hp:(insertBegin|insertEnd|deleteBegin|deleteEnd)\b([^>]*)\/>/g, (all, name, a) => `<hp:${name}${a.replace(/\b(Id|TcId)="(\d+)"/g, (m, k, v) => `${k}="${final.get(v) ?? v}"`)}/>`);
    const identity = [...final].every(([k, v]) => k === v);
    if (removed.length) this.header.rewriteChanges(head.filter((c) => final.has(String(c.id))).map((c) => ({ ...c, id: Number(final.get(String(c.id))) })));
    const touched = new Set(out.map((o) => o.sec));
    for (const o of out) o.sec.load(identity ? o.xml : renum(o.xml));
    if (!identity) for (const sec of this.sections) if (!touched.has(sec)) { const x = renum(sec.xml); if (x !== sec.xml) sec.load(x); }
    return new Map([...final].map(([o, v]) => [Number(v), Number(o)]));
  }

  /**
   * [hwpx-cowork] 너그러운 길(_acceptLoose·_sweepChangeMarks)의 묶음 합치기: 구역의 묶음 경계 가운데 그 나눔(Section.breakOf)이 pred 를 만족하는 것의
   * `</hp:p><hp:p…>` 와 줄 정보를 지운다(표식·글·빈 run 은 그대로 — 뒤에서 표식으로 지운다). 합친 물리 문단 사슬의 여는 태그는 내용이 남는 첫 member 것
   * (없으면 사슬 끝 — 최종본 속성). 합친 것이 있으면 구역을 다시 읽는다 → 합친 경계 수
   */
  _mergeGroups(sec, pred) {
    if (!sec.bodyParas.some((p) => p.members)) return 0;
    const tok = sec.tokens; const xml = sec.xml; const edits = []; let n = 0;
    for (const p of sec.bodyParas) {
      if (!p.members) continue;
      const ms = p.members;
      const join = ms.slice(0, -1).map((_, k) => { const b = Section.breakOf(p, k); return !!b && b.type === 'Delete' && pred(b); });
      if (!join.some(Boolean)) continue;
      for (let i = 0; i < ms.length;) {
        let j = i; while (j < ms.length - 1 && join[j]) j++;
        if (j > i) {
          let lead = j; for (let k = i; k < j; k++) if (Section.memberHasContent(p, k)) { lead = k; break; }
          if (lead !== i) edits.push({ start: tok[ms[i].openTok].start, end: tok[ms[i].openTok].end, insert: xml.slice(tok[ms[lead].openTok].start, tok[ms[lead].openTok].end) });
          for (let k = i; k < j; k++) { edits.push({ start: tok[ms[k].closeTok].start, end: tok[ms[k + 1].openTok].end, insert: '' }); n++; }
          for (let k = i; k <= j; k++) if (ms[k].lineseg) edits.push({ start: ms[k].lineseg.start, end: ms[k].lineseg.end, insert: '' });
        }
        i = j + 1;
      }
    }
    if (edits.length) sec.load(applyEdits(xml, dedupe(edits)));
    return n;
  }

  /** [hwpx-cowork] 문단 나눔 변경(끝 표식 paraend="1") id 들(숫자) — 표식이 없으면 빈 집합(구역 글을 훑기만) */
  _paraEndIds() {
    const out = new Set();
    for (const sec of this.sections) {
      if (!sec.xml.includes('paraend="1"')) continue;
      for (const p of sec.paras) for (const a of p.anchors) if (a.paraEnd && a.id != null && (a.name === 'hp:insertEnd' || a.name === 'hp:deleteEnd')) out.add(Number(a.id));
    }
    return out;
  }

  /**
   * tolerant 수락(그대로 수락할 수 없는 변경 하나): 변경 id 의 표식을 모든 문단에서 지우고, 삭제면 시작 표식이 있는 문단에서
   * 시작 표식 뒤 글자(같은 문단의 끝 표식까지, 끝 표식이 다른 문단에 있거나 없으면 문단 끝까지 = 최종본에서 안 보이는 글자)를
   * 하나씩 지운다. 개체 아닌 부호(ctrl — 메모 시작·끝, 필드 …)는 지우지 않고 제자리에 둔다(개체를 넘어 글을 이어 붙이지 않음).
   * [hwpx-cowork] 이 삭제가 품은 개체(표·그림·도형 — del = id, 최종본에서 안 보임)는 개체째 지운다(안의 변경·그림 파일·차트 부분·메모 정리 — _objectRemoval).
   * 그 범위 안 인라인 요소·다른 변경 표식은 acceptChange 처럼 지운다. 글자를 지우는 편집이 맞지 않으면 글은 두고 표식만 지운다.
   * 끝 표식이 다른 문단에 있는 삭제의 그 문단 글은 최종본에서 보이므로 남는다(문단은 합치지 않는다). 헤더 항목도 지우고 번호를 다시 매긴다.
   */
  _acceptLoose(id) {
    id = String(id);
    const nestedIds = new Set();
    // [hwpx-cowork] 이 변경이 묶음 경계의 지운 나눔이면 먼저 물리 문단을 합친다(아니면 표식을 지운 뒤 묶음이 갈라져 최종본보다 문단이 많아진다)
    for (const sec of this.sections) this._mergeGroups(sec, (b) => b.id === id);
    for (const sec of this.sections) {
      const markSet = new Set(); const text = []; const lines = [];
      const objs = outermostObjects(sec.paras.flatMap((p) => p.anchors.filter((a) => a.del === id && isObjectAnchor(a))));
      const r = objs.length ? this._objectRemoval(sec, objs) : null;
      for (const p of sec.paras) {
        if (r && r.covers(p)) continue;
        const own = Section.changeMarks(p).filter((m) => m.id === id);
        if (!own.length && !(r && r.owners.has(p))) continue;
        for (const m of own) markSet.add(m);
        dropLineseg(p, lines);
        const begin = own.find((m) => m.name === 'hp:deleteBegin');
        if (!begin) continue;
        const end = own.find((m) => m.name === 'hp:deleteEnd' && m.start > begin.start) || null;
        const stop = end ? end.pos : p.chars.length;
        for (let ci = begin.pos; ci < stop; ci++) text.push({ start: p.chars[ci].raw[0], end: p.chars[ci].raw[1], insert: '' });
        for (const a of p.anchors) {
          if (a.kind === 'ctrl' || (a.kind === 'change' && a.id === id) || markSet.has(a)) continue;
          // [hwpx-cowork] 끝 표식이 있으면 XML 차례로 범위 안의 것만 — 폭 0 범위(문단 나눔) 바로 뒤 다른 변경의 시작 표식을 지우지 않게
          const inside = end ? a.start >= begin.end && a.end <= end.start : (a.pos > begin.pos && a.pos < stop) || (a.pos === begin.pos && a.start > begin.start);
          if (inside) {
            text.push({ start: a.start, end: a.end, insert: '' });
          }
        }
      }
      if (r) for (const m of r.marks) markSet.add(m);
      if (!markSet.size && !r) continue;
      const marks = markRemovalEdits(sec.xml, [...markSet]);
      const objEdits = r ? r.edits : [];
      let xml;
      try { xml = applyEdits(sec.xml, dedupe([...marks, ...text, ...lines, ...objEdits])); } catch { xml = applyEdits(sec.xml, dedupe([...marks, ...lines, ...objEdits])); }
      sec.load(xml);
      if (r) { this._afterObjectRemoval(r); for (const x of r.ids) nestedIds.add(x); }
    }
    nestedIds.delete(id);
    this._removeChangeIds([id, ...nestedIds]);
  }

  /**
   * tolerant 정리: 수락 뒤에도 남은 변경 표식(짝 없는 끝 표식, 헤더 번호가 비어 수락되지 않은 것 등)을 모두 지우고,
   * 최종본에서 안 보이는 글자(삭제 표시된 글자)도 하나씩 지운다(개체 아닌 부호는 남김). [hwpx-cowork] 삭제 표시된 개체(del)는 개체째 지운다(최종본에 없다).
   * 헤더 항목은 건드리지 않는다.
   * 반환: [{ id: null, mark, type, ref, code: 'ORPHAN_MARK' }] — 지운 표식마다
   */
  _sweepChangeMarks() {
    const out = [];
    // [hwpx-cowork] 남은 묶음(지운 나눔으로 이은 물리 문단)은 먼저 모두 합친다 — 표식을 지우면 묶음이 갈라진다
    for (const sec of this.sections) this._mergeGroups(sec, () => true);
    for (const sec of this.sections) {
      const markSet = []; const text = []; const lines = [];
      const objs = outermostObjects(sec.paras.flatMap((p) => p.anchors.filter((a) => a.del && isObjectAnchor(a))));
      const r = objs.length ? this._objectRemoval(sec, objs) : null;
      for (const p of sec.paras) {
        if (r && r.covers(p)) continue;
        const own = Section.changeMarks(p);
        if (!own.length && !(r && r.owners.has(p))) continue;
        for (const m of own) {
          markSet.push(m);
          out.push({ id: null, mark: m.id != null ? Number(m.id) : null, type: m.name.slice(3), ref: p.ref, code: 'ORPHAN_MARK' });
        }
        for (const c of p.chars) if (c.del) text.push({ start: c.raw[0], end: c.raw[1], insert: '' });
        dropLineseg(p, lines);
      }
      if (!markSet.length && !r) continue;
      const marks = markRemovalEdits(sec.xml, [...new Set([...markSet, ...(r ? r.marks : [])])]);
      const objEdits = r ? r.edits : [];
      let xml;
      try { xml = applyEdits(sec.xml, dedupe([...marks, ...text, ...lines, ...objEdits])); } catch { xml = applyEdits(sec.xml, dedupe([...marks, ...lines, ...objEdits])); }
      sec.load(xml);
      if (r) this._afterObjectRemoval(r);
    }
    return out;
  }

  /**
   * 변경 하나 수락·거절. 글을 없애는 쪽(넣음 거절·지움 수락)은 범위 안 글자·인라인 요소·다른 변경 표식을 지운다.
   * [hwpx-cowork] 범위 안 개체(표·그림·차트·도형 — 개체에 붙은 표식이든 글과 섞인 범위든)는 개체째 지운다: 안의 변경(캡션·칸 글)의 머리 항목,
   * 아무도 안 쓰는 그림 파일·차트 부분, 그 안에서 열린 메모의 끝까지 정리한다(_objectRemoval). 개체 아닌 부호(메모·필드 경계, 구역 정의, 머리말 등)가
   * 끼면 여전히 CTRL_INSIDE. 남기는 쪽(넣음 수락·지움 거절)은 표식만 지운다(개체에 붙은 표식이 홀로 든 hp:t 는 그 hp:t 째).
   */
  _resolveChange(id, mode) {
    id = String(id);
    // [hwpx-cowork] 같은 번호의 범위가 여러 문단에 있으면(가른 문단에 걸친 변경을 복제한 것 — splitParagraphTracked) 모두 푼다
    const more = new Set(); let found = false;
    for (let guard = 0; guard < 1000; guard++) {
      const hit = this._pairOf(id);
      if (!hit) break;
      const r = this._resolvePair(hit.sec, hit.p, hit.begin, id, mode);
      found = true;
      if (r) for (const x of r.ids) if (x !== id) more.add(x);
    }
    if (found) {
      // 머리 항목: 이 변경 + 개체와 함께 없어진 안쪽·붙은 변경 — 큰 번호부터(다시 매김 기록에 하나씩 남는다)
      this._removeChangeIds([id, ...more], { always: id });
      return true;
    }
    // 본문에 표식이 없으면 헤더 항목만 정리
    const ok = this.header.removeChange(parseInt(id, 10));
    if (ok) this._renumberChanges(parseInt(id, 10));
    return ok;
  }

  /** [hwpx-cowork] 변경 id 의 첫 시작 표식 → { sec, p, begin } | null */
  _pairOf(id) {
    for (const sec of this.sections) for (const p of sec.paras) {
      const begin = p.anchors.find((m) => m.kind === 'change' && m.id === id && (m.name === 'hp:insertBegin' || m.name === 'hp:deleteBegin'));
      if (begin) return { sec, p, begin };
    }
    return null;
  }

  /** [hwpx-cowork] _resolveChange 의 범위 하나(문단 p 의 시작 표식 begin) 풀기 — 구역을 다시 읽는다. → 개체째 지운 것(_objectRemoval) | null */
  _resolvePair(sec, p, begin, id, mode) {
    {
      const marks = Section.changeMarks(p);
      const isInsert = begin.name === 'hp:insertBegin';
      const end = marks.find((m) => m.id === id && m.name === (isInsert ? 'hp:insertEnd' : 'hp:deleteEnd') && m.start > begin.start);
      if (!end) throw new EngineError('SPANS_PARAGRAPH', `변경 ${id} 는 문단 경계에 걸쳐 있어 한글에서 처리해야 합니다`);
      const removeText = (isInsert && mode === 'reject') || (!isInsert && mode === 'accept');
      const markSet = new Set([begin, end]);
      let edits = [];
      const objs = [];
      const gone = { chars: new Set(), anchors: new Set() }; // [hwpx-cowork] 이 풀기로 없어지는 글자·표식·개체(문단 나눔 합침의 '비게 된 run')
      if (removeText) {
        for (let ci = begin.pos; ci < end.pos; ci++) { edits.push({ start: p.chars[ci].raw[0], end: p.chars[ci].raw[1], insert: '' }); gone.chars.add(p.chars[ci]); }
        for (const a of p.anchors) {
          if (a === begin || a === end || a.start < begin.end || a.end > end.start) continue; // 범위 안(XML 차례) 것만
          if (a.kind === 'ctrl') {
            if (isObjectAnchor(a)) { objs.push(a); gone.anchors.add(a); continue; }
            throw new EngineError('CTRL_INSIDE', `변경 ${id} 안에 개체/필드가 있어 자동 처리하지 않습니다`);
          }
          gone.anchors.add(a);
          if (a.kind === 'inline') edits.push({ start: a.start, end: a.end, insert: '' });
          else if (a.kind === 'change' && a.id !== id) { if (a.attach || a.brk) markSet.add(a); else edits.push({ start: a.start, end: a.end, insert: '' }); }
        }
      }
      const r = objs.length ? this._objectRemoval(sec, objs) : null;
      if (r) { edits.push(...r.edits); for (const m of r.marks) markSet.add(m); }
      for (const m of markSet) gone.anchors.add(m);
      edits.push(...markRemovalEdits(sec.xml, [...markSet]));
      dropLineseg(p, edits);
      // [hwpx-cowork] 문단 나눔 변경(끝 표식 paraend="1", 본문): 지운 나눔 수락·넣은 나눔 거절 = 물리 문단 합침, 지운 나눔 거절 = 묶음이 갈라짐(문단 기록)
      const brk = end.paraEnd && !p.parent ? this._breakEffect(sec, p, end, isInsert, mode, gone, r, edits) : null;
      if (brk) {
        edits = edits.filter((e) => !brk.drop.some(([x, y]) => (e.start ?? e.pos) >= x && (e.end ?? e.pos) <= y));
        edits.push(...brk.edits);
      }
      sec.load(applyEdits(sec.xml, dedupe(edits)));
      if (r) this._afterObjectRemoval(r);
      if (brk?.log && !this._paraLogMute) (this._paraLog ??= []).push(brk.log);
      return r;
    }
  }

  /**
   * [hwpx-cowork] 문단 나눔 변경 하나를 풀 때의 구조 효과(_resolveChange 안 — 구역을 다시 읽기 전): p = 끝 표식(end, paraend="1")이 든 본문 기록,
   * gone = 이 풀기로 없어지는 글자·표식·개체, edits = 이 풀기의 다른 편집(이음매 접기가 통째로 지우는 hp:t 를 피한다).
   *  - 지운 나눔 수락(묶음 안): member k·k+1 을 물리로 합친다(최종본 그대로 — 남는 내용이 없는 앞 member 는 뒤 member 속성에 자리를 내준다)
   *  - 지운 나눔 거절(묶음 안): 표식만 지우면 다시 읽을 때 묶음이 갈라진다 → 문단 기록 { op:'split' }
   *  - 넣은 나눔 거절: 이 물리 문단과 다음 본문 물리 문단을 합친다 → 문단 기록 { op:'merge' }(묶음 가운데면 기록 없음)
   *  - 넣은 나눔 수락·묶이지 않은 지운 나눔(구역 끝 등)·다음 문단 첫 run 에 구역 정의(secPr): 표식·글만(null)
   * → { edits, drop: [[start,end]](그 안의 다른 편집은 버린다), log? } | null
   */
  _breakEffect(sec, p, end, isInsert, mode, gone, r, edits) {
    const ms = Section.members(p); const k = Section.memberAtPos(p, end.start);
    if (!isInsert) {
      if (k >= ms.length - 1) return null;
      if (mode === 'reject') return { edits: [], drop: [], log: { sec: sec.index, op: 'split', at: p.body, ...this._partCounts(sec, p, ms[k + 1].start, null) } };
      const keep = memberContentAfter(p, k, gone) ? 'A' : 'B';
      return this._mergeEdits(sec, { rec: p, k }, { rec: p, k: k + 1 }, gone, keep, edits);
    }
    if (mode !== 'reject') return null;
    let B;
    if (k < ms.length - 1) B = { rec: p, k: k + 1 };
    else { const q = sec.bodyParas[p.body + 1]; if (!q) return null; B = { rec: q, k: 0 }; }
    const keep = memberContentAfter(p, k, gone) || !memberContentAfter(B.rec, B.k, gone) ? 'A' : 'B';
    const out = this._mergeEdits(sec, { rec: p, k }, B, gone, keep, edits);
    if (out && B.rec !== p) out.log = { sec: sec.index, op: 'merge', at: p.body, ...this._partCounts(sec, p, Infinity, r) };
    return out;
  }

  /**
   * [hwpx-cowork] 두 물리 본문 문단 A·B(잇닿음 — { rec, k }: 기록과 member 번호)를 하나로 합치는 편집(다시 읽기 전 좌표): `</hp:p><hp:p…>` 와 두 줄 정보를
   * 지우고, keep 'A'(A 속성 — B 에서 이 풀기 뒤 빈 run 은 버림) | 'B'(B 속성 — A 의 여는 태그를 B 것으로, A 의 빈 run 은 버림). A 마지막 run 과 B 의 첫 남는
   * run 이 같은 글자 모양이고 이음매가 `</hp:t></hp:run>…<hp:run><hp:t>` 뿐이면 접는다(가른 뒤 거절하면 원래 run 하나로). B 첫 run 에 구역 정의(secPr)가
   * 있으면 합치지 않는다(null — 표식만). → { edits, drop }
   */
  _mergeEdits(sec, A, B, gone, keep, others = []) {
    const tok = sec.tokens; const xml = sec.xml;
    const am = Section.members(A.rec)[A.k]; const bm = Section.members(B.rec)[B.k];
    const runsOf = (rec, k) => { const ms = Section.members(rec); const lo = ms[k].r0; const hi = k + 1 < ms.length ? ms[k + 1].r0 : rec.runs.length; return rec.runs.slice(lo, hi); };
    const aRuns = runsOf(A.rec, A.k); const bRuns = runsOf(B.rec, B.k);
    if (bRuns[0] && xml.slice(bRuns[0].start, bRuns[0].end).includes('<hp:secPr')) return null;
    const alive = (rec) => {
      const s = new Set();
      for (const c of rec.chars) if (!gone.chars.has(c)) s.add(c.run);
      for (const a of rec.anchors) if (!gone.anchors.has(a)) s.add(a.run);
      return s;
    };
    const dropSide = keep === 'A' ? B : A; const live = alive(dropSide.rec);
    const dropRuns = (keep === 'A' ? bRuns : aRuns).filter((r) => !live.has(r));
    const dropSet = new Set(dropRuns);
    const edits = []; const drop = dropRuns.map((r) => [r.start, r.end]);
    const x0 = tok[am.closeTok].start; const x1 = tok[bm.openTok].end;
    if (keep === 'B') edits.push({ start: tok[am.openTok].start, end: tok[am.openTok].end, insert: xml.slice(tok[bm.openTok].start, tok[bm.openTok].end) });
    // 이음매 접기(A 속성일 때만)
    let seam = null;
    if (keep === 'A') {
      const aLast = aRuns[aRuns.length - 1]; const bKept = bRuns.filter((r) => !dropSet.has(r)); const bFirst = bKept[0];
      if (aLast && bFirst && !aLast.selfclose && !bFirst.selfclose && aLast.charPr === bFirst.charPr) {
        const aT = A.rec.ts.filter((t) => t.run === aLast).pop(); const bT = B.rec.ts.find((t) => t.run === bFirst);
        const whole = (t) => others.some((e) => e.start != null && e.start <= t.openStart && e.end >= t.closeEnd);
        const lead = bRuns.slice(0, bRuns.indexOf(bFirst));
        const okA = aT && !aT.selfclose && aT.closeEnd === aLast.end - '</hp:run>'.length && xml.slice(aT.closeStart, aT.closeEnd) === '</hp:t>'
          && xml.slice(aLast.end, x0) === (am.lineseg ? xml.slice(am.lineseg.start, am.lineseg.end) : '') && (!am.lineseg || am.lineseg.start === aLast.end);
        const okB = bT && !bT.selfclose && bT.openStart === xml.indexOf('>', bFirst.start) + 1 && xml.slice(bT.openStart, bT.openEnd) === '<hp:t>'
          && lead.every((r) => dropSet.has(r)) && xml.slice(x1, bFirst.start) === lead.map((r) => xml.slice(r.start, r.end)).join('');
        if (okA && okB && !whole(aT) && !whole(bT)) seam = [aT.closeStart, bT.openEnd];
      }
    }
    if (seam) {
      edits.push({ start: seam[0], end: seam[1], insert: '' });
      drop.push(seam);
      if (bm.lineseg) edits.push({ start: bm.lineseg.start, end: bm.lineseg.end, insert: '' });
      for (const r of dropRuns) if (r.start >= seam[1]) edits.push({ start: r.start, end: r.end, insert: '' });
    } else {
      edits.push({ start: x0, end: x1, insert: '' });
      for (const ls of [am.lineseg, bm.lineseg]) if (ls) edits.push({ start: ls.start, end: ls.end, insert: '' });
      for (const r of dropRuns) edits.push({ start: r.start, end: r.end, insert: '' });
    }
    return { edits, drop };
  }

  /** [hwpx-cowork] 본문 기록 p 에서 XML 자리 upto 앞의 직접 중첩 문단·제 표 수(없어질 개체 r 안 것은 뺌) → { n(보이는 '/n'), d(숨은 '/d'), t('#t'), td('#d') } */
  _partCounts(sec, p, upto, r) {
    const out = { n: 0, d: 0, t: 0, td: 0 };
    const inGone = (x) => !!r && r.edits.some((e) => e.start <= x.start && x.end <= e.end);
    for (const c of p.children) { if (c.start >= upto || inGone(c)) continue; if (c.hidden) out.d++; else out.n++; }
    for (const t of this._tableIndex(sec).tables) { if (t.owner !== p || t.start >= upto || inGone(t)) continue; if (t.hidden) out.td++; else out.t++; }
    return out;
  }

  /**
   * [hwpx-cowork] 문단 기록(수락·거절이 최종본 문단 구조를 바꾼 것 — 지운 나눔 거절 = 'split', 넣은 나눔 거절 = 'merge')을 돌려주고 비운다.
   * 항목 { sec, op, at(최종본 본문 번호), n, d, t, td(첫 부분의 직접 중첩 문단 '/n'·'/d' 수, 제 표 '#t'·'#d' 수) } — 서비스가 meta ref 를 옮긴다.
   * 쓰는 함수(deleteBreakAfter 등)는 적지 않는다(구조 영향을 돌려주는 값으로 알린다)
   */
  takeParaLog() { const l = this._paraLog || []; this._paraLog = []; return l; }

  /**
   * [hwpx-cowork] 물리 ref(나눔을 지워 이은 묶음을 따로 센 본문 번호 — 묶기 전 문서의 ref) → 최종본 ref | null. 묶음 안 뒤 member 의 중첩 '/n'·'/d'·표 '#t'·'#d'
   * 번호는 앞 member 들 것만큼 민다(옮기기 전용 — 한/글에서 올린 paraend="1" 문서)
   */
  physToFinalRef(ref) {
    const m = /^s(\d+)\/p(\d+)(?:\/([nd])(\d+))?(.*)$/.exec(String(ref ?? ''));
    if (!m) return null;
    const sec = this.sections[Number(m[1])]; if (!sec) return null;
    let i = Number(m[2]);
    for (const p of sec.bodyParas) {
      const ms = Section.members(p);
      if (i >= ms.length) { i -= ms.length; continue; }
      const base = `s${sec.index}/p${p.body}`;
      const tail = m[3] ? `/${m[3]}${m[4]}${m[5]}` : m[5];
      if (i === 0) return base + tail;
      const c = this._partCounts(sec, p, ms[i].start, null);
      if (m[3]) return `${base}/${m[3]}${Number(m[4]) + (m[3] === 'n' ? c.n : c.d)}${m[5]}`;
      const tm = /^#([td])(\d+)(.*)$/.exec(m[5]);
      if (tm) return `${base}#${tm[1]}${Number(tm[2]) + (tm[1] === 't' ? c.t : c.td)}${tm[3]}`;
      return base + m[5];
    }
    return null;
  }

  /**
   * [hwpx-cowork] 변경 id 들의 머리 항목을 지우고 번호를 다시 매긴다 — 큰 번호부터(작은 번호가 흔들리지 않게, 다시 매김 기록에 하나씩 남는다).
   * 머리에 없는 번호는 건너뛴다(always 는 없어도 예전처럼 다시 매긴다)
   */
  _removeChangeIds(ids, { always = null } = {}) {
    const have = new Set(this.header.changes().map((c) => String(c.id)));
    const list = [...new Set([...ids].map((x) => parseInt(x, 10)).filter(Number.isInteger))].sort((a, b) => b - a);
    for (const n of list) {
      if (!have.has(String(n)) && String(n) !== String(always)) continue;
      this.header.removeChange(n);
      this._renumberChanges(n);
    }
  }

  /**
   * [hwpx-cowork] 한 구역의 개체 anchor 들(서로 겹치지 않는 것)을 지우는 편집과 뒷정리 거리(구역을 다시 읽기 전에 모은다):
   *  - edits: 개체 요소째 지우기, marks: 이 개체들에만 붙은 변경 표식(begin.attach ⊆ 지우는 개체 — 개체와 함께 없어진다)
   *  - ids: 개체 안 문단의 변경 id + 붙은 표식의 id(머리 항목을 지워야 한다 — _removeChangeIds)
   *  - xmls·begins: 그림 파일·차트 부분을 거둘 개체 XML, 개체 안에서 열린 필드(메모) id(다른 문단에 남은 끝을 지운다)
   *  - covers(q): 문단 q 가 지우는 개체 안인가, owners: 지우는 개체를 run 에 가진 문단들
   * 다시 읽은 뒤 _afterObjectRemoval 로 거둔다
   */
  _objectRemoval(sec, objs) {
    const set = new Set(objs);
    const edits = objs.map((a) => ({ start: a.start, end: a.end, insert: '' }));
    const xmls = objs.map((a) => sec.xml.slice(a.start, a.end));
    const begins = xmls.flatMap((x) => [...x.matchAll(/<hp:fieldBegin\b[^>]*?\sid="([^"]*)"/g)].map((m) => m[1]));
    const covers = (q) => objs.some((a) => a.start <= q.start && q.end <= a.end);
    const ids = new Set(); const marks = []; const owners = new Set();
    for (const q of sec.paras) {
      if (covers(q)) { for (const m of q.anchors) if (m.kind === 'change' && m.id != null) ids.add(String(m.id)); continue; }
      if (!q.anchors.some((a) => set.has(a))) continue;
      owners.add(q);
      for (const m of q.anchors) if (m.kind === 'change' && m.attach && m.attach.every((o) => set.has(o))) { marks.push(m); if (m.id != null) ids.add(String(m.id)); }
    }
    return { edits, marks, ids, xmls, begins, covers, owners };
  }

  /** [hwpx-cowork] _objectRemoval 뒤(구역을 다시 읽은 다음): 아무도 안 쓰는 그림 파일·차트 부분을 거두고, 개체째 지운 메모의 남은 끝을 지운다 */
  _afterObjectRemoval(r) {
    for (const x of r.xmls) {
      for (const b of new Set([...x.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]))) this.removeUnusedBinary(b);
      this._releaseShapeParts(x);
    }
    if (r.begins.length) this._sweepOrphanFieldEnds(r.begins);
  }

  /** 변경 번호 재부여 기록 {removed, map(old→new)} 을 돌려주고 비운다(서비스가 제안의 changeIds 를 맞추는 데 쓴다). */
  takeRenumberLog() { const l = this._renumberLog || []; this._renumberLog = []; return l; }

  /**
   * 한글은 변경 항목을 헤더 목록의 '위치'로 찾으므로(TcId n = n번째 항목) 항목을 지운 뒤에는
   * 헤더 id 와 본문 표식의 Id/TcId 를 1..n 으로 다시 매긴다.
   */
  _renumberChanges(removedId) {
    const list = this.header.changes().sort((a, b) => a.id - b.id);
    const map = new Map(list.map((c, i) => [String(c.id), String(i + 1)]));
    (this._renumberLog = this._renumberLog || []).push({ removed: removedId, map: new Map([...map].map(([k, v]) => [Number(k), Number(v)])) });
    if ([...map].every(([k, v]) => k === v)) return;
    this.header.rewriteChanges(list.map((c, i) => ({ ...c, id: i + 1 })));
    for (const sec of this.sections) {
      const xml = sec.xml.replace(/<hp:(insertBegin|insertEnd|deleteBegin|deleteEnd)\b([^>]*)\/>/g, (all, name, a) => {
        const b = a.replace(/\b(Id|TcId)="(\d+)"/g, (m, k, v) => `${k}="${map.get(v) ?? v}"`);
        return `<hp:${name}${b}/>`;
      });
      if (xml !== sec.xml) sec.load(xml);
    }
  }

  /**
   * 모든 변경을 수락한 복제본(편집기용 최종본).
   * tolerant=true 이면 절대 던지지 않는다(V3_SPEC §4.3): 수락할 수 없는 변경(CTRL_INSIDE·SPANS_PARAGRAPH 등)은 표식만 지우고
   * 글은 최종본 규칙대로 둔다(acceptAll 참고 — 사본의 글 = 원본 paragraphs({ view: 'final' }) 의 글).
   * 그렇게 처리한 변경 id(원본 번호, 오름차순)는 사본과 원본의 lastTolerantSkips 에, 자세한 내용은 lastTolerantDetail 에 남긴다.
   */
  async flattened(opts) {
    const d = await this.clone();
    if (!opts?.tolerant) { d.acceptAll(); d.setTracking(false); return d; }
    const detail = d.acceptAll({ tolerant: true });
    d.setTracking(false);
    const ids = [...new Set(detail.filter((x) => x.id != null).map((x) => x.id))].sort((a, b) => a - b);
    d.lastTolerantSkips = ids; d.lastTolerantDetail = detail;
    this.lastTolerantSkips = ids; this.lastTolerantDetail = detail;
    return d;
  }

  /**
   * 보기·편집기용 최종본 사본. 저장 줄 복원은 엔진이 담당하므로 정상 줄 정보를 보존한다.
   * tolerant 는 flattened 와 같다(서버 작업본은 tolerant — 편집기가 문서를 못 여는 일을 막는다).
   */
  async viewerCopy(opts) {
    const tolerant = !!opts?.tolerant;
    const d = await this.flattened({ tolerant });
    // [hwpx-cowork] 0.8.7의 전 구역 재조판을 피하려고 떠 있는 개체 앞의 줄을
    // 지우던 보정은 폐기한다. 일부 줄이 없다는 이유로 정상 표지·쪽 경계까지
    // 무효화하면 수정된 엔진에도 원본과 다른 입력을 넘기게 된다.
    d.layoutFixed = 0;
    return d;
  }

  // ───────── 메모 ─────────

  /**
   * 메모 목록(구역 순서, 구역 안에서는 시작 표식 순서).
   * key = `s{구역}:f{fieldId}` — 메모 스레드 열쇠(V3_SPEC §3.6, memoKey 와 같음; fieldId 가 없으면 null).
   */
  memos() {
    const out = [];
    for (const sec of this.sections) {
      const begins = []; const ends = new Map(); // 끝 표식: beginIDRef → [{ q, a }](문단 순서, 문단 안에서는 표식 순서)
      for (const p of sec.paras) for (const a of Section.fieldCtrls(p)) {
        if (p.alt) break; // [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 사본 안 메모는 보이는 갈래 메모의 사본
        if (a.inner === 'hp:fieldBegin' && a.innerAttrs?.get('type') === 'MEMO') begins.push({ p, a });
        if (a.inner === 'hp:fieldEnd') {
          const k = a.innerAttrs?.get('beginIDRef');
          if (!ends.has(k)) ends.set(k, []);
          ends.get(k).push({ q: p, a });
        }
      }
      for (const { p, a } of begins) {
        const fieldId = a.innerAttrs.get('id');
        const body = p.children.filter((c) => c.container === 'hp:fieldBegin' && c.start >= a.start && c.end <= a.end);
        // 끝 표식 = 시작 문단 또는 그 뒤 문단에서 처음 나오는 짝
        const e = (ends.get(fieldId) || []).find((x) => x.q.idx >= p.idx);
        const endInfo = e ? { p: e.q, a: e.a } : null;
        const start = finalIndexAt(p, a.pos);
        const end = endInfo ? finalIndexAt(endInfo.p, endInfo.a.pos) : null;
        const sameP = endInfo && endInfo.p === p;
        const param = (name) => memoParamAt(sec.xml, a, name);
        out.push({
          id: param('ID'), number: parseInt(param('Number') || '0', 10), author: param('Author') || '',
          created: memoCreated(param('Command'), param('CreateDateTime')), fieldId,
          ref: p.ref, where: Section.where(p), start, end: sameP ? end : null, endRef: endInfo ? endInfo.p.ref : null,
          anchorText: sameP ? Section.text(p, 'final').slice(cpToUnit(Section.text(p, 'final'), start), cpToUnit(Section.text(p, 'final'), end)) : null,
          text: body.map((c) => Section.text(c, 'final')).join('\n'),
          key: memoKey({ section: sec.index, fieldId }),
          ...(p.hidden ? { hidden: true } : {}), // [hwpx-cowork] 변경 추적으로 지운 개체 안 메모(ref '/d' — 최종본·작업본에 없음)
        });
      }
    }
    return out;
  }

  /** 메모 추가. [start,end) 생략 시 문단 전체. 반환: 메모 ID(memoN) */
  addMemo(ref, { start, end, author, text, date }) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    if (!text) throw new EngineError('EMPTY', '메모 글이 없습니다');
    const { sec, p } = this.resolve(ref);
    const range = memoRange(p, start, end);
    const existing = this.memos();
    const number = existing.length ? Math.max(...existing.map((m) => m.number)) + 1 : 1;
    const memoId = uniqueMemoId(existing, number);
    const fieldId = uniqueNumber(sec.xml, 'id'); const fid = uniqueNumber(sec.xml, 'fieldid');
    const zorder = (sec.xml.match(/type="MEMO"/g) || []).length + 1;
    const { beginXml, endXml } = memoCtrlXml(this.header.memoStyle(), { number, memoId, fieldId, fid, zorder, author, text, when: date || new Date() });
    sec.load(applyEdits(sec.xml, memoEdits(sec, p, range, beginXml, endXml)));
    return memoId;
  }

  /** 검증된 엔진이 만든 필드/각주 조각만 삽입한다. 원래 run·개체·메모·문단은 다시 쓰지 않는다. */
  insertControlFragment(ref, { start, end = start, beginXml, endXml = '' }) {
    const { sec, p } = this.resolve(ref); const fc = Section.visibleChars(p, 'final');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > fc.length) throw new EngineError('RANGE', '컨트롤 위치가 문단 밖입니다');
    const point = (offset, xml) => {
      if (!fc.length) return emptyParagraphEdit(sec, p, '', xml);
      return offset === fc.length ? ctrlPointAfter(p, p.chars.indexOf(fc.at(-1)), xml)
        : ctrlPointBefore(p, p.chars.indexOf(fc[offset]), xml);
    };
    const edits = start === end ? [point(start, beginXml + endXml)] : [point(end, endXml), point(start, beginXml)];
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, edits));
  }

  /** 각주/미주 생성 엔진이 다시 매긴 번호만 복사한다. 기존 주석 글·개체·서식은 그대로 둔다. */
  syncNoteNumbersFrom(source) {
    const notes = doc => doc.sections.flatMap(sec => sec.paras.filter(p => Section.visibleParagraph(p, 'final')).flatMap(p =>
      p.anchors.filter(a => a.kind === 'ctrl' && !a.del && ['hp:footNote', 'hp:endNote'].includes(a.inner)).map(a => ({ sec, p, a }))));
    const current = notes(this), generated = notes(source);
    if (current.length !== generated.length || current.some((n, i) => n.a.inner !== generated[i].a.inner)) throw new EngineError('EDIT_PRESERVATION', '각주/미주 번호를 대조할 수 없습니다');
    const edits = new Map(), changed = new Map();
    for (let i = 0; i < current.length; i++) {
      const { sec, p, a } = current[i], number = generated[i].a.innerAttrs?.get('number');
      if (!/^\d+$/.test(number || '')) throw new EngineError('EDIT_PRESERVATION', '생성 엔진의 주석 번호가 올바르지 않습니다');
      const xml = sec.xml.slice(a.start, a.end), tag = new RegExp(`<${a.inner}\\b[^>]*>`).exec(xml);
      if (!tag || !/\bnumber="[^"]*"/.test(tag[0])) throw new EngineError('EDIT_PRESERVATION', '기존 주석의 번호 속성을 찾지 못했습니다');
      const list = edits.get(sec) || [], paras = changed.get(sec) || new Set();
      if (number !== a.innerAttrs?.get('number')) {
        list.push({ pos: a.start + tag.index, end: a.start + tag.index + tag[0].length, insert: tag[0].replace(/\bnumber="[^"]*"/, `number="${number}"`) }); paras.add(p);
      }
      const gen = generated[i], genXml = gen.sec.xml.slice(gen.a.start, gen.a.end);
      const auto = text => [...text.matchAll(/<hp:autoNum\b(?=[^>]*\bnumType="(?:FOOTNOTE|ENDNOTE)")[^>]*>/g)];
      const oldNums = auto(xml), newNums = auto(genXml);
      if (oldNums.length !== newNums.length) throw new EngineError('EDIT_PRESERVATION', '주석 본문의 자동 번호를 대조하지 못했습니다');
      for (let j = 0; j < oldNums.length; j++) {
        const desired = /\bnum="(\d+)"/.exec(newNums[j][0])?.[1];
        if (!desired || /\bnum="(\d+)"/.exec(oldNums[j][0])?.[1] === desired) continue;
        const at = a.start + oldNums[j].index;
        list.push({ pos: at, end: at + oldNums[j][0].length, insert: oldNums[j][0].replace(/\bnum="[^"]*"/, `num="${desired}"`) });
        for (const q of sec.paras) if (q.start <= at && q.end > at) paras.add(q);
      }
      if (list.length) { edits.set(sec, list); changed.set(sec, paras); }
    }
    for (const [sec, list] of edits) { for (const p of changed.get(sec)) dropLineseg(p, list); sec.load(applyEdits(sec.xml, list)); }
  }

  /**
   * 메모 여러 개를 한 번에 단다(V3_SPEC §4.2). 결과(메모 id·번호·XML 모양)는 같은 목록으로 addMemo 를 차례로 부른 것과 같다
   * (고유 번호는 Math.random 을 같은 순서로 쓴다). 메모마다 구역 전체를 다시 읽지 않고, 대상 문단 XML 조각만 따로 읽어 고친 뒤
   * 구역마다 한 번 붙여 다시 읽는다.
   * 조각은 나무 모양이다(memoNode): 구역 → 이번 목록의 대상 중 가장 바깥 것들 → 그 안(엄격한 후손)의 대상 중 가장 바깥 것들 → ….
   * 문단에 메모를 달면 그 문단의 자식 번호(n)만 밀리므로, 대상 문단 자기 메모를 달 때만 그 아래 조각을 붙여(joinSlices) 다시 읽고,
   * 후손 대상의 메모는 그 후손 조각만 읽어 고친다 — 큰 표를 품은 문단과 그 칸들이 함께 와도 바깥 문단을 항목마다 다시 읽지 않는다
   * (바깥 문단 다시 읽기 = 그 문단 자기 메모 수 + 1 번쯤).
   * ref 는 addMemo 를 차례로 부를 때처럼 앞 메모를 단 뒤의 문서로 읽는다 — 문단 자기 글에 메모를 달면 그 문단 안에서 메모 뒤에 오는
   * 중첩 문단(표 칸 등) 번호 n 이 메모 줄 수만큼 밀린다(지금 문서 ref 로 미리 만든 목록이면 깊은 ref 를 먼저 두면 밀리지 않는다 —
   * 메모는 자기 문단의 자식 번호만 민다).
   * 하나라도 실패하면(NO_AUTHOR·EMPTY·NO_PARAGRAPH·RANGE …) 아무것도 바꾸지 않고 던진다(차례로 부르면 앞 메모는 남는다).
   * @param {Array<{ref: string, start?: number, end?: number, author: string, text: string, date?: Date}>} list
   * @returns {string[]} 메모 id(입력 순서)
   */
  addMemos(list) {
    const items = Array.from(list || []);
    if (!items.length) return [];
    const existing = this.memos();
    const numbers = existing.map((m) => m.number);
    const taken = new Set(existing.map((m) => m.id));
    const style = this.header.memoStyle();
    // 이번 목록의 대상 ref(숫자 그대로 다시 쓴 꼴) — 조각 나무의 마디가 되는 문단
    const targets = new Set(items.map((it) => canonRef(it?.ref)).filter(Boolean));
    // 구역마다: 조각 나무의 꼭대기(구역 자신 — mini 는 그 Section, 끝까지 다시 읽지 않는다), addMemo 의 sec.xml 검사를 흉내 내는 값 모음
    const states = new Map();
    const stateOf = (sec) => {
      if (states.has(sec)) return states.get(sec);
      const st = { top: { ref: `s${sec.index}`, top: true, xml: sec.xml, mini: sec, kids: new Map() }, memoCount: 0, idVals: new Set(), fidVals: new Set(), beginVals: new Set() };
      // xml.includes(`id="n"`) ⇔ n 이 /id="(\d+)"/ 로 잡히는 값(fieldid=… 도 포함) — 원문 + 이번에 만든 메모 XML
      st.note = (xml) => {
        for (const m of xml.matchAll(/id="(\d+)"/g)) st.idVals.add(m[1]);
        for (const m of xml.matchAll(/fieldid="(\d+)"/g)) st.fidVals.add(m[1]);
        for (const m of xml.matchAll(/beginIDRef="(\d+)"/g)) st.beginVals.add(m[1]);
        st.memoCount += (xml.match(/type="MEMO"/g) || []).length;
      };
      st.note(sec.xml);
      states.set(sec, st);
      return st;
    };
    const ids = [];
    for (const it of items) {
      const { ref, start, end, author, text, date } = it || {};
      if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
      if (!text) throw new EngineError('EMPTY', '메모 글이 없습니다');
      const cref = canonRef(ref);
      const sec = cref ? this.sections[parseInt(cref.slice(1), 10)] : null;
      if (!sec) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: ${ref}`);
      const st = stateOf(sec);
      const node = memoNode(st.top, cref, targets, sec.index);
      if (!node) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: ${ref}`);
      // 대상 문단 자기 메모: 아래 조각을 먼저 제자리에 붙이고(이 메모가 자식 번호를 밀 수 있다) 조각만 구역처럼 읽는다(대상 = s{i}/p0)
      // — 편집 위치는 모두 대상 문단 안이라 구역에서 고친 것과 같다
      if (node.kids.size) { node.xml = joinSlices(node); node.mini = null; }
      if (!node.mini) node.mini = new Section(node.xml, sec.index);
      const p = node.mini.bodyParas[0];
      if (!p) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: ${ref}`);
      const range = memoRange(p, start, end);
      const number = numbers.length ? Math.max(...numbers) + 1 : 1;
      let memoId = `memo${number}`; for (let k = number; taken.has(memoId); ) { k++; memoId = `memo${k}`; }
      const fieldId = uniqueNumberBy((n) => st.idVals.has(n) || st.beginVals.has(n));
      const fid = uniqueNumberBy((n) => st.fidVals.has(n) || st.beginVals.has(n));
      const { beginXml, endXml } = memoCtrlXml(style, { number, memoId, fieldId, fid, zorder: st.memoCount + 1, author, text, when: date || new Date() });
      node.xml = applyEdits(node.xml, memoEdits(node.mini, p, range, beginXml, endXml)); node.mini = null;
      st.note(beginXml); st.note(endXml);
      numbers.push(number); taken.add(memoId); ids.push(memoId);
    }
    // 구역마다 고친 조각을 모두 제자리에 붙이고(먼저 전부 만든 뒤) 한 번만 다시 읽는다
    const out = [];
    for (const [sec, st] of states) if (st.top.kids.size) out.push([sec, joinSlices(st.top)]);
    for (const [sec, xml] of out) sec.load(xml);
    return ids;
  }

  /** 메모 글 바꾸기 */
  setMemoText(memoId, text) {
    const loc = this._memoLoc(memoId);
    const style = this.header.memoStyle();
    const paras = memoBodyXml(style, text);
    const xml = loc.sec.xml; const seg = xml.slice(loc.a.start, loc.a.end);
    const open = /<hp:subList\b[^>]*>/.exec(seg); const closeAt = seg.lastIndexOf('</hp:subList>');
    if (!open || closeAt < 0) throw new EngineError('MEMO_BODY', '메모 본문 구조를 찾지 못했습니다');
    const newSeg = seg.slice(0, open.index + open[0].length) + paras + seg.slice(closeAt);
    loc.sec.load(xml.slice(0, loc.a.start) + newSeg + xml.slice(loc.a.end));
    return true;
  }

  /** 메모 삭제(본문 글은 남긴다) */
  deleteMemo(memoId) {
    const loc = this._memoLoc(memoId);
    const edits = [{ start: loc.a.start, end: loc.a.end, insert: '' }];
    if (loc.endA) edits.push({ start: loc.endA.start, end: loc.endA.end, insert: '' });
    const xml = loc.sec.xml;
    // 끝 표식이 다른 문단에 있으면 두 문단 모두 편집(같은 구역 문자열이므로 함께 처리 가능). 줄 정보 textpos 도 맞춘다
    const same = !loc.endP || loc.endP === loc.p;
    const rm = same ? [loc.a, loc.endA].filter(Boolean) : [loc.a];
    if (!shiftLineseg(loc.sec, loc.p, { remove: rm }, edits)) dropLineseg(loc.p, edits);
    if (!same && loc.endA && !shiftLineseg(loc.sec, loc.endP, { remove: [loc.endA] }, edits)) dropLineseg(loc.endP, edits);
    loc.sec.load(applyEdits(xml, edits));
    return true;
  }

  /**
   * [hwpx-cowork] 메모의 시작·끝 부호 XML(본문·답글 그대로)과 자리 — 실시간 반영이 메모를 다른 문단으로 옮기거나(편집기에서 빈 줄을 합쳐
   * 메모가 앞 문단으로 옮겨 감) 편집기 문서의 메모를 다시 들여올 때(지운 메모를 되돌리기로 살림). 같은 문단에서 닫히는 메모만, 아니면 null
   * → { ref, start, end, beginXml, endXml }
   */
  memoParts(memoId) {
    const loc = this._memoLoc(memoId);
    if (!loc.endA || loc.endP !== loc.p) return null;
    const fc = Section.visibleChars(loc.p, 'final');
    const finalAt = (a) => finalIndexAt(loc.p, a.pos);
    return {
      ref: loc.p.ref, start: Math.min(finalAt(loc.a), fc.length), end: Math.min(finalAt(loc.endA), fc.length),
      beginXml: loc.sec.xml.slice(loc.a.start, loc.a.end), endXml: loc.sec.xml.slice(loc.endA.start, loc.endA.end),
    };
  }

  /** [hwpx-cowork] memoParts 의 메모 부호를 ref 문단 [start,end)(최종본 글자 번호 — 문단 글 길이로 자른다)에 넣는다 */
  putMemo(ref, start, end, { beginXml, endXml }) {
    const { sec, p } = this.resolve(ref);
    const fc = Section.visibleChars(p, 'final');
    const s = Math.max(0, Math.min(Number(start) || 0, fc.length));
    const e = Math.max(s, Math.min(Number(end) || 0, fc.length));
    let edits;
    const ctrls = Section.fieldCtrls(p);
    if (!fc.length && ctrls.length && !p.chars.length) {
      // 글 없는 문단에 메모가 이미 있으면 그 뒤에(편집기 합치기처럼 옮겨 온 차례대로)
      edits = [{ pos: ctrls[ctrls.length - 1].end, insert: beginXml + endXml }];
    } else if (fc.length && s === e) {
      // 붙은 글 없는 메모: 그 자리 글자 앞(문단 끝이면 마지막 글자 뒤)에 시작·끝을 나란히
      const tail = s === fc.length;
      const ci = p.chars.indexOf(fc[tail ? fc.length - 1 : s]);
      edits = [tail ? ctrlPointAfter(p, ci, beginXml + endXml) : ctrlPointBefore(p, ci, beginXml + endXml)];
      const at = tail ? [{ after: ci }, { after: ci }] : [{ before: ci }, { before: ci }];
      if (!shiftLineseg(sec, p, { add: at }, edits)) dropLineseg(p, edits);
    } else edits = memoEdits(sec, p, { fc, start: s, end: e }, beginXml, endXml);
    sec.load(applyEdits(sec.xml, edits));
    return true;
  }

  /**
   * [hwpx-cowork] 본문 문단 ref 의 머리말·꼬리말 부호를 빼서 돌려준다 → [{ key, xml }](문서 차례). 머리말 줄을 앞 줄로 합친 밀어 넣기가 그 줄을
   * 지우기 전에 빼 두었다가 putHeaderFooters 로 보낸 문서의 자리에 다시 넣는다(서버의 원래 XML 그대로 — 편집기 XML 의 모양 번호를 들이지 않는다)
   */
  takeHeaderFooters(ref) {
    const { sec, p } = this.resolve(ref);
    const list = headerFooterAnchors(p);
    if (!list.length) return [];
    const out = list.map((a) => ({ key: headerFooterKey(a), xml: sec.xml.slice(a.start, a.end) }));
    const edits = list.map((a) => codeRemoveEdit(sec.xml, a));
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    return out;
  }

  /** [hwpx-cowork] 구역별 본문 문단마다 머리말·꼬리말 열쇠 목록 { [구역]: string[][] } */
  headerFooterKeys() {
    const out = {};
    for (const sec of this.sections) out[sec.index] = sec.bodyParas.map((q) => headerFooterAnchors(q).map(headerFooterKey));
    return out;
  }

  /** [hwpx-cowork] 머리말·꼬리말 부호 XML 들을 본문 문단 ref 끝(마지막 글자·부호 뒤)에 넣는다 */
  putHeaderFooters(ref, list) {
    if (!list?.length) return false;
    const { sec, p } = this.resolve(ref);
    const xml = list.map((x) => x.xml).join('');
    const fc = Section.visibleChars(p, 'final');
    const ctrls = p.anchors.filter((a) => a.kind === 'ctrl' && a.name === 'hp:ctrl');
    let edit;
    if (fc.length) edit = ctrlPointAfter(p, p.chars.indexOf(fc[fc.length - 1]), xml);
    else if (ctrls.length) edit = { pos: ctrls[ctrls.length - 1].end, insert: xml };
    else edit = emptyParagraphEdit(sec, p, '', xml);
    const edits = [edit];
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, edits));
    return true;
  }

  _memoLoc(memoId) {
    for (const sec of this.sections) for (const p of sec.paras) for (const a of Section.fieldCtrls(p)) {
      if (a.inner !== 'hp:fieldBegin' || a.innerAttrs?.get('type') !== 'MEMO') continue;
      if (memoParamAt(sec.xml, a, 'ID') !== memoId) continue;
      const fieldId = a.innerAttrs.get('id');
      let endA = null; let endP = null;
      for (const q of sec.paras) { if (q.idx < p.idx) continue; const e = Section.fieldCtrls(q).find((x) => x.inner === 'hp:fieldEnd' && x.innerAttrs?.get('beginIDRef') === fieldId); if (e) { endA = e; endP = q; break; } }
      return { sec, p, a, endA, endP };
    }
    throw new EngineError('NO_MEMO', `메모를 찾을 수 없습니다: ${memoId}`);
  }

  // ───────── 글 비교 → 변경 추적 ─────────

  /** 한 문단의 최종본을 newText 로 만드는 변경을 변경 추적으로 기록한다. 반환: 변경 id 목록 */
  mergeParagraphText(ref, newText, { author, date } = {}) {
    const oldText = this.text(ref, 'final');
    if (oldText === newText) return [];
    // 최종본 오프셋(코드포인트) 기준 op 목록(engine/diff.js charOps)을 뒤에서부터 적용.
    // 지우는 범위에 개체(메모 경계·그림·표 등)가 끼면 replaceTracked 가 개체 앞뒤로 나눠 지운다(deleteIds)
    const ops = charOps(oldText, newText);
    const ids = [];
    for (const op of ops.reverse()) {
      const r = op.start === op.end ? { insertId: this.insertTracked(ref, op.start, op.text, { author, date }) } : this.replaceTracked(ref, op.start, op.end, op.text, { author, date });
      for (const d of r.deleteIds || (r.deleteId ? [r.deleteId] : [])) ids.push(d);
      if (r.insertId) ids.push(r.insertId);
    }
    return ids;
  }

  /**
   * 본문 문단 글 전체를 새 글 목록과 맞춘다(편집기에서 돌아온 본·옛 버전과 비교).
   * newBodyTexts: { [sectionIndex]: Array<string | {text, nested?}> } — 구역별 본문 문단 최종본.
   *   항목이 {text, nested} 이면 nested = 그 본문 문단 안 중첩 문단(메모 본문 제외) 글 목록(문서 순서):
   *   string 또는 {text, sig}(sig = 구조 표시, bodyTexts({nested:true}) 가 만들어 준다).
   * opts.nested: { [sectionIndex]: Array<nested 목록 | null> } — 글 목록을 문자열 그대로 두고 중첩 글만 따로 줄 때(새 문단 번호 기준).
   * 항목에 kind 가 있으면(bodyEntries() 모양 {text, kind, sig, nested}) 문단 종류·구조까지 보고 정렬한다(표 앞 빈 줄을 지워도 표가 제 짝을 찾고,
   * 같은 자리에서 표·그림만 생기거나 없어진 문단은 짝으로 보아 빈 문단을 따로 넣지 않는다).
   * 없으면 글만 보고 정렬한다(예전과 같음). 정렬은 engine/diff.js 의 planBody.
   * 중첩 문단은 옛/새 구조(수·순서·sig)가 같을 때만 문단별로 병합하고, 다르면 report.skippedNested 에 본문 ref 를 넣는다.
   * 반환 report 의 ref 는 모두 병합 '뒤' 문서 기준. bodyMap[구역] = 옛 본문 문단 번호 → 새 번호.
   */
  mergeBodyTexts(newBodyTexts, { author, date, nested = null } = {}) {
    const report = { changed: [], inserted: [], deleted: [], ids: [], bodyMap: {}, skippedNested: [] };
    for (const sec of this.sections) {
      const raw = newBodyTexts[sec.index];
      if (!raw) { report.bodyMap[sec.index] = sec.bodyParas.map((_, i) => i); continue; }
      const entries = raw.map((e, i) => normEntry(e, nested?.[sec.index]?.[i]));
      const oldTexts = sec.bodyParas.map((p) => Section.text(p, 'final'));
      // 짝(옛 i ↔ 새 j)과 바꿀 단계(plan; i·j 는 목록 전체 번호). 바뀐 덩어리 안에서는 비슷한 글끼리 짝짓는다.
      const rich = raw.some((e) => e != null && typeof e === 'object' && e.kind != null);
      const { pairs, plan } = rich
        ? planBody(sec.bodyParas.map((p) => this._bodyInfo(sec, p)), entries.map((e, i) => ({ text: e.text, kind: raw[i]?.kind, sig: raw[i]?.sig, nested: e.nested ?? undefined })))
        : planBody(oldTexts, entries.map((e) => e.text));
      // 1) 중첩 문단(표 셀 등): 본문 문단 수가 아직 그대로일 때 옛 번호로 처리(본문 문단 글은 건드리지 않는다)
      const changedOld = []; const skippedOld = [];
      for (const [o, j] of pairs) {
        const want = entries[j].nested; if (!Array.isArray(want)) continue;
        const have = this._nestedItems(sec, sec.bodyParas[o]);
        if (!sameShape(have, want)) { if (have.length || want.length) skippedOld.push(o); continue; }
        for (let k = 0; k < have.length; k++) {
          const w = typeof want[k] === 'string' ? want[k] : String(want[k]?.text ?? '');
          if (have[k].text === w) continue;
          const ids = this.mergeParagraphText(have[k].ref, w, { author, date });
          if (ids.length) { changedOld.push({ o, tail: have[k].ref.slice(`s${sec.index}/p${o}`.length) }); report.ids.push(...ids); }
        }
      }
      // 2) 본문 문단: 단계를 뒤에서부터 처리해 앞 문단 번호가 흔들리지 않게 한다. order 는 같은 삽입을 흉내 내 새 번호를 셈한다.
      const order = oldTexts.map((_, i) => ({ old: i }));
      const deletedOld = [];
      for (const step of plan.reverse()) {
        // 새 문단은 앞선 짝·삭제 문단(없으면 덩어리 바로 앞 문단) 뒤에 넣는다. 첫 문단(구역 속성) 앞에는 넣을 수 없어 그 뒤로 간다.
        let last = step.at - 1;
        const before = step.ops.map((o) => { const b = last; if (o.op !== 'ins') last = o.i; return b; });
        // 뒤에서부터: 앞쪽 옛 문단 번호는 그대로이고, 같은 자리에 여러 개를 넣어도 순서가 지켜진다
        for (let k = step.ops.length - 1; k >= 0; k--) {
          const o = step.ops[k];
          if (o.op === 'ins') {
            const afterIdx = Math.max(before[k], 0);
            this.insertParagraphAfter(sec.index, afterIdx, entries[o.j].text, { author, date });
            order.splice(Math.min(afterIdx + 1, order.length), 0, { ins: true });
          } else if (o.op === 'del') {
            const at = o.i; const len = cpLen(Section.text(sec.bodyParas[at], 'final'));
            if (len > 0) { const r = this.deleteTracked(`s${sec.index}/p${at}`, 0, len, { author, date }); report.ids.push(...(r.deleteIds || [r.deleteId])); }
            deletedOld.push(at);
          } else {
            const at = o.i;
            const ids = this.mergeParagraphText(`s${sec.index}/p${at}`, entries[o.j].text, { author, date });
            if (ids.length) { changedOld.push({ o: at, tail: '' }); report.ids.push(...ids); }
          }
        }
      }
      const map = new Array(oldTexts.length);
      order.forEach((t, i) => { if (t.ins) report.inserted.push(`s${sec.index}/p${i}`); else map[t.old] = i; });
      report.bodyMap[sec.index] = map;
      const at = (o, tail = '') => `s${sec.index}/p${map[o]}${tail}`;
      changedOld.sort((a, b) => (a.o - b.o) || cmpTail(a.tail, b.tail));
      for (const c of changedOld) { const r = at(c.o, c.tail); if (!report.changed.includes(r)) report.changed.push(r); }
      for (const o of deletedOld.sort((a, b) => a - b)) report.deleted.push(at(o));
      for (const o of skippedOld) report.skippedNested.push(at(o));
    }
    return report;
  }

  /** 본문 문단 안의 중첩 문단(메모 본문과 그 안은 제외) — 문서 순서, {ref, text, sig} */
  _nestedItems(sec, body) {
    return this._nestedWalk(sec, body).map(({ p, sig }) => ({ ref: p.ref, text: Section.text(p, 'final'), sig }));
  }

  /**
   * 본문 문단 안의 중첩 문단 레코드(메모 본문과 그 안은 제외) — 문서 순서, {p, sig, cell(표 칸이면 scanTables 의 칸, 아니면 null)}.
   * [hwpx-cowork] view(기본 최종본): 보기에서 숨은 개체(변경 추적으로 지운 표·그림·도형) 안 문단은 그 아래째 건너뛴다 — 표 번호(#t)도 보이는 표끼리
   */
  _nestedWalk(sec, body, { view = 'final' } = {}) {
    const ti = this._tableIndex(sec); const out = [];
    const walk = (p, path) => {
      for (const c of p.children) {
        if (c.container === 'hp:fieldBegin') continue;
        if (!Section.visibleParagraph(c, view)) continue;
        const cell = ti.cellOf.get(c); const capT = ti.captionOf.get(c);
        const seg = cell ? `${c.container}#t${cell.table.index}@${cell.row},${cell.col}` : (capT ? `${c.container}#t${capT.index}:caption` : c.container);
        const sig = path ? `${path}>${seg}` : seg;
        out.push({ p: c, sig, cell: cell || null });
        walk(c, sig);
      }
    };
    walk(body, '');
    return out;
  }

  /**
   * 구역별 본문 문단 정렬 항목(engine/diff.js planBody 용) { [구역]: [{ text, kind, sig, nested: [{ ref, text, sig }] }] }.
   * text = 최종본 글. kind = 글이 있으면 'text', 글 없이 표를 직접 가지면 'table', 그림·도형 등 개체면 'object', 아니면 'empty'.
   * sig = 문단 구조 표시(표·개체 요소와 중첩 문단 sig 목록의 짧은 해시, 아무것도 없으면 ''). nested = 중첩 문단(메모 본문 제외, 문서 순서).
   * mergeBodyTexts 에 그대로 넘기면 종류·구조까지 보고 정렬한다.
   */
  bodyEntries() {
    const out = {};
    for (const sec of this.sections) {
      out[sec.index] = sec.bodyParas.map((p) => {
        const b = this._bodyInfo(sec, p);
        return { text: b.text, kind: b.kind, sig: b.sig, nested: b.nested.map(({ ref, text, sig }) => ({ ref, text, sig })) };
      });
    }
    return out;
  }

  /**
   * 본문 문단 하나의 정렬·비교 정보(bodyEntries·diffDocs 공용).
   * → { ref, text, kind, sig, grid, nested: [{ ref, text, sig, cell: {table,row,col}|null, objs }], tables, objects }
   *   tables = 문단과 그 중첩 문단(메모 본문 제외) 전체의 표 수, objects = 같은 범위의 개체(표 제외) 요소 이름 목록(문서 순서),
   *   grid = sig 에서 잇닿은 같은 자리(같은 칸) 문단을 하나로 본 구조 표시 — 칸 안에서 Enter·Backspace 로 칸 문단 수만 바뀐 표 문단끼리 같다
   *   (diffDocs 정렬이 그런 문단을 짝짓게 — planBody 의 grid; 플러그인 정렬의 표 표시도 칸 문단 수를 보지 않는다). 아무것도 없으면 ''.
   *   nested[].objs = 그 중첩 문단이 직접 가진 표·개체 요소 수(diffDocs 칸 접기 — 글만 든 칸인가). grid·objs 는 bodyEntries 에 싣지 않는다
   */
  _bodyInfo(sec, p) {
    const text = Section.text(p, 'final');
    const own = objectTags(p);
    const ownTables = own.filter((t) => t === 'hp:tbl').length;
    const parts = own.length ? [`@${own.join('+')}`] : [];
    const gridParts = [...parts];
    let tables = ownTables; const objects = own.filter((t) => t !== 'hp:tbl');
    // 이 문단이 직접 가진 그림(과 그 캡션)·표(칸·캡션·칸 안 모든 것)는 diffDocs 가 그림끼리·표끼리 짝지어 옮긴다(copyObjectsFrom) —
    // 중첩 문단마다 어느 그림(cap)·표(tbl) 것인지 적고, 그 밖의 개체·표만 따로 센다(otherObjects·otherTables)
    // [hwpx-cowork] 도형(선·사각형·글상자·묶음 등 — engine/shapes.js)도 도형끼리 짝지어 옮긴다: 그 안 글상자 문단은 shp 로 적는다
    const otherObjects = own.filter((t) => t !== 'hp:tbl' && t !== 'hp:pic' && !SHAPE_TAGS.has(t));
    let otherTables = 0;
    const ownPics = own.includes('hp:pic') ? this._ownPictures(sec, p) : [];
    const ownTbls = ownTables ? this._tableIndex(sec).tables.filter((t) => t.owner === p && !t.hidden) : [];
    const ownShps = ownShapeAnchors(p);
    // [hwpx-cowork] 머리말·꼬리말(hp:header·hp:footer) 안 문단은 hf 로 적는다 — 머리말 줄을 앞 줄로 합치면 서버가 머리말째 옮긴다(server/live.js parkHeaderFooters)
    const ownHfs = headerFooterAnchors(p);
    const topOf = (q) => { let r = q; while (r.parent && r.parent !== p) r = r.parent; return r; };
    const indexIn = (list, r) => { const k = list.findIndex((x) => x.start < r.start && r.end <= x.end); return k < 0 ? null : k; };
    const nested = this._nestedWalk(sec, p).map(({ p: q, sig, cell }) => {
      const tags = objectTags(q);
      const r = topOf(q);
      const cap = ownPics.length ? indexIn(ownPics, r) : null;
      const tbl = cap == null && ownTbls.length ? indexIn(ownTbls, r) : null;
      const shp = cap == null && tbl == null && ownShps.length ? indexIn(ownShps, r) : null;
      const hf = cap == null && tbl == null && shp == null && ownHfs.length ? indexIn(ownHfs, r) : null;
      for (const t of tags) {
        if (t === 'hp:tbl') { tables++; if (cap == null && tbl == null && shp == null && hf == null) otherTables++; } else { objects.push(t); if (cap == null && tbl == null && shp == null && hf == null) otherObjects.push(t); }
      }
      const part = tags.length ? `${sig}@${tags.join('+')}` : sig;
      parts.push(part);
      if (gridParts[gridParts.length - 1] !== part) gridParts.push(part);
      return { ref: q.ref, text: Section.text(q, 'final'), sig, cell: cell ? { table: cell.table.key, row: cell.row, col: cell.col } : null, objs: tags.length, cap, tbl, shp, ...(hf != null ? { hf } : {}) };
    });
    const kind = entryKind(text, { tables: ownTables, objects: own.length - ownTables });
    // 빈 줄은 글로 가릴 수 없다 — 모양(문단·글자 모양·스타일·나누기) 지문으로 가린다(fmt). 빈 줄이 여럿 이어진 곳(지운 차례 자리 등)에서
    // 한 줄을 지우면 정렬이 모양이 다른 엉뚱한 빈 줄을 지우고 나머지를 한 칸씩 밀어 서식 덩어리 수십 개가 생기던 것.
    // 부호(조판 부호·필드 끝)는 넣지 않는다 — 부호만 바뀐 빈 줄은 같은 짝으로 두고 object 덩어리로 옮긴다
    // 단 메모(메모 id)는 넣는다 — 메모만 남은 빈 줄이 이어진 곳에서 한 줄을 지우면 정렬이 메모 없는 엉뚱한 빈 줄을 지워 메모가 한 줄씩 어긋났다
    // (메모만 바뀐 빈 줄도 바뀐 덩어리 안에서 빈 줄끼리 짝지어진다)
    let fmt;
    if (kind === 'empty') {
      const memoIds = Section.fieldCtrls(p).filter((a) => a.inner === 'hp:fieldBegin' && a.innerAttrs?.get('type') === 'MEMO').map((a) => memoParamAt(sec.xml, a, 'ID'));
      fmt = this.formattingFingerprint(p.ref) + (memoIds.length ? `|memo:${memoIds.join(',')}` : '');
    }
    return {
      ref: p.ref, text, kind,
      sig: parts.length ? shortHash(parts.join('|')) : '', grid: gridParts.length ? shortHash(`grid|${gridParts.join('|')}`) : '', nested, tables, objects, otherObjects, otherTables,
      ...(fmt != null ? { fmt } : {}),
      ...(ownHfs.length ? { hfKeys: ownHfs.map(headerFooterKey) } : {}),
    };
  }

  /**
   * 글자 모양(charPr) id → { key, props } — 문서마다 다른 id 대신 실제 속성(글꼴 이름·크기·굵게·기울임·밑줄·취소선·색 …)으로
   * 서식을 비교할 때 쓴다(diffDocs 'format'). 헤더 XML 이 바뀌면 다시 만들고, id 별 결과는 처음 물을 때 만들어 둔다.
   * 없는 id 는 props.missing 에 id 를 넣는다.
   */
  _charFormats() {
    const xml = this.header.xml;
    if (this._fmt && this._fmt.xml === xml) return this._fmt;
    const fonts = new Map(); // 언어(HANGUL …) → Map(글꼴 id → 이름)
    for (const m of xml.matchAll(/<hh:fontface\b([^>]*)>([\s\S]*?)<\/hh:fontface>/g)) {
      const map = new Map();
      for (const f of m[2].matchAll(/<hh:font\b([^>]*)>/g)) {
        const id = /\bid="([^"]*)"/.exec(f[1])?.[1];
        if (id != null && !map.has(id)) map.set(id, decodeEntities(/\bface="([^"]*)"/.exec(f[1])?.[1] ?? ''));
      }
      fonts.set((/\blang="([^"]*)"/.exec(m[1])?.[1] || '').toUpperCase(), map);
    }
    const blocks = new Map(); // charPr id → { attrs, body }
    for (const m of xml.matchAll(/<hh:charPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/hh:charPr>)/g)) {
      const id = /\bid="([^"]*)"/.exec(m[1])?.[1];
      if (id != null && !blocks.has(id)) blocks.set(id, { attrs: m[1], body: m[2] || '' });
    }
    const cache = new Map();
    const get = (id) => {
      const k = id == null ? '' : String(id);
      if (!cache.has(k)) {
        const blk = blocks.get(k);
        const props = blk ? charFormatProps(blk, fonts) : { ...Object.fromEntries(FORMAT_PROPS.map((n) => [n, ''])), missing: k };
        cache.set(k, { key: [...FORMAT_PROPS, 'missing'].map((n) => props[n] ?? '').join('\u0001'), props });
      }
      return cache.get(k);
    };
    this._fmt = { xml, get };
    return this._fmt;
  }

  /**
   * 구역별 본문 문단 최종본 글. nested=true 이면 [{text, nested:[{text, sig}]}] — mergeBodyTexts 에 그대로 넘길 수 있다.
   * (예: 옛 버전 복구 = cur.mergeBodyTexts(old.bodyTexts({nested:true}), {author}))
   */
  bodyTexts({ nested = false } = {}) {
    const out = {};
    for (const sec of this.sections) {
      out[sec.index] = sec.bodyParas.map((p) => (nested
        ? { text: Section.text(p, 'final'), nested: this._nestedItems(sec, p).map(({ text, sig }) => ({ text, sig })) }
        : Section.text(p, 'final')));
    }
    return out;
  }

  /** 구역별·본문 문단별 중첩 문단 글 목록 { [구역]: [[{text, sig}]] } — mergeBodyTexts 의 opts.nested 용 */
  nestedTexts() {
    const out = {};
    for (const sec of this.sections) out[sec.index] = sec.bodyParas.map((p) => this._nestedItems(sec, p).map(({ text, sig }) => ({ text, sig })));
    return out;
  }

  /** 본문 문단 afterIdx 뒤에 새 문단을 넣는다(글은 삽입 변경 추적). afterIdx=-1 이면 맨 앞. 반환: 새 문단 ref */
  insertParagraphAfter(sectionIndex, afterIdx, text, options = {}) {
    validateTextFormatting(text, options);
    return formattingTransaction(this, () => this._insertParagraphAfter(sectionIndex, afterIdx, text, options));
  }

  /**
   * [hwpx-cowork] 실시간 최종본의 같은 틈에 여러 본문 문단을 한 번에 넣는다.
   * 변경 추적을 만들었다 곧바로 수락하는 대신 확정된 글을 기록한다. 승인/추적 문서는
   * 기존 insertParagraphAfter를 사용한다. 서식·개체는 호출자가 기존 import 경로로 옮긴다.
   * 앞 문단의 secPr/colPr를 옮겨야 하는 문서 맨 앞 삽입은 이 API의 대상이 아니다.
   */
  insertFinalParagraphsAfter(sectionIndex, afterIdx, texts) {
    const sec = this.sections[sectionIndex];
    if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: ${sectionIndex}`);
    if (!Number.isInteger(afterIdx) || afterIdx < 0 || afterIdx >= sec.bodyParas.length) throw new EngineError('NO_PARAGRAPH', '일괄 삽입의 앞 문단이 없습니다');
    if (!Array.isArray(texts)) throw new EngineError('BAD_TEXT', '넣을 문단 목록이 필요합니다');
    for (const text of texts) validateTextFormatting(text, {});
    if (!texts.length) return [];
    const model = sec.bodyParas[afterIdx];
    const paraPr = attrOf(sec.xml, model, 'paraPrIDRef') || '0';
    const styleId = attrOf(sec.xml, model, 'styleIDRef') || '0';
    const charPr = model.runs.length ? (Section.lastLiveRun(model)?.charPr ?? '0') : '0';
    const xml = texts.map(text => `<hp:p id="0" paraPrIDRef="${paraPr}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${inlineXml(text)}</hp:t></hp:run></hp:p>`).join('');
    sec.load(sec.xml.slice(0, model.end) + xml + sec.xml.slice(model.end));
    return texts.map((_, i) => `s${sectionIndex}/p${afterIdx + i + 1}`);
  }

  _insertParagraphAfter(sectionIndex, afterIdx, text, { author, date, format, runs, atStart = false, trackBreak = false } = {}) {
    const sec = this.sections[sectionIndex];
    if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: ${sectionIndex}`);
    const model = sec.bodyParas[Math.max(0, Math.min(afterIdx, sec.bodyParas.length - 1))];
    const paraPr = model ? attrOf(sec.xml, model, 'paraPrIDRef') : '0';
    const styleId = model ? attrOf(sec.xml, model, 'styleIDRef') : '0';
    // [hwpx-cowork] 나눔을 지워 이은 기록이면 최종본의 마지막 run(합칠 때 버릴 빈 run 말고 — Section.lastLiveRun). 묶지 않은 기록은 예전 그대로
    const charPr = model && model.runs.length ? (Section.lastLiveRun(model)?.charPr ?? '0') : '0';
    let inner = text ? this._trackedInsertXml(text, { author, date }) : '';
    // [hwpx-cowork] 문단 나눔 변경 추적(trackBreak — 추적 문서): 앞 문단 나눔을 넣은 나눔으로(A{+¶+} N — 한/글 Enter 뒤 입력과 같은 꼴). 앞 문단 나눔이
    // 이미 넣은 나눔이거나(한 밀어 넣기에 넣기 둘) 구역 첫머리 넣기면 새 문단 자기 나눔에. 거절하면 빈 줄 없이 원래 문단으로 돌아간다(engine/track-objects.js BREAK_TRACK)
    let prevBreak = null;
    if (trackBreak && sec.bodyParas.length) {
      const P = atStart && afterIdx < 0 ? null : sec.bodyParas[Math.max(0, Math.min(afterIdx, sec.bodyParas.length - 1))];
      const pb = P ? Section.breakOf(P) : null;
      const marks = this._breakMarksXml('Insert', { author, date });
      if (!P || (pb && pb.type === 'Insert')) inner += marks; else prevBreak = { P, marks };
    }
    const xmlP = `<hp:p id="0" paraPrIDRef="${paraPr}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${inner}</hp:t></hp:run></hp:p>`;
    if (!sec.bodyParas.length) {
      sec.load(sec.xml.slice(0, sec.xml.lastIndexOf('</hs:sec>')) + xmlP + sec.xml.slice(sec.xml.lastIndexOf('</hs:sec>')));
      if (format || runs) applyInsertedFormatting(this, `s${sectionIndex}/p0`, 0, text, { format, runs });
      return `s${sectionIndex}/p0`;
    }
    // [hwpx-cowork] atStart(맨 앞 -1 이 정말 '구역 첫 문단 앞'일 때 — 실시간 밀어 넣기·변경 요청 반영의 구역 첫머리 넣기): 새 문단을 맨 앞에
    // 넣고 구역 나누기(첫 run 머리의 secPr·colPr)는 새 첫 문단으로 옮긴다 — 구역 나누기는 늘 구역 첫머리다(docs/SECTIONS.md). 문서 첫머리
    // Enter 처럼 첫 문단 앞에 빈 줄을 넣은 편집이 서버에서 뒤바뀌던(첫 문단 뒤에 들어가던) 것
    if (atStart && afterIdx < 0) {
      const first = sec.bodyParas[0];
      const run = first.runs[0];
      const brk = run ? /<hp:secPr\b[\s\S]*?<\/hp:secPr>(\s*<hp:ctrl>\s*<hp:colPr\b(?:[^>]*\/>|[\s\S]*?<\/hp:colPr>)\s*<\/hp:ctrl>)?/.exec(sec.xml.slice(run.start, run.end)) : null;
      const from = brk ? run.start + brk.index : first.start; const to = brk ? from + brk[0].length : first.start;
      const xmlFirst = brk ? xmlP.replace(`<hp:run charPrIDRef="${charPr}">`, (x) => x + brk[0]) : xmlP;
      sec.load(sec.xml.slice(0, first.start) + xmlFirst + sec.xml.slice(first.start, from) + sec.xml.slice(to));
      // 구역 정의가 빠진 옛 첫 문단 줄 정보는 지운다(다시 잰다)
      const old = sec.bodyParas[1];
      if (brk && old?.lineseg) sec.load(applyEdits(sec.xml, [{ start: old.lineseg.start, end: old.lineseg.end, insert: '' }]));
      if (format || runs) applyInsertedFormatting(this, `s${sectionIndex}/p0`, 0, text, { format, runs });
      return `s${sectionIndex}/p0`;
    }
    // 첫 문단은 구역 속성(secPr)을 품으므로 맨 앞(-1)도 그 뒤에 넣는다. 범위 밖이면 끝.
    const at = Math.max(0, Math.min(afterIdx, sec.bodyParas.length - 1));
    const pos = sec.bodyParas[at].end;
    if (prevBreak) {
      const edits = [this._breakMarkEdit(sec, prevBreak.P, prevBreak.marks), { pos, insert: xmlP }];
      dropLineseg(prevBreak.P, edits);
      sec.load(applyEdits(sec.xml, dedupe(edits)));
    } else sec.load(sec.xml.slice(0, pos) + xmlP + sec.xml.slice(pos));
    if (format || runs) applyInsertedFormatting(this, `s${sectionIndex}/p${at + 1}`, 0, text, { format, runs });
    return `s${sectionIndex}/p${at + 1}`;
  }

  /**
   * [hwpx-cowork] 본문 문단 at 뒤에 문단 XML(xmlP — 표·그림 문단 등, `</hp:run></hp:p>` 로 끝남)을 넣는다. trackBreak 면 insertParagraphAfter({ trackBreak })
   * 와 같은 규칙으로 나눔을 넣은 나눔으로(앞 문단 나눔 — 이미 넣은 나눔이면 새 문단 자기 나눔, 새 hp:t 안) → 넣은 나눔 변경 id | null
   */
  _insertParagraphXml(sec, at, xmlP, { author, date, trackBreak = false } = {}) {
    const P = sec.bodyParas[at];
    const pos = P.end;
    if (!trackBreak) { sec.load(sec.xml.slice(0, pos) + xmlP + sec.xml.slice(pos)); return null; }
    const marks = this._breakMarksXml('Insert', { author, date });
    const id = Number(/Id="(\d+)"/.exec(marks)[1]);
    const pb = Section.breakOf(P);
    if (pb && pb.type === 'Insert') {
      const own = xmlP.replace(/<\/hp:run><\/hp:p>$/, `<hp:t>${marks}</hp:t></hp:run></hp:p>`);
      if (own === xmlP) throw new EngineError('BREAK_STATE', '새 문단 끝을 찾지 못했습니다');
      sec.load(sec.xml.slice(0, pos) + own + sec.xml.slice(pos));
      return id;
    }
    const edits = [this._breakMarkEdit(sec, P, marks), { pos, insert: xmlP }];
    dropLineseg(P, edits);
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    return id;
  }

  /** [hwpx-cowork] 나눔만의 변경 표식(폭 0 쌍, 끝 표식 paraend="1") XML — 머리 항목(type 'Insert'|'Delete')을 만든다 */
  _breakMarksXml(type, { author, date } = {}) {
    const id = this._newBreakChange(type, { author, date });
    const b = type === 'Insert' ? 'insert' : 'delete';
    return `<hp:${b}Begin Id="${id}" TcId="${id}"/><hp:${b}End Id="${id}" TcId="${id}" paraend="1"/>`;
  }

  /** [hwpx-cowork] 문단 나눔 변경 하나의 머리 항목 → 변경 id(글과 같은 Insert·Delete — 한/글도 나눔 전용 종류가 없다) */
  _newBreakChange(type, { author, date } = {}) {
    const authorId = this.header.ensureAuthor(author || '?');
    const id = this.header.addChange(type, authorId, date);
    if (!this.header.trackingEnabled()) this.header.setTracking(true);
    return id;
  }

  /**
   * [hwpx-cowork] 본문 기록 p 의 마지막 물리 문단 맨 끝(나눔 자리)에 표식 xml 을 두는 편집: 마지막 run 의 마지막 자식이 hp:t 면 그 안 끝에,
   * 개체·부호·빈 <hp:t/> 로 끝나면 그 run 끝에 새 hp:t(거절하면 그 hp:t 째 지워 원래 XML), 스스로 닫힌 run 은 펼치고, run 이 없으면 새 run
   */
  _breakMarkEdit(sec, p, xml) {
    const ms = Section.members(p); const m = ms[ms.length - 1];
    const runs = p.runs.slice(m.r0);
    const last = runs[runs.length - 1];
    if (!last) {
      const at = m.lineseg ? m.lineseg.start : sec.tokens[m.closeTok].start;
      return { pos: at, insert: `<hp:run charPrIDRef="${Section.lastLiveRun(p)?.charPr ?? '0'}"><hp:t>${xml}</hp:t></hp:run>` };
    }
    if (last.selfclose) return { start: last.end - 2, end: last.end, insert: `><hp:t>${xml}</hp:t></hp:run>` };
    const closeAt = last.end - '</hp:run>'.length;
    const t = p.ts.filter((x) => x.run === last).pop();
    if (t && !t.selfclose && t.closeEnd === closeAt) return { pos: t.closeStart, insert: xml };
    return { pos: closeAt, insert: `<hp:t>${xml}</hp:t>` };
  }

  /** [hwpx-cowork] 변경 id 의 작성자 이름(머리 항목) | null */
  _changeAuthor(id) {
    const h = this.header.changes().find((c) => String(c.id) === String(id));
    if (!h) return null;
    return this.header.authors().find((a) => a.id === h.authorID)?.name ?? null;
  }

  /**
   * [hwpx-cowork] 본문 문단 ref(최종본) 뒤의 문단 나눔을 변경 추적으로 지운다 — 늘 최종본 ref 와 ref+1 이 최종본 문단 하나가 된다
   * (부르는 쪽 ref 옮김: i === ref+1 → 없어짐, i > ref+1 → i−1).
   *  - 보통 나눔: 마지막 물리 문단 끝에 폭 0 지운 나눔(b꼴) → { id, merged: false }. ref 가 최종본에서 비었고(남는 내용 없음) ref+1 이 통째로 지워졌으면
   *    ref+1 자기 나눔을 지운다(한/글은 수락 때 빈 앞 문단을 버리고 뒤 문단 속성을 남긴다 — 지운 문단이 자리를 내주게. 최종본·ref 옮김은 같다)
   *  - 내가 넣고 처리 안 된 넣은 나눔(폭 0): 그 넣음을 거절(물리 문단 합침) → { id: null, merged: true }
   *  - 남이 넣은(또는 글과 함께 넣은) 나눔: 그 넣음을 수락한 뒤 지운 나눔
   * 던짐: NO_AUTHOR · NO_PARAGRAPH · NOT_BODY(중첩 문단) · LAST_PARAGRAPH(구역 끝 — 부르는 쪽은 추적 없는 join) · SECTION_BREAK(다음 문단이 구역 나누기)
   * 문단 기록(takeParaLog)은 적지 않는다
   */
  deleteBreakAfter(ref, { author, date } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    const { sec, p } = this.resolve(ref);
    if (p.parent) throw new EngineError('NOT_BODY', `본문 문단의 나눔만 지울 수 있습니다: ${ref}`);
    const k = p.body; const next = sec.bodyParas[k + 1];
    if (!next) throw new EngineError('LAST_PARAGRAPH', `구역의 마지막 문단입니다: ${ref}`);
    if (sectionBreakAt(sec, next)) throw new EngineError('SECTION_BREAK', `다음 문단이 구역 나누기입니다: ${ref}`);
    return formattingTransaction(this, () => this._deleteBreakAfter(sec, k, { author, date }));
  }

  _deleteBreakAfter(sec, k, { author, date }) {
    const mute = (fn) => { const was = this._paraLogMute; this._paraLogMute = true; try { return fn(); } finally { this._paraLogMute = was; } };
    let p = sec.bodyParas[k];
    const pb = Section.breakOf(p);
    if (pb && pb.type === 'Insert' && pb.begin) {
      if (pb.zw && this._changeAuthor(pb.id) === author) { mute(() => this._resolveChange(pb.id, 'reject')); return { id: null, merged: true }; }
      mute(() => this._resolveChange(pb.id, 'accept'));
      p = sec.bodyParas[k];
    } else if (pb && pb.type === 'Delete') throw new EngineError('BREAK_STATE', `문단 나눔이 이미 지워져 있습니다: ${p.ref}`);
    const q = sec.bodyParas[k + 1];
    let target = p;
    if (BREAK_TRACK.emptyPrevOwnBreak && !finalContent(p) && !finalContent(q) && !Section.breakOf(q)) {
      const r = sec.bodyParas[k + 2];
      if (r && !sectionBreakAt(sec, r)) target = q;
    }
    const xml = this._breakMarksXml('Delete', { author, date });
    const id = Number(/Id="(\d+)"/.exec(xml)[1]);
    const edits = [this._breakMarkEdit(sec, target, xml)];
    dropLineseg(p, edits); dropLineseg(q, edits);
    if (target === q) dropLineseg(sec.bodyParas[k + 2], edits);
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    return { id, merged: false };
  }

  // ───────── [hwpx-cowork] (2026-11-03) 실시간 '변경 추적으로'의 큰 잘라내기·붙여넣기를 구역 한 번 다시 읽기로 ─────────
  // 아래 셋은 server/live.js 가 문단마다 부르던 엔진 호출 차례를 그대로 흉내 내 같은 XML·같은 머리 항목(변경 번호·차례·날짜)을 만들고 구역은
  // 한 번만 다시 읽는다(문단마다 1.4MB 구역을 다시 읽어 583문단 지우기 40초·넣기 70초~3분이었다). 흉내 낼 수 없는 꼴(이미 변경 추적이 있는
  // 문단, 메모·필드·머리말·구역 나누기 같은 부호, 줄 없는 문단 등)이 하나라도 있으면 아무것도 바꾸지 않고 null — 부르는 쪽이 예전처럼 하나씩.
  // 같은 결과인지는 tests/live_track_batch.test.mjs 가 하나씩 한 결과와 바이트로 견준다.

  /**
   * 본문 문단들(bodyIdxs)의 글·그림·표·도형을 변경 추적으로 지운다 = 큰 번호부터 문단마다 mergeParagraphText(ref, '', { author, date }) 뒤
   * removeOwnObjectsTracked(ref, { author, date: objectDate }) 와 같다(live.js 1차 지우기). → Map(본문 번호 → keep: 지운 글·변경 표식이 남는가) | null
   */
  clearParagraphsTracked(sectionIndex, bodyIdxs, { author, date, objectDate = date } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    const sec = this.sections[sectionIndex];
    if (!sec) return null;
    const plans = [];
    for (const at of [...new Set(bodyIdxs)].sort((a, b) => b - a)) {
      const plan = this._clearPlan(sec, at);
      if (!plan) return null;
      plans.push(plan);
    }
    return formattingTransaction(this, () => {
      const edits = [];
      for (const { p, segs, objs } of plans) {
        if (segs) {
          // _replaceTracked(ref, 0, 글 길이, '') 와 같은 표식·번호 차례(첫 조각 → 나머지)
          const authorId = this.header.ensureAuthor(author);
          const ids = segs.map(() => this.header.addChange('Delete', authorId, date));
          if (!this.header.trackingEnabled()) this.header.setTracking(true);
          segs.forEach(([a, b], k) => {
            edits.push({ pos: afterChar(p, b), insert: `<hp:deleteEnd Id="${ids[k]}" TcId="${ids[k]}" paraend="0"/>` });
            edits.push({ pos: beforeChar(p, a), insert: `<hp:deleteBegin Id="${ids[k]}" TcId="${ids[k]}"/>` });
          });
        }
        // removeOwnObjectsTracked 와 같은 감쌈(넣음 표식이 없는 개체만 — batchClearable)
        for (const a of objs) {
          const id = this._newObjectChange('Delete', { author, date: objectDate });
          edits.push({ start: a.start, end: a.end, insert: OBJECT_TRACK.wrap(sec.xml.slice(a.start, a.end), { type: 'Delete', id }) });
        }
        if (segs || objs.length) dropLineseg(p, edits);
      }
      if (edits.length) sec.load(applyEdits(sec.xml, edits));
      const changed = new Set(this.changes().map((c) => c.ref));
      return new Map(plans.map(({ at }) => { const p = sec.bodyParas[at]; return [at, Section.markupText(p) !== '' || changed.has(p.ref)]; }));
    });
  }

  /** clearParagraphsTracked 로 흉내 낼 수 있는 본문 문단인가(부르는 쪽이 그런 문단이 잇달아 있는 동안만 묶는다) */
  canClearTracked(sectionIndex, bodyIdx) {
    const sec = this.sections[sectionIndex];
    return !!sec && !!this._clearPlan(sec, bodyIdx);
  }

  /** 본문 문단 at 의 지울 글 조각(ctrlSplit — _replaceTracked(0, 길이) 와 같은 나눔)·감쌀 개체 | null(흉내 낼 수 없음) */
  _clearPlan(sec, at) {
    const p = sec.bodyParas[at];
    if (!p) return null;
    const objs = this._ownObjectAnchors(p);
    if (!batchClearable(p, objs)) return null;
    const fc = Section.visibleChars(p, 'final');
    let segs = null;
    if (fc.length) {
      // mergeParagraphText(ref, '') 의 charOps 가 글 전체 한 덩어리일 때만
      const ops = charOps(Section.text(p, 'final'), '');
      if (ops.length !== 1 || ops[0].start !== 0 || ops[0].end !== fc.length || ops[0].text) return null;
      segs = ctrlSplit(p, p.chars.indexOf(fc[0]), p.chars.indexOf(fc[fc.length - 1]));
    }
    return { at, p, segs, objs };
  }

  /**
   * 본문 번호 ats(지운 문단 — 큰 번호부터)마다 deleteBreakAfter(`s/p{at−1}`, { author, date }) 를 차례로 부른 것과 같다(live.js 2차 — 앞 문단 끝
   * 나눔을 지움 표식으로). 나눔 지움으로 묶이는 기록(최종본 문단)을 흉내 내며 표식 자리를 정하고 편집은 한 번에. 어느 하나라도 던지거나
   * (마지막 문단·구역 나누기·이미 변경된 나눔) 줄 없는 문단에 표식을 둬야 하면 null → 성공하면 true
   */
  deleteBreaksTracked(sectionIndex, ats, { author, date } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    const sec = this.sections[sectionIndex];
    if (!sec) return null;
    const recs = sec.bodyParas;
    const content = new Array(recs.length).fill(null);
    const has = (i) => (content[i] ??= finalContent(recs[i]));
    const groups = recs.map((_, i) => [i]);   // 지금 최종본 문단 = 기록 번호 묶음
    const gone = new Set();                    // 이 묶음 일로 나눔을 지운 기록(그 기록의 마지막 물리 문단 끝)
    const breakOf = (g) => (gone.has(g[g.length - 1]) ? 'Delete' : (Section.breakOf(recs[g[g.length - 1]])?.type ?? null));
    const steps = [];
    let prev = Infinity;
    for (const at of ats) {
      if (!Number.isInteger(at) || at >= prev) return null;
      prev = at;
      const k = at - 1;
      const p = groups[k]; const q = groups[k + 1];
      if (!p || !q || recs[p[0]].parent || sectionBreakAt(sec, recs[q[0]]) || breakOf(p)) return null;
      let tk = k;
      if (BREAK_TRACK.emptyPrevOwnBreak && !p.some(has) && !q.some(has) && !breakOf(q)) {
        const r = groups[k + 2];
        if (r && !sectionBreakAt(sec, recs[r[0]])) tk = k + 1;
      }
      const target = groups[tk]; const last = recs[target[target.length - 1]];
      const ms = Section.members(last);
      if (!last.runs.slice(ms[ms.length - 1].r0).length) return null;
      steps.push({ last, drop: [...p, ...q, ...(tk === k + 1 ? groups[k + 2] : [])] });
      gone.add(target[target.length - 1]);
      groups.splice(tk, 2, [...groups[tk], ...groups[tk + 1]]);
    }
    return formattingTransaction(this, () => {
      const edits = [];
      for (const s of steps) {
        edits.push(this._breakMarkEdit(sec, s.last, this._breakMarksXml('Delete', { author, date })));
        for (const i of s.drop) dropLineseg(recs[i], edits);
      }
      sec.load(applyEdits(sec.xml, dedupe(edits)));
      return true;
    });
  }

  /**
   * 본문 문단 afterIdx 뒤에 넣은 문단들 — texts 는 부르는 차례(문서에서 뒤 문단부터)이고 insertParagraphAfter(sectionIndex, afterIdx, text,
   * { author, date, trackBreak: true }) 를 그 차례로 부른 것과 같다(첫 문단이 앞 문단 나눔을 넣은 나눔으로, 나머지는 제 나눔에). 앞 문단에
   * run 이 없거나 나눔이 이미 지워져 있으면 null → 넣은 문단 ref(texts 차례)
   */
  insertTrackedParagraphsAfter(sectionIndex, afterIdx, texts, { author, date } = {}) {
    const sec = this.sections[sectionIndex];
    if (!sec || !Array.isArray(texts) || !texts.length) return null;
    if (!Number.isInteger(afterIdx) || afterIdx < 0 || afterIdx >= sec.bodyParas.length) return null;
    for (const text of texts) validateTextFormatting(text, {});
    const P = sec.bodyParas[afterIdx];
    const pb = Section.breakOf(P); const ms = Section.members(P);
    if (!P.runs.slice(ms[ms.length - 1].r0).length || (pb && pb.type !== 'Insert')) return null;
    return formattingTransaction(this, () => {
      const paraPr = attrOf(sec.xml, P, 'paraPrIDRef'); const styleId = attrOf(sec.xml, P, 'styleIDRef');
      const charPr = Section.lastLiveRun(P)?.charPr ?? '0';
      let own = !!pb; let prevMarks = null;
      const xmls = texts.map((text) => {
        let inner = text ? this._trackedInsertXml(text, { author, date }) : '';
        const marks = this._breakMarksXml('Insert', { author, date });
        if (own) inner += marks; else { prevMarks = marks; own = true; }
        return `<hp:p id="0" paraPrIDRef="${paraPr}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${inner}</hp:t></hp:run></hp:p>`;
      });
      const insert = { pos: P.end, insert: xmls.reverse().join('') };
      if (prevMarks) {
        const edits = [this._breakMarkEdit(sec, P, prevMarks), insert];
        dropLineseg(P, edits);
        sec.load(applyEdits(sec.xml, dedupe(edits)));
      } else sec.load(sec.xml.slice(0, insert.pos) + insert.insert + sec.xml.slice(insert.pos));
      return texts.map((_, i) => `s${sectionIndex}/p${afterIdx + texts.length - i}`);
    });
  }

  /**
   * [hwpx-cowork] 문단 가름(가운데 Enter)을 변경 추적으로(2단계 — 한/글 실측 꼴): 본문 문단 ref(최종본)를 최종본 글자 offset 에서 물리로 가르고, 앞쪽 반 끝에
   * 폭 0 넣은 나눔(`P머리{+¶+}`), 뒤쪽 반은 같은 문단 모양·스타일의 새 문단으로 옮긴다(글자는 추적 없이 옮김 — 거절하면 원래 문단 하나, 이음매 run 접음).
   * 자름에 걸친 열린 변경 범위(넣음)는 앞쪽에서 닫고 뒤쪽에서 같은 번호로 다시 연다(한/글도 읽고 다시 저장하면 번호를 나눈다 — resolveChanges 는 같은
   * 번호 범위를 모두 푼다). 끝(offset = 글 길이)에서 가르면 빈 새 문단(insertParagraphAfter trackBreak 와 같다).
   * → { id(넣은 나눔 변경), ref(뒤쪽 반 = ref+1), n, d, t, td(앞쪽 반이 가진 직접 중첩 '/n'·'/d' 수와 표 '#t'·'#d' 수 — 부르는 쪽 ref 옮김: i > ref → i+1,
   * ref 의 꼬리 '/n j≥n' → ref+1 '/n j−n' …) }. 문단 기록(takeParaLog)은 적지 않는다. 던짐: NO_AUTHOR · NO_PARAGRAPH · NOT_BODY · RANGE
   */
  splitParagraphTracked(ref, offset, { author, date } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    const { sec, p } = this.resolve(ref);
    if (p.parent) throw new EngineError('NOT_BODY', `본문 문단만 가를 수 있습니다: ${ref}`);
    const n = Section.visibleChars(p, 'final').length;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > n) throw new EngineError('RANGE', `위치가 문단 밖입니다 (0..${n})`);
    return formattingTransaction(this, () => this._splitParagraphTracked(sec, p.body, offset, { author, date }));
  }

  _splitParagraphTracked(sec, k, offset, { author, date }) {
    const p = sec.bodyParas[k];
    const fc = Section.visibleChars(p, 'final');
    const next = `s${sec.index}/p${k + 1}`;
    if (offset === fc.length) {
      const counts = this._partCounts(sec, p, Infinity, null);
      this._insertParagraphAfter(sec.index, k, '', { author, date, trackBreak: true });
      return { id: this.header.changes().length, ref: next, ...counts };
    }
    const xml = sec.xml;
    const ci = p.chars.indexOf(fc[offset]);
    const x = beforeChar(p, ci);
    const counts = this._partCounts(sec, p, x, null);
    const m = Section.members(p)[Section.memberAt(p, ci)];
    // 자름에 걸친 열린 범위(같은 물리 문단에서 x 앞에서 시작해 x 뒤에서 끝남)
    const opens = [];
    for (const b of p.anchors) {
      if (b.kind !== 'change' || (b.name !== 'hp:insertBegin' && b.name !== 'hp:deleteBegin') || b.start < m.start || b.end > x) continue;
      const en = b.name === 'hp:insertBegin' ? 'hp:insertEnd' : 'hp:deleteEnd';
      const e = p.anchors.find((a) => a.kind === 'change' && a.name === en && a.id === b.id && a.start > b.start);
      if (e && e.start >= x && e.end <= m.end) opens.push({ b, e });
    }
    const kind = (b) => (b.name === 'hp:insertBegin' ? 'insert' : 'delete');
    const closes = [...opens].reverse().map(({ b }) => `<hp:${kind(b)}End Id="${b.id}" TcId="${b.id}" paraend="0"/>`).join('');
    const reopens = opens.map(({ b }) => `<hp:${kind(b)}Begin Id="${b.id}" TcId="${b.id}"/>`).join('');
    const marks = this._breakMarksXml('Insert', { author, date });
    const id = Number(/Id="(\d+)"/.exec(marks)[1]);
    const newOpen = `<hp:p id="0" paraPrIDRef="${attrOf(xml, p, 'paraPrIDRef')}" styleIDRef="${attrOf(xml, p, 'styleIDRef')}" pageBreak="0" columnBreak="0" merged="0">`;
    const runOpen = (r) => xml.slice(r.start, xml.indexOf('>', r.start) + 1);
    const T = p.ts.find((t) => !t.selfclose && t.openEnd <= x && x <= t.closeStart);
    const R = T ? T.run : p.runs.find((r) => !r.selfclose && xml.indexOf('>', r.start) + 1 <= x && x <= r.end - '</hp:run>'.length);
    let cut;
    if (T) cut = `${closes}${marks}</hp:t></hp:run></hp:p>${newOpen}${runOpen(T.run)}<hp:t>${reopens}`;
    else if (R) cut = `<hp:t>${closes}${marks}</hp:t></hp:run></hp:p>${newOpen}${runOpen(R)}${reopens ? `<hp:t>${reopens}</hp:t>` : ''}`;
    else {
      const after = p.runs.find((r) => r.start >= x); const before = [...p.runs].reverse().find((r) => r.end <= x);
      const cp = (before || after)?.charPr ?? '0';
      cut = `<hp:run charPrIDRef="${cp}"><hp:t>${closes}${marks}</hp:t></hp:run></hp:p>${newOpen}${reopens ? `<hp:run charPrIDRef="${after?.charPr ?? cp}"><hp:t>${reopens}</hp:t></hp:run>` : ''}`;
    }
    const edits = [{ pos: x, insert: cut }];
    dropLineseg(p, edits);
    sec.load(applyEdits(xml, dedupe(edits)));
    return { id, ref: next, ...counts };
  }

  /** 삽입 변경 추적으로 감싼 인라인 글 XML(헤더 항목을 만든다) */
  _trackedInsertXml(text, { author, date } = {}) {
    const authorId = this.header.ensureAuthor(author || '?');
    const id = this.header.addChange('Insert', authorId, date);
    if (!this.header.trackingEnabled()) this.header.setTracking(true);
    return `<hp:insertBegin Id="${id}" TcId="${id}"/>${inlineXml(text)}<hp:insertEnd Id="${id}" TcId="${id}" paraend="0"/>`;
  }

  // ───────── 표 넣기 · 문단 지우기 ─────────

  /**
   * 본문 문단 afterIdx 뒤에 표 하나만 든 문단을 넣는다.
   * 캡션이 있으면 한글 캡션(hp:caption) 안에 '[표 ' + 자동 번호(hp:autoNum TABLE) + '] 제목' 꼴로 넣고 번호 종류를 '표'(TABLE)로 둔다 —
   * 꼴(앞뒤 글·위치·문단 모양)은 문서의 자동 번호 캡션을 따르고, 없으면 표준서식. 사람이 적은 번호('표 3.' 등)는 뗀다.
   * 제목 글은 변경 추적 '삽입', 표 자체는 추적 없이 들어간다(이력은 서버가 메모로 남긴다). 캡션이 없으면 번호 종류 '없음'.
   * 모양은 문서의 본보기 표(_tableModel)를 빌리고, 표가 없으면 표준서식 표 모양을 header 에 만들어 쓴다(_tableStyle).
   * @param {{rows: string[][], headerRows?: number, caption?: string}} spec
   * @returns {{ref: string, captionRef: string|null, tableKey: string, bodyShift: 1}} captionRef 는 표 문단의 중첩 ref(`${ref}/n0`)
   */
  insertTableAfter(sectionIndex, afterIdx, { rows, headerRows = 1, caption = '', like = null } = {}, { author, date, trackBreak = false } = {}) {
    const sec = this.sections[sectionIndex];
    if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: ${sectionIndex}`);
    if (!sec.bodyParas.length) throw new EngineError('NO_PARAGRAPH', '구역에 본문 문단이 없습니다');
    if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new EngineError('TABLE_ROWS', '표 내용(rows: 문자열 2차원 배열)이 필요합니다');
    const nCols = Math.max(...rows.map((r) => r.length));
    if (nCols < 1) throw new EngineError('TABLE_ROWS', '표에 열이 없습니다');
    if (rows.length > 1000 || nCols > 60) throw new EngineError('TABLE_SIZE', `표가 너무 큽니다(${rows.length}×${nCols}, 최대 1000×60)`);
    const grid = rows.map((r) => Array.from({ length: nCols }, (_, c) => cellText(r[c])));
    const hr = Math.max(0, Math.min(rows.length, parseInt(headerRows, 10) || 0));
    if (!Number.isFinite(Number(afterIdx))) throw new EngineError('RANGE', `문단 번호가 잘못되었습니다: ${afterIdx}`);
    const at = Math.max(0, Math.min(Math.trunc(Number(afterIdx)), sec.bodyParas.length - 1));
    // like(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §20): 본보기 표를 사람·AI 가 고른다. 크기가 같으면 칸마다 그 표의 모양·열 폭을 그대로
    const style = this._tableStyle(like, { rows: grid.length, cols: nCols });
    // 폭은 본보기 표 폭(본문 폭의 90~100% 일 때 — 표준서식 표 42,240), 아니면 본문 폭
    const textWidth = sectionTextWidth(sec);
    const width = style.width && style.width <= textWidth && style.width >= textWidth * 0.9 ? style.width : textWidth;
    const num0 = numericColumns(grid, hr)[0]; // 첫 열 모양(정렬 변형)을 표를 만들 때와 같은 열쇠로 미리 받는다
    // 한 쪽보다 길어 보이면 '자리 차지'로 둬 쪽 경계에서 셀 단위로 나뉘게 한다(글자처럼 취급 표는 쪽을 넘으면 잘린다)
    const estH = grid.reduce((s, _, r) => s + style.cell(r, 0, grid.length, nCols, hr, { numeric: num0 }).height, 0);
    if (estH > sectionTextHeight(sec) * 0.85) {
      style.pos = style.pos.replace(/treatAsChar="\d"/, 'treatAsChar="0"');
      style.tblAttrs.set('pageBreak', 'CELL');
    }
    const id = uniqueNumber(this.sections.map((s) => s.xml).join(''), 'id');
    const zOrder = Math.max(0, ...this.sections.flatMap((s) => [...s.xml.matchAll(/\bzOrder="(\d+)"/g)].map((m) => parseInt(m[1], 10)))) + 1;
    const pos = sec.bodyParas[at].end;
    const capText = stripCaptionNumber(cellText(caption).replace(/\s*\n\s*/g, ' '));
    const captionXml = capText ? this._captionXml(style.caption, capText, { numType: 'TABLE', sectionIndex, pos, width, near: sec.bodyParas[at], author, date }) : '';
    const tbl = tableXml({ id, zOrder, rows: grid, headerRows: hr, width, style, textXml: inlineXml, numbering: capText ? 'TABLE' : 'NONE', captionXml });
    const tp = style.para;
    const xml = `<hp:p id="0" paraPrIDRef="${tp.paraPr}" styleIDRef="${tp.styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${tp.charPr}">${tbl}<hp:t/></hp:run></hp:p>`;
    const breakId = this._insertParagraphXml(sec, at, xml, { author, date, trackBreak });
    const ref = `s${sectionIndex}/p${at + 1}`;
    return { ref, captionRef: capText ? `${ref}/n0` : null, tableKey: `${ref}#t0`, bodyShift: 1, ...(trackBreak ? { breakId } : {}) };
  }

  /**
   * 캡션 요소(hp:caption): cs 꼴(captionFormat·표준)로 앞 글 + 자동 번호(numType — pos 자리 번호) + 뒤 글 + 제목(변경 추적 '삽입').
   * 꼴에 문단 모양이 없으면 near 문단 것. width = 개체 폭(lastWidth)
   */
  _captionXml(cs, text, { numType, sectionIndex, pos, width, near, author, date }) {
    const sec = this.sections[sectionIndex];
    const ps = cs.para || { paraPr: attrOf(sec.xml, near, 'paraPrIDRef'), styleId: attrOf(sec.xml, near, 'styleIDRef'), charPr: near.runs.length ? near.runs[near.runs.length - 1].charPr : '0' };
    const t = (s) => (s ? `<hp:t>${escapeText(s)}</hp:t>` : '');
    const autoNum = cs.autoNum.replace(/\bnum="\d+"/, `num="${this._autoNumberAt(sectionIndex, pos, numType)}"`);
    return cs.open.replace(/\blastWidth="\d+"/, `lastWidth="${width}"`) + cs.subList
      + `<hp:p id="0" paraPrIDRef="${ps.paraPr}" styleIDRef="${ps.styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${ps.charPr}">`
      + `${t(cs.prefix)}<hp:ctrl>${autoNum}</hp:ctrl><hp:t>${escapeText(cs.suffix)}${this._trackedInsertXml(text, { author, date })}</hp:t></hp:run></hp:p></hp:subList></hp:caption>`;
  }

  // ───────── 그림 넣기 ─────────

  /**
   * 그림 목록(문서 순서, 셀·글상자 안 것 포함): [{ ref(그림을 품은 문단), n(그 문단 안 몇째 그림, 1부터), binId, width, height(보이는 크기 HWPUNIT),
   * caption: {ref, text}|null }]
   */
  figures() {
    const out = []; const seen = new Map();
    for (const sec of this.sections) {
      for (const pic of scanPictures(sec)) {
        if (!pic.owner || this._hiddenPicture(pic)) continue; // [hwpx-cowork] 최종본 보기 — 변경 추적으로 지운 그림은 없다
        const sz = /<hp:curSz width="(\d+)" height="(\d+)"/.exec(pic.head);
        const n = (seen.get(pic.owner.ref) || 0) + 1; seen.set(pic.owner.ref, n);
        out.push({ ref: pic.owner.ref, n, binId: pic.binId, width: sz ? Number(sz[1]) : 0, height: sz ? Number(sz[2]) : 0, caption: pic.cap ? { ref: pic.cap.ref, text: Section.text(pic.cap, 'final') } : null });
      }
    }
    return out;
  }

  /** 그림 파일 항목 binId → { href, mime, bytes } | null (매니페스트 content.hpf 의 href 를 따른다) */
  binaryItem(binId) {
    if (!binId) return null;
    const hpf = this.container.getText('Contents/content.hpf') || '';
    const item = new RegExp(`<opf:item\\b[^>]*\\bid="${String(binId).replace(/[^\w-]/g, '')}"[^>]*/>`).exec(hpf);
    const href = item ? (/\bhref="([^"]+)"/.exec(item[0]) || [])[1] : null;
    const bytes = href ? this.container.getBytes(href) : null;
    return bytes ? { href, mime: (/\bmedia-type="([^"]+)"/.exec(item[0]) || [])[1] || '', bytes } : null;
  }

  /** 문단 ref 의 그림 — binId 가 같은 것 가운데 n 째(없으면 binId 가 같은 첫 그림) → { sec, pic } | null */
  _findPicture(ref, binId, n = 1) {
    for (const sec of this.sections) {
      const pics = scanPictures(sec).filter((p) => p.owner && p.owner.ref === ref && !this._hiddenPicture(p));
      if (!pics.length) continue;
      const pic = pics[n - 1]?.binId === binId ? pics[n - 1] : pics.find((p) => p.binId === binId);
      return pic ? { sec, pic } : null;
    }
    return null;
  }

  /**
   * 문단 ref 의 그림(binId·n)을 새 그림 파일로 바꾼다 — 캡션·번호·배치·문단은 그대로, 그림 파일·원본 크기·보이는 크기만.
   * 보이는 폭은 widthMm 이 있으면 그 폭, 없으면 지금 폭(본문 폭 안), 높이는 새 그림 비율대로(한 쪽 높이 안으로 줄임).
   * 예전 그림 파일은 지우지 않는다(되돌리기 restorePicture 가 다시 쓴다).
   * @returns {{ ref, binId(새 항목), width, height, prev: { head, lastWidth } }} prev = 되돌릴 때 쓸 캡션 앞 그림 XML·캡션 lastWidth
   */
  replacePicture(ref, { binId, n = 1 } = {}, { data, widthMm = null } = {}) {
    const hit = this._findPicture(ref, binId, n);
    if (!hit) throw new EngineError('NOT_FOUND', `바꿀 그림을 찾지 못했습니다(문서가 바뀌었을 수 있음): ${ref}`);
    const info = imageInfo(data);
    if (!info) throw new EngineError('BAD_IMAGE', '그림 파일(PNG·JPEG·GIF·BMP)이 아니거나 크기를 읽지 못했습니다');
    const { sec, pic } = hit;
    const xml = sec.xml.slice(pic.start, pic.end); const head = pic.head; const tail = xml.slice(head.length);
    const old = /<hp:curSz width="(\d+)" height="(\d+)"/.exec(head);
    const oldW = old ? Number(old[1]) : 0;
    const textWidth = sectionTextWidth(sec);
    const org = { w: info.width * PX, h: info.height * PX };
    let w = Math.min(textWidth, Number(widthMm) > 0 ? Math.round(Number(widthMm) * MM) : (oldW || org.w));
    let h = Math.round((w * org.h) / org.w);
    const maxH = Math.min(56000, Math.round(sectionTextHeight(sec) * 0.85));
    if (h > maxH) { h = maxH; w = Math.round((h * org.w) / org.h); }
    const newBin = this._addBinary(data, info);
    const s = (x) => String(Number(x.toFixed(5)));
    let nh = head
      .replace(/<hp:orgSz\b[^>]*\/>/, `<hp:orgSz width="${org.w}" height="${org.h}"/>`)
      .replace(/<hp:curSz\b[^>]*\/>/, `<hp:curSz width="${w}" height="${h}"/>`)
      .replace(/<hp:rotationInfo\b[^>]*\/>/, (m) => m.replace(/\bcenterX="\d+"/, `centerX="${Math.floor(w / 2)}"`).replace(/\bcenterY="\d+"/, `centerY="${Math.floor(h / 2)}"`))
      .replace(/<hc:scaMatrix\b[^>]*\/>/, (m) => m.replace(/\be1="[^"]*"/, `e1="${s(w / org.w)}"`).replace(/\be5="[^"]*"/, `e5="${s(h / org.h)}"`))
      .replace(/<hp:imgRect\b[^>]*>[\s\S]*?<\/hp:imgRect>/, `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${org.w}" y="0"/><hc:pt2 x="${org.w}" y="${org.h}"/><hc:pt3 x="0" y="${org.h}"/></hp:imgRect>`)
      .replace(/<hp:imgClip\b[^>]*\/>/, `<hp:imgClip left="0" right="${org.w}" top="0" bottom="${org.h}"/>`)
      .replace(/<hp:imgDim\b[^>]*\/>/, `<hp:imgDim dimwidth="${org.w}" dimheight="${org.h}"/>`)
      .replace(/(<hc:img\b[^>]*\bbinaryItemIDRef=")[^"]*(")/, `$1${newBin}$2`)
      .replace(/<hp:sz\b[^>]*\/>/, (m) => m.replace(/\bwidth="\d+"/, `width="${w}"`).replace(/\bheight="\d+"/, `height="${h}"`));
    // 폭이 바뀌면: 가운데 맞춤용 왼쪽 바깥 여백(insertPictureAfter 가 넣은 꼴)과 캡션 폭(lastWidth)도 따라간다.
    // 문단이 가운데 정렬이면 한/글이 그림 상자(바깥 여백 포함)를 가운데에 두므로 여백을 더하면 그만큼 오른쪽으로 밀린다
    // (매크로테스트용_저장 v19: 폭 120mm + 왼쪽 여백 4252 → 한/글 PDF 에서 그림이 가운데보다 28px 오른쪽) — 그때는 0.
    const lastOld = (/<hp:caption\b[^>]*\blastWidth="(\d+)"/.exec(tail) || [])[1];
    let nt = tail;
    if (w !== oldW) {
      const owner = pic.owner;
      const centered = !!owner && /<hh:align horizontal="CENTER"/.test(this.header.block('paraPr', attrOf(sec.xml, owner, 'paraPrIDRef')) || '');
      nh = nh.replace(/<hp:outMargin\b[^>]*\/>/, (m) => {
        const left = Number((/\bleft="(\d+)"/.exec(m) || [])[1]);
        const ours = pic.body && oldW && Math.abs(left - Math.floor((textWidth - oldW) / 2)) <= 1;
        if (!ours) return m;
        return m.replace(/\bleft="\d+"/, `left="${centered ? 0 : Math.max(0, Math.floor((textWidth - w) / 2))}"`);
      });
      if (lastOld != null) nt = tail.replace(/(<hp:caption\b[^>]*\blastWidth=")\d+(")/, `$1${w}$2`);
    }
    // 그림 크기가 바뀌었으니 그 문단의 줄 정보(hp:linesegarray — 옛 그림 높이)는 낡았다. 지워 한/글·편집기가 다시 재게 한다
    // (남겨 두면 한/글은 다시 재지만 rhwp 는 옛 높이로 그림 아래에 빈자리를 남겼다).
    const owner = pic.owner;
    const segEdit = owner?.lineseg && (w !== oldW || h !== (old ? Number(old[2]) : 0)) ? owner.lineseg : null;
    let out = sec.xml.slice(0, pic.start) + nh + nt + sec.xml.slice(pic.end);
    if (segEdit && segEdit.start > pic.end) {
      const shift = nh.length + nt.length - (pic.end - pic.start);
      out = out.slice(0, segEdit.start + shift) + out.slice(segEdit.end + shift);
    }
    sec.load(out);
    return { ref, binId: newBin, width: w, height: h, prev: { head, lastWidth: lastOld != null ? Number(lastOld) : null } };
  }

  /** replacePicture 되돌리기: 문단 ref 의 그림(binId = 바꿔 넣은 항목)의 캡션 앞 XML·캡션 폭을 prev 로 → 되돌렸는가. 새 그림 파일은 removeUnusedBinary 로 거둔다 */
  restorePicture(ref, binId, prev) {
    if (!prev?.head) throw new EngineError('STATE', '되돌릴 그림 기록이 없습니다');
    const hit = this._findPicture(ref, binId, 1);
    if (!hit) throw new EngineError('NOT_FOUND', `바꾼 그림을 찾지 못했습니다(문서가 바뀌었을 수 있음): ${ref}`);
    const { sec, pic } = hit;
    let tail = sec.xml.slice(pic.start + pic.head.length, pic.end);
    if (prev.lastWidth != null) tail = tail.replace(/(<hp:caption\b[^>]*\blastWidth=")\d+(")/, `$1${prev.lastWidth}$2`);
    sec.load(sec.xml.slice(0, pic.start) + prev.head + tail + sec.xml.slice(pic.end));
    return true;
  }

  /**
   * 본문 문단 afterIdx 뒤에 그림 하나만 든 문단을 넣는다. 그림 파일은 BinData 에 새 항목(매니페스트 content.hpf 포함)으로 들어간다.
   * 캡션이 있으면 그림 캡션(hp:caption) 안에 '[그림 ' + 자동 번호(hp:autoNum PICTURE) + '] 제목'(제목 글만 변경 추적 '삽입'), 번호 종류 '그림' —
   * 꼴(앞뒤 글·위치·문단 모양)은 문서의 자동 번호 그림 캡션을, 없으면 표준서식(그림 아래)을 따른다. 사람이 적은 번호('그림 3.')는 뗀다. 캡션이 없으면 번호 종류 '없음'.
   * 크기: widthMm 이 있으면 그 폭, 없으면 원본 크기(96dpi)를 넘지 않게 — 본문 폭과 한 쪽 높이(캡션 자리를 남김) 안으로 비율대로 줄인다.
   * 배치·문단 모양은 문서의 본보기 그림을 따르고(_pictureStyle), 좁은 그림은 가운데에 둔다.
   * @param {{ data: Uint8Array, caption?: string, widthMm?: number|null }} spec
   * @returns {{ ref: string, captionRef: string|null, binId: string, width: number, height: number, bodyShift: 1 }}
   */
  insertPictureAfter(sectionIndex, afterIdx, { data, caption = '', widthMm = null } = {}, { author, date, trackBreak = false } = {}) {
    const sec = this.sections[sectionIndex];
    if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: ${sectionIndex}`);
    if (!sec.bodyParas.length) throw new EngineError('NO_PARAGRAPH', '구역에 본문 문단이 없습니다');
    const info = imageInfo(data);
    if (!info) throw new EngineError('BAD_IMAGE', '그림 파일(PNG·JPEG·GIF·BMP)이 아니거나 크기를 읽지 못했습니다');
    if (!Number.isFinite(Number(afterIdx))) throw new EngineError('RANGE', `문단 번호가 잘못되었습니다: ${afterIdx}`);
    const at = Math.max(0, Math.min(Math.trunc(Number(afterIdx)), sec.bodyParas.length - 1));
    const style = this._pictureStyle();
    const textWidth = sectionTextWidth(sec);
    const org = { w: info.width * PX, h: info.height * PX };
    let w = Math.min(textWidth, Number(widthMm) > 0 ? Math.round(Number(widthMm) * MM) : org.w);
    let h = Math.round((w * org.h) / org.w);
    const maxH = Math.min(56000, Math.round(sectionTextHeight(sec) * 0.85)); // 서식명세 §5 — 캡션까지 한 쪽에
    if (h > maxH) { h = maxH; w = Math.round((h * org.w) / org.h); }
    // 좁은 그림은 가운데: 문단이 가운데 정렬이 아니면 바깥 여백 왼쪽으로(서식명세 §5)
    const left = w < textWidth && !style.centered ? Math.floor((textWidth - w) / 2) : 0;
    const outMargin = style.outMargin.replace(/\bleft="\d+"/, `left="${left}"`);
    const all = this.sections.map((s) => s.xml).join('');
    const id = uniqueNumber(all, 'id'); const instid = uniqueNumber(all, 'instid');
    const zOrder = Math.max(0, ...this.sections.flatMap((s) => [...s.xml.matchAll(/\bzOrder="(\d+)"/g)].map((m) => parseInt(m[1], 10)))) + 1;
    const pos = sec.bodyParas[at].end;
    const capText = stripCaptionNumber(cellText(caption).replace(/\s*\n\s*/g, ' '), '그림');
    const captionXml = capText ? this._captionXml(style.caption, capText, { numType: 'PICTURE', sectionIndex, pos, width: w, near: sec.bodyParas[at], author, date }) : '';
    const binId = this._addBinary(data, info);
    const pic = pictureXml({ id, instid, zOrder, attrs: style.attrs, binId, org, cur: { w, h }, pos: style.pos, outMargin, captionXml, numbering: capText ? 'PICTURE' : 'NONE' });
    const tp = style.para;
    const xml = `<hp:p id="0" paraPrIDRef="${tp.paraPr}" styleIDRef="${tp.styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${tp.charPr}">${pic}<hp:t/></hp:run></hp:p>`;
    const breakId = this._insertParagraphXml(sec, at, xml, { author, date, trackBreak });
    const ref = `s${sectionIndex}/p${at + 1}`;
    return { ref, captionRef: capText ? `${ref}/n0` : null, binId, width: w, height: h, bodyShift: 1, ...(trackBreak ? { breakId } : {}) };
  }

  /**
   * 새 그림 모양: 본보기 = 캡션에 그림 자동 번호가 있는 첫 본문 그림 — 여는 태그 속성·배치(hp:pos)·바깥 여백·문단 모양·캡션 꼴.
   * 없으면 표준서식(글자처럼 취급·조판 부호와 같은 쪽·아래 여백 283, 바탕글 가운데 문단, 캡션 '[그림 N] 제목' 아래).
   * → { attrs(Map), pos, outMargin, para, caption, centered(문단이 가운데 정렬인가) }
   */
  _pictureStyle() {
    const h = this.header;
    let model = null;
    for (const sec of this.sections) {
      for (const pic of scanPictures(sec)) {
        if (!pic.body || !pic.cap || !/\bnumberingType="PICTURE"/.test(pic.open) || this._hiddenPicture(pic)) continue;
        const cap = captionFormat(sec, pic.cap, pic.start, 'PICTURE');
        if (cap) { model = { sec, pic, cap }; break; }
      }
      if (model) break;
    }
    let para; let attrs = new Map(FIG_ATTRS); let pos = FIG_POS; let outMargin = FIG_OUT_MARGIN; let caption;
    if (model) {
      const { sec, pic } = model; const own = pic.owner;
      const run = own.runs.find((x) => x.start < pic.start && pic.start < x.end) || own.runs[0];
      para = { paraPr: attrOf(sec.xml, own, 'paraPrIDRef'), styleId: attrOf(sec.xml, own, 'styleIDRef'), charPr: run ? run.charPr : '0' };
      attrs = new Map(FIG_ATTRS.map(([k, v]) => [k, (new RegExp(`\\s${k}="([^"]*)"`).exec(pic.open) || [])[1] ?? v]));
      pos = (/<hp:pos\b[^>]*\/>/.exec(pic.head) || [FIG_POS])[0];
      outMargin = (/<hp:outMargin\b[^>]*\/>/.exec(pic.head) || [FIG_OUT_MARGIN])[0];
      caption = model.cap;
    } else {
      const normal = h.style({ engName: 'Normal' }) || h.style({ id: 0 }) || { styleId: '0', paraPr: '0', charPr: '0' };
      para = { paraPr: h.paraPrVariant(normal.paraPr, { align: 'CENTER', noIndent: true }), styleId: normal.styleId, charPr: normal.charPr };
      caption = { ...STD_FIG_CAPTION, para: captionStyle(h) };
    }
    const centered = /<hh:align horizontal="CENTER"/.test(h.block('paraPr', para.paraPr) || '');
    return { attrs, pos, outMargin, para, caption, centered };
  }

  /** 그림 파일을 BinData 새 항목으로 넣고 매니페스트(content.hpf)에 올린다 → 항목 id('imageN' — 있는 번호 다음) */
  _addBinary(data, info) {
    const hpfName = 'Contents/content.hpf';
    const hpf = this.container.getText(hpfName);
    if (!hpf || !hpf.includes('</opf:manifest>')) throw new EngineError('NO_MANIFEST', '문서에 매니페스트(content.hpf)가 없어 그림을 넣을 수 없습니다');
    const used = [...hpf.matchAll(/<opf:item\b[^>]*\bid="image(\d+)"/g), ...this.container.order.map((n) => /^BinData\/image(\d+)\./i.exec(n)).filter(Boolean)].map((m) => parseInt(m[1], 10));
    const id = `image${Math.max(0, ...used) + 1}`; const href = `BinData/${id}.${info.ext}`;
    this.container.setBytes(href, data instanceof Uint8Array ? data : new Uint8Array(data));
    this.container.setText(hpfName, hpf.replace('</opf:manifest>', `<opf:item id="${id}" href="${href}" media-type="${info.mime}" isEmbeded="1"/></opf:manifest>`));
    return id;
  }

  /** 그림 파일 항목 binId 를 아무 XML(구역·머리·바탕쪽 …)도 쓰지 않으면 BinData 파일과 매니페스트 항목을 지운다 → 지웠는가 */
  removeUnusedBinary(binId) {
    if (!binId) return false;
    const use = `binaryItemIDRef="${binId}"`;
    if (this.sections.some((s) => s.xml.includes(use)) || this.header.xml.includes(use)) return false;
    const skip = new Set([...this.sectionNames, 'Contents/header.xml', 'Contents/content.hpf']);
    if (this.container.order.some((n) => /\.xml$/i.test(n) && !skip.has(n) && (this.container.getText(n) || '').includes(use))) return false;
    const hpfName = 'Contents/content.hpf'; const hpf = this.container.getText(hpfName) || '';
    const item = new RegExp(`<opf:item\\b[^>]*\\bid="${binId.replace(/[^\w-]/g, '')}"[^>]*/>`).exec(hpf);
    if (!item) return false;
    this.container.setText(hpfName, hpf.replace(item[0], ''));
    const href = (/\bhref="([^"]+)"/.exec(item[0]) || [])[1];
    if (href) this.container.remove(href);
    return true;
  }

  /**
   * 구역 sectionIndex 의 XML 자리 pos 에 새 개체(번호 종류 type: TABLE 등)를 넣으면 받을 번호 — 앞에서부터 hp:newNum 은 다시 시작,
   * 번호 종류(numberingType)가 type 인 개체는 캡션이 없어도 하나씩(한/글 셈 — 캡션의 hp:autoNum 은 제 개체 번호를 보일 뿐;
   * 표는 numberingType 이 없으면 TABLE). 한글·rhwp 는 열 때 다시 매긴다
   */
  _autoNumberAt(sectionIndex, pos, type) {
    const re = /<hp:(newNum|tbl|pic|rect|ellipse|line|arc|polygon|curve|connectLine|container|equation|ole|chart|textart)\b[^>]*>/g;
    let n = 0;
    this.sections.slice(0, sectionIndex + 1).forEach((s, i) => {
      for (const m of (i === sectionIndex ? s.xml.slice(0, pos) : s.xml).matchAll(re)) {
        if (m[1] === 'newNum') {
          if (tagAttr(m[0], 'numType') === type) n = parseInt(tagAttr(m[0], 'num') || '1', 10) - 1;
        } else if ((tagAttr(m[0], 'numberingType') ?? (m[1] === 'tbl' ? 'TABLE' : 'NONE')) === type) n++;
      }
    });
    return n + 1;
  }

  // ───────── 개체 속성·조판 부호(diffDocs 'object' 덩어리 — 그림 크기·배치, 자동 번호·새 번호 등) ─────────

  /** 구역의 그림 색인(주인 문단 → 그 문단이 직접 가진 그림들, 문서 순서) — 구역 XML 이 바뀔 때만 다시 만든다 */
  _pictureIndex(sec) {
    // [hwpx-cowork] 다시 읽을 때마다(stamp) 새로 — 주인 문단 기록이 열쇠이므로 같은 XML 로 돌아와도 지금 기록이어야 한다(2026-11-16 구역 부분 다시 읽기)
    if (!sec._pics || sec._pics.stamp !== sec.stamp) {
      const byOwner = new Map();
      for (const pic of scanPictures(sec)) {
        if (!pic.owner) continue;
        if (!byOwner.has(pic.owner)) byOwner.set(pic.owner, []);
        byOwner.get(pic.owner).push(pic);
      }
      sec._pics = { stamp: sec.stamp, byOwner };
    }
    return sec._pics.byOwner;
  }

  /** [hwpx-cowork] 문단이 run 에 직접 가진 그림(문서 순서) — 묶음(hp:container) 안 그림은 묶음째 도형으로 옮긴다(_objectInfo shapes) */
  _ownPictures(sec, p, view = 'final') {
    const own = this._pictureIndex(sec).get(p) || [];
    if (!own.length) return own;
    // [hwpx-cowork] view(기본 최종본): 변경 추적으로 지운 그림은 뺀다('all' = 모두)
    const starts = new Set(p.anchors.filter((a) => a.kind === 'ctrl' && a.name === 'hp:pic' && Section.visibleObject(a, view)).map((a) => a.start));
    return own.filter((x) => starts.has(x.start));
  }

  /**
   * [hwpx-cowork] 그림(scanPictures 항목)이 최종본에서 안 보이는가 — 주인 문단이 지운 개체 안이거나, 그림(또는 그림을 품은 묶음 등 개체)이
   * 변경 추적으로 지워졌다
   */
  _hiddenPicture(pic) {
    const o = pic.owner;
    if (!o) return false;
    return !!o.hidden || o.anchors.some((a) => a.del && isObjectAnchor(a) && a.start <= pic.start && pic.end <= a.end);
  }

  /**
   * 그림 파일 열쇠(내용 — 바이트 수 + 앞뒤·고르게 뽑은 바이트의 해시) — 두 문서의 같은 그림을 짝짓는다. 그림 파일 id 는 쓰지 않는다:
   * 편집기(rhwp) 내보내기는 그림 파일 번호를 차례로 다시 매긴다(image901 → image5 — 2025 보고서)
   */
  _picKey(binId) {
    // [hwpx-cowork] 차트 부분(chartIDRef)도 내용 열쇠로 — 편집기에서 차트 값만 바꿔도 도형 지문이 달라진다(engine/chart-parts.js)
    if (/^Chart\//.test(binId)) return chartPartKey(this, binId);
    const b = this.binaryItem(binId);
    return b ? bytesKey(b.bytes) : `missing:${binId}`;
  }

  /**
   * 문단 ref 가 직접 가진 그림·조판 부호. 메모 본문·중첩 문단(표 칸·캡션)의 것은 그 문단 ref 로 따로 본다.
   * → { pics: [{ pic, binId, key, pos(최종본 글자 자리), props }], codes: [{ a, key, label, pos, xml(<hp:ctrl>…</hp:ctrl>) }] }
   */
  _objectInfo(ref) {
    // [hwpx-cowork] 같은 문서 상태(모든 구역의 읽은 차례 stamp — 구역을 고치면 다시 읽어 바뀌고, 구역을 통째로 바꿔 끼워도 다르다)에서 같은
    // 문단을 다시 물으면 앞 결과를 그대로(읽기만 하는 값 — 고치는 쪽은 구역을 다시 읽는다). 그림 파일 열쇠(_picKey)는 새 그림을 새 항목으로만
    // 넣으므로(_addBinary) 구역이 그대로면 같다. 밀어 넣기 한 번에 비교(diffDocs)·옮기기(copyObjectsFrom)·지문(objectPrint)이 글상자 수백 개
    // 문단의 도형 속성을 여러 번 다시 셌다(2026-11-10)
    const seq = this.sections.map((s) => s.stamp).join(',');
    if (this._objectInfoCache?.seq !== seq) this._objectInfoCache = { seq, map: new Map() };
    const hit = this._objectInfoCache.map.get(ref);
    if (hit) return hit;
    const info = this._objectInfoUncached(ref);
    // 너무 많이 쌓이면(개체 수로 센다 — 문서를 메모리에 오래 두는 서버) 비우고 다시 모은다
    const c = this._objectInfoCache; c.objects = (c.objects || 0) + info.pics.length + info.tables.length + info.shapes.length + 1;
    if (c.objects > 20000) { c.map.clear(); c.objects = 0; }
    c.map.set(ref, info);
    return info;
  }

  _objectInfoUncached(ref) {
    const { sec, p } = this.resolve(ref);
    const own = this._ownPictures(sec, p);
    let fin = null;
    const posOf = (start) => {
      const a = p.anchors.find((x) => x.kind === 'ctrl' && x.start === start);
      if (!a) return 0;
      if (!fin) { fin = [0]; for (const c of p.chars) fin.push(fin[fin.length - 1] + (c.del ? 0 : 1)); }
      return fin[Math.min(a.pos, fin.length - 1)];
    };
    // [hwpx-cowork] more = 그림 요소 전체 지문(캡션 빼고 — PIC_PROPS 밖 선·효과·설명 등, 2026-11-12 편집 보존). props 는 종전 지문(판 1·2)이 쓰므로 그대로 둔다.
    // 머리(캡션 앞)만 보면 안 된다: 한/글은 hp:shapeComment 를 캡션 앞에, 편집기는 캡션 뒤에 써서 손대지 않은 캡션 그림이 거짓 덩어리가 되고 반영 때 설명이 빠졌다
    const pics = own.map((pic) => ({ pic, binId: pic.binId, key: this._picKey(pic.binId), pos: posOf(pic.start), props: pictureProps(sec.xml.slice(pic.start, pic.end), pic.head.length), ...pictureCanon(sec.xml.slice(pic.start, pic.end)) }));   // more·rest
    // [hwpx-cowork] 최종본 보기: 변경 추적으로 지운 표는 빼고, 표 뼈대는 칸 안의 지운 개체(그림·표 …)를 빼고 본다(평탄화 사본과 같은 지문)
    const tables = this._tableIndex(sec).tables.filter((t) => t.owner === p && !t.hidden)
      .map((t) => ({ t, pos: posOf(t.start), print: tableSkeleton(this, this._visibleSlice(sec, t.start, t.end)), head: tableHead(sec.xml.slice(t.start, t.end)) }));
    const id = attrOf(sec.xml, p, 'id');
    // 문서 안 하이퍼링크(차례 항목 '?#<id>;…')가 가리키는 문단이면 그 id 도 옮긴다(편집기가 고유 id 를 새로 줬을 수 있다)
    const pid = id !== '0' && id !== '2147483648' && this._linkTargetIds().has(id) ? id : null;
    // [hwpx-cowork] 도형(engine/shapes.js): 짝짓기 열쇠(이름+id)·비교 속성·지문 글
    const shapes = ownShapeAnchors(p).map((a) => {
      const xml = sec.xml.slice(a.start, a.end);
      const { props, print } = shapePropsMemo(xml, (v) => this._picKey(v));
      return { a, tag: anchorTag(a), xml, key: shapeKey(anchorTag(a), xml), pos: posOf(a.start), props, print };
    });
    return { pics, tables, shapes, codes: paragraphCodes(sec, p, this._fieldTypes(), (v) => this._borderFillKey(v)), id, pid };
  }

  /**
   * [hwpx-cowork] 테두리/배경 정의 번호 → 내용 열쇠(id 를 뺀 hh:borderFill XML 의 해시, 없으면 '?번호'). 구역 정의 지문(쪽 테두리)이 번호가 아니라
   * 내용으로 견주게 — 서버는 옮긴 정의를 제 머리에 다른 번호로 넣을 수 있다(2026-11-12 편집 보존). 머리 XML 이 바뀌면 다시 센다
   */
  _borderFillKey(id) {
    const xml = this.header?.xml || '';
    if (this._bfKeys?.xml !== xml) {
      const map = new Map();
      for (const m of xml.matchAll(/<hh:borderFill\b([^>]*?)(?:\/>|>[\s\S]*?<\/hh:borderFill>)/g)) {
        const v = /\sid="([^"]*)"/.exec(m[1])?.[1];
        // [hwpx-cowork] HWPX 저장기가 빈 태그 공백과 속성 순서를 바꿀 수 있다.
        // 정의 자체 번호만 빼고 선·색·채우기의 전체 요소와 속성값을 비교한다.
        if (v != null) map.set(v, shortHash(canonLines(m[0].replace(/\sid="[^"]*"/, '')).join('\n')));
      }
      this._bfKeys = { xml, map };
    }
    return this._bfKeys.map.get(String(id)) ?? `?${id}`;
  }

  /**
   * [hwpx-cowork] 구역 XML [start, end) 에서 그 안 문단의 변경 추적으로 지운 개체(del — 가장 바깥 것)를 뺀 XML(최종본 보기 지문용).
   * 지운 개체가 없으면 그대로 자른다
   */
  _visibleSlice(sec, start, end) {
    const xml = sec.xml.slice(start, end);
    if (!xml.includes('deleteBegin')) return xml;
    const cut = [];
    for (const q of sec.paras) {
      if (q.start < start || q.end > end) continue;
      for (const a of q.anchors) if (a.del && isObjectAnchor(a) && !cut.some(([s, e]) => s <= a.start && a.end <= e)) cut.push([a.start, a.end]);
    }
    if (!cut.length) return xml;
    cut.sort((x, y) => x[0] - y[0]);
    let out = ''; let at = start;
    for (const [s, e] of cut) { if (s < at) continue; out += sec.xml.slice(at, s); at = e; }
    return out + sec.xml.slice(at, end);
  }

  /** 이 문서의 문서 안 하이퍼링크(`?#<id>;…`)가 가리키는 id 들(구역을 다시 읽으면 다시 센다) */
  _linkTargetIds() {
    const key = this.sections.map((s) => s.loadSeq).join(',');
    if (this._linkIds?.key === key) return this._linkIds.set;
    const set = new Set();
    for (const s of this.sections) for (const m of s.xml.matchAll(/<hp:stringParam name="Command"[^>]*>\?#(\d+);/g)) set.add(m[1]);
    this._linkIds = { key, set };
    return set;
  }

  /** 문서의 필드 시작 id → 종류(모든 구역 — 구역을 넘는 필드의 끝도 짝을 찾게, 구역을 다시 읽으면 다시 센다) */
  _fieldTypes() {
    const key = this.sections.map((s) => s.loadSeq).join(',');
    if (this._fieldTypeMap?.key === key) return this._fieldTypeMap.map;
    const map = new Map();
    for (const s of this.sections) for (const [id, type] of fieldTypes(s)) if (!map.has(id)) map.set(id, type);
    this._fieldTypeMap = { key, map };
    return map;
  }

  /**
   * 필드 시작 ids 가 문서에서 사라졌으면 그 필드의 끝 표지를 지운다(한/글은 짝 없는 끝을 버리고 — 문단 머리에 있으면 파일을 못 연다 —
   * 편집기도 저장하지 않는다). 표·그림째 지운 필드 시작(표 칸 안 메모 등)의 끝만 다른 문단에 남은 것. → 지웠으면 true
   * (지운 시작만 본다 — 문단을 차례로 옮기는 중에는 끝이 시작보다 먼저 들어올 수 있다)
   */
  _sweepOrphanFieldEnds(ids) {
    const types = this._fieldTypes();
    const gone = new Set([...ids].filter((id) => !types.has(id)));
    if (!gone.size) return false;
    let any = false;
    for (const sec of this.sections) {
      const edits = [];
      for (const p of sec.paras) {
        for (const a of p.anchors) {
          if (a.kind !== 'ctrl' || a.name !== 'hp:ctrl' || a.inner !== 'hp:fieldEnd') continue;
          if (!gone.has(a.innerAttrs?.get('beginIDRef') ?? '')) continue;
          edits.push(codeRemoveEdit(sec.xml, a));
          dropLineseg(p, edits);
        }
      }
      if (edits.length) { sec.load(applyEdits(sec.xml, dedupe(edits))); any = true; }
    }
    return any;
  }

  /**
   * [hwpx-cowork] 전체 개체 지문 = objectPrint + '^' + 덧지문(그림 전체 지문 pictureMore — 선·효과 등, 구역 첫 문단의 구역 정의 내용 secDef,
   * 표 머리 속성 zOrder·lock). 덧지문이 없는 문단(그림·표·구역 정의가 없음)은 objectPrint 와 같다(2026-11-12 편집 보존).
   * objectPrint(판 2)는 이 값들을 보지 않아 편집기에서 바꿔도 실시간 반영이 '이미 같음'(crs._place SAME)으로 버리거나 덩어리를 내지 않았다.
   * 판 번호(OBJECT_PRINT_VERSION)는 그대로 두고 '^' 가 든 저장 지문만 전체 지문으로 견준다(matchesObjectPrint) — 옛 기록('^' 없음)은 종전대로
   */
  objectPrintFull(ref) {
    const base = this.objectPrint(ref);
    const extra = this._objectExtraPrint(ref);
    return extra ? `${base}^${extra}` : base;
  }

  /** [hwpx-cowork] 덧지문('' = 없음) — objectPrintFull */
  _objectExtraPrint(ref) {
    const o = this._objectInfo(ref);
    const defs = o.codes.filter((c) => c.secDef).map((c) => c.key);
    if (!o.pics.length && !defs.length && !o.tables.length) return '';
    // 그림은 rest(판 2 지문과 겹치지 않는 몫 — 검토 P1 2026-11-12)
    return shortHash(JSON.stringify({ m: o.pics.map((x) => x.rest), d: defs, t: o.tables.map((x) => x.head) }));
  }

  /** 문단의 그림(파일·속성)·표(뼈대)·조판 부호 지문('' = 없음) — 변경 요청·실시간 반영이 '그새 남이 바꿨나'를 볼 때(판 2 — 덧지문은 objectPrintFull) */
  objectPrint(ref) {
    const legacy = this.objectPrintLegacy(ref);
    // [hwpx-cowork] 단 정의(구역 첫 단 정의 — 2단 이상일 때만, 다단 설정 나누기)는 종전 지문 뒤에 '~' 로 따로 붙인다(h2022-format 2026-11-12).
    // 종전 지문(판 1)으로 저장된 변경 요청·되돌리기 기록은 matchesObjectPrint 가 앞부분(objectPrintLegacy)으로 견준다 — 단 정의를 몰랐던 기록에
    // 거짓 '남이 바꿈'을 내지 않는다. 단 정의가 없는 문단(한 단 문서 전부)의 지문은 종전과 같다.
    const cols = this._objectInfo(ref).codes.filter((c) => (c.colSection && !/^hp:colPr#sec\|[^|]*\|[^|]*\|1\|/.test(c.key)) || c.colBreak || c.markpen);
    return cols.length ? `${legacy}~${shortHash(JSON.stringify(cols.map((c) => c.key)))}` : legacy;
  }

  /** [hwpx-cowork] 단 정의를 넣기 전(판 1)의 개체 지문 — 단 정의 부호(colSection·colBreak)를 빼고 종전 규칙 그대로 */
  objectPrintLegacy(ref) {
    const o = this._objectInfo(ref);
    // 구역 첫 문단의 구역 정의(secPr)는 늘 있다 — 지문에 넣지 않는다(종전 지문 그대로). 가운데 구역 나누기만 센다
    const codes = o.codes.filter((c) => !(c.section && c.first) && !c.colSection && !c.colBreak && !c.markpen && !c.secDef);
    if (!o.pics.length && !o.tables.length && !codes.length && !o.pid && !o.shapes.length) return '';
    // 도형은 있을 때만 싣는다(도형 없는 문단의 지문은 종전 그대로). 개체 id 는 넣지 않는다(서버가 새로 매긴 id 로 다시 열지 않게)
    return shortHash(JSON.stringify({ c: codes.map((c) => c.key), p: o.pics.map((x) => [x.key, x.props]), t: o.tables.map((x) => x.print), ...(o.pid ? { i: o.pid } : {}), ...(o.shapes.length ? { s: o.shapes.map((x) => x.print) } : {}) }));
  }

  /**
   * [hwpx-cowork] 저장된 개체 지문이 지금 문단과 같은가. version = 지문 판(OBJECT_PRINT_VERSION 이면 objectPrint, 없거나 1 이면 종전 판 —
   * objectPrintLegacy 로 견준다). 변경 요청(baseObjectPrint·newObjectPrint)·개체 지우기 되돌리기(objectUndo.after) 처럼 data 에 남는 지문용.
   */
  matchesObjectPrint(ref, stored, version) {
    if (stored == null) return false;
    // [hwpx-cowork] '^' 가 든 지문 = 덧지문까지 실은 전체 지문(objectPrintFull, 2026-11-12) — 판 2 이상에서만 만든다
    if (Number(version) >= OBJECT_PRINT_VERSION && String(stored).includes('^')) return this.objectPrintFull(ref) === stored;
    return (Number(version) >= OBJECT_PRINT_VERSION ? this.objectPrint(ref) : this.objectPrintLegacy(ref)) === stored;
  }

  /**
   * 본문 문단 ref 의 글 밖 내용이 모두 diffDocs 가 옮길 수 있는 것인가 — 글·빈 문단이거나, 그 밖의 것이 제 그림(과 캡션)·제 표(칸·캡션 —
   * 표 안의 무엇이든 표째 옮긴다)뿐(글상자·도형 등 없음). 이런 문단은 통째로 넣고 지울 수 있다(편집기에서 그림·표 문단을 넣고 지운 것)
   */
  plainOrObjectParagraph(ref) {
    const { sec, p } = this.resolve(ref);
    if (p.parent) return false;
    // [hwpx-cowork] 도형(글상자 문단까지 도형째)도 옮길 수 있다(engine/shapes.js SHAPE_TAGS)
    if (objectTags(p).some((t) => t !== 'hp:pic' && t !== 'hp:tbl' && !SHAPE_TAGS.has(t))) return false;
    const own = [...this._ownPictures(sec, p), ...this._tableIndex(sec).tables.filter((t) => t.owner === p && !t.hidden), ...ownShapeAnchors(p), ...headerFooterAnchors(p)];
    const inOwn = (q) => { let r = q; while (r.parent && r.parent !== p) r = r.parent; return own.some((x) => x.start < r.start && r.end <= x.end); };
    return this._nestedWalk(sec, p).every(({ p: q }) => inOwn(q));
  }

  /**
   * [hwpx-cowork] 다른 HWPX(source — 대개 이 문서에서 만든 빈 서식에 모델이 쓴 문서)의 본문 문단을 sectionIndex 의 afterIdx 문단 뒤에 넣는다
   * (MCP v3 실험 op insert_document — 2026-11-20, docs/MCP_REDESIGN_2026-11-16.md §21). 긴 장·부록을 문서로 써서 통째로 넣는 길.
   *  - 각 구역 첫 문단(구역 정의 hp:secPr 를 든 문단)은 구역·쪽 설정이라 넣지 않는다 — 그 문단에 글이 있으면 글만 같은 모양의 보통 문단으로
   *  - 글자·문단 모양·스타일·테두리 번호는 이 문서의 같은 정의로(importFormattingRefs — 빈 서식은 이 문서 머리를 그대로 가지므로 대개 그대로)
   *  - 개체(표·그림·도형)·누름틀 id 는 새로 매긴다(모델이 이 문서 사본의 표를 본떠 오면 id 가 겹친다), 그림 파일은 이 문서로(_importBinary)
   *  - 줄 정보(hp:linesegarray)는 지운다(자리가 바뀌므로 한/글·편집기가 다시 잰다)
   *  - 메모는 부호만 지우고 글은 남긴다(report.memos), 차트(부분 파일이 따로 있다)가 든 문단은 아직 받지 않는다
   * → { count(넣은 본문 문단 수), report: { paragraphs, tables, figures, shapes, chars, memos? } }
   */
  insertDocumentAfter(sectionIndex, afterIdx, source) {
    const sec = this.sections[sectionIndex];
    if (!sec || !Number.isInteger(afterIdx) || afterIdx < 0 || afterIdx >= sec.bodyParas.length) throw new EngineError('RANGE', `끼워 넣을 자리가 본문 문단 범위 밖입니다: s${sectionIndex}/p${afterIdx}`);
    if (typeof source.acceptAll === 'function' && source.changes().length) source.acceptAll();
    // 메모는 검토 의견이지 넣을 글이 아니다 — 부호만 지우고 글은 남긴다(사본 'document' 의 문단을 본떠 오면 메모가 묻어 온다). 지운 수는 report.memos
    let memos = 0;
    for (const m of source.memos().filter((x) => !x.hidden)) { try { source.deleteMemo(m.id); memos += 1; } catch { /* 아래 검사가 남은 메모를 거절한다 */ } }
    const parts = [];
    for (const [si, s] of source.sections.entries()) {
      for (const [bi, p] of s.bodyParas.entries()) {
        const xml = s.xml.slice(p.start, p.end);
        if (/<hp:secPr\b/.test(xml)) {
          // 구역 정의 문단: 글이 있으면 글만(첫 글자 모양·문단 모양·스타일 그대로) — 쪽 설정·머리말·꼬리말·쪽 번호는 이 문서 것을 쓴다
          const text = source.text(`s${si}/p${bi}`, 'final');
          if (!text.trim()) continue;
          const pa = (k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(xml.slice(0, xml.indexOf('>'))) || [])[1] ?? '0';
          const cp = (/<hp:run\b[^>]*\bcharPrIDRef="(\d+)"/.exec(xml) || [])[1] ?? '0';
          parts.push(`<hp:p id="0" paraPrIDRef="${pa('paraPrIDRef')}" styleIDRef="${pa('styleIDRef')}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${cp}"><hp:t>${inlineXml(text)}</hp:t></hp:run></hp:p>`);
          continue;
        }
        parts.push(xml);
      }
    }
    if (!parts.length) throw new EngineError('EMPTY', '끼워 넣을 본문 문단이 없습니다 — 빈 서식의 첫 문단(구역 정의) 뒤에 문단을 쓰세요');
    let x = parts.join('');
    if (/chartIDRef=/.test(x)) throw new EngineError('UNSUPPORTED', '차트가 든 문서는 아직 끼워 넣을 수 없습니다 — 차트는 그림(figure)으로 넣으세요');
    if (/<hp:fieldBegin\b[^>]*\btype="MEMO"/.test(x)) throw new EngineError('UNSUPPORTED', '메모가 든 문단은 끼워 넣을 수 없습니다 — 메모를 빼고 다시 올리세요');
    x = x.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
    x = importFormattingRefs(this, source, x);
    // 개체·누름틀·각주/미주 id 새로: 이 문서에서 쓰는 id·instid·instId 다음 번호부터(32비트 안 — 넘으면 1부터 빈 번호).
    // 2026-11-20 검증: 각주·미주의 instId(대문자 I)도 겹치지 않게, 넣기를 거듭해 4e9 를 넘겨도 앞 번호와 겹치지 않게
    const all = this.sections.map((s) => s.xml).join('');
    const U32 = 4294967295;
    const used = new Set([...all.matchAll(/\s(?:id|instid|instId)="(\d{1,10})"/g)].map((m) => Number(m[1])).filter((n) => n <= U32));
    let cursor = Math.max(0, ...used);
    const fresh = () => {
      for (;;) { cursor = cursor >= U32 ? 1 : cursor + 1; if (!used.has(cursor)) { used.add(cursor); return cursor; } }
    };
    const fieldIds = new Map();
    x = x.replace(/<hp:(tbl|pic|rect|line|ellipse|arc|polygon|curve|connectLine|container|equation|ole|textart)\b[^>]*>/g, (tag) => tag
      .replace(/(\sid=")\d+(")/, (m, a, b) => `${a}${fresh()}${b}`).replace(/(\sinstid=")\d+(")/, (m, a, b) => `${a}${fresh()}${b}`));
    x = x.replace(/<hp:(footNote|endNote)\b[^>]*>/g, (tag) => tag.replace(/(\sinstId=")\d+(")/, (m, a, b) => `${a}${fresh()}${b}`));
    x = x.replace(/<hp:fieldBegin\b[^>]*>/g, (tag) => tag.replace(/(\sid=")(\d+)(")/, (m, a, old, b) => { const n = fresh(); fieldIds.set(old, n); return `${a}${n}${b}`; }));
    x = x.replace(/(<hp:fieldEnd\b[^>]*\sbeginIDRef=")(\d+)(")/g, (m, a, old, b) => `${a}${fieldIds.get(old) ?? old}${b}`);
    const bins = new Map();
    x = x.replace(/binaryItemIDRef="([^"]+)"/g, (m, id) => { if (!bins.has(id)) bins.set(id, this._importBinary(source, id)); return `binaryItemIDRef="${bins.get(id)}"`; });
    const pos = sec.bodyParas[afterIdx].end;
    sec.load(sec.xml.slice(0, pos) + x + sec.xml.slice(pos));
    const count = (re) => (x.match(re) || []).length;
    // 첫 글(카드·영수증에서 무엇을 넣는지 알아보게 — 표 칸 글이 아닌 첫 본문 글 40자)
    const first = parts.map((q) => q.replace(/<hp:tbl\b[\s\S]*<\/hp:tbl>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    return { count: parts.length, report: { paragraphs: parts.length, tables: count(/<hp:tbl\b/g), figures: count(/<hp:pic\b/g), shapes: count(/<hp:(?:rect|line|ellipse|arc|polygon|curve|connectLine|container)\b/g), chars: [...x.replace(/<[^>]+>/g, '')].length, ...(memos ? { memos } : {}), ...(first ? { first: [...first].length > 40 ? `${[...first].slice(0, 40).join('')}…` : first } : {}) } };
  }

  /** source 의 그림 파일 binId 를 이 문서로 — 같은 id 에 같은 바이트가 있으면 그것, 아니면 새 항목(BinData·매니페스트) → 이 문서의 id */
  _importBinary(source, binId) {
    const item = source.binaryItem(binId);
    if (!item) throw new EngineError('NO_BINARY', `옮길 그림 파일이 없습니다: ${binId}`);
    const same = (x) => !!x && x.bytes.length === item.bytes.length && x.bytes.every((v, i) => v === item.bytes[i]);
    if (same(this.binaryItem(binId))) return binId;
    // 같은 내용이 다른 번호로 이미 있으면 그것(편집기는 그림 파일 번호를 다시 매긴다)
    const hpf = this.container.getText('Contents/content.hpf') || '';
    for (const m of hpf.matchAll(/<opf:item\b[^>]*\bid="([^"]+)"[^>]*\bhref="BinData\/[^"]+"/g)) if (same(this.binaryItem(m[1]))) return m[1];
    const info = imageInfo(item.bytes);
    const ext = info?.ext || ((/\.([A-Za-z0-9]+)$/.exec(item.href) || [])[1] || 'bin').toLowerCase();
    return this._addBinary(item.bytes, { ext, mime: item.mime || info?.mime || 'application/octet-stream' });
  }

  /**
   * source 문서 sourceRef 문단의 그림·조판 부호를 이 문서 targetRef 문단에 옮긴다(글은 건드리지 않는다).
   *  - 그림: 그림 파일 열쇠(_picKey) 차례 비교(LCS)로 짝지은 그림은 크기(sz·curSz)·배치(pos·글 감싸기)·바깥/안 여백·자르기·뒤집기·회전 각·
   *    밝기/대비/효과·캡션 위치/폭을 source 값으로(크기가 바뀌면 회전 중심·배율 행렬을 새 크기로). source 에 없는 그림은 캡션째 지우고,
   *    새(또는 바꾼) 그림은 source 의 hp:pic 을 그 글자 자리에 넣는다 — 그림 파일은 이 문서로 옮기고(_importBinary), 캡션 문단의 글자·문단
   *    모양 번호는 이 문서의 같은 정의로 바꾸고(importFormattingRefs), 겹치는 개체 id 는 새로 매긴다. 지운 그림의 파일은 아무도 안 쓰면 거둔다.
   *    그림을 넣고 빼거나 크기가 바뀌면 그 문단 줄 정보(hp:linesegarray — 옛 그림 높이)를 지운다(한/글·편집기가 다시 잰다).
   *  - 조판 부호: 차례 비교(LCS, 부호 종류·번호 종류 등)로 source 에 없는 부호는 지우고, 새 부호는 source 글자 자리(지금 글로 옮긴 자리)에
   *    source 의 <hp:ctrl> 그대로 넣는다. 넣고 뺐으면 그 문단 줄 정보를 지운다(줄 textpos 가 부호 8칸만큼 어긋나므로).
   * [hwpx-cowork] 추적하지 않는 옮기기: 지운 개체에 붙은 변경 표식과 지우거나 통째로 바꾼 개체 안 변경의 머리 항목도 정리한다(고아 trackChange 를
   * 남기지 않게 — 다시 매김 기록은 takeRenumberLog). 변경 추적으로 지운 개체(최종본에 없음)는 짝짓지 않고 그대로 둔다
   * @returns {boolean} 바꾼 것이 있는가
   */
  copyObjectsFrom(source, sourceRef, targetRef) { return this._copyObjects(source, sourceRef, targetRef, null).changed; }

  /**
   * [hwpx-cowork] copyObjectsFrom 의 변경 추적판(표·그림·차트·도형 변경 추적 — 2026-10-30). 넣은 개체는 넣음 표식으로 감싸 넣고, 뺀 개체는
   * 지움 표식으로 감싸 남긴다 — 단 같은 작성자가 추적으로 넣은 개체는 그 넣음을 거절(새 변경 없이 바로 지움), 남이 넣은 개체는 그 넣음을 수락한 뒤
   * 지움 표식. 짝지은 개체의 속성 고침·통째 바꿈은 OBJECT_TRACK.modify 를 따른다(자리표시 'direct': 고침은 그대로, 통째 바꿈(표 뼈대·고칠 수 없는
   * 도형)은 옛 개체 안 처리 안 된 변경을 먼저 수락한 뒤 바꿈 | 'replace': 옛 것 지움 + 새 것 넣음). 표식 꼴은 OBJECT_TRACK.wrap(engine/track-objects.js).
   * 조판 부호·문단 id 는 copyObjectsFrom 과 같다(추적하지 않음).
   * @returns {{ changed: boolean, ids: number[] }} ids = 새로 만든 변경 id(이 호출이 끝난 뒤의 번호 — 거절·수락으로 번호가 밀리면 따라 옮겼다)
   */
  copyObjectsTracked(source, sourceRef, targetRef, { author, date } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    return this._copyObjects(source, sourceRef, targetRef, { author, date });
  }

  /** copyObjectsFrom·copyObjectsTracked 공용(track = { author, date } | null) → { changed, ids } */
  _copyObjects(source, sourceRef, targetRef, track) {
    let changed = false;
    const ids = []; // 추적판이 새로 만든 변경 id(지금 번호 — 뒤에서 머리 항목을 지우면 따라 옮긴다)
    const log = (this._renumberLog ??= []);
    const cleanup = (stale) => { const from = log.length; this._removeChangeIds(stale); ids.splice(0, ids.length, ...remapIds(ids, log.slice(from))); };
    const mark = (type) => { const id = this._newObjectChange(type, track); ids.push(id); return id; };
    const replaceProps = !!track && OBJECT_TRACK.modify.props === 'replace';
    const replaceXml = !!track && OBJECT_TRACK.modify.replaceXml === 'replace';
    // 같은 자리에 넣는 개체는 차례대로 한 편집으로(dedupe 가 같은 자리 편집을 하나만 남긴다)
    const pushAdd = (adds, e) => { const prev = e.pos != null ? adds.find((x) => x.pos === e.pos && x.start == null) : null; if (prev) prev.insert += e.insert; else adds.push(e); };
    // 이 문단(표 칸·캡션 포함)에서 열리는 필드 — 표·그림·부호를 지워 시작이 사라지면 다른 문단에 남은 끝도 지운다(끝에서)
    const beginIds = (() => { const { sec, p } = this.resolve(targetRef); return [...sec.xml.slice(p.start, p.end).matchAll(/<hp:fieldBegin\b[^>]*?\sid="([^"]*)"/g)].map((m) => m[1]); })();
    // 추적판: 뺄 개체의 넣음 표식 정리(내 넣음 거절·남의 넣음 수락)와 통째 바꿀 개체 안 변경 수락을 먼저(번호가 바뀌므로 짝은 그 뒤에 다시 셈)
    if (track && this._untrackForCopy(source, sourceRef, targetRef, track)) changed = true;
    {
      // 표: 뼈대가 다른 표(크기·줄·칸·칸 크기 등을 바꿈)는 source 의 표로 통째로 바꾸고(칸 글도 함께), 없어진 표는 지우고, 새 표는 그 글자 자리에 넣는다
      const { sec, p } = this.resolve(targetRef);
      const sp = source.resolve(sourceRef);
      const T = this._objectInfo(targetRef).tables; const S = source._objectInfo(sourceRef).tables;
      const { pairs, removed, added } = pairTables(T, S);
      const edits = []; const swapped = [];
      const all = this.sections.map((s) => s.xml).join('');
      // [hwpx-cowork] 표 넣고 빼기·뼈대 고침이 없는 문단에서만 머리 속성을 옮긴다(objectChange 의 '표 순서·보호' 판정과 같은 조건)
      const headOnly = !removed.length && !added.length && pairs.every(([i, j]) => T[i].print === S[j].print);
      for (const [i, j] of pairs) {
        if (T[i].print === S[j].print) {
          // [hwpx-cowork] 머리 속성(zOrder·lock)만 다르면 여는 태그 값만 바꾼다 — 칸 글·변경 추적은 그대로
          if (headOnly && JSON.stringify(T[i].head) !== JSON.stringify(S[j].head)) {
            const open = (/^<hp:tbl\b[^>]*>/.exec(sec.xml.slice(T[i].t.start, T[i].t.end)) || [])[0];
            if (open) edits.push({ start: T[i].t.start, end: T[i].t.start + open.length, insert: setTagAttrs(open, Object.fromEntries(TABLE_HEAD_ATTRS.map((k, n) => [k, S[j].head[n]]))) });
          }
          continue;
        }
        if (replaceXml) { removed.push(i); added.push(j); continue; }
        edits.push({ start: T[i].t.start, end: T[i].t.end, insert: this._importTable(source, sp.sec.xml.slice(S[j].t.start, S[j].t.end), all, false) });
        swapped.push(T[i].t);
      }
      removed.sort((a, b) => a - b); added.sort((a, b) => a - b);
      const gone = !track && removed.length ? this._objectRemoval(sec, removed.map((i) => ownAnchorAt(p, T[i].t))) : null;
      if (track) for (const i of removed) edits.push({ start: T[i].t.start, end: T[i].t.end, insert: OBJECT_TRACK.wrap(sec.xml.slice(T[i].t.start, T[i].t.end), { type: 'Delete', id: mark('Delete') }) });
      else if (gone) edits.push(...gone.edits, ...markRemovalEdits(sec.xml, gone.marks));
      if (added.length) {
        const sText = Section.text(sp.p, 'final'); const tText = Section.text(p, 'final');
        const adds = [];
        for (const j of added) {
          let x = this._importTable(source, sp.sec.xml.slice(S[j].t.start, S[j].t.end), all, true);
          if (track) x = OBJECT_TRACK.wrap(x, { type: 'Insert', id: mark('Insert') });
          pushAdd(adds, ctrlInsertEdit(sec, p, mapTextPos(sText, tText, S[j].pos), x));
        }
        edits.push(...adds);
      }
      if (edits.length) {
        const stale = this._nestedChangeIds(sec, swapped);
        dropLineseg(p, edits);
        sec.load(applyEdits(sec.xml, dedupe(edits)));
        changed = true;
        if (gone) this._afterObjectRemoval(gone);
        cleanup([...stale, ...(gone ? gone.ids : [])]);
      }
    }
    {
      // [hwpx-cowork] 도형(선·사각형·글상자·타원·호·다각형·곡선·연결선·묶음·차트 요소 — engine/shapes.js): 짝(이름+id, 남은 것은 이름 차례)은
      // 이 문서 XML 을 source 값으로 고치고(patchShape — 요소 짜임이 달라 못 고치면 통째로 바꾸되 id 는 그대로), source 에 없는 도형은 지우고,
      // 새 도형은 그 글자 자리에 넣는다(_importShape). 편집기가 못 읽는 개체(글맵시 등)가 든 묶음은 통째로 바꾸지 않는다.
      // 줄 정보: 글자처럼 취급하거나 글을 밀어내는 도형을 넣고 빼거나 옮기면, 또는 여러 줄 문단에 넣고 빼면 지운다(다시 잰다).
      // 글 앞·뒤에 떠 있는 도형의 한 줄 문단은 그대로(한/글 실측 — 지우기·옮기기에 줄 정보를 고치지 않는다). 추적판은 표식을 더하면 늘 지운다
      const { sec, p } = this.resolve(targetRef);
      const sp = source.resolve(sourceRef);
      const T = this._objectInfo(targetRef).shapes; const S = source._objectInfo(sourceRef).shapes;
      const { pairs, removed, added } = pairShapes(T, S);
      const edits = []; let relayout = false; const swapped = [];
      const all = this.sections.map((x) => x.xml).join('');
      const mapBin = (x) => x.replace(/(binaryItemIDRef=")([^"]+)(")/g, (m, a, id, b) => `${a}${this._importBinary(source, id)}${b}`);
      for (const [i, j] of pairs) {
        const t = T[i]; const s = S[j];
        if (t.print === s.print) continue;
        if (replaceProps && !t.props.foreign) { removed.push(i); added.push(j); continue; }
        let out = t.props.foreign ? null : patchShape(t.xml, s.xml, mapBin);
        if (out == null) {
          if (t.props.foreign) continue;
          if (replaceXml) { removed.push(i); added.push(j); continue; }
          out = this._importShape(source, s.xml, all, t.xml);
          swapped.push(t.a);
        }
        if (out === t.xml) continue;
        edits.push({ start: t.a.start, end: t.a.end, insert: out });
        const flows = shapeFlowsText(t.xml) || shapeFlowsText(s.xml);
        if (flows && (t.props.pos !== s.props.pos || JSON.stringify(t.props.sz) !== JSON.stringify(s.props.sz) || shapeFlowsText(t.xml) !== shapeFlowsText(s.xml))) relayout = true;
      }
      removed.sort((a, b) => a - b); added.sort((a, b) => a - b);
      const gone = !track && removed.length ? this._objectRemoval(sec, removed.map((i) => T[i].a)) : null;
      for (const i of removed) {
        if (track) edits.push({ start: T[i].a.start, end: T[i].a.end, insert: OBJECT_TRACK.wrap(T[i].xml, { type: 'Delete', id: mark('Delete') }) });
        if (shapeFlowsText(T[i].xml)) relayout = true;
      }
      if (gone) edits.push(...gone.edits, ...markRemovalEdits(sec.xml, gone.marks));
      if (added.length) {
        const sText = Section.text(sp.p, 'final'); const tText = Section.text(p, 'final');
        const adds = [];
        for (const j of added) {
          let x = this._importShape(source, S[j].xml, all, null);
          if (track) x = OBJECT_TRACK.wrap(x, { type: 'Insert', id: mark('Insert') });
          pushAdd(adds, ctrlInsertEdit(sec, p, mapTextPos(sText, tText, S[j].pos), x));
          if (shapeFlowsText(S[j].xml)) relayout = true;
        }
        edits.push(...adds);
      }
      if (edits.length) {
        const lines = p.lineseg ? (sec.xml.slice(p.lineseg.start, p.lineseg.end).match(/<hp:lineseg\b/g) || []).length : 0;
        if (relayout || ((removed.length || added.length) && (lines > 1 || track))) dropLineseg(p, edits);
        const stale = this._nestedChangeIds(sec, swapped);
        sec.load(applyEdits(sec.xml, dedupe(edits)));
        changed = true;
        if (gone) this._afterObjectRemoval(gone);
        cleanup([...stale, ...(gone ? gone.ids : [])]);
      }
    }
    {
      const { sec, p } = this.resolve(targetRef);
      const sp = source.resolve(sourceRef);
      const S = source._objectInfo(sourceRef).pics; const T = this._objectInfo(targetRef).pics;
      const pairs = keyLcs(T.map((x) => x.key), S.map((x) => x.key));
      const keptT = new Set(pairs.map(([i]) => i)); const keptS = new Set(pairs.map(([, j]) => j));
      if (replaceProps) for (const [i, j] of pairs) if (JSON.stringify(T[i].props) !== JSON.stringify(S[j].props) || T[i].more !== S[j].more) { keptT.delete(i); keptS.delete(j); }
      const removed = T.filter((_, i) => !keptT.has(i));
      const added = S.filter((_, j) => !keptS.has(j));
      const edits = []; let relayout = removed.length > 0 || added.length > 0;
      for (const [i, j] of pairs) {
        const t = T[i]; const s = S[j];
        if (!keptT.has(i) || (JSON.stringify(t.props) === JSON.stringify(s.props) && t.more === s.more)) continue;   // [hwpx-cowork] more = 목록 밖 속성(선·효과 등)
        const txml = sec.xml.slice(t.pic.start, t.pic.end); const sxml = sp.sec.xml.slice(s.pic.start, s.pic.end);
        edits.push({ start: t.pic.start, end: t.pic.end, insert: patchPicture(txml, t.pic.head.length, sxml, s.pic.head.length) });
        if (JSON.stringify([t.props.sz, t.props.cur]) !== JSON.stringify([s.props.sz, s.props.cur])) relayout = true;
      }
      const gone = !track && removed.length ? this._objectRemoval(sec, removed.map((t) => ownAnchorAt(p, t.pic))) : null;
      if (track) for (const t of removed) edits.push({ start: t.pic.start, end: t.pic.end, insert: OBJECT_TRACK.wrap(sec.xml.slice(t.pic.start, t.pic.end), { type: 'Delete', id: mark('Delete') }) });
      else if (gone) edits.push(...gone.edits, ...markRemovalEdits(sec.xml, gone.marks));
      if (added.length) {
        const sText = Section.text(sp.p, 'final'); const tText = Section.text(p, 'final');
        const all = this.sections.map((s) => s.xml).join('');
        const adds = [];
        for (const s of added) {
          const sourceXml = sp.sec.xml.slice(s.pic.start, s.pic.end);
          // Repair stale image dimensions only for a replaced existing picture.
          // A newly copied picture carries authoritative HWPUNIT dimensions and
          // may use an image resolution other than 96 dpi.
          const replacingImage = removed.some(t => ['id', 'instid'].some(key => {
            const value = tagAttr(s.pic.head, key);
            return value && value !== '0' && value === tagAttr(t.pic.head, key);
          }) && t.key !== s.key && ['hp:orgSz', 'hp:imgDim'].every(tag => xmlTag(t.pic.head, tag) === xmlTag(s.pic.head, tag)));
          let x = this._importPicture(source, sourceXml, s.binId, all, { replacingImage });
          if (track) x = OBJECT_TRACK.wrap(x, { type: 'Insert', id: mark('Insert') });
          pushAdd(adds, ctrlInsertEdit(sec, p, mapTextPos(sText, tText, s.pos), x));
        }
        edits.push(...adds);
      }
      if (edits.length) {
        if (relayout) dropLineseg(p, edits);
        sec.load(applyEdits(sec.xml, dedupe(edits)));
        changed = true;
        if (gone) { this._afterObjectRemoval(gone); cleanup(gone.ids); }
      }
    }
    {
      const { sec, p } = this.resolve(targetRef);
      const sp = source.resolve(sourceRef);
      // 구역 첫 문단의 구역 정의는 넣고 빼지 않는다(구역마다 꼭 하나 — 맞는 자리의 짝이 다른 문단이어도)
      const T0 = paragraphCodes(sec, p, this._fieldTypes(), (v) => this._borderFillKey(v)).filter((c) => !(c.section && c.first));
      const S0 = paragraphCodes(sp.sec, sp.p, source._fieldTypes(), (v) => source._borderFillKey(v)).filter((c) => !(c.section && (c.first || sec.bodyParas[0] === p)));
      // [hwpx-cowork] 구역 첫 단 정의(colSection)는 넣고 빼지 않고 그 자리에서 바꾼다(구역마다 꼭 하나)
      const tCol = T0.find((c) => c.colSection); const sCol = S0.find((c) => c.colSection);
      const colEdits = tCol && sCol && tCol.key !== sCol.key ? [colPrReplaceEdit(sec.xml, tCol.a, sCol.xml)].filter(Boolean) : [];
      // [hwpx-cowork] 형광펜은 열쇠 차례가 다르면 문단의 것을 통째로 바꾼다(맞닿은 다른 색 범위의 끝·시작 차례를 지키려고)
      const tPen = T0.filter((c) => c.markpen); const sPen = S0.filter((c) => c.markpen);
      const penEdits = [];
      if (tPen.map((c) => c.key).join('\u0001') !== sPen.map((c) => c.key).join('\u0001')) {
        const sTextP = Section.text(sp.p, 'final'); const tTextP = Section.text(p, 'final');
        for (const c of tPen) penEdits.push({ start: c.a.start, end: c.a.end, insert: '' });
        const adds = [];
        for (const c of sPen) pushAdd(adds, inlineInsertEdit(sec, p, mapTextPos(sTextP, tTextP, c.pos), c.xml));
        penEdits.push(...adds);
      }
      colEdits.push(...penEdits);
      const T = T0.filter((c) => !c.colSection && !c.markpen && !c.secDef); const S = S0.filter((c) => !c.colSection && !c.markpen && !c.secDef);
      const pairs = keyLcs(T.map((c) => c.key), S.map((c) => c.key));
      const keptT = new Set(pairs.map(([i]) => i)); const keptS = new Set(pairs.map(([, j]) => j));
      const removed = T.filter((_, i) => !keptT.has(i));
      const added = S.filter((_, j) => !keptS.has(j));
      // [hwpx-cowork] 구역 정의 내용(secDef)은 넣고 빼지 않고 그 자리에서 바꾼다(차례대로 짝 — 수가 같을 때만). 지우는 구역 나누기의 것은 두고,
      // 넣는 구역 나누기는 제 XML 을 그대로 가져온다. 쪽 테두리 정의 번호는 이 문서 것으로(importFormattingRefs)
      {
        const tDef = T0.filter((c) => c.secDef); const sDef = S0.filter((c) => c.secDef);
        const gone = new Set(removed.filter((c) => c.section).map((c) => c.a.start));
        if (tDef.length === sDef.length) {
          tDef.forEach((t, i) => {
            const s = sDef[i];
            if (t.key === s.key || gone.has(t.a.start)) return;
            let x = mergeSecDef(t.xml, s.xml);
            try { x = importFormattingRefs(this, source, x); } catch (e) { if (!(e instanceof EngineError)) throw e; }
            colEdits.push({ start: t.a.start, end: t.a.end, insert: x });
          });
        }
      }
      if (removed.length || added.length || colEdits.length) {
        const sText = Section.text(sp.p, 'final'); const tText = Section.text(p, 'final');
        const edits = removed.flatMap((c) => (c.inline || c.compose ? [{ start: c.a.start, end: c.a.end, insert: '' }]
          : c.section ? [{ start: c.a.start, end: c.a.end, insert: '' }, ...(c.col ? [codeRemoveEdit(sec.xml, c.col)] : [])]
            : [codeRemoveEdit(sec.xml, c.a)]));
        // 같은 자리에 넣는 부호(차례 첫 문단의 구역 나누기·차례 필드 시작·하이퍼링크 시작 등)는 차례대로 이어 한 편집으로
        // (따로 두면 dedupe 가 같은 자리 편집을 하나만 남긴다)
        const adds = [];
        for (const c of added) {
          const xml = c.hf ? this._importHeaderFooter(source, c.xml) : c.compose ? importComposeRefs(this, source, c.xml) : c.xml;
          let e = c.section || c.colBreak ? runStartEdit(sec, p, xml) : c.inline ? inlineInsertEdit(sec, p, mapTextPos(sText, tText, c.pos), xml) : ctrlInsertEdit(sec, p, mapTextPos(sText, tText, c.pos), xml);
          // [hwpx-cowork] Empty fields share a character offset but still have
          // ordered boundaries. Use the LCS's retained neighbours at that offset
          // so sequential links stay sequential, and nested links stay nested.
          // The generic empty-paragraph point is inside its first existing link.
          if (!c.section && !c.colBreak && !c.inline) {
            const j = S.indexOf(c);
            const mapped = mapTextPos(sText, tText, c.pos);
            const samePoint = ([i, k]) => S[k].pos === c.pos && T[i].pos === mapped
              && !T[i].section && !T[i].inline;
            const previous = pairs.findLast(pair => pair[1] < j && samePoint(pair));
            const next = pairs.find(pair => pair[1] > j && samePoint(pair));
            if (previous) e = { pos: T[previous[0]].a.end, insert: xml };
            else if (next) e = { pos: T[next[0]].a.start, insert: xml };
          }
          pushAdd(adds, e);
        }
        edits.push(...adds, ...colEdits);
        dropLineseg(p, edits);
        sec.load(applyEdits(sec.xml, dedupe(edits)));
        changed = true;
      }
    }
    {
      // 하이퍼링크가 가리키는 문단 id(편집기가 고유 id 를 새로 준 제목 문단)
      const pid = source._objectInfo(sourceRef).pid;
      const { sec, p } = this.resolve(targetRef);
      if (pid && attrOf(sec.xml, p, 'id') !== pid) {
        const open = /^<hp:p\b[^>]*>/.exec(sec.xml.slice(p.start, p.start + 600))?.[0];
        if (open) {
          sec.load(sec.xml.slice(0, p.start) + setTagAttrs(open, { id: pid }) + sec.xml.slice(p.start + open.length));
          changed = true;
        }
      }
    }
    // 표·그림째 지운 필드 시작(표 칸 안 메모 등)의 끝이 다른 문단에 남았으면 지운다(편집기 저장본에도 없다)
    if (changed && beginIds.length && this._sweepOrphanFieldEnds(beginIds)) changed = true;
    idScan = { xml: null, asked: 0, index: null };   // 문서 전체 글·id 색인을 붙들고 있지 않는다(idTaken)
    return { changed, ids };
  }

  /**
   * [hwpx-cowork] copyObjectsTracked 의 앞 단계: source 와 짝지어 뺄 개체(source 에 없음 — 'replace' 꼴이면 바뀐 짝도)의 넣음 표식을 정리하고
   * (_untrackPlan — 내 넣음은 거절, 남의 넣음은 수락), 통째로 바꿀 개체(표 뼈대가 바뀜·고칠 수 없는 도형) 안의 처리 안 된 변경을 수락한다 → 바꿨는가
   */
  _untrackForCopy(source, sourceRef, targetRef, track) {
    const { sec, p } = this.resolve(targetRef);
    const ti = this._objectInfo(targetRef); const si = source._objectInfo(sourceRef);
    const replaceProps = OBJECT_TRACK.modify.props === 'replace'; const replaceXml = OBJECT_TRACK.modify.replaceXml === 'replace';
    const out = []; const swap = [];
    const tp = pairTables(ti.tables, si.tables);
    for (const i of tp.removed) out.push(ownAnchorAt(p, ti.tables[i].t));
    for (const [i, j] of tp.pairs) if (ti.tables[i].print !== si.tables[j].print) (replaceXml ? out : swap).push(ownAnchorAt(p, ti.tables[i].t));
    const sp = pairShapes(ti.shapes, si.shapes);
    for (const i of sp.removed) out.push(ti.shapes[i].a);
    for (const [i, j] of sp.pairs) {
      const t = ti.shapes[i]; const s = si.shapes[j];
      if (t.print === s.print || t.props.foreign) continue;
      if (replaceProps) out.push(t.a);
      else if (patchShape(t.xml, s.xml) == null) (replaceXml ? out : swap).push(t.a);
    }
    const pp = keyLcs(ti.pics.map((x) => x.key), si.pics.map((x) => x.key));
    const kept = new Set(pp.map(([i]) => i));
    ti.pics.forEach((x, i) => { if (!kept.has(i)) out.push(ownAnchorAt(p, x.pic)); });
    if (replaceProps) for (const [i, j] of pp) if (JSON.stringify(ti.pics[i].props) !== JSON.stringify(si.pics[j].props)) out.push(ownAnchorAt(p, ti.pics[i].pic));
    const plan = this._untrackPlan(out, track.author);
    return this._runUntrack(plan.reject, [...plan.accept, ...this._nestedChangeIds(sec, swap)]);
  }

  /**
   * [hwpx-cowork] 뺄 개체 anchor 들의 넣음 표식 정리 계획(추적판 빼기): 개체에 붙은 넣음 표식이 이 개체들만 감싸고 그 넣음의 작성자가 author 면
   * 거절(개체째 바로 지움 — 새 변경 없음), 남의 넣음(또는 다른 개체도 감싼 넣음)이면 수락(표식만 지우고 개체는 남는다 — 그 뒤 지움 표식으로 감싼다)
   * → { reject: [id], accept: [id] }
   */
  _untrackPlan(objs, author) {
    const heads = new Map(this.header.changes().map((c) => [String(c.id), c]));
    const names = new Map(this.header.authors().map((a) => [a.id, a.name]));
    const set = new Set(objs); const reject = new Set(); const accept = new Set();
    for (const a of objs) {
      const g = a?.marks;
      if (!g || !a.ins || g.begin.name !== 'hp:insertBegin' || g.begin.id == null) continue;
      const h = heads.get(String(g.begin.id));
      const mine = !!h && names.get(h.authorID) === author && g.begin.attach.every((o) => set.has(o));
      (mine ? reject : accept).add(Number(g.begin.id));
    }
    return { reject: [...reject], accept: [...accept] };
  }

  /** [hwpx-cowork] 변경 거절 목록 → 수락 목록(거절로 밀린 번호를 따라 옮김 — 너그럽게)을 차례로 → 한 것이 있는가 */
  _runUntrack(reject, accept) {
    if (!reject.length && !accept.length) return false;
    const log = (this._renumberLog ??= []);
    const from = log.length;
    if (reject.length) this.resolveChanges(reject, 'reject', { keepIfStuck: true });
    const cur = remapIds(accept, log.slice(from));
    if (cur.length) this.resolveChanges(cur, 'accept', { tolerant: true });
    return true;
  }

  /** [hwpx-cowork] 개체 anchor 들(한 구역) 안 문단의 변경 id(문자열, 중복 없음) */
  _nestedChangeIds(sec, objs) {
    if (!objs.length) return [];
    const ids = new Set();
    for (const q of sec.paras) {
      if (!objs.some((a) => a.start <= q.start && q.end <= a.end)) continue;
      for (const m of q.anchors) if (m.kind === 'change' && m.id != null) ids.add(String(m.id));
    }
    return [...ids];
  }

  /** [hwpx-cowork] 개체 변경 하나의 머리 항목(OBJECT_TRACK.headerType)을 만든다 → 변경 id */
  _newObjectChange(type, { author, date } = {}) {
    const authorId = this.header.ensureAuthor(author || '?');
    const id = this.header.addChange(OBJECT_TRACK.headerType(type), authorId, date);
    if (!this.header.trackingEnabled()) this.header.setTracking(true);
    return id;
  }

  /** [hwpx-cowork] 문단이 run 에 직접 가진 그림·표·도형 anchor(removeOwnObjects 와 같은 것 — view 기본 최종본: 변경 추적으로 지운 것은 뺌) */
  _ownObjectAnchors(p, view = 'final') {
    return p.anchors.filter((a) => a.kind === 'ctrl' && (a.name === 'hp:pic' || a.name === 'hp:tbl' || SHAPE_TAGS.has(anchorTag(a))) && Section.visibleObject(a, view));
  }

  /**
   * [hwpx-cowork] 본문·중첩 문단 ref 가 직접 가진(최종본에 보이는) 그림·표·도형 목록(문서 순서 — 2026-11-10 개체 지우기 제안이 무엇을 지울지 보인다)
   * → [{ kind: 'table'|'figure'|'chart'|'shape', name: '표'|'그림'|'차트'|'글상자'|'사각형'|'선'|'묶음' … }]
   */
  ownObjects(ref) {
    const { sec, p } = this.resolve(ref);
    return this._ownObjectAnchors(p).map((a) => {
      const kind = objectKind(a);
      return { kind, name: kind === 'table' ? '표' : kind === 'figure' ? '그림' : shapeName(anchorTag(a), sec.xml.slice(a.start, a.end)) };
    });
  }

  /**
   * [hwpx-cowork] 개체 지우기(removeOwnObjects·removeOwnObjectsTracked — kinds 같음) 뒤 ref 의 직접 중첩 문단('/n' 번호 — 글상자·표 칸·캡션·각주 …)이
   * 갈 번호(2026-11-10 개체 지우기 제안이 다른 제안의 중첩 주소를 옮길 때). 지우기 전에 부른다 → [새 번호 | null(지울 개체 안 문단)]
   * — 남는 문단은 차례를 지킨 채 앞으로 당겨진다(section.js: 보이는 중첩 문단만 차례대로 n 번호, 지운 개체 안은 '/d')
   */
  nestedAfterRemoval(ref, kinds = null) {
    const { p } = this.resolve(ref);
    const picked = this._ownObjectAnchors(p).filter((a) => !kinds || kinds.includes(objectKind(a)));
    let n = 0;
    return p.children.filter((c) => !c.hidden).map((c) => (picked.some((a) => a.start <= c.start && c.end <= a.end) ? null : n++));
  }

  /**
   * [hwpx-cowork] ref 의 직접 중첩 문단('/n' 차례)을 담는 요소 차례('hp:rect,hp:tbl,…') — 개체 지우기를 되돌린 뒤 중첩 문단 차례가 지우기 전과 같은지 볼 때.
   * copyObjectsFrom 은 같은 종류 안의 차례는 지키지만 표·도형·그림 사이 차례는 바뀔 수 있다(종류별로 따로 넣는다)
   */
  nestedSignature(ref) {
    return this.resolve(ref).p.children.filter((c) => !c.hidden).map((c) => c.container || '').join(',');
  }

  /**
   * [hwpx-cowork] 본문·중첩 문단 ref 가 직접 가진(최종본에 보이는) 그림·표·도형을 변경 추적으로 뺀다(removeOwnObjects 의 추적판): 같은 작성자가
   * 추적으로 넣은 개체는 그 넣음을 거절(바로 지움 — 새 변경 없음), 남이 넣은 개체는 그 넣음을 수락한 뒤, 나머지와 함께 지움 표식으로 감싼다
   * (개체는 XML 에 남고 최종본에서 사라진다). → { count: 뺀 개체 수, ids: 새 지움 변경 id(이 호출이 끝난 뒤의 번호) }
   */
  removeOwnObjectsTracked(ref, { author, date, kinds = null } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    // kinds(2026-11-10 개체 지우기 제안): 그 종류의 개체만('table'|'figure'|'shape'|'chart' — objectKind). 없으면 모두(종전 그대로)
    const pick = (a) => !kinds || kinds.includes(objectKind(a));
    const first = this._ownObjectAnchors(this.resolve(ref).p).filter(pick);
    if (!first.length) return { count: 0, ids: [] };
    const plan = this._untrackPlan(first, author);
    this._runUntrack(plan.reject, plan.accept);
    const { sec, p } = this.resolve(ref);
    const left = this._ownObjectAnchors(p).filter(pick);
    const ids = [];
    if (left.length) {
      const edits = left.map((a) => { const id = this._newObjectChange('Delete', { author, date }); ids.push(id); return { start: a.start, end: a.end, insert: OBJECT_TRACK.wrap(sec.xml.slice(a.start, a.end), { type: 'Delete', id }) }; });
      dropLineseg(p, edits);
      sec.load(applyEdits(sec.xml, dedupe(edits)));
    }
    return { count: first.length, ids };
  }

  /**
   * [hwpx-cowork] 본문·중첩 문단 ref 가 직접 가진 그림·표·도형 가운데 변경 추적에 들지 않은 것(ins·del 없음)을 넣음 표식으로 감싼다
   * (AI 표·그림 적용처럼 추적 없이 넣은 개체를 추적으로 — 2단계) → 새 넣음 변경 id(문서 차례)
   */
  trackObjectInsert(ref, { author, date } = {}) {
    if (!author) throw new EngineError('NO_AUTHOR', '작성자 이름이 필요합니다');
    const { sec, p } = this.resolve(ref);
    const list = this._ownObjectAnchors(p).filter((a) => !a.ins && !a.del);
    if (!list.length) return [];
    const ids = [];
    const edits = list.map((a) => { const id = this._newObjectChange('Insert', { author, date }); ids.push(id); return { start: a.start, end: a.end, insert: OBJECT_TRACK.wrap(sec.xml.slice(a.start, a.end), { type: 'Insert', id }) }; });
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    return ids;
  }

  /**
   * source 의 그림 XML(hp:pic 하나)을 이 문서에 넣을 꼴로: 그림 파일을 옮겨 id 를 바꾸고, 이 문서의 다른 개체와 겹치는 id·instid 는 새로,
   * 캡션 문단의 글자·문단 모양·스타일 번호는 이 문서의 같은 정의로(못 옮기면 그대로 — 편집기 내보내기는 원본 머리 번호를 그대로 쓴다)
   */
  _importPicture(source, xml, binId, all, { replacingImage = false } = {}) {
    let out = xml;
    const nb = this._importBinary(source, binId);
    if (nb !== binId) out = out.replace(/(<hc:img\b[^>]*\bbinaryItemIDRef=")[^"]*(")/, `$1${nb}$2`);
    const open = (/^<hp:pic\b[^>]*>/.exec(out) || [''])[0];
    let o2 = open;
    for (const k of ['id', 'instid']) {
      // 편집기가 새로 넣은 그림은 id 0 — 한/글 문서처럼 문서 안에서 겹치지 않는 번호로
      const v = tagAttr(open, k);
      if (v != null && (v === '0' || idTaken(all, v, k))) o2 = setTagAttrs(o2, { [k]: uniqueNumber(all, k) });
    }
    out = o2 + out.slice(open.length);
    if (replacingImage) out = fitPictureToImage(out, this.binaryItem(nb)?.bytes);
    try { out = importFormattingRefs(this, source, out); } catch (e) { if (!(e instanceof EngineError)) throw e; }
    return out;
  }

  /**
   * source 의 표 XML(hp:tbl 하나)을 이 문서에 넣을 꼴로: 안의 그림 파일을 옮기고(번호를 바꿈), 새로 넣는 표(fresh)와 그 안 개체의 id 0·겹치는
   * id 는 새로(바꿔 끼우는 표는 같은 id 를 그대로), 칸·캡션 문단의 글자·문단 모양·스타일·칸 테두리 번호는 이 문서의 같은 정의로
   */
  /** [hwpx-cowork] source 의 머리말·꼬리말 부호 XML 을 이 문서에 넣을 꼴로 — 안 문단의 모양 번호를 이 문서 것으로, 겹치는 머리말 id 는 새로 */
  _importHeaderFooter(source, xml) {
    let out = xml;
    const all = this.sections.map((s) => s.xml).join('');
    out = out.replace(/<(hp:header|hp:footer)\b[^>]*>/, (o, tag) => {
      const v = tagAttr(o, 'id');
      return v != null && all.includes(`<${tag} id="${v}"`) ? setTagAttrs(o, { id: uniqueNumber(all, 'id') }) : o;
    });
    try { out = importFormattingRefs(this, source, out); } catch (e) { if (!(e instanceof EngineError)) throw e; }
    return out;
  }

  _importTable(source, xml, all, fresh) {
    let out = xml.replace(/(binaryItemIDRef=")([^"]+)(")/g, (m, a, id, b) => `${a}${this._importBinary(source, id)}${b}`);
    out = out.replace(/<(hp:tbl|hp:pic)\b[^>]*>/g, (o) => {
      let t = o;
      for (const k of ['id', 'instid']) {
        const v = tagAttr(o, k);
        if (v != null && (v === '0' || (fresh && idTaken(all, v, k)))) t = setTagAttrs(t, { [k]: uniqueNumber(all, k) });
      }
      return t;
    });
    try { out = importFormattingRefs(this, source, out); } catch (e) { if (!(e instanceof EngineError)) throw e; }
    return out;
  }

  /**
   * 본문·중첩 문단 ref 가 직접 가진 그림·표·도형(묶음 안 그림은 묶음째)을 모두 지운다(지운 그림 파일은 아무도 안 쓰면 거둔다) → 지운 수.
   * [hwpx-cowork] 추적하지 않는 지우기 — 변경 추적으로 지운(최종본에 없는) 개체도 함께('all'), 개체에 붙은 변경 표식과 개체 안 변경의 머리 항목,
   * 차트 부분, 개체째 지운 메모의 남은 끝까지 정리한다(_objectRemoval — 다시 매김 기록은 takeRenumberLog)
   */
  removeOwnObjects(ref, { kinds = null, pick = null } = {}) {
    const { sec, p } = this.resolve(ref);
    // kinds(2026-11-10 개체 지우기 제안): 그 종류의 개체만 — 문단이 run 에 직접 가진 것 가운데서 고른다(묶음 안 그림은 묶음째). 없으면 모두(종전 그대로)
    // pick(2026-11-16 개체 → 본문, engine/flow.js): kinds 와 함께 줄 때 그 가운데 pick(anchor) 가 참인 개체만(글을 본문으로 옮긴 글상자·괘선만 지운다)
    const own = kinds
      ? this._ownObjectAnchors(p, 'all').filter((a) => kinds.includes(objectKind(a)) && (!pick || pick(a)))
      : [...this._ownPictures(sec, p, 'all'), ...this._tableIndex(sec).tables.filter((t) => t.owner === p), ...ownShapeAnchors(p, 'all')];
    if (!own.length) return 0;
    const anchors = outermostObjects(own.map((x) => p.anchors.find((a) => a.kind === 'ctrl' && a.start === x.start) || { kind: 'ctrl', start: x.start, end: x.end }));
    const r = this._objectRemoval(sec, anchors);
    const edits = [...r.edits, ...markRemovalEdits(sec.xml, r.marks)];
    dropLineseg(p, edits);
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    this._afterObjectRemoval(r);
    this._removeChangeIds(r.ids);
    return own.length;
  }

  /**
   * [hwpx-cowork] source 의 도형 XML(본문 run 의 직접 자식 하나)을 이 문서에 넣을 꼴로: 안의 그림 파일(묶음 안 그림·그림 채우기)을 옮기고,
   * 글상자·캡션 문단의 글자·문단 모양 번호를 이 문서의 같은 정의로 바꾼다. 바꿔 끼우는 도형(keep = 이 문서의 원래 XML)은 원래 id·instid 를
   * 그대로, 새 도형은 0(편집기 '개체 묶기' 묶음)이거나 이 문서에서 겹치는 id·instid 만 새로 매긴다(편집기가 준 id 는 그대로 — 보낸 창은
   * 다시 열지 않으므로 같은 id 여야 다음 밀어 넣기에서 같은 도형으로 짝짓는다). 도형이 가리키는 다른 꾸러미 부분은 _importShapeParts
   */
  _importShape(source, xml, all, keep = null) {
    let out = xml.replace(/(binaryItemIDRef=")([^"]+)(")/g, (m, a, id, b) => `${a}${this._importBinary(source, id)}${b}`);
    const open = (/^<[\w:]+\b[^>]*>/.exec(out) || [''])[0];
    let o2 = open;
    for (const k of ['id', 'instid']) {
      const v = tagAttr(open, k);
      if (v == null) continue;
      if (keep) { const kv = tagAttr((/^<[\w:]+\b[^>]*>/.exec(keep) || [''])[0], k); if (kv != null && kv !== v) o2 = setTagAttrs(o2, { [k]: kv }); }
      else if (v === '0' || idTaken(all, v, k, true)) o2 = setTagAttrs(o2, { [k]: uniqueNumber(all, k) });
    }
    out = o2 + out.slice(open.length);
    out = this._importShapeParts(source, out, keep, all);
    try { out = importFormattingRefs(this, source, out); } catch (e) { if (!(e instanceof EngineError)) throw e; }
    return out;
  }

  /**
   * [hwpx-cowork] 꾸러미 부분 갈고리 — 넣는 도형 XML 이 가리키는 다른 꾸러미 부분(차트 요소의 chartIDRef → Chart/chartN.xml 등)을 source 에서
   * 이 문서로 옮기고 그 참조를 고친 XML 을 돌려준다. 기본은 그대로(차트 부분 옮기기는 차트 쪽에서 채운다)
   */
  // [hwpx-cowork] 차트: Chart/chartN.xml 을 옮기고(바꿔 끼우는 차트는 원래 번호 자리에), 한/글식 <hp:switch> 안 차트·대체 OLE 의 id 를 맞춘다
  // (engine/chart-parts.js)
  _importShapeParts(source, xml, keep = null, all = '') { return importChartParts(this, source, fixSwitchIds(xml, keep, all), keep); }

  /** [hwpx-cowork] 꾸러미 부분 갈고리 — 지운 도형 XML 이 가리키던 꾸러미 부분(차트 등)을 아무도 안 쓰면 거둔다(engine/chart-parts.js) */
  _releaseShapeParts(xml) { return releaseChartParts(this, xml) > 0; }

  /**
   * 새 표의 본보기 표 — 셀 주소가 있는 표 가운데 점수가 가장 높은 것(같으면 문서 앞쪽). 없으면 null.
   * 점수: 번호 매긴 자료 표(numberingType TABLE — 번호 없는 배치용 표보다 앞) > 합친 칸 없음(자리마다 제 모양 칸이 있다) >
   * 4행·3열 이상(머리행·첫 본문 행·중간 행·끝 행 × 첫 열·가운데 열·끝 열이 다 있다) > 2행·2열 이상
   */
  _tableModel(like = null) {
    // [hwpx-cowork] 고른 본보기 표(like — 표 열쇠, 2026-11-20 §20). 없거나 쓸 수 없으면 아래 점수로 고른다
    if (like) {
      for (const sec of this.sections) {
        const t = this._tableIndex(sec).tables.find((x) => x.key === like);
        if (t && !t.hidden && t.cells.length && !t.cells.some((c) => c.row == null || !c.paras.length)) return { sec, t, picked: true };
      }
    }
    let best = null; let bestScore = -1;
    for (const sec of this.sections) {
      for (const t of this._tableIndex(sec).tables) {
        if (t.hidden || !t.cells.length || t.cells.some((c) => c.row == null || !c.paras.length)) continue;
        const score = (t.attrs.get('numberingType') === 'TABLE' ? 8 : 0) + (t.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1) ? 4 : 0)
          + (t.rows >= 4 && t.cols >= 3 ? 2 : 0) + (t.rows >= 2 && t.cols >= 2 ? 1 : 0);
        if (score > bestScore) { best = { sec, t }; bestScore = score; }
      }
    }
    return best;
  }

  /**
   * [hwpx-cowork] 본보기 표(like)의 병합 칸 목록 — 새 표가 그 표와 행·열 수가 같을 때만(2026-11-20 §20). → ['r0c0:r0c5', …] | null(크기가 다르거나 표 없음)
   * 표기는 read 의 병합 표기와 같다(server/mcp2/views.js)
   */
  tableMergesLike(like, nRows, nCols) {
    const m = like ? this._tableModel(like) : null;
    if (!m?.picked || m.t.rows !== nRows || m.t.cols !== nCols) return null;
    const out = m.t.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).map((c) => `r${c.row}c${c.col}:r${c.row + c.rowSpan - 1}c${c.col + c.colSpan - 1}`);
    return out.length ? out : null;
  }

  /** 문서의 자동 번호 표 캡션 꼴(본보기 표 것, 없으면 문서 앞쪽 표 것) → captionModel 결과 | null */
  _captionModel(model) {
    if (model) { const c = captionModel(model.sec, model.t); if (c) return c; }
    for (const sec of this.sections) for (const t of this._tableIndex(sec).tables) { if (t.hidden) continue; const c = captionModel(sec, t); if (c) return c; }
    return null;
  }

  /**
   * 새 표 모양: { tblAttrs, width(본보기 표 폭 | 없음), pos, outMargin, inMargin, para, caption, cell(r, c, nRows, nCols, headerRows, { numeric }) } — header 에 모양 항목을 더할 수 있다.
   * caption = { open(hp:caption 여는 태그), subList, prefix, suffix, autoNum, para({paraPr, styleId, charPr} | null) }
   */
  /**
   * [hwpx-cowork] 칸 안 새 표 XML 을 만드는 함수(editTable 의 cell_paragraphs {table} — 2026-11-20 §22, engine/table-edit.js rebuildCell 이 부른다).
   * 꼴은 한/글·편집기 엔진이 칸 안에 만든 표와 같게(vendor/rhwp create_table_in_cell_by_path_native — 한/글 2020 표본 #8262): 글자처럼 취급,
   * 세로 기준 문단·가로 기준 단, 바깥 여백 283, 폭 = 칸 안쪽 폭 − 2×283(열은 고르게), 칸 안 여백 510/141, 세로 가운데, 줄 높이 = 141 + 글자 높이 + 141,
   * 칸 문단 모양·글자 모양 = 넣을 자리 칸 문단의 것, 테두리 = 네 변 실선. spec.like(본보기 표 열쇠)가 있으면 그 표의 칸 모양을 빌린다(위치·여백은 칸 안 표 그대로).
   * 머리행(header_rows)은 굵게. 캡션 없는 표라 번호 종류 '없음'(insertTableAfter 와 같은 까닭). merges 는 표 고치기 merge 로.
   * h = 쓸 머리(미리 보기는 사본). → ({ spec:{rows, headerRows?, merges?, like?}, width, paraPr, styleId, charPr }) → { xml, rows, cols }
   */
  _cellTableFactory(h) {
    const all = this.sections.map((s) => s.xml).join('');
    const used = new Set();
    let zOrder = Math.max(0, ...this.sections.flatMap((s) => [...s.xml.matchAll(/\bzOrder="(\d+)"/g)].map((m) => parseInt(m[1], 10)))) + 1;
    const OUT = 283;
    return ({ spec, width, paraPr, styleId, charPr }) => {
      const rows = spec?.rows;
      if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new EngineError('TABLE_ROWS', '칸 안 표 내용(rows: 문자열 2차원 배열)이 필요합니다');
      const nCols = Math.max(...rows.map((r) => r.length));
      if (nCols < 1 || rows.length > 200 || nCols > 30) throw new EngineError('TABLE_SIZE', `칸 안 표가 너무 크거나 열이 없습니다(${rows.length}×${nCols}, 최대 200×30)`);
      const grid = rows.map((r) => Array.from({ length: nCols }, (_, c) => cellText(r[c])));
      const hr = Math.max(0, Math.min(grid.length, parseInt(spec.headerRows ?? 0, 10) || 0));
      // 열 폭은 고르게(한/글·편집기 엔진처럼 칸 안쪽 폭 − 2×바깥 여백을 열 수로 나눈 몫 — 표 폭 = 몫 × 열 수)
      const content = Math.max(600, Math.floor((Math.round(width) - 2 * OUT) / nCols)) * nCols;
      const inlinePos = '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>';
      const outMargin = `<hp:outMargin left="${OUT}" right="${OUT}" top="${OUT}" bottom="${OUT}"/>`;
      let style;
      if (spec.like) {
        // 본보기 표의 칸 모양(테두리·글자·문단·높이) — _tableStyle 은 this.header 를 쓰므로 미리 보기 사본 머리로 잠시 바꾼다
        const saved = this.header; this.header = h;
        try { style = this._tableStyle(spec.like, { rows: grid.length, cols: nCols }); } finally { this.header = saved; }
        style = { ...style, pos: inlinePos, outMargin };
      } else {
        const line = { type: 'SOLID', width: '0.12 mm', color: '#000000' };
        const bf = h.borderFill({ left: line, right: line, top: line, bottom: line });
        const height = 141 + h.charHeight(charPr) + 141;
        const head = hr ? h.boldCharPr(charPr) : charPr;
        const margin = '<hp:cellMargin left="510" right="510" top="141" bottom="141"/>';
        style = {
          colWidths: Array(nCols).fill(1), em: h.charHeight(charPr),
          cell: (r) => ({ borderFill: bf, paraPr, styleId, charPr: r < hr ? head : charPr, height, hasMargin: 0, margin, vertAlign: 'CENTER' }),
          pos: inlinePos, outMargin, inMargin: '<hp:inMargin left="510" right="510" top="141" bottom="141"/>',
          tblAttrs: new Map([['id', '0'], ['zOrder', '0'], ['numberingType', 'NONE'], ['textWrap', 'TOP_AND_BOTTOM'], ['textFlow', 'BOTH_SIDES'], ['lock', '0'], ['dropcapstyle', 'None'],
            ['pageBreak', 'CELL'], ['repeatHeader', '0'], ['rowCnt', '0'], ['colCnt', '0'], ['cellSpacing', '0'], ['borderFillIDRef', String(bf)], ['noAdjust', '0']]),
        };
      }
      const id = uniqueNumberBy((n) => used.has(Number(n)) || idTaken(all, n, 'id') || idTaken(all, n, 'beginIDRef'));
      used.add(id);
      let xml = tableXml({ id, zOrder: zOrder++, rows: grid, headerRows: hr, width: content, style, textXml: inlineXml, numbering: 'NONE' });
      // 글자처럼 취급 표는 쪽에서 나뉘지 않으므로 머리행 되풀이는 끈다(편집기 엔진이 칸 안에 만드는 표와 같게 — 머리행 표시는 칸의 header="1")
      xml = xml.replace(/^(<hp:tbl\b[^>]*?\s)repeatHeader="1"/, '$1repeatHeader="0"');
      const merges = Array.isArray(spec.merges) && spec.merges.length ? spec.merges : spec.like ? this.tableMergesLike(spec.like, grid.length, nCols) : null;
      if (merges?.length) {
        const mops = merges.map((s) => { const [r0, c0, r1, c1] = /r(\d+)c(\d+):r(\d+)c(\d+)/.exec(String(s)).slice(1).map(Number); return { op: 'merge', range: { row_from: r0, row_to: r1, col_from: c0, col_to: c1 } }; });
        xml = editTableXml(xml, mops, { header: h }).xml;
      }
      return { xml, rows: grid.length, cols: nCols };
    };
  }

  _tableStyle(like = null, shape = null) {
    const h = this.header;
    const model = this._tableModel(like);
    const cache = new Map();
    const capModel = this._captionModel(model);
    const capPara = (m) => {
      const capP = m?.t.captionParas.find((p) => p.container !== 'hp:fieldBegin');
      return capP ? { paraPr: attrOf(m.sec.xml, capP, 'paraPrIDRef'), styleId: attrOf(m.sec.xml, capP, 'styleIDRef'), charPr: textRunCharPr(capP) } : null;
    };
    const caption = capModel || { ...STD_CAPTION, para: capPara(model) || captionStyle(h) };
    if (model) {
      const { sec, t } = model;
      let srcHead = 0;
      for (let r = 0; r < t.rows; r++) { const row = t.cells.filter((c) => c.row === r); if (row.length && row.every((c) => c.header)) srcHead++; else break; }
      if (!srcHead && t.rows >= 2) srcHead = 1; // 머리행 표시가 없어도 첫 행을 머리행으로 본다
      const sb = Math.min(srcHead, t.rows - 1); const last = t.rows - 1; const C = t.cols;
      const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
      const allRows = range(0, last);
      /** rs 행 차례로(그 행에서 시작하는 칸, 열 차례) pred 를 만족하는 첫 칸 */
      const firstIn = (rs, pred) => { for (const r of rs) for (const x of t.cells) if (x.row === r && pred(x)) return x; return null; };
      const single = (x) => x.rowSpan === 1 && x.colSpan === 1;
      const atLeft = (x) => x.col === 0; const atRight = (x) => x.col + x.colSpan === C;
      const tblAttrs = new Map(t.attrs);
      const owner = t.owner; const run = owner.runs.find((x) => x.start < t.start && t.start < x.end) || owner.runs[0];
      const bodyCell = firstIn(range(sb, last), () => true) || t.cells[0];
      // [hwpx-cowork] 고른 본보기(like)와 크기가 같으면(2026-11-20 §20) 칸마다 그 자리 칸(합친 칸이면 그 칸)의 모양을 그대로 — 단위·주석 행처럼 행 종류로는
      // 나눌 수 없는 꼴까지 같게. 열 폭은 열 수가 같으면 본보기 비율대로(한 칸짜리 칸의 폭, 없으면 합친 칸 폭을 나눔)
      const exact = !!(model.picked && shape && shape.rows === t.rows && shape.cols === t.cols);
      const cover = (r, c) => t.cells.find((x) => r >= x.row && r < x.row + x.rowSpan && c >= x.col && c < x.col + x.colSpan) || null;
      let colWidths = null;
      if (model.picked && shape && shape.cols === C) {
        colWidths = range(0, C - 1).map((c) => {
          const one = t.cells.find((x) => x.col === c && x.colSpan === 1 && x.width > 0);
          if (one) return one.width;
          const span = t.cells.find((x) => c >= x.col && c < x.col + x.colSpan && x.width > 0);
          return span ? Math.round(span.width / span.colSpan) : 0;
        });
        if (colWidths.some((w) => !(w > 0))) colWidths = null;
      }
      const style = {
        colWidths,
        tblAttrs,
        em: h.charHeight(textRunCharPr(bodyCell.paras[0])),
        width: /\bwidthRelTo="ABSOLUTE"/.test(t.parts['hp:sz'] || '') ? parseInt((/\bwidth="(\d+)"/.exec(t.parts['hp:sz']) || [])[1], 10) || null : null,
        pos: t.parts['hp:pos'] || DEFAULT_POS,
        // 바깥 아래 여백은 2mm 이상(원본 표는 뒤에 주석·빈 문단이 따르지만 새 표는 바로 다음 문단이 붙는다)
        outMargin: (t.parts['hp:outMargin'] || DEFAULT_OUT_MARGIN).replace(/\bbottom="(\d+)"/, (m, v) => `bottom="${Math.max(567, parseInt(v, 10))}"`),
        inMargin: t.parts['hp:inMargin'] || DEFAULT_IN_MARGIN,
        para: { paraPr: attrOf(sec.xml, owner, 'paraPrIDRef'), styleId: attrOf(sec.xml, owner, 'styleIDRef'), charPr: run ? run.charPr : '0' },
        caption,
        // 새 표 (r, c) 의 모양 = 본보기 표에서 행 종류(머리행 / 첫 본문 행 / 중간 행 / 끝 행)가 같고 왼쪽·오른쪽 변이 같은 자리(표 바깥 / 안쪽 선)인 칸.
        // 그런 칸이 없으면(첫 열이 합친 칸 등) 같은 행 종류의 다른 칸 테두리에서 왼쪽·오른쪽 선만 그 변 자리 칸의 것으로 바꾼다 —
        // 첫 열 왼쪽·끝 열 오른쪽 선이 없는 표에서 가운데 칸 테두리를 그대로 빌리면 표 바깥에 세로선이 생긴다
        cell: (r, c, nRows, nCols, hr, { numeric = false } = {}) => {
          if (exact) {
            const x = cover(r, c);
            if (x?.paras.length) {
              const key = `x:${x.row},${x.col}`;
              if (cache.has(key)) return cache.get(key);
              const sp = x.paras[0];
              const out = { borderFill: x.attrs.get('borderFillIDRef') || '1', hasMargin: x.attrs.get('hasMargin') || '0',
                paraPr: attrOf(sec.xml, sp, 'paraPrIDRef'), styleId: attrOf(sec.xml, sp, 'styleIDRef'), charPr: textRunCharPr(sp),
                vertAlign: x.subListAttrs?.get('vertAlign') || 'CENTER', margin: x.parts['hp:cellMargin'] || DEFAULT_CELL_MARGIN,
                height: Math.max(500, Math.round((x.height || 1282) / (x.rowSpan || 1))) };
              cache.set(key, out); return out;
            }
          }
          const isHead = r < hr;
          const grp = isHead ? `h${Math.min(r, Math.max(0, srcHead - 1))}` : (r === hr ? 'b1' : r === nRows - 1 ? 'bl' : 'bn');
          const outL = c === 0; const outR = c === nCols - 1;
          const key = `${grp}:${+outL}${+outR}:${+numeric}`;
          if (cache.has(key)) return cache.get(key);
          let rs;
          if (isHead) rs = srcHead ? [Math.min(r, srcHead - 1), ...range(0, srcHead - 1)] : [0];
          else if (grp === 'b1') rs = range(sb, last);
          else if (grp === 'bl') rs = [last, ...range(sb + 1, last - 1).reverse(), sb];
          else rs = sb + 1 <= last ? [...range(sb + 1, Math.max(sb + 1, last - 1)), sb, last] : [sb];
          const edges = (x) => atLeft(x) === outL && atRight(x) === outR;
          let src = firstIn(rs, (x) => single(x) && edges(x));
          let borderFill;
          if (src) borderFill = src.attrs.get('borderFillIDRef') || '1';
          else {
            const base = firstIn(rs, (x) => single(x) && !atLeft(x) && !atRight(x)) || firstIn(rs, single) || firstIn(rs, () => true) || t.cells[0];
            const side = (pred) => (firstIn(rs, pred) || firstIn(allRows, pred))?.attrs.get('borderFillIDRef') ?? null;
            borderFill = h.borderFillSides(base.attrs.get('borderFillIDRef') || '1', { left: side((x) => atLeft(x) === outL), right: side((x) => atRight(x) === outR) });
            // 글 모양은 같은 변 자리 칸(합친 칸도)에서 — 첫 열은 첫 열 칸의 정렬을 따른다
            src = firstIn(rs, edges) || firstIn(rs, (x) => atLeft(x) === outL) || base;
          }
          const sp = src.paras[0];
          let charPr = textRunCharPr(sp);
          if (isHead && !h.isBold(charPr)) charPr = h.boldCharPr(charPr);
          let paraPr = attrOf(sec.xml, sp, 'paraPrIDRef');
          // 본문 칸 정렬은 새 글에 맞춘다(서식명세 §4): 본보기 칸과 글 종류(숫자·글)가 다르면 숫자 열은 오른쪽, 글 열은 첫 열 왼쪽·나머지 가운데
          if (!isHead && isNumericCell(Section.text(sp, 'final')) !== numeric) paraPr = h.paraPrVariant(paraPr, { align: numeric ? 'RIGHT' : outL ? 'LEFT' : 'CENTER' });
          const out = {
            borderFill, hasMargin: src.attrs.get('hasMargin') || '0',
            paraPr, styleId: attrOf(sec.xml, sp, 'styleIDRef'), charPr,
            vertAlign: src.subListAttrs?.get('vertAlign') || 'CENTER',
            margin: src.parts['hp:cellMargin'] || DEFAULT_CELL_MARGIN,
            height: Math.max(500, Math.round((src.height || 1282) / (src.rowSpan || 1))),
          };
          cache.set(key, out); return out;
        },
      };
      return style;
    }
    // 문서에 표가 없다: 표준서식 표(skill/hwpx-standard-report 서식명세 §3·§4) — 첫 열 왼쪽·끝 열 오른쪽 선 없음,
    // 머리행 위 0.5mm 실선·아래 0.5mm 이중선·회색(#BFBFBF) 바탕, 첫 본문 행 위 이중선, 나머지 0.15mm 실선(머리행 두 줄 사이도).
    // 글은 바탕글 모양: 머리행 굵게·가운데, 첫 열 왼쪽, 숫자 열 오른쪽, 나머지 가운데
    const normal = h.style({ engName: 'Normal' }) || h.style({ id: 0 }) || { styleId: '0', paraPr: '0', charPr: '0' };
    const line = (type, width) => ({ type, width, color: '#000000' });
    const NONE = line('NONE', '0.1 mm'); const THIN = line('SOLID', '0.15 mm'); const THICK = line('SOLID', '0.5 mm'); const DOUBLE = line('DOUBLE_SLIM', '0.5 mm');
    const tableBf = h.borderFill({ left: NONE, right: NONE, top: THIN, bottom: THIN });
    const ppBody = h.paraPrVariant(normal.paraPr, { noIndent: true });
    const ppLeft = h.paraPrVariant(normal.paraPr, { align: 'LEFT', noIndent: true });
    const ppCenter = h.paraPrVariant(normal.paraPr, { align: 'CENTER', noIndent: true });
    const ppRight = h.paraPrVariant(normal.paraPr, { align: 'RIGHT', noIndent: true });
    const cpBody = normal.charPr; const cpHead = h.boldCharPr(normal.charPr);
    const height = h.charHeight(cpBody) + 282;
    return {
      tblAttrs: new Map([['id', ''], ['zOrder', ''], ['numberingType', 'NONE'], ['textWrap', 'TOP_AND_BOTTOM'], ['textFlow', 'BOTH_SIDES'], ['lock', '0'],
        ['dropcapstyle', 'None'], ['pageBreak', 'CELL'], ['repeatHeader', '1'], ['rowCnt', ''], ['colCnt', ''], ['cellSpacing', '0'], ['borderFillIDRef', tableBf], ['noAdjust', '0']]),
      pos: DEFAULT_POS, outMargin: '<hp:outMargin left="0" right="0" top="0" bottom="567"/>', inMargin: DEFAULT_IN_MARGIN,
      para: { paraPr: ppBody, styleId: normal.styleId, charPr: cpBody },
      em: h.charHeight(cpBody),
      caption,
      cell: (r, c, nRows, nCols, hr, { numeric = false } = {}) => {
        const isHead = r < hr;
        const top = r === 0 ? THICK : r === hr ? DOUBLE : THIN;
        const bottom = isHead && r === hr - 1 ? DOUBLE : THIN;
        const key = `std:${r === 0 ? 't' : r === hr ? 'f' : 'b'}${isHead ? (r === hr - 1 ? 'H' : 'h') : ''}:${+(c === 0)}${+(c === nCols - 1)}:${+numeric}`;
        if (cache.has(key)) return cache.get(key);
        const out = {
          borderFill: h.borderFill({ left: c === 0 ? NONE : THIN, right: c === nCols - 1 ? NONE : THIN, top, bottom }, { face: isHead ? '#BFBFBF' : null }),
          hasMargin: '0', paraPr: isHead ? ppCenter : numeric ? ppRight : c === 0 ? ppLeft : ppCenter, styleId: normal.styleId,
          charPr: isHead ? cpHead : cpBody, vertAlign: 'CENTER', margin: DEFAULT_CELL_MARGIN, height,
        };
        cache.set(key, out); return out;
      },
    };
  }

  /**
   * 본문 문단 하나를 통째로 지운다(hp:p 요소째). 구역의 첫 문단(secPr)은 지우지 않는다 — 구역 가운데의 구역 나누기 문단
   * (편집기 '새 구역' 차례 첫 문단 등 — 구역 파일 안의 두 번째 secPr)은 지울 수 있다(편집기에서 그 문단을 지우면 구역이 앞 구역에 합쳐진다).
   * 안에 있던 변경 표식은 헤더 항목까지 지우고 번호를 다시 매긴다(takeRenumberLog 로 서비스가 맞춘다).
   * 문단 밖으로 이어지는 필드(메모)는 짝을 정리한다: 시작만 안에 있으면 바깥 끝 표식을 지우고, 끝만 안에 있으면 앞 문단 끝으로 옮긴다.
   */
  removeBodyParagraph(sectionIndex, bodyIdx) {
    const sec = this.sections[sectionIndex];
    if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: ${sectionIndex}`);
    const p = sec.bodyParas[bodyIdx];
    if (!p) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: s${sectionIndex}/p${bodyIdx}`);
    if (bodyIdx === 0) throw new EngineError('FIRST_PARAGRAPH', '구역의 첫 문단(구역 속성을 품은 문단)은 지울 수 없습니다');
    const inside = (q) => q.start >= p.start && q.end <= p.end;
    const ids = new Set();
    const begins = new Map(); const ends = new Map(); // 필드 id → {inside, anchor, para}
    for (const q of sec.paras) {
      const isIn = inside(q);
      for (const a of q.anchors) {
        if (a.kind === 'change' && isIn) ids.add(String(a.id));
        if (a.kind === 'ctrl' && a.inner === 'hp:fieldBegin') begins.set(a.innerAttrs.get('id'), { isIn, a, q });
        if (a.kind === 'ctrl' && a.inner === 'hp:fieldEnd') ends.set(a.innerAttrs.get('beginIDRef'), { isIn, a, q });
      }
    }
    const edits = [{ start: p.start, end: p.end, insert: '' }];
    // 문단 밖에 남는 같은 변경의 표식(문단 경계에 걸친 변경)도 지운다
    for (const q of sec.paras) {
      if (inside(q)) continue;
      for (const a of Section.changeMarks(q)) if (ids.has(String(a.id))) edits.push({ start: a.start, end: a.end, insert: '' });
    }
    for (const [fid, b] of begins) {
      const e = ends.get(fid);
      if (b.isIn && e && !e.isIn) edits.push({ start: e.a.start, end: e.a.end, insert: '' });
    }
    const prev = sec.bodyParas[bodyIdx - 1];
    for (const [fid, e] of ends) {
      const b = begins.get(fid);
      if (!e.isIn || !b || b.isIn) continue;
      const endXml = sec.xml.slice(e.a.start, e.a.end);
      const fc = prev.chars.length;
      edits.push(fc ? ctrlPointAfter(prev, fc - 1, endXml) : emptyParagraphEdit(sec, prev, '', endXml));
      dropLineseg(prev, edits);
    }
    // [hwpx-cowork] 앞 문단이 넣은 나눔(폭 0 — 이 문단을 넣을 때 표시한 것)으로 끝나고 이 문단 자기 나눔은 보통이면(원래 나눔을 이 문단이 가졌다)
    // 앞 문단 나눔 표식·머리 항목도 지운다 — 남기면 뒤 거절이 앞 문단과 그 뒤 문단을 합친다(제안 되돌리기 등)
    const pb = Section.breakOf(prev); const ob = Section.breakOf(p);
    if (pb && pb.type === 'Insert' && pb.zw && pb.begin && !(ob && ob.type === 'Insert')) {
      edits.push(...markRemovalEdits(sec.xml, [pb.begin, pb.end]));
      dropLineseg(prev, edits);
      ids.add(String(pb.id));
    }
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    // 헤더 항목 정리: 큰 번호부터 지워 작은 번호가 흔들리지 않게 한다
    const have = new Set(this.header.changes().map((c) => String(c.id)));
    for (const id of [...ids].map(Number).sort((a, b) => b - a)) {
      if (!have.has(String(id))) continue;
      this.header.removeChange(id);
      this._renumberChanges(id);
    }
    return true;
  }

  /**
   * 본문 문단 bodyIdx 를 앞 문단에 붙인다(문단 나눔 없애기): 그 문단 run 들의 내용(hp:t·컨트롤)을 앞 문단의 마지막 run 끝으로 옮기고 그 문단
   * (hp:p)을 없앤다. 문서 차례가 그대로라 변경 표식·필드 짝은 깨지지 않는다(헤더 항목도 그대로). 앞 문단 줄 정보는 지운다(다시 계산).
   * 옮긴 내용은 앞 문단 마지막 run 의 글자 모양을 따른다 — 새 run 을 붙이면 문단 끝(빈 문단이면 그 줄) 글자 모양이 옮긴 글 것으로 바뀌어
   * 최종본 줄 높이·끝에서 이어 친 글 모양이 달라진다. 글자·표식·컨트롤이 없는 빈 run 은 옮기지 않고, 짝 없는 필드 끝(시작이 문서에 없음 —
   * 한/글이 버리고 문단 머리에 있으면 파일을 못 연다)은 버린다.
   * 변경 추적 문서에서 지운 문단의 '지운 글' 표식을 남긴 채 문단만 없앨 때 쓴다(server/live.js — 최종본에서 빈 줄로 남지 않게)
   */
  joinBodyParagraph(sectionIndex, bodyIdx) {
    const sec = this.sections[sectionIndex];
    if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: ${sectionIndex}`);
    const p = sec.bodyParas[bodyIdx];
    if (!p) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: s${sectionIndex}/p${bodyIdx}`);
    if (bodyIdx === 0) throw new EngineError('FIRST_PARAGRAPH', '구역의 첫 문단은 앞 문단에 붙일 수 없습니다');
    const prev = sec.bodyParas[bodyIdx - 1];
    const types = this._fieldTypes();
    const orphan = (a) => a.kind === 'ctrl' && a.name === 'hp:ctrl' && a.inner === 'hp:fieldEnd' && !types.has(a.innerAttrs?.get('beginIDRef') ?? '');
    const CLOSE = '</hp:run>';
    let moved = ''; let firstCharPr = null;
    for (const r of p.runs) {
      if (r.selfclose) continue;
      const own = p.anchors.filter((a) => a.run === r);
      if (!p.chars.some((c) => c.run === r) && !own.some((a) => !orphan(a))) continue;
      const from = sec.xml.indexOf('>', r.start) + 1; const to = r.end - CLOSE.length;
      let x = sec.xml.slice(from, to);
      for (const a of own.filter(orphan).sort((u, v) => v.start - u.start)) x = x.slice(0, a.start - from) + x.slice(a.end - from);
      moved += x.replace(/<hp:t\/>|<hp:t><\/hp:t>/g, ''); firstCharPr ??= r.charPr;   // 빈 hp:t 는 옮길 것이 없다(이어 붙이면 쌓인다)
    }
    // 구역 나누기 문단(파일 안 secPr)을 붙이면 구역 나누기를 지운 것이다 — 구역·단 정의는 옮기지 않는다(한/글: 합친 글은 앞 구역을 따른다,
    // docs/SECTIONS.md). 옮기면 앞 문단 가운데에 구역 정의가 남는다
    moved = stripSectionBreakXml(moved);
    const edits = [{ start: p.start, end: p.end, insert: '' }];
    if (moved) {
      const last = prev.runs[prev.runs.length - 1];
      if (!last) edits.push({ pos: prev.lineseg ? prev.lineseg.start : sec.xml.lastIndexOf('</hp:p>', prev.end), insert: `<hp:run charPrIDRef="${firstCharPr}">${moved}${CLOSE}` });
      else if (last.selfclose) edits.push({ start: last.end - 2, end: last.end, insert: `>${moved}${CLOSE}` });   // <hp:run …/> → <hp:run …>…</hp:run>
      else edits.push({ pos: last.end - CLOSE.length, insert: moved });
      dropLineseg(prev, edits);
    }
    sec.load(applyEdits(sec.xml, dedupe(edits)));
    return true;
  }

  // ───────── 구역(구역 파일) 구조 — docs/SECTIONS.md ─────────
  // 구역 = Contents/sectionN.xml 하나. 구역 나누기 = 구역 첫 문단 머리의 hp:secPr(+ hp:colPr). 파일 안 secPr 문단(차례 '새 구역')도 한/글에는
  // 같은 구역 나누기다. 구역을 넘는 편집(구역 합치기·나누기)은 구역 파일을 하나로 이어(flattenSections — 구역 나누기는 파일 안 secPr 로 남는다)
  // 한 구역처럼 견주고 고친 뒤, 수정본 구역 경계에서 다시 파일로 나눈다(splitSectionsAt).

  /** 구역 파일마다 본문 문단 수 */
  sectionSizes() { return this.sections.map((s) => s.bodyParas.length); }

  /** 본문 문단 ref 가 구역 나누기 문단인가(첫 run 머리에 hp:secPr — 구역 첫 문단·파일 안 구역 나누기) */
  hasSectionBreak(ref) {
    const { sec, p } = this.resolve(ref);
    return !p.parent && sectionBreakAt(sec, p);
  }

  /**
   * 구역 파일을 모두 구역 0 하나로 잇는다 — 구역 k(≥1)의 본문 문단을 첫머리 구역·단 정의째(파일 안 구역 나누기로) 앞 구역 끝에 옮긴다.
   * 한/글에는 같은 문서다(구역 나누기는 그대로). 옮긴 필드 id(메모·누름틀)가 겹치면 새 번호로 — 메모 스레드 열쇠(구역·필드 id)는 부르는 쪽이 맞춘다.
   * → 원래 구역 크기 목록
   */
  flattenSections() {
    const sizes = this.sectionSizes();
    if (this.sections.length < 2) return sizes;
    let xml = this.sections[0].xml;
    for (const sec of this.sections.slice(1)) {
      if (!sec.bodyParas.length) continue;
      const body = renumberFieldIds(sec.xml.slice(sec.bodyParas[0].start, sec.bodyParas[sec.bodyParas.length - 1].end), xml);
      const close = xml.lastIndexOf('</hs:sec>');
      xml = xml.slice(0, close) + body + xml.slice(close);
    }
    this.sections = [new Section(xml, 0)];
    this._rewriteSectionFiles();
    return sizes;
  }

  /**
   * 구역 0 을 본문 문단 starts(구역 나누기 — 첫 run 에 hp:secPr 가 있는 문단)에서 구역 파일로 나눈다(flattenSections 의 반대).
   * 구역 나누기가 아닌 문단·0 은 건너뛴다. → 실제로 나눈 문단 번호(오름차순)
   */
  splitSectionsAt(starts) {
    const sec = this.sections[0];
    const cut = [...new Set(starts)].filter((i) => i > 0 && i < sec.bodyParas.length && sectionBreakAt(sec, sec.bodyParas[i])).sort((a, b) => a - b);
    if (!cut.length || this.sections.length !== 1) return [];
    const xml = sec.xml;
    const open = xml.indexOf('>', xml.indexOf('<hs:sec')) + 1;
    const close = xml.lastIndexOf('</hs:sec>');
    const head = xml.slice(0, open); const tail = xml.slice(close);
    const bounds = [...cut.map((i) => sec.bodyParas[i].start), close];
    const parts = [xml.slice(0, bounds[0]) + tail];
    for (let k = 0; k < cut.length; k++) parts.push(head + xml.slice(bounds[k], bounds[k + 1]) + tail);
    this.sections = parts.map((x, i) => new Section(x, i));
    this._rewriteSectionFiles();
    return cut;
  }

  /** 구역 목록이 바뀐 뒤 구역 파일 이름(section0.xml…)·content.hpf(항목·spine)·header secCnt 를 맞춘다 */
  _rewriteSectionFiles() {
    const names = this.sections.map((_, i) => `Contents/section${i}.xml`);
    for (const n of this.sectionNames) if (!names.includes(n)) this.container.remove(n);
    this.sectionNames = names;
    names.forEach((n, i) => this.container.setText(n, this.sections[i].xml));
    let hpf = this.container.getText('Contents/content.hpf');
    if (hpf) {
      const itemRe = /<opf:item\b[^>]*href="Contents\/section\d+\.xml"[^>]*\/>/g;
      const items = [...hpf.matchAll(itemRe)];
      if (items.length) {
        const ids = items.map((m) => /\bid="([^"]*)"/.exec(m[0])?.[1]).filter(Boolean);
        const at = items[0].index;
        hpf = hpf.replace(itemRe, '');
        hpf = hpf.slice(0, at) + names.map((n, i) => `<opf:item id="section${i}" href="${n}" media-type="application/xml"/>`).join('') + hpf.slice(at);
        const refRe = new RegExp(`<opf:itemref\\b[^>]*idref="(?:${ids.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})"[^>]*/>`, 'g');
        const refs = [...hpf.matchAll(refRe)];
        if (refs.length) {
          const rat = refs[0].index;
          hpf = hpf.replace(refRe, '');
          hpf = hpf.slice(0, rat) + names.map((_, i) => `<opf:itemref idref="section${i}" linear="yes"/>`).join('') + hpf.slice(rat);
        }
        this.container.setText('Contents/content.hpf', hpf);
      }
    }
    this.header.xml = this.header.xml.replace(/(<hh:head\b[^>]*\ssecCnt=")\d+(")/, `$1${names.length}$2`);
  }
}

/** [hwpx-cowork] run 안쪽 XML 에서 구역 나누기(hp:secPr 와 바로 뒤 단 정의 hp:ctrl>hp:colPr)를 뺀다 */
function stripSectionBreakXml(x) {
  if (!x.includes('<hp:secPr')) return x;
  return x.replace(/<hp:secPr\b[\s\S]*?<\/hp:secPr>(\s*<hp:ctrl>\s*<hp:colPr\b(?:[^>]*\/>|[\s\S]*?<\/hp:colPr>)\s*<\/hp:ctrl>)?/, '');
}

/** 본문 문단 p 의 첫 run 이 구역 나누기(hp:secPr)를 품는가 */
function sectionBreakAt(sec, p) {
  const run = p.runs[0];
  return !!run && sec.xml.slice(run.start, run.end).includes('<hp:secPr');
}

/**
 * [hwpx-cowork] 다른 구역에서 옮겨 올 본문 XML 의 필드 id(fieldBegin id · fieldEnd beginIDRef · fieldid)가 받는 구역 XML 과 겹치면 새 번호로
 * (한 구역 안에서 필드 id 는 고유해야 한다 — 메모 짝이 엉킨다)
 */
function renumberFieldIds(body, target) {
  const taken = (attr, n) => target.includes(`${attr}="${n}"`) || (attr === 'id' && target.includes(`beginIDRef="${n}"`));
  let out = body;
  for (const attr of ['id', 'fieldid']) {
    const seen = new Set([...body.matchAll(new RegExp(`<hp:fieldBegin\\b[^>]*\\s${attr}="(\\d+)"`, 'g'))].map((m) => m[1]));
    for (const old of seen) {
      if (!taken(attr, old)) continue;
      const n = String(uniqueNumberBy((v) => taken(attr, v) || out.includes(`${attr}="${v}"`)));
      const refAttr = attr === 'id' ? 'beginIDRef' : 'fieldid';
      out = out.replace(new RegExp(`(<hp:fieldBegin\\b[^>]*\\s${attr}=")${old}(")`, 'g'), `$1${n}$2`)
        .replace(new RegExp(`(<hp:fieldEnd\\b[^>]*\\s${refAttr}=")${old}(")`, 'g'), `$1${n}$2`);
    }
  }
  return out;
}

const DEFAULT_POS ='<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>';
const DEFAULT_OUT_MARGIN = '<hp:outMargin left="0" right="0" top="0" bottom="567"/>';
const DEFAULT_IN_MARGIN = '<hp:inMargin left="510" right="510" top="141" bottom="141"/>';
const DEFAULT_CELL_MARGIN = '<hp:cellMargin left="510" right="510" top="141" bottom="141"/>';
// 표준서식 캡션(서식명세 §5·§6): 간격 850, '[표 ' / '[그림 ' + 자동 번호 + '] 제목' — 표는 위, 그림은 아래
const stdCaption = (side, label, numType) => ({
  open: `<hp:caption side="${side}" fullSz="0" width="8503" gap="850" lastWidth="0">`,
  subList: '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">',
  prefix: `[${label} `, suffix: '] ',
  autoNum: `<hp:autoNum num="1" numType="${numType}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum>`,
});
const STD_CAPTION = stdCaption('TOP', '표', 'TABLE');
const STD_FIG_CAPTION = stdCaption('BOTTOM', '그림', 'PICTURE');
// 표준서식 그림 배치(서식명세 §5): 글자처럼 취급 + 개체와 조판 부호를 같은 쪽에, 바깥 아래 여백 283
const FIG_POS = '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="1" holdAnchorAndSO="1" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>';
const FIG_OUT_MARGIN = '<hp:outMargin left="0" right="0" top="0" bottom="283"/>';
const FIG_ATTRS = [['id', ''], ['zOrder', ''], ['numberingType', 'PICTURE'], ['textWrap', 'TOP_AND_BOTTOM'], ['textFlow', 'BOTH_SIDES'], ['lock', '0'], ['dropcapstyle', 'None'],
  ['href', ''], ['groupLevel', '0'], ['instid', ''], ['reverse', '0']];

/** 표 t 의 캡션 꼴(captionFormat) | null */
function captionModel(sec, t) {
  const capP = t.captionParas.find((p) => p.container !== 'hp:fieldBegin');
  return capP ? captionFormat(sec, capP, t.start, 'TABLE') : null;
}

/**
 * 개체(objStart 에서 시작하는 표·그림)의 캡션 문단 capP 꼴 — 그 문단에 numType 자동 번호(hp:autoNum)가 있을 때만:
 * { open, subList, prefix(번호 앞 글), suffix(번호 뒤 '] '·'. ' 같은 구두점·빈칸), autoNum(요소), para({paraPr, styleId, charPr}) } | null
 */
function captionFormat(sec, capP, objStart, numType) {
  const pxml = sec.xml.slice(capP.start, capP.end);
  const m = new RegExp(`<hp:ctrl>\\s*(<hp:autoNum\\b[^>]*\\bnumType="${numType}"[^>]*>[\\s\\S]*?<\\/hp:autoNum>)\\s*<\\/hp:ctrl>`).exec(pxml);
  if (!m) return null;
  const textOf = (s) => decodeEntities([...s.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((x) => x[1].replace(/<[^>]*>/g, '')).join(''));
  const prefix = textOf(pxml.slice(0, m.index));
  if (prefix.length > 12) return null; // 번호 앞에 제목 글이 있는 꼴은 따르지 않는다
  const suffix = (/^[\])>〉》】）.:：\s]*/.exec(textOf(pxml.slice(m.index + m[0].length))) || [''])[0];
  const openAt = sec.xml.lastIndexOf('<hp:caption', capP.start); const subAt = sec.xml.lastIndexOf('<hp:subList', capP.start);
  if (openAt < objStart || subAt < openAt) return null;
  const tag = (at) => sec.xml.slice(at, sec.xml.indexOf('>', at) + 1);
  const ctrlAt = capP.start + m.index;
  const run = capP.runs.find((x) => x.start < ctrlAt && ctrlAt < x.end);
  return {
    open: tag(openAt), subList: tag(subAt), prefix, suffix, autoNum: m[1],
    para: { paraPr: attrOf(sec.xml, capP, 'paraPrIDRef'), styleId: attrOf(sec.xml, capP, 'styleIDRef'), charPr: run ? run.charPr : textRunCharPr(capP) },
  };
}

// ───────── 문서 차이(변경 요청 덩어리) ─────────

/**
 * 변경 요청의 문단 단위 차이 하나(V3_SPEC §3.1 Hunk).
 * @typedef {object} Hunk
 * @property {string} hid 'h' + 짧은 해시(type, ref 또는 afterRef, newText) — 다시 계산해도 같은 덩어리는 같은 값.
 *   새 글이 바뀌면 hid 도 바뀐다(일부러 — 웹 editor.js draftSig 가 hid 목록으로 다른 창의 저장을 알아챈다). 같은 자리의 덩어리를
 *   이어 보는 일은 자리 열쇠(종류 + 기준 자리 + 차례 — 서버 crs.js _rethread·웹 crs.js hunkKeys)가 맡는다
 * @property {'replace'|'insert'|'delete'|'format'|'object'} type  object = 그림 속성·조판 부호 변경(글은 그대로 — objectSummary·baseObjectPrint·newObjectPrint·headRef)
 * @property {string|null} ref replace·delete: 기준 문서 문단 ref(표 칸 등은 중첩 ref). insert: 보여 줄 자리 = afterRef(문서 맨 앞이면 첫 문단)
 * @property {string|null} [afterRef] insert 만: 이 기준 본문 문단 뒤에 들어간다(문서 맨 앞이면 null)
 * @property {string} baseText 기준 최종본 글(insert 는 '')
 * @property {string} newText 수정본 글(delete 는 '')
 * @property {{table: string, row: number, col: number}|null} cell 표 칸 문단이면 칸(table = 기준 문서 표 key), 아니면 null
 * @property {true} [structure] 이 문단의 중첩 구조(표 행·열·칸 등)가 바뀌어 칸 글(전부 또는 일부)은 비교하지 않았다(unsupported 에도 있음)
 */

/**
 * 두 문서(기준 base ↔ 수정본 head)의 본문 차이 덩어리 — 변경 요청 계산(V3_SPEC §3.1·§3.2·§4.4).
 * 글은 모두 최종본(변경 추적을 수락한 글), ref 는 baseDoc 기준. 본문 문단은 구역마다 planBody(글 + 종류 + 구조)로 정렬한다
 * (구역 수가 다르면 마지막 공통 구역부터 끝까지를 한 목록으로 정렬하고 unsupported 'format' 으로 알린다).
 *  - 짝지어진 문단: 글이 다르면 replace. 중첩 문단(표 칸·캡션·글상자 등) 구조(sig 목록)가 같으면 글이 다른 중첩 문단마다 replace
 *    (표 칸이면 cell). 구조가 다르면 표 수가 같고 칸 묶음(표 순번·행·열 — nestedGroups)의 차례가 같을 때만 칸마다 비교한다: 모양이 같은 칸은
 *    문단마다, 칸 문단 수만 달라진 글 칸(칸 안에서 Enter 로 문단을 나눔·Backspace 로 합침 — 칸 안에 표·개체 없음)은 칸 문단 수를 그대로 두고
 *    글을 줄바꿈('\n' = <hp:lineBreak/>)으로 접은 replace(foldCell — 표 구조는 반영하지 않으므로 글이 사라지지 않게). 그렇게 다 비교하지 못하면
 *    (격자·표 수·칸 차례가 다름, 칸 안의 표·개체·캡션 문단 수가 바뀜) 못 한 칸 글은 비교하지 않고 unsupported 'table-structure'
 *    (본문 replace 가 있으면 structure: true). 접어서 모두 반영한 문단은 table-structure 를 알리지 않는다.
 *    그림·개체 요소가 다르면 unsupported 'object'. 짝에는 같은 자리에서 표·그림만 생기거나 없어진 글 없는 문단(빈 줄 ↔ 표·개체),
 *    구조(sig)가 같은 표 문단 ↔ 글 문단(표만 있던 문단에 글을 씀)도 있다(planBody).
 *  - 짝 없는 새 문단: insert(afterRef = 바로 앞 기준 본문 문단, 문서 맨 앞이면 null). 짝 없는 옛 문단: delete.
 *    글 없는 표·개체 문단의 추가·삭제는 덩어리를 만들지 않고 unsupported 로만 알린다(표 구조·개체는 반영하지 않는다).
 *  - 같은 글의 서식 변경은 format 덩어리. shape ID 대신 참조된 실제 정의를 비교한다. 쪽·단 나누기(<hp:p pageBreak/columnBreak>)도 서식으로
 *    본다(지문·formatting·copyFormattingFrom — 요약 '쪽 나누기 넣음' 등).
 *  - 짝지은 문단(본문·중첩)이 직접 가진 그림의 속성(크기·배치·여백·자르기 등 — 그림 수·파일 차례가 같을 때)이나 조판 부호(자동 번호·
 *    새 번호로 시작·감추기·책갈피 등)가 바뀌면 object 덩어리(objectSummary, 반영 = copyObjectsFrom). 글 덩어리와 같은 문단에 함께 생길 수 있다.
 *    글 교체는 기존 혼합 서식의 투영 결과와 다른 경우에만 formatting=true로 표시한다.
 * @param {HwpxDoc|Uint8Array|ArrayBuffer} baseDoc 기준 문서(HwpxDoc 또는 HWPX 바이트)
 * @param {HwpxDoc|Uint8Array|ArrayBuffer} headDoc 수정본(HwpxDoc 또는 HWPX 바이트)
 * @param {{ anchorFirst?: boolean }} [opts] anchorFirst = 구역 첫 문단이 짝 없이 지워질 정렬이면 새 첫 문단과 짝(실시간 밀어 넣기 — planBodyAnchored)
 * @returns {Promise<{ hunks: Hunk[], unsupported: Array<{ ref: string|null, what: 'table-structure'|'object'|'format', detail: string }> }>}
 */
export async function diffDocs(baseDoc, headDoc, { anchorFirst = false, yieldEvery = 0 } = {}) {
  const base = baseDoc instanceof HwpxDoc ? baseDoc : await HwpxDoc.load(baseDoc);
  const head = (headDoc instanceof HwpxDoc ? headDoc : await HwpxDoc.load(headDoc)).inFormattingUnitsOf(base);
  // [hwpx-cowork] yieldEvery(ms): 견주는 동안 그만큼마다 이벤트 루프에 차례를 내준다(서버가 다른 요청·생존 신호를 처리하게 — 2026-11-10:
  // 글상자 4천여 개 문서의 밀어 넣기 한 번이 1초 넘게 서버를 막았다). 두 문서를 그사이 아무도 고치지 않을 때만(문서 큐 안 · 사본) 준다
  const slice = yieldEvery > 0 ? timeSlicer(yieldEvery) : null;
  // [hwpx-cowork] 구역 수가 다르면(구역을 넘는 지우기로 합친 구역·구역 나누기를 실은 붙여넣기 — docs/SECTIONS.md) 두 문서를 구역 0 하나로
  // 이어(사본 — 구역 나누기는 파일 안 secPr 조판 부호로 남는다) 견준다: 구역 합치기는 구역 나누기 문단을 합치거나 지운 것, 나누기는 secPr 를
  // 넣은 것(object 덩어리)으로 나온다. 덩어리 ref·headRef 는 이은 문서 번호다 → sections = { base, head }(원래 구역 크기), flatBase·flatHead
  // (이은 사본 — 적용·서식 옮기기에 쓴다). 구역별 주소로 되돌리려면 realSectionHunks
  if (base.sections.length !== head.sections.length) {
    // 사본은 이 함수만 쓰므로 사본을 만든 뒤에는 나눠 돌아도 된다(yieldEvery 가 없어도 40ms 마다)
    const pause = slice || timeSlicer(40);
    const flatBase = await base.clone(); await pause(); const flatHead = await head.clone(); await pause();
    const sb = flatBase.flattenSections(); await pause(); const sh = flatHead.flattenSections(); await pause();
    return { ...(await diffDocs(flatBase, flatHead, { anchorFirst, yieldEvery: yieldEvery || 40 })), sections: { base: sb, head: sh }, flatBase, flatHead };
  }
  const B = base.sections.map((sec) => sec.bodyParas.map((p) => base._bodyInfo(sec, p)));
  const H = head.sections.map((sec) => sec.bodyParas.map((p) => head._bodyInfo(sec, p)));
  const allB = B.flat();
  const firstRef = allB.length ? allB[0].ref : null; const lastRef = allB.length ? allB[allB.length - 1].ref : null;
  const hunks = []; const unsupported = [];
  // 서식 변경 문단마다 전체 문단 목록을 다시 만들면 문서 크기에 따라 제곱으로 늘어난다.
  // diff는 문서를 수정하지 않으므로 첫 서식 덩어리에서 한 번만 조회해 재사용한다.
  let baseParagraphs;
  const baseCell = ref => {
    baseParagraphs ??= new Map(base.paragraphs().map(p => [p.ref, p.cell]));
    return baseParagraphs.get(ref) ?? null;
  };
  const warn = (ref, what, detail) => unsupported.push({ ref, what, detail });
  // 구역은 번호끼리 맞춘다(구역 수가 다르면 위에서 이어 붙여 견줬다)
  const groups = B.map((b, k) => [b, H[k]]);
  // 추가·삭제한 글 문단에 딸린 표·중첩 문단·개체(글과 제 그림·캡션만 반영된다 — 그림은 copyObjectsFrom 이 옮긴다)
  const extras = (x, ref, verb) => {
    if (x.otherTables || x.nested.some((n) => n.cap == null && n.tbl == null && n.shp == null && n.hf == null)) warn(ref, 'table-structure', `${verb} 문단의 중첩 문단(글상자 등)은 반영되지 않습니다`);
    if (x.otherObjects.length) warn(ref, 'object', `${verb} 문단의 개체(그림 말고) ${x.otherObjects.length}개는 반영되지 않습니다`);
  };
  const formatInfo = (bRef, hRef) => ({
    headRef: hRef,
    baseFormatFingerprint: bRef ? base.formattingFingerprint(bRef) : null,
    newFormatFingerprint: head.formattingFingerprint(hRef),
    formatting: bRef ? formattingChanged(base, bRef, head, hRef) : true,
  });
  const replacement = (b, h, cell = null) => ({ hid: '', type: 'replace', ref: b.ref, baseText: b.text, newText: h.text, cell, ...formatInfo(b.ref, h.ref) });
  // 메모/개체 XML과 무관하게 문단·스타일·글자 정의를 비교한다.
  const format = (bRef, hRef) => {
    const info = formatInfo(bRef, hRef);
    if (info.baseFormatFingerprint !== info.newFormatFingerprint) {
      const d = [...breakChangeLabels(base, bRef, head, hRef), ...(formatDiff(base, bRef, head, hRef) || [])];
      hunks.push({ hid: '', type: 'format', ref: bRef, baseText: base.text(bRef), newText: head.text(hRef), cell: baseCell(bRef), ...info, formatting: true, formatSummary: d.length ? d.join('·') : '문단모양·스타일' });
    }
  };
  // 그림 속성(크기·배치·여백 등)·조판 부호(자동 번호·새 번호 등)가 바뀐 문단 → 'object' 덩어리(글 덩어리와 따로 — 반영은 copyObjectsFrom)
  const objects = (b, h, cell = null) => {
    const ch = objectChange(base, b.ref, head, h.ref);
    if (ch) hunks.push({ hid: '', type: 'object', ref: b.ref, headRef: h.ref, baseText: b.text, newText: h.text, cell, objectSummary: ch.notes.join(' · '), baseObjectPrint: ch.basePrint, newObjectPrint: ch.newPrint, objectPrintVersion: OBJECT_PRINT_VERSION });
  };
  // 짝지은 중첩 문단 하나: 글이 다르면 replace, 같으면 글자 모양만 비교
  const nestedPair = (n, x) => {
    if (n.text !== x.text) hunks.push(replacement(n, x, n.cell));
    else format(n.ref, x.ref);
    objects(n, x, n.cell);
  };
  /**
   * 칸 문단 수가 달라진 글 칸 하나(bs·hs = 기준·수정본의 그 칸 문단, 문서 순서): 칸 문단 수는 그대로 두고 글만 접는다(V4 §2.2 — 표 구조는
   * 반영하지 않으므로 Enter 로 나눈 칸의 글이 통째로 사라지지 않게). 수정본 문단마다 그 글을 받을 기준 문단(owner)은 engine/diff.js
   * foldOwners(빈 줄 아닌 같은 글은 그대로 짝 · 틈 앞뒤 빈 줄끼리 짝 · 바뀐 틈은 글자 단위로 맞춰 첫 글자가 맞는 기준 문단 · 새 문단만 든 틈은
   * 바로 앞 문단(빈 줄만이면 바로 뒤 문단) — 플러그인 맞추기도 같은 함수로 편집기 칸을 접는다). 기준 문단의 새 글 = 받은 수정본 문단 글을 차례로
   * '\n'(엔진은 <hp:lineBreak/> 로 쓴다)으로 이은 것,
   * 받은 것이 없는 기준 문단은 글을 비운다(문단은 남음). 주인은 문서 차례대로라 기준 문단들의 새 글을 차례로 '\n' 으로 이으면(비운 문단 빼고)
   * 수정본 칸 글(문단마다 '\n')과 같다 — 글 차례 그대로. 새 글이 기준과 같은 문단은 덩어리가 없다(수정본 한 문단과 짝이면 글자 모양만 비교)
   */
  const foldCell = (bs, hs) => {
    const owner = foldOwners(bs.map((n) => n.text), hs.map((n) => n.text));
    const parts = bs.map(() => []);
    hs.forEach((x, j) => parts[owner[j]].push(x));
    bs.forEach((n, i) => {
      const t = parts[i].map((x) => x.text).join('\n');
      if (n.text !== t) hunks.push(parts[i].length === 1 ? replacement(n, parts[i][0], n.cell) : { hid: '', type: 'replace', ref: n.ref, baseText: n.text, newText: t, cell: n.cell });
      else if (parts[i].length === 1) format(n.ref, parts[i][0].ref);
    });
  };
  /**
   * 중첩 구조(sig 목록)가 다른 짝 문단(표 수는 같음)의 칸 글. 칸 묶음(nestedGroups)의 열쇠 차례가 같을 때만(표 격자·칸 차례 그대로):
   * 모양이 같은 묶음은 문단마다, 칸 문단 수만 다른 글 칸(양쪽 다 plain — 칸 안에 표·개체·더 깊은 문단 없음)은 foldCell.
   * → 'all'(차이를 모두 덩어리로 냈다) | 'some'(못 낸 묶음이 있다 — 칸 안 표·개체가 바뀐 칸, 칸이 아닌 것) | 'none'(격자·칸 차례가 달라 칸 글을 비교하지 않음)
   */
  const foldNested = (bn, hn) => {
    const BG = nestedGroups(bn); const HG = nestedGroups(hn);
    if (BG.length !== HG.length || BG.some((g, k) => g.key !== HG[k].key)) return 'none';
    let all = true;
    BG.forEach((bg, k) => {
      const hg = HG[k];
      if (bg.items.length === hg.items.length && bg.items.every((n, i) => n.sig === hg.items[i].sig)) { bg.items.forEach((n, i) => nestedPair(n, hg.items[i])); return; }
      if (bg.cell && bg.plain && hg.plain) foldCell(bg.items, hg.items); else all = false;
    });
    return all ? 'all' : 'some';
  };
  const paired = (b, h) => {
    let body = null;
    if (b.text !== h.text) { body = replacement(b, h); hunks.push(body); }
    else format(b.ref, h.ref);
    // 이 문단이 직접 가진 그림의 캡션(중첩 문단 cap)은 그림끼리(파일 열쇠 차례) 짝지어 본다 — 그림을 넣고 빼거나 바꾸면 캡션 문단 수가 달라져도
    // 나머지 중첩(표 칸 등)은 그대로 비교된다. 넣고 뺀 그림의 캡션은 그림과 함께 옮겨진다(objects → copyObjectsFrom)
    if (b.nested.some((n) => n.cap != null) || h.nested.some((n) => n.cap != null)) {
      const pairs = keyLcs(base._objectInfo(b.ref).pics.map((x) => x.key), head._objectInfo(h.ref).pics.map((x) => x.key));
      for (const [i, j] of pairs) {
        const bc = b.nested.filter((n) => n.cap === i); const hc = h.nested.filter((n) => n.cap === j);
        if (bc.length === hc.length && bc.every((n, k) => n.sig === hc[k].sig)) bc.forEach((n, k) => nestedPair(n, hc[k]));
        else warn(b.ref, 'object', `그림 캡션 문단 수가 바뀌어(${bc.length} → ${hc.length}) 캡션 글은 반영되지 않습니다`);
      }
    }
    // 이 문단이 직접 가진 표: 뼈대가 바뀐 표(크기·줄·칸)·지운 표·넣은 표는 표째 옮긴다(objects → copyObjectsFrom) — 그 표의 칸 글은 따로 비교하지 않는다.
    // 뼈대가 같은 표만 칸 글을 칸마다 비교한다(칸 안 Enter 는 아래 접기)
    const skipB = new Set(); const skipH = new Set();
    if (b.nested.some((n) => n.tbl != null) || h.nested.some((n) => n.tbl != null)) {
      const tb = base._objectInfo(b.ref).tables; const th = head._objectInfo(h.ref).tables;
      const tp = pairTables(tb, th);
      for (const [i, j] of tp.pairs) if (tb[i].print !== th[j].print) { skipB.add(i); skipH.add(j); }
      tp.removed.forEach((i) => skipB.add(i)); tp.added.forEach((j) => skipH.add(j));
    }
    // [hwpx-cowork] 이 문단이 직접 가진 도형: 지운·넣은 도형과 통째로 바꿀 도형(요소 짜임이 달라 고칠 수 없음)의 글상자 문단은 도형째 옮긴다
    // (objects → copyObjectsFrom). 고칠 수 있는 짝(옮김·크기 등)의 글상자 문단은 그대로 문단마다 비교한다
    const skipSB = new Set(); const skipSH = new Set();
    if (b.nested.some((n) => n.shp != null) || h.nested.some((n) => n.shp != null)) {
      const sb = base._objectInfo(b.ref).shapes; const sh = head._objectInfo(h.ref).shapes;
      const sp = pairShapes(sb, sh);
      for (const [i, j] of sp.pairs) if (sb[i].print !== sh[j].print && !sb[i].props.foreign && patchShape(sb[i].xml, sh[j].xml) == null) { skipSB.add(i); skipSH.add(j); }
      sp.removed.forEach((i) => skipSB.add(i)); sp.added.forEach((j) => skipSH.add(j));
    }
    // [hwpx-cowork] 머리말·꼬리말이 옮겨 오거나 간 짝(머리말 줄을 앞 줄로 합침)은 그 안 문단을 견주지 않는다 — 서버가 머리말째 옮긴다(live parkHeaderFooters)
    const hfSame = (b.hfKeys || []).join('|') === (h.hfKeys || []).join('|');
    const bn = b.nested.filter((n) => n.cap == null && !(n.tbl != null && skipB.has(n.tbl)) && !(n.shp != null && skipSB.has(n.shp)) && (hfSame || n.hf == null));
    const hn = h.nested.filter((n) => n.cap == null && !(n.tbl != null && skipH.has(n.tbl)) && !(n.shp != null && skipSH.has(n.shp)) && (hfSame || n.hf == null));
    const sameShape = bn.length === hn.length && bn.every((n, k) => n.sig === hn[k].sig);
    if (sameShape) bn.forEach((n, k) => nestedPair(n, hn[k]));
    const fold = sameShape ? 'all' : b.otherTables === h.otherTables ? foldNested(bn, hn) : 'none';
    if (fold !== 'all' || b.otherTables !== h.otherTables) {
      if (body) body.structure = true;
      warn(b.ref, 'table-structure', b.otherTables !== h.otherTables
        ? `글상자 등 안의 표 ${b.otherTables}개 → ${h.otherTables}개 — 반영되지 않습니다`
        : fold === 'some'
          ? `표 칸 안의 표·개체 등 중첩 구조가 바뀌어(중첩 문단 ${bn.length} → ${hn.length}) 그 칸 글은 반영되지 않습니다`
          : `표 행·열·칸 등 중첩 구조가 바뀌어(중첩 문단 ${bn.length} → ${hn.length}) 칸 글은 반영되지 않습니다`);
    }
    if (b.otherObjects.join('|') !== h.otherObjects.join('|')) {
      warn(b.ref, 'object', b.otherObjects.length !== h.otherObjects.length ? `개체(그림 말고) ${b.otherObjects.length}개 → ${h.otherObjects.length}개 — 반영되지 않습니다` : '개체 종류가 바뀜 — 반영되지 않습니다');
    }
    objects(b, h);
  };
  let prevRef = null; // 앞 묶음의 마지막 기준 본문 문단(기준 구역이 비었을 때 넣은 문단의 자리)
  for (const [bs, hs] of groups) {
    // [hwpx-cowork] 실시간 밀어 넣기(anchorFirst)는 구역 첫 문단끼리 짝(지울 수 없는 문단 — planBodyAnchored). 변경 요청 다시 맞추기는 종전 정렬
    const { pairs, plan } = (anchorFirst ? planBodyAnchored : planBody)(bs, hs);
    // 그대로인 짝(글·종류·구조·중첩 글이 같아 plan 에 없는 짝)도 paired 로 본다 — 덩어리는 생기지 않고 글자 모양만 비교된다.
    // 문서 순서를 지키려고 plan 단계 사이사이에 끼워 처리한다.
    const inPlan = new Set();
    for (const step of plan) for (const o of step.ops) if (o.op !== 'ins') inPlan.add(o.i);
    const same = pairs.filter(([i]) => !inPlan.has(i));
    let si = 0;
    const sameUpTo = async (at) => { for (; si < same.length && same[si][0] < at; si++) { paired(bs[same[si][0]], hs[same[si][1]]); if (slice) await slice(); } };
    for (const step of plan) {
      await sameUpTo(step.at);
      if (slice) await slice();
      let last = step.at - 1; // 새 문단이 들어갈 자리 = 앞선 짝·삭제 문단(없으면 덩어리 바로 앞 문단) 뒤 — mergeBodyTexts 와 같은 규칙
      for (const o of step.ops) {
        if (o.op === 'ins') {
          // [hwpx-cowork] 구역 첫머리에 넣은 문단은 afterRef 없음(그 구역 맨 앞 — 반영은 insertParagraphAfter(-1, atStart)로 구역 나누기를 새 첫
          // 문단에 옮긴다). 종전에는 앞 구역 마지막 문단 뒤(prevRef)로 보내 다른 구역에 들어갔다
          const h = hs[o.j]; const afterRef = last >= 0 ? bs[last].ref : null; const at = afterRef ?? bs[0]?.ref ?? prevRef ?? firstRef;
          if ((h.kind === 'table' || h.kind === 'object') && !head.plainOrObjectParagraph(h.ref)) warn(at, h.kind === 'table' ? 'table-structure' : 'object', '글상자·도형이 든 문단 추가는 반영되지 않습니다(그림·표 문단은 반영됨)');
          else {
            // 글 문단·그림 문단: 문단을 넣고(글·서식) 그 문단의 그림·부호를 옮긴다(objects — 반영 쪽이 headRef 로 copyObjectsFrom)
            // 맨 앞에 문단을 넣으면 서버가 기존 구역 정의를 새 첫 문단으로 옮긴다.
            // 붙여넣기가 그 설정까지 바꿨으면 옮긴 자리에서 갱신한다. 첫 문단의
            // secPr는 일반 개체 지문에서 제외되므로 그대로 두면 용지·쪽 테두리가 사라진다.
            let op = head.objectPrint(h.ref);
            if (o.j === 0 && bs.length) {
              const oldSection = base._objectInfo(bs[0].ref).codes.find(c => c.secDef);
              const newSection = head._objectInfo(h.ref).codes.find(c => c.secDef);
              if (oldSection && newSection && oldSection.key !== newSection.key) op = head.objectPrintFull(h.ref);
            }
            hunks.push({ hid: '', type: 'insert', ref: at, afterRef, baseText: '', newText: h.text, cell: null, ...formatInfo(null, h.ref), ...(op ? { objects: true, newObjectPrint: op, objectPrintVersion: OBJECT_PRINT_VERSION } : {}) });
            extras(h, at, '추가한');
          }
          continue;
        }
        const b = bs[o.i]; last = o.i;
        if (o.op === 'pair') { paired(b, hs[o.j]); if (slice) await slice(); continue; }
        if ((b.kind === 'table' || b.kind === 'object') && !base.plainOrObjectParagraph(b.ref)) warn(b.ref, b.kind === 'table' ? 'table-structure' : 'object', '글상자·도형이 든 문단 삭제는 반영되지 않습니다(그림·표 문단은 반영됨)');
        else {
          const oi = base.plainOrObjectParagraph(b.ref) ? base._objectInfo(b.ref) : null;
          const obj = !!oi && (oi.pics.length > 0 || oi.tables.length > 0 || oi.shapes.length > 0);
          hunks.push({ hid: '', type: 'delete', ref: b.ref, baseText: b.text, newText: '', cell: null, ...(obj ? { objects: true } : {}) });
          extras(b, b.ref, '지운');
        }
      }
    }
    await sameUpTo(Infinity);
    if (bs.length) prevRef = bs[bs.length - 1].ref;
  }
  hunks.push(...masterTextChanges(base, head));
  // hid: 같은 열쇠(종류·자리·새 글)가 또 나오면 차례 번호를 더한다(예: 같은 문단 뒤에 빈 문단 둘).
  // 새 글을 열쇠에 넣는 까닭은 Hunk typedef 설명(자리만으로 셈하면 같은 자리 다른 글의 수정본을 가려내지 못한다)
  const seen = new Map();
  for (const h of hunks) {
    const key = `${h.type}${h.master ? JSON.stringify(h.master) : ''}\u0001${h.type === 'insert' ? (h.afterRef ?? '') : h.ref}\u0001${h.newText}${h.newFormatFingerprint ? `\u0001${h.newFormatFingerprint}` : ''}${h.newObjectPrint ? `\u0001${h.newObjectPrint}` : ''}`;
    const n = seen.get(key) || 0; seen.set(key, n + 1);
    h.hid = `h${shortHash(n ? `${key}\u0001${n}` : key)}`;
  }
  return { hunks, unsupported };
}

/**
 * [hwpx-cowork] 이은 문서 주소(s0/pN…) → 구역별 주소. sizes = 구역마다 본문 문단 수(flattenSections 가 돌려준 것). 넘으면 그대로
 */
export function unflattenRef(ref, sizes) {
  const m = /^s0\/p(\d+)(.*)$/.exec(String(ref ?? ''));
  if (!m || !Array.isArray(sizes) || sizes.length < 2) return ref;
  let i = Number(m[1]);
  for (let s = 0; s < sizes.length; s++) {
    if (i < sizes[s]) return `s${s}/p${i}${m[2]}`;
    i -= sizes[s];
  }
  return ref;
}

/** [hwpx-cowork] 구역별 주소 → 이은 문서 주소(unflattenRef 의 반대) */
export function flattenRef(ref, sizes) {
  const m = /^s(\d+)\/p(\d+)(.*)$/.exec(String(ref ?? ''));
  if (!m || !Array.isArray(sizes)) return ref;
  const s = Number(m[1]);
  if (s >= sizes.length) return ref;
  return `s0/p${sizes.slice(0, s).reduce((a, b) => a + b, 0) + Number(m[2])}${m[3]}`;
}

/**
 * [hwpx-cowork] 구역 수가 다른 두 문서의 diffDocs 결과(이은 문서 주소)를 구역별 주소로 되돌린다 — 기준 ref·afterRef 는 기준 구역으로, headRef 는
 * 수정본 구역으로. 구역 합치기·나누기 자체는 구역별로는 나타낼 수 없어(구역 첫 문단 지우기·파일 안 구역 나누기 넣기로 보인다) unsupported 에 알린다
 * (변경 요청 반영 — 실시간 밀어 넣기는 이은 주소 그대로 적용하고 구역 파일까지 맞춘다, server/live.js)
 */
export function realSectionHunks(result) {
  if (!result?.sections) return result;
  const { base, head } = result.sections;
  const hunks = result.hunks.map((h) => ({
    ...h,
    ref: unflattenRef(h.ref, base),
    ...(h.afterRef != null ? { afterRef: unflattenRef(h.afterRef, base) } : {}),
    ...(h.headRef != null ? { headRef: unflattenRef(h.headRef, head) } : {}),
  }));
  const unsupported = result.unsupported.map((u) => ({ ...u, ref: unflattenRef(u.ref, base) }));
  unsupported.push({ ref: hunks[0]?.ref ?? null, what: 'format', detail: `구역 수가 바뀌었습니다(기준 ${base.length}, 수정본 ${head.length}) — 변경 요청은 글·서식만 반영하고 구역 합치기·나누기는 반영하지 않습니다` });
  return { hunks, unsupported };
}

// ───────── 내부 도우미 ─────────

/** mergeBodyTexts 입력 항목 → {text, nested|null} */
function normEntry(e, extra) {
  const ex = Array.isArray(extra) ? extra : null;
  if (e != null && typeof e === 'object') return { text: String(e.text ?? ''), nested: Array.isArray(e.nested) ? e.nested : ex };
  return { text: String(e ?? ''), nested: ex };
}

// 그림·도형 등 개체 요소 목록(OBJECT_TAGS)·개체 anchor 이름(anchorTag — 한/글 차트 switch 는 'hp:chart')은 engine/section.js 에 있다(파서가 변경 추적 개체를 가린다)

/**
 * 문단이 직접 가진 표(hp:tbl)·개체 요소 이름(문서 순서). [hwpx-cowork] view: 기본 최종본 — 변경 추적으로 지운 개체는 빼고('original' 은 넣은 개체를 뺀다,
 * 'all' 은 모두)
 */
function objectTags(p, view = 'final') { return p.anchors.filter((a) => isObjectAnchor(a) && Section.visibleObject(a, view)).map(anchorTag); }

/** [hwpx-cowork] 문단이 run 에 직접 가진 도형 개체 anchor(문서 순서 — engine/shapes.js SHAPE_TAGS) */
/**
 * [hwpx-cowork] zorder 가 없는 메모 시작(편집기·예전 내보내기가 쓴 메모)에 zorder(= 그 메모의 Number)·metaTag 를 단다 — zorder 가 없으면 한/글이
 * 저장할 때 메모 끝을 모두 버려 메모가 문단 끝까지 늘어나고, 다시 열면 그 끝 부호를 지울 수도 없다(한/글 2022 실측 2026-10-30, 메모 22개)
 */
function memoZorderFix(xml) {
  if (!xml.includes('type="MEMO"') || !/<hp:fieldBegin\b(?![^>]*\szorder=)[^>]*\stype="MEMO"/.test(xml)) return xml;
  let seq = 0;
  return xml.replace(/<hp:fieldBegin\b[^>]*\stype="MEMO"[^>]*>/g, (tag, off) => {
    seq++;
    if (/\szorder="/.test(tag)) return tag;
    const end = xml.indexOf('</hp:parameters>', off);
    const num = end > 0 ? /<hp:integerParam name="Number">(\d+)<\/hp:integerParam>/.exec(xml.slice(off, end))?.[1] : null;
    let out = /\sfieldid="/.test(tag) ? tag.replace(/\sfieldid="/, ` zorder="${num || seq}" fieldid="`) : tag.replace(/(\/?)>$/, ` zorder="${num || seq}"$1>`);
    if (!/\smetaTag="/.test(out)) out = out.replace(/(\/?)>$/, ' metaTag=""$1>');
    return out;
  });
}

/** [hwpx-cowork] 문단이 직접 가진 머리말·꼬리말 부호(hp:ctrl — 안의 문단째) */
function headerFooterAnchors(p) { return p.anchors.filter((a) => a.kind === 'ctrl' && a.name === 'hp:ctrl' && (a.inner === 'hp:header' || a.inner === 'hp:footer')); }
/** 머리말·꼬리말 열쇠(종류·적용 쪽) */
function headerFooterKey(a) { return `${a.inner}|${a.innerAttrs?.get('applyPageType') ?? ''}`; }

function ownShapeAnchors(p, view = 'final') { return p.anchors.filter((a) => a.kind === 'ctrl' && SHAPE_TAGS.has(anchorTag(a)) && Section.visibleObject(a, view)); }
/** [hwpx-cowork] 개체 anchor 의 종류(개체 지우기 제안의 kinds): 표 'table' · 그림 'figure' · 차트 'chart' · 그 밖의 도형(글상자·선·묶음 …) 'shape' */
function objectKind(a) { return a.name === 'hp:tbl' ? 'table' : a.name === 'hp:pic' ? 'figure' : anchorTag(a) === 'hp:chart' ? 'chart' : 'shape'; }

// ───────── 글자 모양 비교(diffDocs 'format') ─────────

/** 비교하는 글자 모양 속성(이 순서로 열쇠를 만든다)과 이름표. 글꼴 간격 쓰기·커닝·글자 테두리(borderFill)는 보지 않는다 */
const FORMAT_PROPS = ['font', 'size', 'bold', 'italic', 'underline', 'strike', 'color', 'shade', 'script', 'ratio', 'spacing', 'relSz', 'offset', 'effect', 'mark'];
const FORMAT_LABELS = {
  font: '글꼴', size: '크기', bold: '굵게', italic: '기울임', underline: '밑줄', strike: '취소선', color: '글자색', shade: '음영',
  script: '위·아래 첨자', ratio: '장평', spacing: '자간', relSz: '상대 크기', offset: '글자 위치', effect: '외곽선·그림자·양각·음각', mark: '강조점',
};
const FONT_LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];

/** header charPr 블록 { attrs, body } → 비교용 속성(문자열 값, 기본값은 한글 기본과 같게 채움). fonts = 언어 → 글꼴 id → 이름 */
function charFormatProps(blk, fonts) {
  const at = (s, name) => (s == null ? undefined : new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(s)?.[1]);
  const el = (name) => new RegExp(`<hh:${name}\\b([^>]*?)\\/?>`).exec(blk.body)?.[1] ?? null;
  const has = (name) => new RegExp(`<hh:${name}\\b`).test(blk.body);
  const color = (c) => (c == null || c === '' ? '' : String(c).trim().toUpperCase());
  const perLang = (name, def) => { const e = el(name); return FONT_LANGS.map((l) => at(e, l) ?? def).join(','); };
  const fr = el('fontRef');
  const ul = el('underline'); const ulType = at(ul, 'type') || 'NONE';
  const so = el('strikeout'); const soShape = at(so, 'shape') || 'NONE';
  const ol = el('outline'); const olType = at(ol, 'type') || 'NONE';
  const sh = el('shadow'); const shType = at(sh, 'type') || 'NONE';
  return {
    font: FONT_LANGS.map((l) => { const id = at(fr, l); return id == null ? '' : (fonts.get(l.toUpperCase())?.get(id) ?? `#${id}`); }).join('|'),
    size: at(blk.attrs, 'height') ?? '1000',
    bold: has('bold') ? '1' : '',
    italic: has('italic') ? '1' : '',
    underline: ulType === 'NONE' ? '' : `${ulType}/${at(ul, 'shape') ?? ''}/${color(at(ul, 'color'))}`,
    strike: soShape === 'NONE' ? '' : `${soShape}/${color(at(so, 'color'))}`,
    color: color(at(blk.attrs, 'textColor')) || '#000000',
    shade: color(at(blk.attrs, 'shadeColor')) || 'NONE',
    script: has('supscript') ? 'sup' : (has('subscript') ? 'sub' : ''),
    ratio: perLang('ratio', '100'), spacing: perLang('spacing', '0'), relSz: perLang('relSz', '100'), offset: perLang('offset', '0'),
    effect: [olType !== 'NONE' ? `outline:${olType}` : '', shType !== 'NONE' ? `shadow:${shType}` : '', has('emboss') ? 'emboss' : '', has('engrave') ? 'engrave' : ''].filter(Boolean).join(','),
    mark: at(blk.attrs, 'symMark') ?? 'NONE',
  };
}

/**
 * 글이 같은 두 문단(문서 a 의 aRef, 문서 b 의 bRef)의 글자별 서식(최종본 글자) 비교.
 * → 바뀐 속성 이름표 목록(문서 순서가 아닌 FORMAT_PROPS 순서), 같거나 비교할 수 없으면 null
 */
function formatDiff(a, aRef, b, bRef) {
  let pa; let pb;
  try { pa = a.resolve(aRef).p; pb = b.resolve(bRef).p; } catch { return null; }
  const ca = Section.visibleChars(pa, 'final'); const cb = Section.visibleChars(pb, 'final');
  if (!ca.length || ca.length !== cb.length) return null;
  const fa = a._charFormats(); const fb = b._charFormats();
  let names = null;
  for (let i = 0; i < ca.length; i++) {
    const x = fa.get(ca[i].run?.charPr); const y = fb.get(cb[i].run?.charPr);
    if (x.key === y.key) continue;
    names = names || new Set();
    const before = names.size;
    for (const k of FORMAT_PROPS) if (x.props[k] !== y.props[k]) names.add(k);
    if (names.size === before && x.props.missing !== y.props.missing) names.add('missing');
  }
  if (!names) return null;
  return [...FORMAT_PROPS, 'missing'].filter((k) => names.has(k)).map((k) => FORMAT_LABELS[k] || '글자 모양');
}

/** 짧은 고정 해시(cyrb53 → 36진 10자리) — 덩어리 id·구조 표시용(암호용 아님) */
function shortHash(s) {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0').slice(-10);
}

/**
 * 본문 문단의 중첩 문단(_bodyInfo nested, 문서 순서)을 칸 묶음으로(diffDocs 칸 접기):
 *  - 1단 표 칸 문단: 칸마다 한 묶음 — 열쇠 = 그 문단 안 표 순번(표 key 의 '#t<k>' — ref 는 보지 않는다: 앞에 문단이 들어가면 번호가 밀린다)·행·열
 *  - 칸 안의 더 깊은 문단(칸 속 표·글상자 등 — sig 에 '>'): 그 칸 묶음에 넣고 그 칸은 plain 이 아니다
 *  - 그 밖(캡션·글상자 등 칸이 아닌 것): 문단마다 한 묶음(열쇠 = sig) — 문단 수가 다르면 열쇠 차례가 달라진다
 * plain = 그 칸 문단들이 표·개체 요소를 갖지 않고(objs) 더 깊은 문단도 없다(글만 든 칸).
 * → [{ key, top, cell: boolean, plain: boolean, items: nested[] }]
 */
function nestedGroups(nested) {
  const out = []; let cur = null;
  for (const n of nested) {
    const sig = String(n.sig ?? ''); const cut = sig.indexOf('>');
    const top = cut < 0 ? sig : sig.slice(0, cut);
    if (cut < 0 && n.cell) {
      const ord = /#t(\d+)$/.exec(String(n.cell.table ?? ''))?.[1] ?? '?';
      const key = `c:${ord}@${n.cell.row},${n.cell.col}`;
      if (!cur || cur.key !== key) { cur = { key, top, cell: true, plain: true, items: [] }; out.push(cur); }
      cur.items.push(n);
      if (n.objs) cur.plain = false;
      continue;
    }
    if (cut >= 0 && cur && cur.top === top) { cur.items.push(n); cur.plain = false; continue; }
    cur = { key: `x:${sig}`, top, cell: false, plain: false, items: [n] }; out.push(cur);
  }
  return out;
}

/** 옛 중첩 문단 목록과 새 목록의 구조가 같은가(수, 그리고 sig 가 있으면 sig 순서) */
function sameShape(have, want) {
  if (have.length !== want.length) return false;
  return want.every((w, k) => typeof w === 'string' || w?.sig == null || w.sig === have[k].sig);
}

/** '/n3/n1' 같은 꼬리를 숫자 순서로 비교 */
function cmpTail(a, b) {
  const x = a.split('/n').slice(1).map(Number); const y = b.split('/n').slice(1).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] == null) return -1; if (y[i] == null) return 1; if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}

/** 셀·캡션 글: 문자열로, XML 에 쓸 수 없는 제어 문자는 뺀다(탭·줄바꿈은 둔다) */
function cellText(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

/** 문단에서 글이 든 첫 run 의 글자 모양(없으면 첫 run) */
function textRunCharPr(p) {
  if (!p) return '0';
  const withText = p.chars.length ? p.chars[0].run : null;
  return (withText || p.runs[0])?.charPr ?? '0';
}

function captionStyle(h) { return h.style({ engName: 'Caption' }) || h.style({ name: '캡션' }) || null; }

function cpLen(s) { let n = 0; for (const _ of s) n++; return n; }
function cpToUnit(s, cp) { let i = 0; let n = 0; for (const ch of s) { if (n === cp) return i; i += ch.length; n++; } return i; }

function inlineXml(text) {
  return String(text).split(/\r?\n/).map((line) => escapeText(line).replace(/\t/g, '<hp:tab/>')).join('<hp:lineBreak/>');
}

function finalIndexAt(p, fullPos) { let n = 0; for (let i = 0; i < fullPos && i < p.chars.length; i++) if (!p.chars[i].del) n++; return n; }

function attrOf(xml, p, name) {
  // [hwpx-cowork] 나눔을 지워 이은 기록은 leader member 의 여는 태그(최종본 문단 속성 — engine/section.js setLeader)
  const at = p.members ? p.members[p.leader ?? 0].start : p.start;
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml.slice(at, Math.min(p.end, at + 400)));
  return m ? m[1] : '0';
}

/** 메모 필드 시작 컨트롤(anchor — 구역 xml 안 위치)의 매개변수 값 */
function memoParamAt(xml, anchor, name) {
  const seg = xml.slice(anchor.start, anchor.end);
  const m = new RegExp(`<hp:(?:string|integer)Param name="${name}">([^<]*)</hp:(?:string|integer)Param>`).exec(seg);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}

/**
 * 메모 스레드 열쇠 `s{구역}:f{fieldId}`(V3_SPEC §3.6 — 메모 fieldId 는 구역 안에서 유일하고 편집기 내보내기에도 그대로 남는다).
 * m = memos() 항목(key 가 있으면 같은 값) 또는 { ref|section, fieldId }. 구역·fieldId 를 모르면 null.
 */
export function memoKey(m) {
  if (!m || typeof m !== 'object') return null;
  const sec = m.section != null ? m.section : /^s(\d+)\//.exec(m.ref || '')?.[1];
  const fid = m.fieldId;
  if (sec == null || !Number.isFinite(Number(sec)) || fid == null || fid === '') return typeof m.key === 'string' && m.key ? m.key : null;
  return `s${Number(sec)}:f${fid}`;
}

/** 메모 범위 기본값·검사([start,end) 생략 시 문단 전체) → { fc, start, end } */
function memoRange(p, start, end) {
  const fc = Section.visibleChars(p, 'final');
  if (start == null) start = 0; if (end == null) end = fc.length;
  if (start < 0 || end > fc.length || start > end) throw new EngineError('RANGE', `범위가 문단 밖입니다 (0..${fc.length})`);
  return { fc, start, end };
}

/** 메모 본문 문단 XML(줄마다 한 문단, 메모 스타일) */
function memoBodyXml(style, text) {
  return String(text).split(/\r?\n/).map((line) => `<hp:p id="0" paraPrIDRef="${style.paraPr}" styleIDRef="${style.styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${style.charPr}"><hp:t>${escapeText(line)}</hp:t></hp:run></hp:p>`).join('');
}

/**
 * 메모 필드 시작·끝 컨트롤 XML(addMemo·addMemos 공용).
 * 한글 형식: Command 의 두 수 = Windows FILETIME(1601 년부터 100ns) 아래·위 32비트, CreateDateTime = 지역 시간 + 'Z'
 * (한글이 다시 저장한 파일로 확인: FILETIME 을 지역 시간으로 바꿔 'Z' 를 붙여 쓴다)
 */
function memoCtrlXml(style, { number, memoId, fieldId, fid, zorder, author, text, when }) {
  const { low: d1, high: d2 } = toFiletime(when);
  const iso = localIsoZ(when);
  const beginXml = `<hp:ctrl><hp:fieldBegin id="${fieldId}" type="MEMO" name="" editable="1" dirty="1" zorder="${zorder}" fieldid="${fid}" metaTag="">`
    + `<hp:parameters cnt="7" name=""><hp:integerParam name="Prop">0</hp:integerParam>`
    + `<hp:stringParam name="Command">MEMO/65535/${number}/${d1}/${d2}/${escapeText(author)}/\\;;</hp:stringParam>`
    + `<hp:stringParam name="ID">${escapeText(memoId)}</hp:stringParam><hp:integerParam name="Number">${number}</hp:integerParam>`
    + `<hp:stringParam name="Author">${escapeText(author)}</hp:stringParam><hp:stringParam name="MemoShapeIDRef">65535</hp:stringParam>`
    + `<hp:stringParam name="CreateDateTime">${iso}</hp:stringParam></hp:parameters>`
    + `<hp:subList ${SUBLIST_ATTRS}>${memoBodyXml(style, text)}</hp:subList></hp:fieldBegin></hp:ctrl>`;
  const endXml = `<hp:ctrl><hp:fieldEnd beginIDRef="${fieldId}" fieldid="${fid}"/></hp:ctrl>`;
  return { beginXml, endXml };
}

/**
 * 문단 p 의 최종본 [start,end)(memoRange)에 메모 시작·끝 컨트롤을 넣는 편집 목록(addMemo·addMemos 공용, 위치는 sec.xml 기준).
 * 메모 필드는 0폭 컨트롤이라 줄 나눔이 그대로다: 줄 정보(lineseg)는 지우지 않고 textpos 만 옮긴다
 * (지우면 rhwp 가 구역 전체를 다시 조판하며 떠 있는 표 자리가 어긋난다). 모르는 요소가 있으면 지운다.
 */
function memoEdits(sec, p, { fc, start, end }, beginXml, endXml) {
  const edits = []; let at = [];
  if (fc.length === 0) {
    // 빈 문단: run 안에 begin+end 를 나란히 둔다
    edits.push(emptyParagraphEdit(sec, p, '', beginXml + endXml));
  } else {
    const ciA = p.chars.indexOf(fc[Math.min(start, fc.length - 1)]);
    const ciB = p.chars.indexOf(fc[Math.max(end - 1, 0)]);
    // 끝 → 앞 순서로 넣는다(앞 편집이 뒤 위치를 흔들지 않도록 applyEdits 가 정렬하지만, 같은 위치면 순서가 중요)
    if (end > start) edits.push(ctrlPointAfter(p, ciB, endXml));
    else edits.push(ctrlPointBefore(p, ciA, endXml));
    edits.push(ctrlPointBefore(p, ciA, beginXml));
    at = [{ before: ciA }, end > start ? { after: ciB } : { before: ciA }];
  }
  if (!shiftLineseg(sec, p, { add: at }, edits)) dropLineseg(p, edits);
  return edits;
}

/**
 * addMemos 조각 나무에서 대상 cref(canonRef 꼴)의 마디 — 없으면 가는 길의 마디를 만든다. 찾지 못하면 null.
 * 마디 = { ref, xml(그 문단 XML 조각, 고친 것), mini(xml 을 구역처럼 읽은 Section — 꼭대기는 구역 자신 | null = 다시 읽어야 함),
 *         kids: Map(ref → 자식 마디), start·end(부모 xml 안 자리) }.
 * 자식 마디 = 마디에서 대상 쪽으로 내려가는 길에 처음 만나는 이번 목록의 대상(targets) — 그래서 형제 자식끼리는 겹치지 않는다.
 * 자식의 start·end 는 부모 xml 기준이고 부모 xml 은 자식이 있는 동안 바뀌지 않는다(자기 메모 전에 joinSlices 로 붙여 비운다).
 * 메모는 자기 문단의 자식 번호만 밀고 그 메모를 단 마디는 자식이 없으므로, 남은 자식 마디의 ref 는 차례로 단 문서에서도 같은 문단이다.
 */
function memoNode(top, cref, targets, secIndex) {
  let node = top;
  while (node.ref !== cref) {
    const tail = cref.slice(node.ref.length); // '/p3/n2'(꼭대기) 또는 '/n5/n2'
    let kidRef = cref;
    for (const m of tail.matchAll(/\/[pn]\d+/g)) {
      const r = node.ref + tail.slice(0, m.index + m[0].length);
      if (targets.has(r)) { kidRef = r; break; }
    }
    let kid = node.kids.get(kidRef);
    if (!kid) {
      if (!node.mini) node.mini = new Section(node.xml, secIndex);
      const p = node.mini.byRef(node.top ? kidRef : `s${secIndex}/p0${kidRef.slice(node.ref.length)}`);
      if (!p) return null;
      kid = { ref: kidRef, start: p.start, end: p.end, xml: node.xml.slice(p.start, p.end), mini: null, kids: new Map() };
      node.kids.set(kidRef, kid);
    }
    node = kid;
  }
  return node;
}

/** 마디 xml 에 자식 조각(그 자식의 자식부터 붙인 것)을 제자리에 붙인 XML — 앞에서부터 이어 붙인다. 자식 목록은 비운다 */
function joinSlices(node) {
  if (!node.kids.size) return node.xml;
  const kids = [...node.kids.values()].sort((a, b) => a.start - b.start);
  const parts = []; let at = 0;
  for (const k of kids) {
    if (k.start < at) throw new EngineError('EDIT_OVERLAP', '메모 조각이 겹칩니다');
    parts.push(node.xml.slice(at, k.start), joinSlices(k)); at = k.end;
  }
  parts.push(node.xml.slice(at));
  node.kids.clear();
  return parts.join('');
}

/** ref 를 숫자 그대로 다시 쓴 꼴(s0/p03 → s0/p3). 모양이 틀리면 null */
function canonRef(ref) {
  const m = /^s(\d+)\/p(\d+)((?:\/n\d+)*)$/.exec(typeof ref === 'string' ? ref : '');
  if (!m) return null;
  return `s${parseInt(m[1], 10)}/p${parseInt(m[2], 10)}${m[3].split('/n').slice(1).map((k) => `/n${parseInt(k, 10)}`).join('')}`;
}

const FT_EPOCH_MS = 11644473600000n; // 1601-01-01 → 1970-01-01
function toFiletime(when) {
  const ft = (BigInt(when.getTime()) + FT_EPOCH_MS) * 10000n;
  return { low: Number(ft & 0xffffffffn), high: Number(ft >> 32n) };
}
const pad2 = (n) => String(n).padStart(2, '0');
function localIsoZ(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}Z`; }

/** 메모 만든 시각(ISO, UTC). Command 의 FILETIME 이 기준, 예전 엔진(초 단위 epoch)·CreateDateTime 은 대체 */
export function memoCreated(command, cdt) {
  const m = /^MEMO\/\d+\/\d+\/(\d+)\/(\d+)\//.exec(command || '');
  const plausible = (ms) => ms > Date.UTC(2000, 0, 1) && ms < Date.UTC(2200, 0, 1);
  if (m) {
    const ms = Number(((BigInt(m[2]) << 32n) + BigInt(m[1])) / 10000n - FT_EPOCH_MS);
    if (plausible(ms)) return new Date(ms).toISOString();
    const old = Number(m[1]) * 1000; // 0.1 엔진: 첫 수 = epoch 초
    if (plausible(old)) return new Date(old).toISOString();
  }
  return cdt || null;
}

function uniqueMemoId(existing, number) {
  const ids = new Set(existing.map((m) => m.id));
  let id = `memo${number}`; let k = number;
  while (ids.has(id)) { k++; id = `memo${k}`; }
  return id;
}

function uniqueNumber(xml, attrName) {
  return uniqueNumberBy((n) => idTaken(xml, n, attrName) || idTaken(xml, n, 'beginIDRef'));
}

/**
 * [hwpx-cowork] xml 에 이름이 k 로 끝나는 속성(exact 면 이름이 꼭 k — ` k="v"`)의 값 v 가 있는가 — `xml.includes(\`${k}="${v}"\`)`
 * (exact 면 `includes(\` ${k}="${v}"\`)`)와 같은 답. 같은 xml 에 여러 번 물으면(개체 수백 개를 한 번에 옮기기 — 개체마다 id·instid 를 묻고
 * 겹치면 새 번호도 묻는다) 처음 몇 번만 글을 훑고 그다음은 id 꼴 속성 값 색인을 한 번 만들어 쓴다. 2026-11-10: 구역 XML 8.5MB 문서에서
 * 글상자 635개를 옮기는 밀어 넣기가 이 훑기로만 2.7초 동안 서버를 멈췄다
 */
/**
 * [hwpx-cowork] 도형 비교 속성·지문 글(shapeProps·shapePrintText)을 XML 글이 같으면 다시 세지 않는다 — 밀어 넣기 한 번에 같은 도형 XML 을
 * 기준 문서·보낸 문서·이은 사본·적용 뒤 문서에서 거듭 센다(2026-11-10: 글상자 4천여 개 문서에서 1초 넘게). 열쇠는 글 자체가 아니라 길이와
 * 해시 둘(구역 XML 을 잘라 낸 글을 열쇠로 붙들면 구역 XML 통째가 메모리에 남는다). 그림 파일·차트 부분을 가리키는 도형은 문서마다 열쇠가
 * 달라(binKey) 담지 않는다. 값은 읽기만 한다(여러 문서가 함께 쓴다)
 */
const SHAPE_MEMO_MAX = 50000;
const shapeMemo = new Map();
function shapePropsMemo(xml, binKey) {
  const docBound = xml.includes('binaryItemIDRef') || xml.includes('chartIDRef');
  if (docBound) { const props = shapeProps(xml, binKey); return { props, print: shapePrintText(props) }; }
  let h1 = 0x811c9dc5; let h2 = 5381;
  for (let i = 0; i < xml.length; i++) { const c = xml.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = (Math.imul(h2, 33) + c) | 0; }
  const key = `${xml.length}:${h1 >>> 0}:${h2 >>> 0}`;
  let hit = shapeMemo.get(key);
  if (!hit) {
    const props = shapeProps(xml, binKey);
    hit = { props, print: shapePrintText(props) };
    if (shapeMemo.size >= SHAPE_MEMO_MAX) shapeMemo.clear();
    shapeMemo.set(key, hit);
  }
  return hit;
}

/** [hwpx-cowork] ms 넘게 이어 돌았으면 이벤트 루프에 한 번 차례를 내주는 함수(setImmediate — 없으면 setTimeout 0) */
function timeSlicer(ms) {
  let mark = Date.now();
  const turn = () => new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
  return async () => { if (Date.now() - mark < ms) return; await turn(); mark = Date.now(); };
}

const ID_ATTR_RE = /\s((?:[A-Za-z_:][\w:.\-]*?)?(?:id|IDRef))="([^"]*)"/g;
let idScan = { xml: null, asked: 0, index: null };
function idTaken(xml, v, k, exact = false) {
  // 같은 글이면 같은 색인(대개 같은 문자열 — 길이가 다르면 바로 다르다고 본다)
  if (idScan.xml !== xml) idScan = { xml, asked: 0, index: null };
  if (!idScan.index && ++idScan.asked <= 4) return xml.includes(exact ? ` ${k}="${v}"` : `${k}="${v}"`);
  if (!idScan.index) {
    const index = new Map();
    ID_ATTR_RE.lastIndex = 0;
    for (const m of xml.matchAll(ID_ATTR_RE)) { const s = index.get(m[2]); if (s) s.add(m[1]); else index.set(m[2], new Set([m[1]])); }
    idScan.index = index;
  }
  const names = idScan.index.get(String(v));
  if (!names) return false;
  if (exact) return names.has(k);
  for (const n of names) if (n.endsWith(k)) return true;
  return false;
}

/** 무작위 9~10자리 수 중 taken(문자열) 이 아닌 것. addMemo·addMemos 가 Math.random 을 같은 차례로 쓴다 */
function uniqueNumberBy(taken) {
  for (let i = 0; i < 50; i++) {
    const n = 100000000 + Math.floor(Math.random() * 2000000000);
    if (!taken(String(n))) return n;
  }
  throw new EngineError('ID', '고유 id 를 만들지 못했습니다');
}

/**
 * chars[ci] 바로 앞(변경 범위 시작 표식보다 앞) 원문 위치.
 * [hwpx-cowork] 개체에 붙은 표식(attach — 바로 앞 개체의 넣음·지움)은 개체의 일부로 보고 넘지 않는다(글 지우기가 개체를 감싸지 않게)
 */
function beforeChar(p, ci) {
  const c = p.chars[ci];
  let pos = c.raw[0];
  // [hwpx-cowork] 나눔을 지워 이은 기록: 글자가 든 물리 문단(member) 안의 표식만 — 앞 member 끝의 나눔 표식을 넘지 않는다
  const from = p.members ? p.members[Section.memberAt(p, ci)].start : -1;
  for (const a of p.anchors) {
    if (a.pos !== ci || a.kind !== 'change' || a.attach || a.brk || a.start < from) continue;
    if ((a.name === 'hp:insertBegin' || a.name === 'hp:deleteBegin') && a.start < pos) pos = a.start;
  }
  return pos;
}

/** chars[ci] 바로 뒤(이 글자를 닫는 변경 끝 표식 뒤) 원문 위치 — 개체에 붙은 표식은 넘지 않는다 */
function afterChar(p, ci) {
  const c = p.chars[ci];
  let pos = c.raw[1];
  const to = p.members ? p.members[Section.memberAt(p, ci)].end : Infinity;
  for (const a of p.anchors) {
    if (a.pos !== ci + 1 || a.kind !== 'change' || a.attach || a.brk || a.end > to) continue;
    if ((a.name === 'hp:insertEnd' && a.id === c.ins) || (a.name === 'hp:deleteEnd' && a.id === c.del)) pos = Math.max(pos, a.end);
  }
  return pos;
}

/** 최종본 offset 에 인라인 내용(xml)을 넣는 편집. 빈 문단이면 hp:t(필요하면 run)를 함께 만든다. */
function insertEdit(sec, p, offset, xml) {
  const fc = Section.visibleChars(p, 'final');
  if (offset < 0 || offset > fc.length) throw new EngineError('RANGE', `위치가 문단 밖입니다 (0..${fc.length})`);
  if (fc.length === 0) return emptyParagraphEdit(sec, p, 'inline', xml);
  if (offset === 0) return { pos: beforeChar(p, p.chars.indexOf(fc[0])), insert: xml };
  return { pos: afterChar(p, p.chars.indexOf(fc[offset - 1])), insert: xml };
}

/**
 * 보이는 글자가 없는 문단에 내용(xml)을 넣는 편집 하나. mode 'inline' 이면 hp:t 안, '' 이면 run 안(hp:t 밖).
 * 감싸는 태그가 필요하면(<hp:t/>, <hp:run/>, run 없음) 같은 편집 안에 함께 넣는다 — applyEdits 는 모든 좌표를
 * 원문 기준으로 보므로, 감싸기와 내용을 따로 넣으면 내용이 엉뚱한 곳(다음 태그 안)에 들어간다.
 */
function emptyParagraphEdit(sec, p, mode, xml) {
  const inT = mode === 'inline' ? `<hp:t>${xml}</hp:t>` : xml;
  // [hwpx-cowork] 나눔을 지워 이은 기록은 마지막 물리 문단(member) 안에 — 앞 member 끝의 나눔 표식 뒤에 넣으면 묶음이 깨진다
  const m = p.members ? p.members[p.members.length - 1] : null;
  // [hwpx-cowork] 문단 나눔 표식(brk — 그 물리 문단의 마지막 내용)보다 앞에: 표식이 든 hp:t 면 표식 앞에서 넣거나 쪼갠다
  const brkIn = (t) => p.anchors.filter((a) => a.brk && a.t === t);
  // 지워진 글자만 있는 경우: 마지막 글자 뒤(삭제 끝 표식 뒤)
  if (p.chars.length > (m ? m.c0 : 0)) {
    const ci = p.chars.length - 1;
    if (mode === 'inline') return { pos: afterChar(p, ci), insert: xml };
    const bk = brkIn(p.chars[ci].t).filter((a) => a.start >= p.chars[ci].raw[1]);
    if (bk.length) return { pos: bk[0].start, insert: `</hp:t>${xml}<hp:t>` };
    return { pos: p.chars[ci].t.closeEnd, insert: xml };
  }
  const runs = m ? p.runs.slice(m.r0) : p.runs;
  const run = runs.length ? runs[runs.length - 1] : null;
  if (run) {
    const t = p.ts.filter((x) => x.run === run).pop();
    const bk = t ? brkIn(t) : [];
    if (t && mode === 'inline') {
      if (t.selfclose) return { start: t.openStart, end: t.openEnd, insert: inT }; // <hp:t/> → <hp:t>…</hp:t>
      return { pos: bk.length ? bk[0].start : t.closeStart, insert: xml };
    }
    if (t && bk.length) return sec.xml.slice(t.openEnd, bk[0].start) === '' ? { pos: t.openStart, insert: xml } : { pos: bk[0].start, insert: `</hp:t>${xml}<hp:t>` };
    if (t) return { pos: t.closeEnd, insert: xml }; // hp:t 뒤(run 안)
    if (run.selfclose) return { start: run.end - 2, end: run.end, insert: `>${inT}</hp:run>` }; // <hp:run …/> → <hp:run …>…</hp:run>
    return { pos: sec.xml.lastIndexOf('</hp:run>', run.end), insert: inT };
  }
  // run 이 전혀 없는 문단
  const ls = m ? m.lineseg : p.lineseg;
  const at = ls ? ls.start : sec.xml.lastIndexOf('</hp:p>', m ? m.end : p.end);
  return { pos: at, insert: `<hp:run charPrIDRef="0">${inT}</hp:run>` };
}

/**
 * chars[ci] 앞에 hp:ctrl 을 둘 편집(필요하면 hp:t 를 쪼갠다).
 * [hwpx-cowork] 같은 hp:t 안 글자 앞에 개체에 붙은 표식(앞 개체의 끝 표식)이 있으면 hp:t 앞이 아니라 그 뒤에서 쪼갠다(부호가 개체 변경 범위에 들지 않게)
 */
function ctrlPointBefore(p, ci, ctrlXml) {
  const c = p.chars[ci];
  const first = !p.chars.some((x, i) => i < ci && x.t === c.t) && !p.anchors.some((a) => (a.attach || a.brk) && a.t === c.t && a.start < c.raw[0]);
  if (first) return { pos: c.t.openStart, insert: ctrlXml };
  return { pos: beforeChar(p, ci), insert: `</hp:t>${ctrlXml}<hp:t>` };
}

/** chars[ci] 뒤에 hp:ctrl 을 둘 편집 — [hwpx-cowork] 같은 hp:t 안 글자 뒤에 개체에 붙은 표식(뒤 개체의 시작 표식)이 있으면 그 앞에서 쪼갠다 */
function ctrlPointAfter(p, ci, ctrlXml) {
  const c = p.chars[ci];
  const last = !p.chars.some((x, i) => i > ci && x.t === c.t) && !p.anchors.some((a) => (a.attach || a.brk) && a.t === c.t && a.start >= c.raw[1]);
  if (last) return { pos: c.t.closeEnd, insert: ctrlXml };
  return { pos: afterChar(p, ci), insert: `</hp:t>${ctrlXml}<hp:t>` };
}

/**
 * 글자 범위 [ciA, ciB](p.chars 번호)를 그 안의 개체(ctrl — run 의 직접 자식: 메모 시작·끝, 그림, 표, 필드, 구역 설정 …) 자리에서 나눈 조각
 * [[a, b], …](문서 순서). 개체 자리 = 그 개체 바로 뒤 글자 번호(anchor.pos); 범위 첫 글자 앞·끝 글자 뒤 개체는 범위 밖이다.
 * 개체가 없으면 [[ciA, ciB]].
 */
function ctrlSplit(p, ciA, ciB) {
  const at = p.anchors.filter((a) => a.kind === 'ctrl' && a.pos > ciA && a.pos <= ciB).map((a) => a.pos);
  // [hwpx-cowork] 나눔을 지워 이은 기록: 물리 문단(member) 경계에서도 나눈다 — 범위는 member 를 넘지 않는다(member 마다 지움 하나 — 한/글처럼)
  if (p.members) for (const m of p.members) if (m.c0 > ciA && m.c0 <= ciB) at.push(m.c0);
  const cuts = [...new Set(at)].sort((x, y) => x - y);
  const out = []; let s = ciA;
  for (const k of cuts) { out.push([s, k - 1]); s = k; }
  out.push([s, ciB]);
  return out;
}

function assertNoOverlap(p, ciA, ciB) {
  for (let i = ciA; i <= ciB; i++) if (p.chars[i].ins || p.chars[i].del) throw new EngineError('OVERLAP', '범위 안에 이미 변경 추적이 있습니다. 먼저 수락하거나 거절하세요');
  for (const a of p.anchors) {
    // [hwpx-cowork] 개체에 붙은 표식은 개체의 일부 — 글 지우기는 그 개체 자리에서 나뉜다(ctrlSplit). 나눔만의 표식(brk)도 member 경계라 넘어간다
    if (a.kind !== 'change' || a.attach || a.brk) continue;
    if (a.pos > ciA && a.pos <= ciB) throw new EngineError('OVERLAP', '범위 안에 변경 표식이 있습니다');
  }
}

/** 문단 줄 정보를 지우는 편집 — [hwpx-cowork] 나눔을 지워 이은 기록은 member 마다 */
function dropLineseg(p, edits) { for (const ls of Section.linesegs(p)) edits.push({ start: ls.start, end: ls.end, insert: '' }); }

const CTRL_UNITS = 8; // 한글 textpos 에서 컨트롤(메모 필드 등) 하나 = 8글자
const isFieldCtrl = (a) => a.kind === 'ctrl' && a.name === 'hp:ctrl' && (a.inner === 'hp:fieldBegin' || a.inner === 'hp:fieldEnd');

/**
 * 줄 정보 textpos 의 단위 모형: 글자 = UTF-16 길이, 메모 필드 컨트롤 = 8.
 * 글자와 메모 필드만 있는 문단에서만 만든다(탭·줄바꿈·변경 표식·개체 등이 있으면 null = 모름).
 */
function unitModel(p) {
  if (p.chars.some((c) => c.inline)) return null;
  if (p.anchors.some((a) => !isFieldCtrl(a))) return null;
  const anchors = [...p.anchors].sort((x, y) => x.pos - y.pos || x.start - y.start);
  const lo = []; const hi = []; const anchorUnit = new Map(); const valid = new Set();
  let u = 0; let k = 0;
  for (let b = 0; b <= p.chars.length; b++) {
    lo[b] = u; valid.add(u);
    while (k < anchors.length && anchors[k].pos === b) { anchorUnit.set(anchors[k], u); u += CTRL_UNITS; valid.add(u); k++; }
    hi[b] = u;
    if (b < p.chars.length) u += p.chars[b].ch.length;
  }
  return { lo, hi, anchorUnit, valid, total: u };
}

/**
 * 0폭 컨트롤을 넣거나 뺀 만큼 그 문단 줄 정보(hp:linesegarray)의 textpos 를 옮기는 편집을 edits 에 더한다.
 * add: [{before: ci} | {after: ci}] (ctrlPointBefore/After 와 같은 자리), remove: 지울 컨트롤 anchor.
 * 줄 정보가 없으면 true(할 일 없음), 모형이 안 맞으면(모르는 요소, 줄 시작이 경계에 안 맞음) false → 호출자가 지운다.
 */
function shiftLineseg(sec, p, { add = [], remove = [] }, edits) {
  if (p.members) return false; // [hwpx-cowork] 나눔을 지워 이은 기록은 member 마다 줄 정보 — 옮기지 않고 지운다
  if (!p.lineseg) return true;
  const model = unitModel(p); if (!model) return false;
  const seg = sec.xml.slice(p.lineseg.start, p.lineseg.end);
  const re = /(<hp:lineseg\b[^>]*?\btextpos=")(\d+)(")/g;
  const ts = [...seg.matchAll(re)].map((m) => Number(m[2]));
  if (!ts.length || ts[0] !== 0 || ts.some((t, i) => (i && t <= ts[i - 1]) || !model.valid.has(t) || t >= Math.max(1, model.total))) return false;
  const addU = add.map((x) => (x.before != null ? model.hi[x.before] : model.lo[x.after + 1]));
  const remU = remove.map((a) => model.anchorUnit.get(a));
  if (addU.some((u) => u == null) || remU.some((u) => u == null)) return false;
  let i = 0;
  const out = seg.replace(re, (m, a, t, b) => {
    const v = ts[i++];
    const nv = v + CTRL_UNITS * addU.filter((u) => u < v).length - CTRL_UNITS * remU.filter((u) => u < v).length;
    return `${a}${nv}${b}`;
  });
  if (out !== seg) edits.push({ start: p.lineseg.start, end: p.lineseg.end, insert: out });
  return true;
}

/**
 * [hwpx-cowork] 변경 표식들(한 구역)을 지우는 편집. 개체에 붙은 표식(attach)이 든 hp:t 에 지울 표식 말고 아무것도 없으면(개체를 감쌀 때 더한
 * 빈 hp:t) 그 hp:t 째 지운다 — 수락·거절 뒤 빈 <hp:t></hp:t> 를 남기지 않아 거절이 원래 XML 로 돌아간다. 글 표식만 든 hp:t 는 예전처럼 표식만
 */
function markRemovalEdits(xml, marks) {
  const out = []; const byT = new Map();
  for (const m of new Set(marks)) {
    if (m.t && !m.t.selfclose) { if (!byT.has(m.t)) byT.set(m.t, []); byT.get(m.t).push(m); } else out.push({ start: m.start, end: m.end, insert: '' });
  }
  for (const [t, ms] of byT) {
    let whole = false;
    if (ms.some((m) => m.attach || m.brk)) { // [hwpx-cowork] 나눔만의 표식(brk)을 담으려고 만든 hp:t 도 통째로(거절 = 원래 XML)
      let inner = xml.slice(t.openEnd, t.closeStart);
      for (const m of [...ms].sort((a, b) => b.start - a.start)) inner = inner.slice(0, m.start - t.openEnd) + inner.slice(m.end - t.openEnd);
      whole = inner === '';
    }
    if (whole) out.push({ start: t.openStart, end: t.closeEnd, insert: '' });
    else for (const m of ms) out.push({ start: m.start, end: m.end, insert: '' });
  }
  return out;
}

/** [hwpx-cowork] 문단 p 의 run 에 든 개체 anchor 가운데 x(표·그림 색인 항목 — start·end)와 같은 자리의 것(없으면 자리만 든 대용품) */
function ownAnchorAt(p, x) { return p.anchors.find((a) => a.kind === 'ctrl' && a.start === x.start) || { kind: 'ctrl', start: x.start, end: x.end }; }

/** [hwpx-cowork] 변경 id 목록을 다시 매김 기록(takeRenumberLog 항목)들을 따라 옮긴다 — 지워진 번호는 뺀다(서비스 _syncChangeIds 와 같은 규칙) */
function remapIds(ids, entries) {
  let out = [...ids].map(Number);
  for (const e of entries) out = out.filter((c) => c !== e.removed).map((c) => (e.map.has(c) ? e.map.get(c) : c));
  return out;
}

/** [hwpx-cowork] 개체 anchor 목록에서 다른 것 안에 든 것을 뺀다(문서 차례) */
function outermostObjects(list) {
  const out = [];
  for (const a of [...new Set(list)].sort((x, y) => x.start - y.start || y.end - x.end)) if (!out.length || a.start >= out[out.length - 1].end) out.push(a);
  return out;
}

/**
 * [hwpx-cowork] 기록 p 의 member k 에 풀기(gone — 없어지는 글자·표식·개체) 뒤에도 최종본 내용(보이는 글자, 변경 표식·지운 개체가 아닌 부호)이 남나
 * (한/글: 남는 내용이 없는 문단의 나눔을 지우면 그 문단이 없어지고 뒤 문단 속성이 남는다)
 */
function memberContentAfter(p, k, gone) {
  const ms = Section.members(p); const m = ms[k];
  const c1 = k + 1 < ms.length ? ms[k + 1].c0 : p.chars.length; const a1 = k + 1 < ms.length ? ms[k + 1].a0 : p.anchors.length;
  for (let i = m.c0; i < c1; i++) { const c = p.chars[i]; if (!c.del && !gone.chars.has(c)) return true; }
  for (let i = m.a0; i < a1; i++) { const a = p.anchors[i]; if (a.kind !== 'change' && !(isObjectAnchor(a) && a.del) && !gone.anchors.has(a)) return true; }
  return false;
}

/** [hwpx-cowork] 기록 p(최종본 문단 — 묶음이면 모든 member)에 최종본 내용(보이는 글자, 변경 표식·지운 개체가 아닌 부호)이 있나 */
function finalContent(p) {
  return p.chars.some((c) => !c.del) || p.anchors.some((a) => a.kind !== 'change' && !(isObjectAnchor(a) && a.del));
}

/**
 * [hwpx-cowork] clearParagraphsTracked 가 문단마다 지운 것과 같게 흉내 낼 수 있는 문단인가: 본문 기록 하나(나눔 묶음 아님), 변경 추적 글자·표식이
 * 없고, run 의 직접 부호가 removeOwnObjectsTracked 가 감쌀 개체(objs — 넣음·지움 표식 없음)뿐(메모·필드·머리말·구역 나누기 등이 없음)
 */
function batchClearable(p, objs) {
  if (p.parent || p.members || p.chars.some((c) => c.ins || c.del)) return false;
  const own = new Set(objs);
  return p.anchors.every((a) => a.kind === 'inline' || (a.kind === 'ctrl' && own.has(a) && !a.ins && !a.del));
}

function dedupe(edits) {
  const seen = new Set(); const out = [];
  for (const e of edits) { const k = `${e.start ?? e.pos}:${e.end ?? ''}`; if (seen.has(k)) continue; seen.add(k); out.push(e); }
  return out;
}

// ───────── 개체 속성·조판 부호 도우미(_objectInfo·copyObjectsFrom·diffDocs 'object') ─────────

/**
 * 비교·옮기기 하는 그림 속성: [이름, 요소(null = hp:pic 여는 태그), 속성들]. 편집기(rhwp) 내보내기가 손대지 않은 그림은 이 값이
 * 한/글 원본과 똑같다(시험 문서 90여 그림으로 확인) — 배율 행렬·회전 중심은 rhwp 가 크기를 바꿔도 옛 값을 쓰므로 비교하지 않고 새로 셈한다.
 */
const PIC_PROPS = [
  ['open', null, ['textWrap', 'textFlow', 'numberingType', 'zOrder', 'lock']], // 번호 종류(개체 속성) — 바꾸면 캡션 번호 셈이 바뀐다. [hwpx-cowork] 2026-11-11 순서(zOrder)·개체 보호(lock)도 — 한/글 2022 맨 앞으로·개체 보호하기
  ['cur', 'hp:curSz', ['width', 'height']],
  ['org', 'hp:orgSz', ['width', 'height']],
  ['sz', 'hp:sz', ['width', 'widthRelTo', 'height', 'heightRelTo', 'protect']],
  ['pos', 'hp:pos', ['treatAsChar', 'affectLSpacing', 'flowWithText', 'allowOverlap', 'holdAnchorAndSO', 'vertRelTo', 'horzRelTo', 'vertAlign', 'horzAlign', 'vertOffset', 'horzOffset']],
  ['out', 'hp:outMargin', ['left', 'right', 'top', 'bottom']],
  ['in', 'hp:inMargin', ['left', 'right', 'top', 'bottom']],
  ['clip', 'hp:imgClip', ['left', 'right', 'top', 'bottom']],
  ['flip', 'hp:flip', ['horizontal', 'vertical']],
  ['rot', 'hp:rotationInfo', ['angle']],
  ['img', 'hc:img', ['bright', 'contrast', 'effect', 'alpha']],
];
const CAPTION_PROPS = ['side', 'fullSz', 'width', 'gap', 'lastWidth'];
/** 비교에서 빼는 캡션 속성: lastWidth 는 그림 폭을 따라가는 파생값(옮길 때 새 폭으로 맞춘다 — patchPicture) */
const CAPTION_COMPARE = CAPTION_PROPS.filter((k) => k !== 'lastWidth');
const xmlTag = (xml, name) => (name ? (new RegExp(`<${name}\\b[^>]*>`).exec(xml) || [])[0] : (/^<hp:pic\b[^>]*>/.exec(xml) || [])[0]) || '';
const tagAttr = (tag, k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(tag) || [])[1] ?? null;
/** 태그의 속성 값을 바꾼다(없는 속성은 닫는 > 앞에 더한다) */
function setTagAttrs(tag, values) {
  let out = tag;
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    const re = new RegExp(`(\\s${k}=")[^"]*(")`);
    out = re.test(out) ? out.replace(re, `$1${escapeAttr(String(v))}$2`) : out.replace(/\s*(\/?)>$/, ` ${k}="${escapeAttr(String(v))}"$1>`);
  }
  return out;
}
const pickAttrs = (tag, keys) => Object.fromEntries(keys.map((k) => [k, tagAttr(tag, k)]).filter(([, v]) => v != null));

/** 그림 XML(hp:pic 하나, headLen = 캡션 앞까지 길이)의 비교용 속성 */
function pictureProps(xml, headLen) {
  const head = xml.slice(0, headLen); const tail = xml.slice(headLen);
  const out = {};
  for (const [k, tag, keys] of PIC_PROPS) { const t = xmlTag(head, tag); out[k] = keys.map((a) => tagAttr(t, a)); }
  const cap = xmlTag(tail, 'hp:caption');
  out.cap = cap ? CAPTION_COMPARE.map((a) => tagAttr(cap, a)) : null;
  return out;
}

// ───────── [hwpx-cowork] 정규 나무 지문(2026-11-12 편집 보존 — research/edit-preservation-20261112/preserve/ledger.md) ─────────
// 그림·구역 정의(secPr)는 '보는 속성 목록'(PIC_PROPS)만 견주면 목록 밖 속성(그림 테두리 선 hp:lineShape·그림 효과 hp:effects, 구역의 용지·여백·
// 각주/미주 모양·쪽 테두리·시작 번호·감추기)을 편집기에서 바꿔도 덩어리가 0 이라 서버에서 조용히 사라졌다. 그래서 요소 전체를 (경로, 속성, 값)
// 줄들로 바꿔 견준다(도형 engine/shapes.js 의 지문과 같은 생각). 편집기 내보내기는 손대지 않은 그림의 요소 차례·빈 요소 꼴·엔티티 꼴을 바꿔 쓰므로
// (한/글 문서 223개 실측: 본문 그림 61개 모두 차례가 다름 — fp_probe.mjs) 경로는 '같은 이름 형제 차례'로만 매기고 줄을 정렬한다(차례를 보지 않음).
// 빼는 것(휘발·파생)은 표마다 이유를 단다. 같은 실측에서 이 지문은 손대지 않은 본문 그림 61개 중 60개, 구역 정의 245개 모두 같았다
// (다른 1개는 hc:img alpha 128→127 — 종전 PIC_PROPS 도 보던 값).
const CANON_TOK = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|([^<]+)/g;
const CANON_ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/**
 * XML 조각 → 정렬한 지문 줄들. skipTags = 그 아래 전부 뺄 요소, skipAttrs = 뺄 속성, mapAttr(이름, 값) = 값을 바꿔 볼 것(번호 → 내용 열쇠 등).
 * 글은 엔티티를 풀고 \r 을 빼고 양끝 공백을 지워 본다(편집기는 설명 글의 줄바꿈을 &#13; 로 쓴다)
 */
function canonLines(xml, { skipTags = new Set(), skipAttrs = new Set(), mapAttr = null } = {}) {
  const out = []; const stack = [{ path: '', counts: new Map(), skip: false }];
  // [hwpx-cowork] 쪽 테두리 참조의 실제 내용을 읽을 때 같은 정규화기가 중첩 호출된다.
  // 각 XML의 반복자가 자신의 위치를 소유해야 캐시 유무와 관계없이 같은 지문을 얻는다.
  for (const m of xml.matchAll(CANON_TOK)) {
    const [, close, tag, attrs, self, text] = m;
    const top = stack[stack.length - 1];
    if (text != null) {
      if (top.skip) continue;
      const t = decodeEntities(text).replace(/\r/g, '').trim();
      if (t) out.push(`${top.path}#${t}`);
      continue;
    }
    if (!tag) continue;
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const n = top.counts.get(tag) || 0; top.counts.set(tag, n + 1);
    const path = `${top.path}/${tag}[${n}]`;
    const skip = top.skip || skipTags.has(tag);
    if (!skip) {
      out.push(path);
      for (const a of attrs.matchAll(CANON_ATTR)) {
        if (skipAttrs.has(a[1])) continue;
        const v = a[2] ?? a[3] ?? '';
        out.push(`${path}@${a[1]}=${mapAttr ? mapAttr(a[1], v) : v}`);
      }
    }
    if (!self) stack.push({ path, counts: new Map(), skip });
  }
  return out.sort();
}

/**
 * 그림 지문에서 빼는 요소: 줄 캐시(hp:linesegarray), 파생 행렬(hp:renderingInfo — 크기·회전·뒤집기에서 셈, rhwp 는 크기를 바꿔도 옛 값을 쓴다 —
 * 회전·뒤집기를 옮길 때 함께 옮긴다), 그림 네 꼭짓점(hp:imgRect — 크기에서 셈, 종전에도 옮기지 않음), 캡션(따로 CAPTION_PROPS)
 */
const PIC_CANON_SKIP_TAGS = new Set(['hp:linesegarray', 'hp:renderingInfo', 'hp:imgRect', 'hp:caption']);
/** 그림 지문에서 빼는 속성: 개체 번호(id·instid — 서버가 새로 매길 수 있다), 그림 파일 번호(편집기가 다시 매긴다 — 짝은 파일 내용 열쇠로), 회전 중심(크기/2 파생) */
const PIC_CANON_SKIP_ATTRS = new Set(['id', 'instid', 'binaryItemIDRef', 'centerX', 'centerY']);
/** 그림(hp:pic 하나) XML 의 전체 지문 — PIC_PROPS 밖 속성(선·효과·설명 등)까지. 캡션(hp:caption)은 어디 있든 뺀다(따로 CAPTION_PROPS) */
function pictureMore(xml) { return pictureCanon(xml).more; }
/**
 * [hwpx-cowork] 그림 정규 지문 둘 — more = 전체(차이 찾기·옮기기), rest = 그중 PIC_PROPS 가 이미 보는 속성(여는 태그·바로 아래 요소의 그 속성)을
 * 뺀 나머지(덧지문 _objectExtraPrint — 판 2 지문과 겹치지 않게: 판 2 로 보이는 변경만 한 덩어리는 덧지문이 같아 종전 지문을 그대로 싣는다)
 */
const PIC_PROP_LINES = new Map(PIC_PROPS.map(([, tag, keys]) => [tag || 'hp:pic', new Set(keys)]));
function pictureCanon(xml) {
  const lines = canonLines(xml, { skipTags: PIC_CANON_SKIP_TAGS, skipAttrs: PIC_CANON_SKIP_ATTRS });
  const rest = lines.filter((l) => {
    const m = /^\/hp:pic\[0\](?:\/([\w:]+)\[\d+\])?@([\w:.-]+)=/.exec(l);
    if (!m) return true;
    const keys = PIC_PROP_LINES.get(m[1] || 'hp:pic');
    return !(keys && keys.has(m[2]));
  });
  return { more: shortHash(lines.join('\n')), rest: shortHash(rest.join('\n')) };
}

/** 첫 요소(root)의 바로 아래 자식 요소들 [{ tag, start, end }](head 안 자리) */
function topChildren(xml) {
  const out = []; let depth = 0; let cur = null;
  for (const m of xml.matchAll(CANON_TOK)) {
    const [all, close, tag, , self] = m;
    if (!tag) continue;
    if (close) { depth--; if (depth === 1 && cur) { cur.end = m.index + all.length; out.push(cur); cur = null; } continue; }
    if (depth === 1) { if (self) out.push({ tag, start: m.index, end: m.index + all.length }); else cur = { tag, start: m.index, end: 0 }; }
    if (!self) depth++;
  }
  return out;
}

/**
 * [hwpx-cowork] patchPicture 뒤: 그림 요소 전체(head·sHead = hp:pic 하나 전체, 캡션은 건너뜀)의 나머지 차이를 요소 단위로 맞춘다(한/글 원본 요소 차례는 두고) — 목록 밖 속성이 다시 사라지지 않게.
 *  - 여는 태그: id·instid·xmlns 밖의 속성을 sxml 값으로
 *  - 바로 아래 요소: 지문이 다르면 sxml 의 것으로 바꾸고, sxml 에만 있으면 sxml 에서 앞 형제였던 요소 뒤(없으면 여는 태그 뒤)에 넣고,
 *    txml 에만 있으면 뺀다. 빼는 요소(PIC_CANON_SKIP_TAGS — 파생)는 두되, 회전 각·뒤집기가 바뀐 그림(rotated — 원래 txml 과 견줌)은
 *    회전 정보·행렬(hp:rotationInfo·hp:renderingInfo)을 sxml 것으로 바꾼다(편집기가 회전·뒤집기로 셈한 값 — 종전에는 각만 옮기려다
 *    curSz 0 인 그림에서는 각도 못 옮겼다)
 *  - 그림 파일 번호(binaryItemIDRef)는 txml 것을 둔다(짝은 파일 내용 열쇠로 지었다)
 */
function patchPictureRest(head, sHead, rotated) {
  if (!rotated && pictureMore(head) === pictureMore(sHead)) return head;
  const sk = { skipTags: PIC_CANON_SKIP_TAGS, skipAttrs: PIC_CANON_SKIP_ATTRS };
  let out = head;
  if (rotated) {
    const sRot = xmlTag(sHead, 'hp:rotationInfo');
    if (sRot) out = out.replace(/<hp:rotationInfo\b[^>]*>/, (o) => setTagAttrs(o, pickAttrs(sRot, ['angle', 'centerX', 'centerY', 'rotateimage'])));
    const tR = /<hp:renderingInfo\b[\s\S]*?<\/hp:renderingInfo>/.exec(out); const sR = /<hp:renderingInfo\b[\s\S]*?<\/hp:renderingInfo>/.exec(sHead);
    if (tR && sR) out = out.slice(0, tR.index) + sR[0] + out.slice(tR.index + tR[0].length);
  }
  const tOpen = (/^<hp:pic\b[^>]*>/.exec(out) || [''])[0]; const sOpen = (/^<hp:pic\b[^>]*>/.exec(sHead) || [''])[0];
  const openVals = {};
  for (const a of sOpen.matchAll(CANON_ATTR)) if (a[1] !== 'id' && a[1] !== 'instid' && !/^xmlns/.test(a[1])) openVals[a[1]] = a[2] ?? a[3] ?? '';
  const open2 = setTagAttrs(tOpen, openVals);
  out = open2 + out.slice(tOpen.length);
  const T = topChildren(out); const S = topChildren(sHead);
  const group = (L) => { const g = new Map(); for (const c of L) { if (!g.has(c.tag)) g.set(c.tag, []); g.get(c.tag).push(c); } return g; };
  const TG = group(T); const SG = group(S);
  const keepBin = (sx, tx) => { const b = tagAttr(xmlTag(tx, 'hc:img'), 'binaryItemIDRef'); return b != null ? sx.replace(/(<hc:img\b[^>]*\bbinaryItemIDRef=")[^"]*(")/, `$1${b}$2`) : sx; };
  const edits = [];
  for (const [tag, ts] of TG) {
    if (PIC_CANON_SKIP_TAGS.has(tag)) continue;
    const ss = SG.get(tag) || [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; const s = ss[i]; const tx = out.slice(t.start, t.end);
      if (!s) { edits.push({ start: t.start, end: t.end, insert: '' }); continue; }
      const sx = sHead.slice(s.start, s.end);
      if (canonLines(tx, sk).join('\n') === canonLines(sx, sk).join('\n')) continue;
      edits.push({ start: t.start, end: t.end, insert: keepBin(sx, tx) });
    }
  }
  for (const [tag, ss] of SG) {
    if (PIC_CANON_SKIP_TAGS.has(tag)) continue;
    const have = (TG.get(tag) || []).length;
    for (let i = have; i < ss.length; i++) {
      const k = S.indexOf(ss[i]);
      let at = open2.length;
      for (let j = k - 1; j >= 0; j--) { const prev = (TG.get(S[j].tag) || []).slice(-1)[0]; if (prev) { at = prev.end; break; } }
      edits.push({ pos: at, insert: sHead.slice(ss[i].start, ss[i].end) });
    }
  }
  return edits.length ? applyEdits(out, edits) : out;
}

/** 그림 txml 의 속성을 sxml(같은 그림 파일) 값으로 — 요소·속성 차례는 txml(한/글 원본) 그대로 두고 값만 바꾼다 */
function patchPicture(txml, tHeadLen, sxml, sHeadLen) {
  let head = txml.slice(0, tHeadLen); let tail = txml.slice(tHeadLen);
  const sHead = sxml.slice(0, sHeadLen); const sTail = sxml.slice(sHeadLen);
  // [hwpx-cowork] 회전 각·뒤집기가 바뀐 그림인가(원래 txml 과 견줌 — 행렬을 sxml 것으로 바꿀지, patchPictureRest)
  const rotated = [['hp:rotationInfo', ['angle']], ['hp:flip', ['horizontal', 'vertical']]]
    .some(([tag, keys]) => keys.some((k) => tagAttr(xmlTag(head, tag), k) !== tagAttr(xmlTag(sHead, tag), k)));
  for (const [, tag, keys] of PIC_PROPS) {
    if (tag === 'hp:orgSz' || tag === 'hp:rotationInfo') continue;
    const src = xmlTag(sHead, tag); if (!src) continue;
    const re = tag ? new RegExp(`<${tag}\\b[^>]*>`) : /^<hp:pic\b[^>]*>/;
    head = head.replace(re, (o) => setTagAttrs(o, pickAttrs(src, keys)));
  }
  const cur = xmlTag(head, 'hp:curSz'); const org = xmlTag(head, 'hp:orgSz');
  const w = Number(tagAttr(cur, 'width')) || 0; const h = Number(tagAttr(cur, 'height')) || 0;
  const ow = Number(tagAttr(org, 'width')) || 0; const oh = Number(tagAttr(org, 'height')) || 0;
  const angle = tagAttr(xmlTag(sHead, 'hp:rotationInfo'), 'angle');
  if (w > 0 && h > 0) head = head.replace(/<hp:rotationInfo\b[^>]*>/, (o) => setTagAttrs(o, { angle, centerX: Math.round(w / 2), centerY: Math.round(h / 2) }));
  if (w > 0 && h > 0 && ow > 0 && oh > 0) {
    const f = (x) => String(Number(x.toFixed(6)));
    head = head.replace(/<hc:scaMatrix\b[^>]*>/, (o) => setTagAttrs(o, { e1: f(w / ow), e5: f(h / oh) }));
  }
  const sCap = xmlTag(sTail, 'hp:caption');
  if (sCap) {
    // 캡션 폭(lastWidth)이 그림 폭을 따라가던 것이면(fullSz 0 — 한/글 원본은 lastWidth = 그림 폭) 새 폭으로. 편집기는 그림 크기를 바꿔도 옛 값을 쓴다
    const oldW = Number(tagAttr(xmlTag(txml.slice(0, tHeadLen), 'hp:sz'), 'width')) || 0;
    const newW = Number(tagAttr(xmlTag(head, 'hp:sz'), 'width')) || 0;
    const cap = pickAttrs(sCap, CAPTION_PROPS);
    const last = Number(tagAttr(xmlTag(tail, 'hp:caption'), 'lastWidth'));
    if (newW && oldW && newW !== oldW && Math.abs(last - oldW) <= 1 && Math.abs(Number(cap.lastWidth) - last) <= 1) cap.lastWidth = String(newW);
    tail = tail.replace(/<hp:caption\b[^>]*>/, (o) => setTagAttrs(o, cap));
  }
  // [hwpx-cowork] PIC_PROPS 밖의 차이(선·효과·설명 등)도 요소 단위로(2026-11-12 편집 보존). 캡션 뒤 요소까지 견주도록 그림 전체로 맞춘다
  // (한/글은 hp:shapeComment 를 캡션 앞에, 편집기는 캡션 뒤에 쓴다 — 머리만 보면 서버 쪽 설명을 지웠다). 캡션은 위에서 맞췄으니 건너뛴다
  return patchPictureRest(head + tail, sxml, rotated);
}

/**
 * 표 뼈대 지문 — 표·칸의 기하(표 속성·크기·배치·여백·캡션 꼴, 줄, 칸 주소·합침·크기·여백·칸 글 상자 꼴)와 칸 안 개체(안쪽 표·그림 — 그림은
 * 파일 내용 열쇠)만 본다. 칸 글·칸 문단 수·메모는 보지 않는다(글은 칸마다 따로 비교 — 칸 안 Enter 는 접어서 반영). 편집기 내보내기는 손대지
 * 않은 표의 이 값을 그대로 쓴다(시험 문서 표 80여 개 — 서버가 만든 표의 outMargin 4294967295 만 0 으로 바꿔 쓴다 → 0 으로 본다)
 * [hwpx-cowork] 표 자신의 크기 높이(hp:tbl 바로 뒤 hp:sz@height)는 보지 않는다: 한/글은 이 값을 조판에 쓰지 않고 다시 저장할 때 실제 높이로
 * 고쳐 쓰며(docs/TABLE_VARIABLES_2026-11-04.md E1), rhwp 0.9.0 편집기도 칸 글을 고친 표는 내보낼 때 내용 높이로 키워 적는다(grown_table_heights).
 * 칸 안 Enter·글 입력만으로 이 값이 바뀌므로 뼈대로 보면 글 편집이 '표 고침'(표째 옮김·다시 열기)이 된다. 줄 높이·표 크기를 실제로 고치면
 * 칸 크기(hp:cellSz)가 바뀌어 그대로 잡힌다. 그림·안쪽 그림의 hp:sz 는 그대로 본다
 */
const TABLE_TAGS = /<(hp:tbl|hp:sz|hp:pos|hp:outMargin|hp:inMargin|hp:caption|hp:tr|hp:tc|hp:cellAddr|hp:cellSpan|hp:cellSz|hp:cellMargin|hp:cellzone|hp:subList|hp:pic|hp:curSz|hc:img)\b([^>]*?)\/?>/g;
const TABLE_SKIP_ATTRS = new Set(['id', 'instid', 'zOrder', 'linkListIDRef', 'linkListNextIDRef', 'textWidth', 'textHeight', 'hasTextRef', 'hasNumRef']);
/**
 * [hwpx-cowork] 표 머리 속성(hp:tbl 여는 태그의 zOrder·lock) — 한/글 2022 '맨 앞으로'(문서 전체 zOrder 다시 매김)·'개체 보호하기'.
 * 뼈대(tableSkeleton)와 따로 비교해, 이것만 다르면 표를 통째로 바꾸지 않고(_importTable — 칸 글·변경 추적까지 덮어씀) 여는 태그 값만 옮긴다.
 */
const TABLE_HEAD_ATTRS = ['zOrder', 'lock'];
function tableHead(xml) {
  const open = (/^<hp:tbl\b[^>]*>/.exec(xml) || [])[0] || '';
  return TABLE_HEAD_ATTRS.map((k) => tagAttr(open, k));
}

function tableSkeleton(doc, xml) {
  const body = xml.replace(/<hp:ctrl>\s*<hp:fieldBegin\b[\s\S]*?<\/hp:fieldBegin>\s*<\/hp:ctrl>/g, '');
  const out = [];
  let tblHead = false;   // hp:tbl 을 연 뒤 그 표의 첫 hp:sz 를 아직 못 봄(줄·칸·캡션·그림이 먼저 오면 표 크기가 아니다)
  let outer = true;      // [hwpx-cowork] 첫 hp:tbl = 이 표 자신 — 그 lock(개체 보호)은 머리 속성으로 따로 본다(tableHead, 2026-11-12)
  for (const m of body.matchAll(TABLE_TAGS)) {
    const ownSz = tblHead && m[1] === 'hp:sz';
    tblHead = m[1] === 'hp:tbl' || (tblHead && !ownSz && !/^hp:(tr|tc|caption|pic|subList)$/.test(m[1]));
    const own = outer && m[1] === 'hp:tbl'; if (own) outer = false;
    const at = [...m[2].matchAll(/([\w:]+)="([^"]*)"/g)].filter((a) => !TABLE_SKIP_ATTRS.has(a[1]) && !(ownSz && a[1] === 'height') && !(own && a[1] === 'lock')).map(([, k, v]) => {
      if (k === 'binaryItemIDRef') return `${k}=${doc._picKey(v)}`;
      if (/Margin$/.test(m[1]) && /^\d+$/.test(v) && Number(v) > 2147483647) return `${k}=0`;
      return `${k}=${v}`;
    });
    out.push(`${m[1]}(${at.join(',')})`);
  }
  return shortHash(out.join('|'));
}

/**
 * 두 문단의 표 짝: 수가 같으면 차례대로(뼈대가 다르면 고친 표), 다르면 뼈대 차례 비교(LCS)로 같은 표를 짝짓고 나머지는 지움·넣음.
 * → { pairs: [[i, j]], removed: [i], added: [j] } — diffDocs(칸 글 비교에서 뺄 표)와 copyObjectsFrom 이 같은 짝을 쓴다
 */
function pairTables(T, S) {
  if (T.length === S.length) return { pairs: T.map((_, i) => [i, i]), removed: [], added: [] };
  const pairs = keyLcs(T.map((x) => x.print), S.map((x) => x.print));
  const kt = new Set(pairs.map(([i]) => i)); const ks = new Set(pairs.map(([, j]) => j));
  return { pairs, removed: T.map((_, i) => i).filter((i) => !kt.has(i)), added: S.map((_, j) => j).filter((j) => !ks.has(j)) };
}

/** 바이트 내용 열쇠: 길이 + (앞 512·뒤 512·고르게 256곳) 바이트의 짧은 해시 — 그림 짝짓기용(전부 해시하지 않아 큰 문서도 가볍다) */
function bytesKey(u) {
  const n = u.length; const parts = [];
  for (let i = 0; i < Math.min(512, n); i++) parts.push(u[i]);
  for (let i = Math.max(0, n - 512); i < n; i++) parts.push(u[i]);
  for (let k = 0; k < 256 && n; k++) parts.push(u[Math.floor((k * n) / 256)]);
  return `${n}:${shortHash(String.fromCharCode(...parts))}`;
}

/**
 * 옮겨 넣는 그림 XML 의 원본 크기(orgSz·imgRect·imgDim)를 그림 파일의 실제 크기(픽셀 × 75 HWPUNIT — 한/글 원본과 같은 환산)에 맞춘다.
 * 편집기(rhwp)가 그림 파일만 바꾼 그림(그림 바꾸기)은 옛 그림의 원본 크기를 그대로 써서 한/글이 자르기(imgClip)를 엉뚱하게 늘여 그렸다
 * (120×60 그림이 쪽보다 수십 배 크게). 자르기가 새 크기 밖이면 전체로, 배율 행렬은 보이는 크기 / 원본 크기로. 맞으면 그대로
 */
function fitPictureToImage(xml, bytes) {
  const info = bytes ? imageInfo(bytes) : null;
  if (!info) return xml;
  const capAt = xml.indexOf('<hp:caption');
  let head = capAt < 0 ? xml : xml.slice(0, capAt); const tail = capAt < 0 ? '' : xml.slice(capAt);
  const ow = info.width * PX; const oh = info.height * PX;
  const org = xmlTag(head, 'hp:orgSz');
  if (Number(tagAttr(org, 'width')) === ow && Number(tagAttr(org, 'height')) === oh) return xml;
  head = head
    .replace(/<hp:orgSz\b[^>]*>/, (o) => setTagAttrs(o, { width: ow, height: oh }))
    .replace(/<hp:imgRect\b[^>]*>[\s\S]*?<\/hp:imgRect>/, `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${ow}" y="0"/><hc:pt2 x="${ow}" y="${oh}"/><hc:pt3 x="0" y="${oh}"/></hp:imgRect>`)
    .replace(/<hp:imgDim\b[^>]*>/, (o) => setTagAttrs(o, { dimwidth: ow, dimheight: oh }));
  const clip = xmlTag(head, 'hp:imgClip');
  const [l, r, t, b] = ['left', 'right', 'top', 'bottom'].map((k) => Number(tagAttr(clip, k)));
  if (!(l >= 0 && t >= 0 && r <= ow && b <= oh && r > l && b > t)) head = head.replace(/<hp:imgClip\b[^>]*>/, (o) => setTagAttrs(o, { left: 0, right: ow, top: 0, bottom: oh }));
  const cur = xmlTag(head, 'hp:curSz'); const w = Number(tagAttr(cur, 'width')) || 0; const h = Number(tagAttr(cur, 'height')) || 0;
  if (w > 0 && h > 0) {
    const f = (x) => String(Number(x.toFixed(6)));
    head = head.replace(/<hc:scaMatrix\b[^>]*>/, (o) => setTagAttrs(o, { e1: f(w / ow), e5: f(h / oh) }));
  }
  return head + tail;
}

/**
 * 조판 부호(hp:ctrl 의 첫 자식) → 같은 부호로 볼 속성. 자동 번호의 num 은 캐시(한/글·rhwp 가 열 때 다시 매긴다)라 보지 않는다.
 * 표·그림·필드·머리말·구역 정의 같은 것은 조판 부호로 다루지 않는다(그것대로의 경로가 있다).
 */
const CODE_TAGS = {
  'hp:autoNum': ['numType'], 'hp:newNum': ['numType', 'num'], 'hp:pageNum': ['pos', 'formatType', 'sideChar'],
  'hp:pageHiding': ['hideHeader', 'hideFooter', 'hideMasterPage', 'hideBorder', 'hideFill', 'hidePageNum'],
  'hp:bookmark': ['name'], 'hp:indexmark': [], 'hp:pageNumCtrl': ['pageStartsOn'],
};
const NUM_TYPE_KO = { PAGE: '쪽', FOOTNOTE: '각주', ENDNOTE: '미주', PICTURE: '그림', FIGURE: '그림', TABLE: '표', EQUATION: '수식', TOTAL_PAGE: '전체 쪽수' };
function codeLabel(inner, attrs) {
  const nt = NUM_TYPE_KO[attrs?.get('numType')] || attrs?.get('numType') || '';
  switch (inner) {
    case 'hp:autoNum': return `번호(${nt})`;
    case 'hp:newNum': return `새 번호(${nt} ${attrs?.get('num') ?? ''})`.replace(' )', ')');
    case 'hp:pageNum': return '쪽 번호 위치';
    case 'hp:pageHiding': return '감추기';
    case 'hp:bookmark': return `책갈피(${attrs?.get('name') ?? ''})`;
    case 'hp:indexmark': return '찾아보기 표식';
    case 'hp:pageNumCtrl': return '홀짝 쪽 시작';
    case 'hp:header': case 'hp:footer': {
      const side = { BOTH: '양 쪽', EVEN: '짝수 쪽', ODD: '홀수 쪽' }[attrs?.get('applyPageType')] || '';
      return `${inner === 'hp:header' ? '머리말' : '꼬리말'}${side ? `(${side})` : ''}`;
    }
    default: return inner;
  }
}

/** 조판 부호로 옮기는 필드(차례·하이퍼링크) — 메모·누름틀 등은 그것대로의 경로가 있다 */
// [hwpx-cowork] DATE = 한/글 날짜/시간 코드(입력 > 날짜/시간 > 날짜/시간 코드 — 편집기 insert:date-code, 2026-11-11).
// 필드 안 날짜 글은 글 비교가, 필드 시작·끝 부호는 여기서 옮긴다(하이퍼링크와 같은 길)
// [hwpx-cowork] FORMULA = 표 계산식 필드(h2022 표 2026-11-11) — 식·형식·마지막 결과(Command)가 바뀌거나 새로 생기면 object 덩어리로 옮긴다.
// 종전에는 칸 글(결과)만 글 덩어리로 실려 서버 저장본의 LastResult 가 옛 값으로 남았다(한/글은 결과 ≠ LastResult 를 손으로 고친 결과로 본다).
// [hwpx-cowork] CROSSREF = 한/글 상호 참조(편집기 insert:cross-reference, 2026-11-12) — 열쇠의 Command 에 대상(표 id·책갈피 이름)이 든다
const LINK_FIELD_TYPES = new Set(['TABLEOFCONTENTS', 'HYPERLINK', 'DATE', 'FORMULA', 'CROSSREF']);
const FIELD_LABEL = { TABLEOFCONTENTS: '차례 필드', HYPERLINK: '하이퍼링크', DATE: '날짜 코드', FORMULA: '계산식', CROSSREF: '상호 참조' };

/** 구역의 필드 시작 id → 종류(필드 끝의 종류를 알려고 — 차례 필드 끝은 다른 문단에 있다) */
function fieldTypes(sec) {
  if (sec._fieldTypes?.seq === sec.loadSeq) return sec._fieldTypes.map;
  const map = new Map();
  for (const m of sec.xml.matchAll(/<hp:fieldBegin\b[^>]*>/g)) {
    const id = /\sid="([^"]*)"/.exec(m[0])?.[1]; const type = /\stype="([^"]*)"/.exec(m[0])?.[1];
    if (id != null) map.set(id, type ?? '');
  }
  sec._fieldTypes = { seq: sec.loadSeq, map };
  return map;
}

/**
 * 문단이 직접 가진 조판 부호(차례대로) — pos = 그 부호 앞 최종본 글자 수.
 * 차례·하이퍼링크 필드의 시작·끝(편집기 '차례 만들기'), 제목 차례 표시·차례 숨김(hp:t 안의 hp:titleMark — inline)도 부호로 옮긴다.
 * 짝 시작이 문서에 없는 필드 끝(지운 차례의 남은 끝 — 한/글은 버리고, 편집기도 저장할 때 내지 않는다)과
 * 구역 나누기(hp:secPr + 뒤따르는 단 정의 hp:colPr — 편집기 '새 구역' 차례)도 부호다(section: 문단 맨 앞, first: 구역 첫 문단의 것 —
 * 지문(objectPrint)에 넣지 않고 옮기지도 않는다). types = 필드 시작 id → 종류(문서 전체 — HwpxDoc._fieldTypes).
 */
function paragraphCodes(sec, p, types = fieldTypes(sec), bfKey = null) {
  const out = [];
  const sectionCols = new Set();
  let fin = null;
  const posOf = (a) => {
    if (!fin) { fin = [0]; for (const c of p.chars) fin.push(fin[fin.length - 1] + (c.del ? 0 : 1)); }
    return fin[Math.min(a.pos, fin.length - 1)];
  };
  // [hwpx-cowork] 형광펜(hp:t 안 hp:markpenBegin color / hp:markpenEnd — 한/글 2022 MarkPenShape 실측, h2022-format 2026-11-12).
  // 열쇠 = 색 + 칠한 글(최종본) — 범위 밖 글을 고쳐도 덩어리가 나지 않고, 범위·색이 바뀌면 난다. 옮길 때는 문단의 형광펜을 통째로 바꾼다(copyObjectsFrom)
  const pens = p.anchors.filter((a) => a.kind === 'inline' && (a.name === 'hp:markpenBegin' || a.name === 'hp:markpenEnd'));
  if (pens.length) {
    const text = Section.text(p, 'final');
    for (let i = 0; i < pens.length; i++) {
      const a = pens[i];
      const begin = a.name === 'hp:markpenBegin';
      const mate = begin ? pens.slice(i + 1).find((b) => b.name === 'hp:markpenEnd') : [...pens.slice(0, i)].reverse().find((b) => b.name === 'hp:markpenBegin');
      const [from, to] = begin ? [posOf(a), mate ? posOf(mate) : text.length] : [mate ? posOf(mate) : 0, posOf(a)];
      const covered = text.slice(from, to);
      const color = begin ? (a.attrs?.get('color') ?? '').toUpperCase() : '';
      out.push({ a, key: `${a.name}|${color}|${covered}`, label: '형광펜', pos: posOf(a), xml: sec.xml.slice(a.start, a.end), inline: true, markpen: true });
    }
  }
  for (const a of p.anchors) {
    if (a.kind === 'inline' && (a.name === 'hp:markpenBegin' || a.name === 'hp:markpenEnd')) continue;
    if (a.kind === 'inline' && a.name === 'hp:titleMark') {
      const ig = a.attrs?.get('ignore') ?? '';
      out.push({ a, key: `hp:titleMark|ignore=${ig}`, label: ig === '1' ? '제목 차례 표시' : '차례 숨김', pos: posOf(a), xml: sec.xml.slice(a.start, a.end), inline: true });
      continue;
    }
    if (a.kind === 'ctrl' && a.name === 'hp:secPr') {
      if (p.parent) continue;
      const col = p.anchors.find((b) => b.kind === 'ctrl' && b.name === 'hp:ctrl' && b.inner === 'hp:colPr' && b.start > a.start);
      out.push({ a, col, key: 'hp:secPr', label: '구역 나누기', pos: 0, xml: sec.xml.slice(a.start, a.end) + (col ? sec.xml.slice(col.start, col.end) : ''), section: true, first: sec.bodyParas[0] === p });
      // [hwpx-cowork] 구역 정의 내용(용지·여백·각주/미주 모양·쪽 테두리·시작 번호·감추기 등 — 편집기 편집 용지·구역 설정·주석 모양·쪽 테두리 창)은
      // 구역 나누기 부호와 따로 견준다(secDef — 고치면 그 자리에서 바꾼다, copyObjectsFrom). 종전에는 열쇠가 늘 'hp:secPr' 라 이 값을 바꿔도
      // 덩어리가 0 이었다(2026-11-12 편집 보존 시험 — 서버에서 조용히 사라짐). 지문은 secDefKey(바탕쪽 참조·id 빼고, 쪽 테두리는 정의 내용으로)
      // 구역 첫 문단의 것만 싣는다: 구역 수가 바뀐 밀어 넣기(두 문서를 이어 견줌 — 가운데 구역 나누기)에서는 문단 짝이 다른 구역의 구역 정의를
      // 짝지을 수 있어(구역 나누기를 실은 붙여넣기) 그 구역 정의는 구역 나누기 부호째(넣고 빼기) 옮긴다
      if (sec.bodyParas[0] === p) {
        const sx = sec.xml.slice(a.start, a.end);
        out.push({ a, key: secDefKey(sx, bfKey), label: '구역 설정', pos: 0, xml: sx, secDef: true });
      }
      // [hwpx-cowork] 구역 첫 단 정의(다단 설정·구분선·단 너비 — 편집기 다단 설정 창)는 구역 나누기와 따로 견준다(colSection — 고치면 그 자리에서 바꾼다).
      // 종전에는 구역 나누기 열쇠가 늘 같아 단 설정을 바꿔도 서버에 실리지 않았다(h2022-format 2026-11-11)
      // 구역 나누기가 첫 문단이 아닌 자리로 옮겨 가도(맨 앞에 문단을 넣음) 같은 단 정의로 짝지어지게, 구역 나누기마다 싣는다
      if (col) {
        sectionCols.add(col);
        const cx = sec.xml.slice(col.start, col.end);
        out.push({ a: col, key: colDefKey(cx, '#sec'), label: '단 정의', pos: 0, xml: cx, colSection: true });
      }
      continue;
    }
    // [hwpx-cowork] 다단 설정 나누기(구역 가운데 문단 머리의 hp:colPr — 한/글 BreakColDef 실측: 그 문단 첫 run 머리) — 부호로 넣고 빼고 고친다
    if (a.kind === 'ctrl' && a.name === 'hp:ctrl' && a.inner === 'hp:colPr' && !p.parent) {
      if (sectionCols.has(a) || p.anchors.some((b) => b.kind === 'ctrl' && b.name === 'hp:secPr' && b.start < a.start)) continue;
      const cx = sec.xml.slice(a.start, a.end);
      out.push({ a, key: colDefKey(cx, ''), label: '다단 설정 나누기', pos: 0, xml: cx, colBreak: true });
      continue;
    }
    // [hwpx-cowork] 덧말(hp:dutmal)·글자 겹침(hp:compose) — run 의 직접 자식(hp:ctrl 로 싸지 않음, 한/글 2022 저장본 실측 2026-11-11).
    // 글(hp:t)이 아니라 글 비교에 안 보이므로 부호처럼 object 덩어리로 옮긴다(편집기 '덧말 넣기'·'글자 겹치기' — 종전에는 서버에서 사라졌다).
    // 열쇠는 모양 번호(charPr·스타일 id)를 빼고 뜻만 — 손대지 않은 문서가 덩어리를 내지 않게
    if (a.kind === 'ctrl' && (a.name === 'hp:dutmal' || a.name === 'hp:compose')) {
      const xml = sec.xml.slice(a.start, a.end);
      out.push({ a, key: composeCodeKey(a.name, xml), label: a.name === 'hp:dutmal' ? '덧말' : '글자 겹침', pos: posOf(a), xml, compose: true });
      continue;
    }
    if (a.kind !== 'ctrl' || a.name !== 'hp:ctrl') continue;
    if (a.inner === 'hp:fieldBegin' || a.inner === 'hp:fieldEnd') {
      const xml = sec.xml.slice(a.start, a.end);
      const ref = a.innerAttrs?.get('beginIDRef') ?? '';
      if (a.inner === 'hp:fieldEnd' && !types.has(ref)) {
        out.push({ a, key: 'hp:fieldEnd|?', label: '짝 없는 필드 끝', pos: posOf(a), xml });
        continue;
      }
      const type = a.inner === 'hp:fieldBegin' ? (a.innerAttrs?.get('type') ?? '') : (types.get(ref) ?? '');
      if (!LINK_FIELD_TYPES.has(type)) continue;
      const cmd = a.inner === 'hp:fieldBegin' ? (/<hp:stringParam name="Command"[^>]*>([\s\S]*?)<\/hp:stringParam>/.exec(xml)?.[1] ?? '') : '';
      out.push({ a, key: `${a.inner}|${type}|${cmd}`, label: `${FIELD_LABEL[type]}${a.inner === 'hp:fieldEnd' ? ' 끝' : ''}`, pos: posOf(a), xml });
      continue;
    }
    // [hwpx-cowork] 머리말·꼬리말(본문 문단의 것)도 지울 수 있는 부호 — 편집기에서 지우거나 새로 만들면 object 덩어리로 옮겨 간다
    // (열쇠 = 종류·적용 쪽; 안 문단 글은 중첩 문단 비교가 맡는다. 넣을 때는 모양 번호를 이 문서 것으로 — _importHeaderFooter)
    if ((a.inner === 'hp:header' || a.inner === 'hp:footer') && !p.parent) {
      out.push({ a, key: headerFooterKey(a), label: codeLabel(a.inner, a.innerAttrs), pos: posOf(a), xml: sec.xml.slice(a.start, a.end), hf: true });
      continue;
    }
    if (!CODE_TAGS[a.inner]) continue;
    const key = [a.inner, ...CODE_TAGS[a.inner].map((k) => `${k}=${a.innerAttrs?.get(k) ?? ''}`)].join('|');
    out.push({ a, key, label: codeLabel(a.inner, a.innerAttrs), pos: posOf(a), xml: sec.xml.slice(a.start, a.end) });
  }
  return out;
}

/**
 * [hwpx-cowork] 구역 정의(hp:secPr 요소 하나) 비교 열쇠 — 정규 나무 지문(canonLines). 빼는 것: 구역 id(편집기·서버가 따로 매김), 바탕쪽 참조
 * (hp:masterPage·masterPageCnt — 바탕쪽은 다른 꾸러미 부분이라 이 경로로 옮기지 않는다). 쪽 테두리의 borderFillIDRef 는 정의 내용 열쇠로(bfKey).
 * 한/글 문서 223개를 편집기에서 손대지 않고 내보낸 245개 구역 정의는 모두 같은 지문이었다(fp_probe.mjs, 2026-11-12)
 */
const SECDEF_SKIP_TAGS = new Set(['hp:masterPage']);
const SECDEF_SKIP_ATTRS = new Set(['id', 'masterPageCnt']);
function secDefKey(xml, bfKey = null) {
  const mapAttr = bfKey ? (k, v) => (k === 'borderFillIDRef' ? bfKey(v) : v) : null;
  return `hp:secPr#def|${shortHash(canonLines(xml, { skipTags: SECDEF_SKIP_TAGS, skipAttrs: SECDEF_SKIP_ATTRS, mapAttr }).join('\n'))}`;
}
/**
 * [hwpx-cowork] 구역 정의를 sxml(편집기 것) 내용으로 바꾼 XML — 이 문서의 구역 id·바탕쪽 참조(hp:masterPage·masterPageCnt)는 그대로 둔다
 * (바탕쪽 꾸러미 부분은 옮기지 않으므로). 머리 정의 참조(쪽 테두리 borderFillIDRef)는 부르는 쪽이 importFormattingRefs 로 이 문서 번호로 바꾼다
 */
function mergeSecDef(txml, sxml) {
  const tOpen = (/^<hp:secPr\b[^>]*>/.exec(txml) || [''])[0];
  const keep = {}; for (const k of ['id', 'masterPageCnt']) { const v = tagAttr(tOpen, k); if (v != null) keep[k] = v; }
  const tMaster = (txml.match(/<hp:masterPage\b[^>]*\/>/g) || []).join('');
  let out = sxml.replace(/^<hp:secPr\b[^>]*>/, (o) => setTagAttrs(o, keep));
  const at = out.search(/<hp:masterPage\b/);
  out = out.replace(/<hp:masterPage\b[^>]*\/>/g, '');
  if (tMaster) {
    const pos = at >= 0 ? at : out.lastIndexOf('</hp:secPr>');
    if (pos >= 0) out = out.slice(0, pos) + tMaster + out.slice(pos);
  }
  return out;
}

/** [hwpx-cowork] 단 정의(hp:colPr) 비교 열쇠 — 뜻만(종류·방향·단 수·같은 너비·간격·구분선·단별 너비). 쓰는 꼴(id·공백)은 보지 않는다 */
function colDefKey(xml, tag) {
  const open = /<hp:colPr\b[^>]*>/.exec(xml)?.[0] ?? '';
  const at = (t, k) => tagAttr(t, k) ?? '';
  const same = at(open, 'sameSz') === '1' || at(open, 'sameSz') === 'true';
  const line = /<hp:colLine\b[^>]*>/.exec(xml)?.[0];
  const sz = same ? [] : [...xml.matchAll(/<hp:colSz\b[^>]*>/g)].map((m) => `${at(m[0], 'width')}/${at(m[0], 'gap')}`);
  return [`hp:colPr${tag}`, at(open, 'type'), at(open, 'layout'), at(open, 'colCount'), same ? 1 : 0, same ? at(open, 'sameGap') : '',
    line ? `${at(line, 'type')}/${at(line, 'width')}/${at(line, 'color').toUpperCase()}` : '', sz.join(',')].join('|');
}

/** [hwpx-cowork] 단 정의 요소(hp:colPr — 홀로 닫힘이면 여는 태그만, 아니면 </hp:colPr> 까지)의 [시작, 끝) */
function colPrSpan(xml, from) {
  const open = /<hp:colPr\b[^>]*>/.exec(xml.slice(from));
  if (!open) return null;
  const start = from + open.index;
  if (open[0].endsWith('/>')) return [start, start + open[0].length];
  const k = xml.indexOf('</hp:colPr>', start);
  return k < 0 ? null : [start, k + '</hp:colPr>'.length];
}

/** [hwpx-cowork] 구역 첫 단 정의를 source 의 것으로 바꾸는 편집(자리 그대로) */
function colPrReplaceEdit(xml, a, sourceXml) {
  const t = colPrSpan(xml, a.start); const s = colPrSpan(sourceXml, 0);
  if (!t || !s || t[1] > a.end) return null;
  return { start: t[0], end: t[1], insert: sourceXml.slice(s[0], s[1]) };
}

/** [hwpx-cowork] 덧말·글자 겹침의 비교 열쇠(뜻만 — 모양 번호 빼고). 덧말 스타일은 스타일 쓰기(option 4)일 때만 */
function composeCodeKey(name, xml) {
  const open = /^<[^>]*>/.exec(xml)?.[0] ?? '';
  const at = (k) => tagAttr(open, k) ?? '';
  if (name === 'hp:dutmal') {
    const text = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? '';
    const style = (Number(at('option')) & 4) ? at('styleIDRef') : '';
    return ['hp:dutmal', at('posType'), at('szRatio'), at('option'), at('align'), style, text('hp:mainText'), text('hp:subText')].join('|');
  }
  return ['hp:compose', at('circleType'), at('charSz'), at('composeType'), at('composeText')].join('|');
}

/** [hwpx-cowork] 다른 문서에서 옮겨 오는 덧말·글자 겹침 XML 의 모양 번호(글자 겹침 charPr prIDRef·덧말 styleIDRef)를 이 문서 번호로 */
function importComposeRefs(doc, source, xml) {
  // 글자 겹침의 글자 모양 참조는 prIDRef(미설정 4294967295 는 그대로) — importFormattingRefs 가 아는 이름으로 잠시 바꿔 옮긴다
  const marked = xml.replace(/<hp:charPr prIDRef="(\d+)"/g, (m, id) => (id === '4294967295' ? m : `<hp:charPr charPrIDRef="${id}"`));
  let out = marked;
  try { out = importFormattingRefs(doc, source, marked); } catch (e) { if (!(e instanceof EngineError)) throw e; }
  return out.replace(/<hp:charPr charPrIDRef="(\d+)"/g, '<hp:charPr prIDRef="$1"');
}

/** 최종본 글자 자리 offset 의 hp:t 안에 인라인 요소(제목 차례 표시 등)를 넣는 편집 */
function inlineInsertEdit(sec, p, offset, xml) {
  const fc = Section.visibleChars(p, 'final');
  if (!fc.length) return emptyParagraphEdit(sec, p, 'inline', xml);
  if (offset < fc.length) return { pos: beforeChar(p, p.chars.indexOf(fc[Math.max(0, offset)])), insert: xml };
  return { pos: afterChar(p, p.chars.indexOf(fc[fc.length - 1])), insert: xml };
}

/** 열쇠 목록 둘의 가장 긴 공통 부분 차례 → [[i, j], …] */
function keyLcs(A, B) {
  const n = A.length; const m = B.length;
  if (!n || !m) return [];
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return out;
}

/** 조판 부호 지우기 편집 — hp:ctrl 안에 그 부호 하나뿐이면 hp:ctrl 째로, 아니면 부호 요소만 */
function codeRemoveEdit(xml, a) {
  const ctrl = xml.slice(a.start, a.end);
  const s = a.innerStart - a.start;
  const open = xml.slice(a.innerStart, a.innerEnd);
  let e = a.innerEnd - a.start;
  if (!/\/>$/.test(open)) { const close = `</${a.inner}>`; const k = ctrl.indexOf(close, s); if (k >= 0) e = k + close.length; }
  const rest = ctrl.slice(0, s) + ctrl.slice(e);
  if (!/^<hp:ctrl\b[^>]*>\s*<\/hp:ctrl>$/.test(rest)) return { start: a.start + s, end: a.start + e, insert: '' };
  // 글 사이의 부호였으면(…</hp:t><hp:ctrl>…</hp:ctrl><hp:t>…) 양쪽 hp:t 를 하나로 잇는다
  if (xml.slice(a.start - 7, a.start) === '</hp:t>' && xml.startsWith('<hp:t>', a.end)) return { start: a.start - 7, end: a.end + 6, insert: '' };
  return { start: a.start, end: a.end, insert: '' };
}

/** 최종본 글자 자리 offset 에 hp:ctrl(run 의 직접 자식)을 넣는 편집 */
function ctrlInsertEdit(sec, p, offset, ctrlXml) {
  const fc = Section.visibleChars(p, 'final');
  if (!fc.length) return emptyParagraphEdit(sec, p, '', ctrlXml);
  if (offset < fc.length) return ctrlPointBefore(p, p.chars.indexOf(fc[Math.max(0, offset)]), ctrlXml);
  // [hwpx-cowork] 문단 끝: 마지막 글자 뒤에 있는 개체·부호(떠 있는 선 등)까지 지나 맨 끝에 — 한/글은 줄을 합칠 때 뒤 문단 부호를 앞 문단 맨 끝에
  // 붙인다(실측 2026-10-30: `bc[선][감추기]`). 마지막 글자 바로 뒤에 넣으면 `bc[감추기][선]` 이 되어 조판 부호 보기 차례가 달랐다
  const lastCi = p.chars.indexOf(fc[fc.length - 1]);
  const lastT = p.chars[lastCi]?.t;
  const tail = p.anchors.filter((a) => a.kind === 'ctrl' && lastT && a.start >= lastT.closeEnd && !(a.inner === 'hp:fieldEnd' || a.inner === 'hp:fieldBegin'));
  if (tail.length) return { pos: Math.max(...tail.map((a) => a.end)), insert: ctrlXml };
  return ctrlPointAfter(p, lastCi, ctrlXml);
}

/** 문단 맨 앞(첫 run 의 첫 자식 자리)에 xml 을 넣는 편집 — 구역 나누기(secPr·colPr)는 한/글처럼 첫 run 머리에 둔다 */
function runStartEdit(sec, p, xml) {
  const r = p.runs[0];
  if (!r) {
    const open = sec.xml.indexOf('>', p.start) + 1;
    return { pos: open, insert: `<hp:run charPrIDRef="0">${xml}</hp:run>` };
  }
  const open = sec.xml.slice(r.start, sec.xml.indexOf('>', r.start) + 1);
  if (r.selfclose) return { start: r.start, end: r.start + open.length, insert: `${open.replace(/\s*\/>$/, '>')}${xml}</hp:run>` };
  return { pos: r.start + open.length, insert: xml };
}

/** src 글의 글자 자리 pos 를 dst 글(src 를 고친 글)의 자리로 — 바뀐 범위 안이면 그 범위 시작, 그 자리 넣기는 넣은 글 앞 */
function mapTextPos(src, dst, pos) {
  if (src === dst) return pos;
  let delta = 0;
  for (const o of charOps(src, dst)) {
    if (o.start >= pos) break;
    if (o.end <= pos) { delta += Array.from(o.text).length - (o.end - o.start); continue; }
    return Math.max(0, o.start + delta);
  }
  return Math.max(0, pos + delta);
}

/** 그림 크기 글('120×60mm') */
const sizeMm = (sz) => `${Math.round((Number(sz?.[0]) || 0) / MM)}×${Math.round((Number(sz?.[2]) || 0) / MM)}mm`;

/**
 * 두 문단(base bRef ↔ head hRef)의 그림 속성·조판 부호 차이 → { notes: ['그림 크기 150×75mm → 75×37mm', '조판 부호 지움: 번호(표)'],
 * basePrint, newPrint } | null(같음). 그림은 파일 열쇠 차례로 짝짓는다 — 짝은 속성, 짝 없는 것은 지움·넣음·바꿈(반영은 copyObjectsFrom)
 */
/** [hwpx-cowork] 개체 지문 판 — 2 = 단 정의 부호를 '~' 뒤에 따로 싣는 판(2026-11-12). 저장하는 지문에는 이 판을 함께 남긴다 */
export const OBJECT_PRINT_VERSION = 2;

function objectChange(base, bRef, head, hRef) {
  const B = base._objectInfo(bRef); const H = head._objectInfo(hRef);
  const idChange = !!H.pid && B.id !== H.pid;
  if (!B.pics.length && !H.pics.length && !B.tables.length && !H.tables.length && !B.codes.length && !H.codes.length && !idChange && !B.shapes.length && !H.shapes.length) return null;
  const notes = [];
  if (idChange) notes.push('하이퍼링크 대상 표시');
  const tp = pairTables(B.tables, H.tables);
  const tChanged = tp.pairs.filter(([i, j]) => B.tables[i].print !== H.tables[j].print).length;
  if (tChanged) notes.push(`표 고침(크기·줄·칸)${tChanged > 1 ? ` ${tChanged}개` : ''}`);
  // [hwpx-cowork] 뼈대는 같고 머리 속성(순서 zOrder·개체 보호 lock)만 다른 표 — 여는 태그 값만 옮긴다(copyObjectsFrom)
  // 표를 넣고 빼거나 뼈대를 고친 문단에서는 머리 속성 차이를 따로 알리지 않는다(새 표·다시 매긴 번호의 곁가지 — 격자 변경과 섞지 않음)
  const tHead = tChanged || tp.removed.length || tp.added.length ? 0
    : tp.pairs.filter(([i, j]) => JSON.stringify(B.tables[i].head) !== JSON.stringify(H.tables[j].head)).length;
  if (tHead) notes.push(`표 순서·보호${tHead > 1 ? ` ${tHead}개` : ''}`);
  if (tp.removed.length) notes.push(`표 지움${tp.removed.length > 1 ? ` ${tp.removed.length}개` : ''}`);
  if (tp.added.length) notes.push(`표 넣음${tp.added.length > 1 ? ` ${tp.added.length}개` : ''}`);
  // [hwpx-cowork] 구역 정의 내용(secDef)은 넣고 빼는 부호가 아니라 그 자리의 설정 — 차례대로 견준다(2026-11-12 편집 보존)
  const BC = B.codes.filter((c) => !c.secDef); const HC = H.codes.filter((c) => !c.secDef);
  const bDef = B.codes.filter((c) => c.secDef); const hDef = H.codes.filter((c) => c.secDef);
  if (bDef.length === hDef.length && bDef.some((c, i) => c.key !== hDef[i].key)) notes.push('구역 설정 바꿈(용지·여백·주석 모양 등)');
  const pairs = keyLcs(BC.map((c) => c.key), HC.map((c) => c.key));
  const kb = new Set(pairs.map(([i]) => i)); const kh = new Set(pairs.map(([, j]) => j));
  const gone = BC.filter((_, i) => !kb.has(i)); const added = HC.filter((_, j) => !kh.has(j));
  if (gone.length) notes.push(`조판 부호 지움: ${gone.map((c) => c.label).join(', ')}`);
  if (added.length) notes.push(`조판 부호 넣음: ${added.map((c) => c.label).join(', ')}`);
  // 그림: 파일 열쇠 차례로 짝짓고(LCS) 짝은 속성, 짝 없는 것은 지움·넣음(둘 다면 바꿈)
  const pp = keyLcs(B.pics.map((x) => x.key), H.pics.map((x) => x.key));
  const pb = new Set(pp.map(([i]) => i)); const ph = new Set(pp.map(([, j]) => j));
  const picGone = B.pics.filter((_, i) => !pb.has(i)); const picAdded = H.pics.filter((_, j) => !ph.has(j));
  const swap = Math.min(picGone.length, picAdded.length);
  if (swap) notes.push(`그림 바꿈${swap > 1 ? ` ${swap}개` : ''}`);
  if (picGone.length > swap) notes.push(`그림 지움${picGone.length - swap > 1 ? ` ${picGone.length - swap}개` : ''}: ${picGone.slice(swap).map((x) => sizeMm(x.props.sz)).join(', ')}`);
  if (picAdded.length > swap) notes.push(`그림 넣음${picAdded.length - swap > 1 ? ` ${picAdded.length - swap}개` : ''}: ${picAdded.slice(swap).map((x) => sizeMm(x.props.sz)).join(', ')}`);
  for (const [i, j] of pp) {
    const x = B.pics[i]; const y = H.pics[j];
    if (JSON.stringify(x.props) === JSON.stringify(y.props)) {
      // [hwpx-cowork] 목록 밖 속성(테두리 선·그림 효과·설명 등 — pictureMore)만 다름
      if (x.more !== y.more) notes.push('그림 모양 변경(선·효과 등)');
      continue;
    }
    notes.push(JSON.stringify(x.props.sz) !== JSON.stringify(y.props.sz) ? `그림 크기 ${sizeMm(x.props.sz)} → ${sizeMm(y.props.sz)}` : '그림 배치·여백 변경');
  }
  // [hwpx-cowork] 도형: 이름+id 로 짝짓고(engine/shapes.js pairShapes) 짝은 옮김·크기·모양, 짝 없는 것은 지움·넣음(반영은 copyObjectsFrom)
  const sp = pairShapes(B.shapes, H.shapes);
  const shpMm = (sz) => `${Math.round((sz?.[0] || 0) / MM)}×${Math.round((sz?.[1] || 0) / MM)}mm`;
  if (sp.removed.length) notes.push(`도형 지움: ${sp.removed.map((i) => shapeName(B.shapes[i].tag, B.shapes[i].xml)).join(', ')}`);
  if (sp.added.length) notes.push(`도형 넣음: ${sp.added.map((j) => shapeName(H.shapes[j].tag, H.shapes[j].xml)).join(', ')}`);
  for (const [i, j] of sp.pairs) {
    const x = B.shapes[i]; const y = H.shapes[j];
    if (x.print === y.print) continue;
    const c = shapeChange(x.props, y.props); const what = [];
    if (c.moved) what.push('옮김');
    if (c.resized) what.push(`크기 ${shpMm(x.props.sz)} → ${shpMm(y.props.sz)}`);
    if (c.other || !what.length) what.push('모양 바꿈');
    notes.push(`${shapeName(x.tag, x.xml)} ${what.join('·')}`);
  }
  if (!notes.length) return null;
  // [hwpx-cowork] 판 2 지문이 같고 덧지문만 다른 변경(그림 선·효과, 구역 정의 내용, 표 순서·보호 — 2026-11-12 편집 보존)은 덧지문까지 실은 전체 지문을
  // 싣는다('^' — matchesObjectPrint 가 전체로 견줌). 판 2 로 보이는 변경은 종전처럼 objectPrint(반영 쪽 '이미 같음' 판정·충돌 판정이 종전과 같다)
  const bp = base.objectPrint(bRef); const np = head.objectPrint(hRef);
  // [hwpx-cowork] 검토 P1(2026-11-12): 판 2 지문도 바뀐 덩어리라도 덧지문(판 2 와 겹치지 않는 몫)이 바뀌었으면 전체 지문을 싣는다 — 다단(판 2)과
  // 여백(덧지문)을 함께 바꾼 덩어리를 남이 같은 다단을 먼저 반영한 문서에 대면 판 2 지문만으로는 '이미 같음'(crs._place SAME)이 되어 여백이 버려졌다
  if (bp === np || base._objectExtraPrint(bRef) !== head._objectExtraPrint(hRef)) return { notes, basePrint: base.objectPrintFull(bRef), newPrint: head.objectPrintFull(hRef) };
  return { notes, basePrint: bp, newPrint: np };
}

/** 위치 편집 목록을 뒤에서부터 적용. {pos, insert} 또는 {start, end, insert}. 같은 위치는 주어진 순서를 유지. */
export function applyEdits(xml, edits) {
  // [hwpx-cowork] 앞에서부터 조각을 이어 붙인다(편집 수 × 구역 길이만큼 문자열을 다시 만들지 않게 — 2.5MB 구역에 편집 수백 개). 뒤에서부터 차례로
  // 적용한 예전 결과와 같다: 같은 자리는 주어진 순서, 같은 시작이면 짧은 범위(넣기)가 앞, 이웃한 두 편집이 겹치면 EDIT_OVERLAP
  const list = edits.map((e, i) => ({ start: e.pos ?? e.start, end: e.end ?? e.pos ?? e.start, insert: e.insert || '', i }));
  list.sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.i - b.i));
  const parts = []; let at = 0;
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    if (k + 1 < list.length && e.end > list[k + 1].start) throw new EngineError('EDIT_OVERLAP', '편집 범위가 겹칩니다');
    parts.push(xml.slice(at, e.start), e.insert);
    at = e.end;
  }
  parts.push(xml.slice(at));
  return parts.join('');
}
