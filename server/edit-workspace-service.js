// 요청별 실험 사본: 내용 → 형식 → 묶음 제안. 모든 쓰기는 기존 선점·시도·문서 큐를 거친다.
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import crypto from 'node:crypto';
import { HwpxDoc } from '../engine/doc.js';
import { listFields } from '../engine/fields.js';
import { docBytesSync, containerFromBytesSync } from '../engine/toc.js';
import { writeFileAtomic } from './store.js';
import { normalizeEditOperations, documentEditHash, contentEditHash, contentMarkdown, insertDocumentFeature, applyStyleOperation } from './document-edit.js';
import { debugRecord } from './ai-debug.js';
import { ServiceError } from './service.js';

const error = (code, message) => new ServiceError(code, message,
  ['NOT_OWNER', 'FORBIDDEN'].includes(code) ? 403 : code === 'EDIT_SNAPSHOT_MISSING' ? 404
    : ['EDIT_SOURCE_CHANGED', 'EDIT_REVISION', 'EDIT_INCOMPLETE', 'CLAIM_REQUIRED', 'REQUEST_CLOSED', 'STALE'].includes(code) ? 409 : 400);
export const EDIT_BATCH_SOURCE = Symbol('validatedEditWorkspace');
const compress = bytes => deflateRawSync(bytes).toString('base64');
const restore = value => new HwpxDoc(containerFromBytesSync(inflateRawSync(Buffer.from(value, 'base64'))));
const PROPOSAL_STATE = ['ref', 'afterRef', 'insertedRef', 'captionRef', 'tableKey', 'start', 'end', 'offset', 'find', 'occurrence', 'figure', 'lost', 'refGone', 'insertedGone', 'applyConflict', 'formatSnapshot', 'formatFingerprint', 'formatUndo', 'formatBefore', 'formatAfterFingerprint', 'split', 'changeIds', 'appliedRange', 'appliedFinal', 'autoAccepted'];
const select = (o, fields) => Object.fromEntries(fields.filter(k => Object.hasOwn(o, k)).map(k => [k, structuredClone(o[k])]));
function referenceState(meta, excludePid) {
  return { seq: { proposal: meta.seq.proposal, request: meta.seq.request },
    proposals: meta.proposals.filter(p => p.pid !== excludePid).map(p => ({ pid: p.pid, values: select(p, PROPOSAL_STATE) })),
    requests: meta.requests.map(r => ({ rid: r.rid, values: select(r, ['ref', 'target', 'memoId', 'comments']) })),
    shared: select(meta, ['memoThreads', 'locks', 'liveTouch']) };
}
const stateHash = state => crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
function putState(target, values, keys) { for (const k of keys) { if (Object.hasOwn(values, k)) target[k] = structuredClone(values[k]); else delete target[k]; } }

export const editWorkspaceMethods = {
  _editWorkspaceActor(meta, r, user) {
    // 실험이 꺼져 있으면(기본 — server/config.js experiments.contentFormat) 사본을 읽거나 고치는 처리 중 작업을 받지 않는다. 이미 저장된 사본 파일 내려받기(editWorkspaceFile)는 그대로다
    if (!this._contentFormatOn()) throw error('EDIT_WORKFLOW_OFF', '내용·형식 나눠 처리(실험)는 이 서버에서 쓰지 않습니다 — 이 요청은 그만두세요');
    if (!Number.isSafeInteger(user?.agentAttempt) || user.agentAttempt < 1) throw error('ATTEMPT_REQUIRED', '실험 사본에는 expected_attempt가 필요합니다');
    this._assertCanEdit(user, meta); this._assertRequestAttempt(r, user);
    this._assertResultClaim(r, user, user.agentSession);
    if (!this._mayTake(r, user, user.agentSession)) throw error('NOT_OWNER', '이 요청을 맡을 권한이 없습니다');
    if (!this._isServerRunActor(user) && (this._claimExpired(r.claim) || !this._holdsClaim(r, user, user.agentSession))) throw error('CLAIM_REQUIRED', '현재 세션에서 start_request로 유효한 선점을 얻은 뒤 사본을 편집하세요');
    if (r.status !== 'working') throw error('REQUEST_CLOSED', '처리 중인 요청의 실험 사본만 편집할 수 있습니다');
    if (r.options?.workflow !== 'content_format') throw error('EDIT_WORKFLOW', '내용·형식 분리 실험을 선택한 요청이 아닙니다');
  },
  _editWorkspaceFile(id, r, revision, attempt = this._attempt(r)) {
    return path.join(this.store._docDir(id), 'edit-workspaces', `r${r.rid}-a${attempt}-v${revision}.hwpx`);
  },
  _editWorkspaceEnsure(id, doc, meta, r) {
    const attempt = this._attempt(r);
    if (r.editWorkspace?.attempt === attempt) return r.editWorkspace;
    let revision = 0;
    while (fs.existsSync(this._editWorkspaceFile(id, r, revision))) revision++;
    const file = this._editWorkspaceFile(id, r, revision); fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, docBytesSync(doc));
    r.editWorkspace = { attempt, revision, stage: 'content', baseHash: documentEditHash(doc), operations: [], stages: [] };
    this.store.saveMeta(meta);
    return r.editWorkspace;
  },
  _editWorkspaceDoc(id, r) {
    return new HwpxDoc(containerFromBytesSync(fs.readFileSync(this._editWorkspaceFile(id, r, r.editWorkspace.revision))));
  },
  async readEditWorkspace(id, rid, { part = 'content', from = 0, maxChars = 30000 } = {}, user) {
    return this._read(id, async () => {
      const { doc, meta } = await this._load(id), r = this._req(meta, rid);
      if (r.status === 'working') this._editWorkspaceActor(meta, r, user);
      else if (r.by !== user.name && user.role !== 'admin') throw error('NOT_OWNER', '내 실험 사본만 읽을 수 있습니다');
      const w = this._editWorkspaceEnsure(id, doc, meta, r);
      if (documentEditHash(doc) !== w.baseHash && w.stage !== 'published') throw error('EDIT_SOURCE_CHANGED', '원문이 바뀌었습니다. 실험을 다시 요청하세요. 작업 사본은 보존했습니다');
      const draft = this._editWorkspaceDoc(id, r);
      const base = { revision: w.revision, stage: w.stage, sourceHash: w.baseHash, draftHash: documentEditHash(draft), stages: w.stages };
      let items;
      if (part === 'receipts') items = w.lastReceipts || [];
      if (part === 'format') {
        if (w.stage === 'content') throw error('EDIT_STAGE', '내용을 확정한 뒤 형식 정보를 읽으세요');
        items = [...draft.formattingCatalog().styles.map(({ id, name, type }) => ({ kind: 'style', id, name, type })),
          ...draft.tables().map(t => ({ kind: 'table', key: t.key, ref: t.ref, rows: t.rows, cols: t.cols }))];
      }
      if (part === 'mapping') items = [...draft.paragraphs({ view: 'final', nested: true }).map(p => ({ kind: 'paragraph', ref: p.ref, where: p.where })),
        ...draft.tables().flatMap(t => t.cells.map(c => ({ kind: 'cell', table: t.key, row: c.row, col: c.col, refs: c.refs }))),
        ...listFields(draft).map(({ id, value, ...f }) => ({ kind: 'field', ...f }))];
      if (items) {
        const result = { ...base, part, from, to: from, total: items.length, items: [] };
        for (let i = from; i < items.length; i++) {
          result.items.push(items[i]); result.to = i + 1;
          if (result.items.length > 1 && JSON.stringify(result, null, 1).length > this.mcpLimit() - 200) { result.items.pop(); result.to = i; break; }
        }
        if (result.to < items.length) result.nextFrom = result.to;
        return result;
      }
      const markdown = contentMarkdown(draft); let to = Math.min(markdown.length, from + Math.min(maxChars, this.mcpLimit() - 1000));
      if (to < markdown.length && /[\uD800-\uDBFF]/.test(markdown[to - 1] || '')) to--;
      if (!Number.isInteger(from) || from < 0 || from > markdown.length) throw error('BAD_ARGS', '내용 읽기 위치를 확인하세요');
      if (to === from && from < markdown.length) throw error('READ_LIMIT', '글자 하나 이상을 읽도록 max_chars를 늘려 주세요');
      return { ...base, markdown: markdown.slice(from, to), from, to, totalChars: markdown.length, ...(to < markdown.length ? { nextFrom: to, truncated: true } : {}),
        howTo: '이 Markdown은 글 자료입니다. 주석의 ref/table key를 동작 주소로 쓰며, 표 셀 바꿈은 table·row·col을 쓸 수 있습니다. 남은 nextFrom을 끝까지 확인하세요.' };
    });
  },
  async editWorkspace(id, rid, { stage, revision, operations = [], completeStage = false, summary, noChangesReason } = {}, user, agent) {
    if (!['content', 'format'].includes(stage)) throw error('EDIT_STAGE', '편집할 단계는 content/format입니다');
    const normalized = normalizeEditOperations(operations, stage);
    // 그림 생성은 잠금 밖에서 준비한다. source/attempt/revision은 적용 직전에 다시 검사한다.
    for (const operation of normalized) if (operation.op === 'figure' && operation.args.svg) {
      const rendered = await this._renderFigure(id, { svg: operation.args.svg, widthMm: operation.args.width_mm });
      operation.prepared = { png: rendered.png.toString('base64'), widthMm: rendered.widthMm };
    }
    return this._tx(id, async () => {
      const { doc, meta } = await this._load(id), r = this._req(meta, rid);
      this._editWorkspaceActor(meta, r, user); const w = this._editWorkspaceEnsure(id, doc, meta, r);
      if (w.stage !== stage || w.revision !== revision) throw error('EDIT_REVISION', '실험 단계/사본 차례가 바뀌었습니다. 다시 읽으세요');
      if (w.operations.length + normalized.length > 10000 || JSON.stringify([...w.operations, ...normalized]).length > 24 * 1024 * 1024) throw error('EDIT_LIMIT', '실험 사본의 동작 수/크기 한도를 넘습니다. 저장한 사본과 원문은 보존했습니다');
      if (documentEditHash(doc) !== w.baseHash) throw error('EDIT_SOURCE_CHANGED', '원문이 바뀌었습니다. 작업 사본은 보존했습니다');
      const draft = this._editWorkspaceDoc(id, r), draftMeta = structuredClone(meta);
      const ctx = this._ctx(id, draft, draftMeta, this.authorName(user, agent)); ctx.preview = true;
      const beforeContent = contentEditHash(draft);
      const receipts = this._applyEditOperations(ctx, normalized);
      if (stage === 'format' && contentEditHash(draft) !== beforeContent) throw error('EDIT_CONTENT_CHANGED', '형식 단계가 확정된 본문 글을 바꿨습니다. 이 호출은 저장하지 않았습니다');
      if (completeStage && !w.operations.some(o => o.stage === stage) && !normalized.length && !String(noChangesReason || '').trim()) throw error('EDIT_NO_RESULTS', '작업이 없는 단계는 no_changes_reason에 확인한 범위와 사유를 적으세요');
      let nextRevision = w.revision + 1;
      // 메타 저장 직전 중단돼 남은 사본도 실패 증거이므로 덮지 않는다.
      while (fs.existsSync(this._editWorkspaceFile(id, r, nextRevision))) nextRevision++;
      writeFileAtomic(this._editWorkspaceFile(id, r, nextRevision), docBytesSync(draft));
      w.operations.push(...normalized.map(o => ({ ...o, stage }))); w.revision = nextRevision; w.lastReceipts = receipts;
      if (completeStage) {
        const markdown = contentMarkdown(draft);
        w.stages.push({ stage, revision: w.revision, summary: String(summary || '').slice(0, 2000), noChangesReason: String(noChangesReason || '').slice(0, 2000),
          contentHash: contentEditHash(draft), markdownChars: markdown.length, markdownBytes: Buffer.byteLength(markdown), at: new Date().toISOString() });
        w.stage = stage === 'content' ? 'format' : 'ready';
      }
      this.store.saveMeta(meta);
      debugRecord('edit.workspace.saved', { docId: id, requestId: r.rid, stage, revision: w.revision, nextStage: w.stage, receipts, sourceHash: w.baseHash });
      const result = { revision: w.revision, stage: w.stage, stageCompleted: completeStage, receiptCount: receipts.length, receipts: [], originalChanged: false };
      for (const receipt of receipts) {
        result.receipts.push(receipt);
        if (result.receipts.length > 1 && JSON.stringify(result, null, 1).length > this.mcpLimit() - 500) { result.receipts.pop(); result.nextReceiptFrom = result.receipts.length; break; }
      }
      return result;
    });
  },
  _applyEditOperations(ctx, operations) {
    const receipts = []; const { doc, meta } = ctx; const author = ctx.editAuthor || ctx.by;
    for (const { op, args: a, prepared } of operations) {
      if (['import_styles', 'define_style'].includes(op)) { receipts.push({ op, ...applyStyleOperation(doc, op, a) }); continue; }
      if (['hyperlink', 'field', 'note'].includes(op)) {
        const result = insertDocumentFeature(doc, op, a);
        if (/^s\d+\/p\d+$/.test(a.ref)) this._remapObjectChildren(meta, a.ref, result.nestedMapping, false);
        receipts.push({ op, ref: result.ref, fieldId: result.fieldId }); continue;
      }
      if (op === 'format') {
        const style = a.style_name ? doc.formattingCatalog().styles.find(s => s.name === a.style_name) : null;
        if (a.style_name && !style) throw error('NO_STYLE', `스타일이 없습니다: ${a.style_name}`);
        if (!style && !a.format) throw error('FORMAT_SPEC', 'style_name 또는 format이 필요합니다');
        for (const ref of a.refs) { const info = doc.inspectFormatting(ref); doc.formatRange(ref, { ...a.format, ...(style ? { styleId: style.id } : {}), start: 0, end: info.length }); }
        receipts.push({ op, paragraphs: a.refs.length }); continue;
      }
      if (op === 'figure' && prepared) {
        const m = /^s(\d+)\/p(\d+)$/.exec(a.after_ref); if (!m) throw error('BAD_REF', '그림의 본문 after_ref가 필요합니다');
        const result = doc.insertPictureAfter(+m[1], +m[2], { data: Buffer.from(prepared.png, 'base64'), caption: a.caption, widthMm: a.width_mm || prepared.widthMm }, { author });
        this._remapRefs(meta, +m[1], i => i > +m[2] ? i + result.bodyShift : i); receipts.push({ op, ref: result.ref }); continue;
      }
      let input;
      if (op === 'replace') {
        let ref = a.ref;
        if (!ref && a.table != null) ref = doc.tables().find(t => t.key === a.table)?.cells.find(c => c.row === a.row && c.col === a.col)?.refs?.[0];
        if (!ref) throw error('BAD_REF', '바꿀 문단 ref 또는 table·row·col이 필요합니다');
        input = { type: 'replace', ref, find: a.find, replace: a.replace, occurrence: a.occurrence };
      } else if (op === 'insert') input = { type: 'insert', afterRef: a.after_ref, paragraphs: a.paragraphs, text: a.paragraphs.map(p => p.text).join('\n') };
      else if (op === 'table') input = { type: 'table', afterRef: a.after_ref, table: { rows: a.rows, headerRows: a.header_rows ?? 1, caption: a.caption || '' } };
      else if (op === 'table_edit' || op === 'table_structure') input = { type: 'table_edit', tableEdit: { table: a.table, ops: a.ops } };
      else if (op === 'page_layout') input = { type: 'page_layout', pageLayout: { ops: a.ops } };
      else if (op === 'toc') input = { type: 'toc', toc: { at: a.ref, createIfMissing: a.create_if_missing, styles: a.apply_styles ? true : undefined, oneLine: a.one_line } };
      else if (op === 'delete') input = { type: 'delete', ref: a.ref, delete: { kinds: a.kinds } };
      else if (op === 'figure') input = { type: 'figure', afterRef: a.after_ref, figure: { aid: a.attachment_id, caption: a.caption, widthMm: a.width_mm } };
      else if (op === 'chart') input = { type: 'figure', afterRef: a.after_ref, figure: { nativeChart: a.chart, sourceTable: a.source_table, widthMm: a.width_mm, heightMm: a.height_mm } };
      else if (op === 'fill_field') input = { type: 'replace', fieldFill: { name: a.name, occurrence: a.occurrence }, replace: a.value };
      else throw error('EDIT_OPERATION', `지원하지 않는 동작: ${op}`);
      const proposal = this._proposeCore(ctx, { ...input, reason: a.reason || '내용·형식 분리 실험', memo: false }, author);
      this._applyCore(ctx, proposal, ctx.by);
      receipts.push({ op, ref: proposal.insertedRef || proposal.ref, table: proposal.tableKey, status: proposal.status });
      meta.proposals = meta.proposals.filter(p => p !== proposal);
    }
    ctx.dirty = true; ctx.formatting = true;
    return receipts;
  },
  async publishEditWorkspace(id, rid, user, agent, { stage_usage } = {}) {
    return this._tx(id, async () => {
      const { doc, meta } = await this._load(id), r = this._req(meta, rid);
      this._editWorkspaceActor(meta, r, user); const w = r.editWorkspace;
      if (w?.stage === 'published') return { pid: w.proposalId, stage: 'published' };
      if (w?.stage !== 'ready') throw error('EDIT_INCOMPLETE', '내용과 형식 두 단계를 모두 끝낸 뒤 제안으로 저장하세요');
      if (documentEditHash(doc) !== w.baseHash) throw error('EDIT_SOURCE_CHANGED', '원문이 바뀌어 제안으로 저장하지 않았습니다. 사본은 보존했습니다');
      if (stage_usage) w.runnerStages = structuredClone(stage_usage);
      const p = this._proposeCore(this._ctx(id, doc, meta, this.authorName(user, agent)), { type: 'edit_batch', rid: r.rid, memo: false,
        [EDIT_BATCH_SOURCE]: true,
        ref: r.target.ref, reason: w.stages.map(s => s.summary || s.noChangesReason).filter(Boolean).join('\n'),
        batchSnapshot: { baseHash: w.baseHash, bodyHash: contentEditHash(this._editWorkspaceDoc(id, r)), operations: w.operations },
        batch: { attempt: w.attempt, revision: w.revision, contentOperations: w.operations.filter(o => o.stage === 'content').length, formatOperations: w.operations.filter(o => o.stage === 'format').length,
          features: [...new Set(w.operations.map(o => o.op))] } }, this.authorName(user, agent));
      w.proposalId = p.pid; w.stage = 'published'; this.store.saveMeta(meta);
      this.hub.broadcast(id, { type: 'proposal', action: 'created', pid: p.pid, rid: r.rid, by: p.by, version: meta.version });
      return { pid: p.pid, status: p.status, stage: w.stage, batch: p.batch, originalChanged: false };
    });
  },
  async recordEditStage(id, rid, { stage, usage, model, fresh_conversation } = {}, user) {
    return this._tx(id, async () => {
      const meta = this._meta(id), r = this._req(meta, rid); this._editWorkspaceActor(meta, r, user);
      const record = r.editWorkspace?.stages.find(s => s.stage === stage);
      if (!record) throw error('EDIT_STAGE', '완료되어 저장된 단계만 사용량을 기록할 수 있습니다');
      record.usage = usage || null; record.model = model || null; record.freshConversation = fresh_conversation === true;
      this.store.saveMeta(meta); debugRecord('edit.stage.usage', { docId: id, requestId: rid, ...record });
      return { stage, recorded: true };
    });
  },
  async editWorkspaceFile(id, rid, { kind = 'hwpx', attempt, revision } = {}, user) {
    return this._read(id, async () => {
      const meta = this._meta(id), r = this._req(meta, rid); this.assertDocRead(id, user);
      if (!r.editWorkspace) throw error('EDIT_WORKFLOW', '저장된 실험 사본이 없습니다');
      attempt = Number(attempt ?? r.editWorkspace.attempt); revision = Number(revision ?? r.editWorkspace.revision);
      if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(revision) || revision < 0) throw error('BAD_ARGS', '사본 차례를 확인하세요');
      const published = meta.proposals.some(p => p.type === 'edit_batch' && p.rid === r.rid && p.batch.attempt === attempt && p.batch.revision === revision);
      if (r.by !== user.name && user.role !== 'admin' && !published) throw error('NOT_OWNER', '공유 제안으로 저장하기 전의 사본은 작성자만 내려받을 수 있습니다');
      let bytes;
      try { bytes = fs.readFileSync(this._editWorkspaceFile(id, r, revision, attempt)); }
      catch (e) { if (e.code === 'ENOENT') throw error('EDIT_SNAPSHOT_MISSING', '해당 시도/차례의 실험 사본이 없습니다'); throw e; }
      if (kind === 'markdown') return Buffer.from(contentMarkdown(new HwpxDoc(containerFromBytesSync(bytes))), 'utf8');
      if (kind !== 'hwpx') throw error('BAD_ARGS', '사본 종류는 hwpx/markdown입니다');
      return bytes;
    });
  },
  _applyEditBatch(ctx, p) {
    if (documentEditHash(ctx.doc) !== p.batchSnapshot.baseHash) throw error('EDIT_SOURCE_CHANGED', '제안 이후 원문이 달라졌습니다. 실험 사본은 보존했습니다');
    p.batchUndoSnapshot = { before: compress(docBytesSync(ctx.doc)), references: referenceState(ctx.meta, p.pid) };
    const previous = ctx.batchExecution, author = ctx.editAuthor; ctx.batchExecution = true; ctx.editAuthor = p.by;
    try {
      this._applyEditOperations(ctx, p.batchSnapshot.operations);
      if (contentEditHash(ctx.doc) !== p.batchSnapshot.bodyHash) throw error('EDIT_VERIFY', '실제 적용 본문이 검토한 사본과 다릅니다. 원문을 저장하지 않았습니다');
    } finally { ctx.batchExecution = previous; ctx.editAuthor = author; }
    (ctx.batchSnapshots ||= []).push(p);
  },
  _sealEditBatch(ctx) {
    for (const p of ctx.batchSnapshots || []) {
      p.batchUndoSnapshot.after = documentEditHash(ctx.doc);
      p.batchUndoSnapshot.afterReferences = stateHash(referenceState(ctx.meta, p.pid));
    }
  },
  _undoEditBatch(ctx, p) {
    const undo = p.batchUndoSnapshot;
    if (!undo || undo.after !== documentEditHash(ctx.doc) || undo.afterReferences !== stateHash(referenceState(ctx.meta, p.pid))) {
      throw error('STALE', '묶음 적용 뒤 문서/주소가 바뀌어 안전하게 되돌릴 수 없습니다. 이력의 원본과 사본은 보존되어 있습니다');
    }
    Object.assign(ctx.doc, restore(undo.before));
    for (const item of undo.references.proposals) { const current = ctx.meta.proposals.find(p => p.pid === item.pid); if (current) putState(current, item.values, PROPOSAL_STATE); }
    for (const item of undo.references.requests) { const current = ctx.meta.requests.find(r => r.rid === item.rid); if (current) putState(current, item.values, ['ref', 'target', 'memoId', 'comments']); }
    putState(ctx.meta, undo.references.shared, ['memoThreads', 'locks', 'liveTouch']);
    ctx.dirty = true; ctx.formatting = true; delete p.batchUndoSnapshot;
  },
};
