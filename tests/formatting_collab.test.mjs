import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const ref = 's0/p2';
async function baseDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  d.mergeParagraphText(ref, '제목 보통 문장', { author: '준비' }); d.acceptAll();
  d.formatRange(ref, { start: 0, end: 8, charPrId: '0' });
  return d;
}
async function working(api, d) {
  const r = await api.res(`${d}/file?kind=working`);
  return { doc: await HwpxDoc.load(r.data), version: Number(r.headers.get('x-doc-version')) };
}
const save = async d => Buffer.from(await d.save());

test('서식만 바꾼 실시간 저장·재시도·동시 서식 충돌 및 문단모양 보존', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a'); const up = await uploadDoc(srv.base, srv.tokens.a, await save(await baseDoc())); const D = `/api/docs/${up.id}`;
    const first = await working(A, D); const other = await HwpxDoc.load(await save(first.doc));
    first.doc.formatRange(ref, { start: 0, end: 8, paragraph: { align: 'CENTER', spaceAfterPt: 7 } });
    first.doc.formatRange(ref, { start: 0, end: 2, char: { bold: true } });
    const body = await save(first.doc);
    const pushed = await A(`${D}/live?base=${first.version}`, { method: 'PUT', body });
    assert.equal(pushed.clean, true); assert.deepEqual(pushed.applied.changed, [ref]);
    const now = await working(A, D); assert.equal(now.doc.inspectFormatting(ref).paragraph.align, 'CENTER');
    assert.equal(now.doc.inspectFormatting(ref).runs[0].char.bold, true);
    const again = await A(`${D}/live?base=${first.version}`, { method: 'PUT', body }); assert.equal(again.version, pushed.version);
    other.formatRange(ref, { start: 0, end: 8, paragraph: { align: 'RIGHT' } });
    const conflict = await A.res(`${D}/live?base=${first.version}`, { method: 'PUT', body: await save(other) });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'FORMAT_CONFLICT');
    assert.equal((await working(A, D)).doc.inspectFormatting(ref).paragraph.align, 'CENTER');
  } finally { await srv.stop(); }
});

test('서식 제안은 내 수정본에 반영·취소되고 검토 승인 후 원본에 병합된다', async () => {
  const srv = await startServer({ config: { documents: { defaultEditMode: 'review' } } });
  try {
    const A = srv.api('a'); const B = srv.api('b'); const admin = srv.api('admin');
    const up = await uploadDoc(srv.base, srv.tokens.a, await save(await baseDoc())); const D = `/api/docs/${up.id}`;
    const catalog = await A(`${D}/formatting?ref=${ref}`); assert.ok(catalog.catalog.charProperties.length);
    const p = await A(`${D}/proposals`, { method: 'POST', body: { type: 'format', ref, find: '제목 보통 문장', format: { char: { bold: true }, paragraph: { align: 'RIGHT' } }, reason: '지정 서식' } });
    const original = (await working(A, D)).doc.formattingFingerprint(ref);
    const adopted = await A(`${D}/proposals/${p.pid}/adopt-format`, { method: 'POST', body: { expectedDraftRev: 0 } });
    assert.equal(adopted.proposal.adopted.canUndo, true); assert.equal(adopted.cr.hunks[0].type, 'format');
    assert.equal((await working(A, D)).doc.formattingFingerprint(ref), original);
    const stale = await A.res(`${D}/proposals/${p.pid}/undo-adopt-format`, { method: 'POST', body: { expectedDraftRev: 0 } }); assert.equal(stale.status, 409);
    const undone = await A(`${D}/proposals/${p.pid}/undo-adopt-format`, { method: 'POST', body: { expectedDraftRev: adopted.rev } }); assert.equal(undone.cr.hunks.length, 0);
    const again = await A(`${D}/proposals/${p.pid}/adopt-format`, { method: 'POST', body: { expectedDraftRev: undone.rev } });
    const cid = again.cr.cid;
    await A(`${D}/change-requests/${cid}/submit`, { method: 'POST', body: { title: '서식 변경' } });
    await B(`${D}/change-requests/${cid}/reviews`, { method: 'POST', body: { verdict: 'approve', text: '확인' } });
    const merged = await A(`${D}/change-requests/${cid}/merge`, { method: 'POST' });
    assert.equal(merged.cr.status, 'merged'); assert.ok(merged.report.adopted.applied.includes(p.pid));
    const final = (await working(A, D)).doc.inspectFormatting(ref); assert.equal(final.paragraph.align, 'RIGHT'); assert.ok(final.runs.every(r => r.char.bold));
    await admin(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
    assert.equal((await working(A, D)).doc.formattingFingerprint(ref), original);
  } finally { await srv.stop(); }
});

test('서식만 있는 수정본은 재정렬 뒤에도 보존되고 승인 뒤 서식 수정은 재승인을 요구한다', async () => {
  const srv = await startServer({ config: { documents: { defaultEditMode: 'review' } } });
  try {
    const A = srv.api('a'); const B = srv.api('b'); const admin = srv.api('admin');
    const up = await uploadDoc(srv.base, srv.tokens.a, await save(await baseDoc())); const D = `/api/docs/${up.id}`;
    const first = await working(A, D); first.doc.formatRange(ref, { start: 0, end: 8, paragraph: { align: 'RIGHT' } });
    const draft = await A(`${D}/drafts/mine?base=${first.version}&rev=0`, { method: 'PUT', body: await save(first.doc) }); const cid = draft.cr.cid;
    await A(`${D}/change-requests/${cid}/submit`, { method: 'POST', body: {} }); await B(`${D}/change-requests/${cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    const p = await admin(`${D}/proposals`, { method: 'POST', body: { type: 'insert', afterRef: 's0/p0', text: '새 문단', applyNow: true } });
    assert.ok(p.pid);
    const rebase = await A(`${D}/drafts/mine/rebase`, { method: 'POST' });
    assert.equal(rebase.conflicts.length, 0); assert.equal(rebase.cr.hunks[0].type, 'format'); assert.equal(rebase.cr.hunks[0].ref, 's0/p3');
    assert.equal(rebase.cr.approvals, 1);
    const w = await A(`${D}/drafts/mine/file`); const doc = await HwpxDoc.load(w);
    doc.formatRange('s0/p3', { start: 0, end: 8, paragraph: { align: 'CENTER' } });
    const changed = await A(`${D}/drafts/mine?base=${rebase.cr.baseVersion}&rev=${rebase.rev}`, { method: 'PUT', body: await save(doc) });
    assert.equal(changed.cr.approvals, 0); assert.equal(changed.cr.staleApprovals, 1);
  } finally { await srv.stop(); }
});

test('글과 서식을 함께 제안한 수정본·새 문단의 혼합 글자모양을 병합하고 취소한다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a'); const up = await uploadDoc(srv.base, srv.tokens.a, await save(await baseDoc())); const D = `/api/docs/${up.id}`;
    const original = (await working(A, D)).doc.formattingFingerprint(ref);
    const p = await A(`${D}/proposals`, { method: 'POST', body: { ref, find: '제목 보통 문장', replace: '새 제목 일반 내용', format: { paragraph: { align: 'CENTER' } }, runs: [{ text: '새 제목', char: { bold: true } }, { text: ' 일반 내용', char: { bold: false } }] } });
    const adopted = await A(`${D}/proposals/${p.pid}/adopt-format`, { method: 'POST', body: {} });
    const merged = await A(`${D}/change-requests/${adopted.cr.cid}/merge`, { method: 'POST' });
    assert.ok(merged.report.adopted.applied.includes(p.pid));
    let info = (await working(A, D)).doc.inspectFormatting(ref);
    assert.equal(info.text, '새 제목 일반 내용'); assert.equal(info.paragraph.align, 'CENTER'); assert.equal(info.runs[0].char.bold, true); assert.equal(info.runs.at(-1).char.bold, false);
    await A(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
    assert.equal((await working(A, D)).doc.formattingFingerprint(ref), original);
    const ins = await A(`${D}/proposals`, { method: 'POST', body: { type: 'insert', afterRef: ref, text: '추가 본문', format: { paragraph: { align: 'RIGHT' } }, runs: [{ text: '추가', char: { bold: true } }, { text: ' 본문', char: { bold: false } }] } });
    const add = await A(`${D}/proposals/${ins.pid}/adopt-format`, { method: 'POST', body: {} });
    const cancel = await A(`${D}/proposals/${ins.pid}/undo-adopt-format`, { method: 'POST', body: { expectedDraftRev: add.rev } });
    assert.equal(cancel.cr.hunks.length, 0);
    const redo = await A(`${D}/proposals/${ins.pid}/adopt-format`, { method: 'POST', body: {} });
    await A(`${D}/change-requests/${redo.cr.cid}/merge`, { method: 'POST' });
    info = (await working(A, D)).doc.inspectFormatting('s0/p3');
    assert.equal(info.text, '추가 본문'); assert.equal(info.paragraph.align, 'RIGHT'); assert.equal(info.runs[0].char.bold, true); assert.equal(info.runs.at(-1).char.bold, false);
  } finally { await srv.stop(); }
});

test('같은 문단의 서로 다른 범위 서식 제안을 함께 반영하고 각 범위만 되돌린다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a'); const up = await uploadDoc(srv.base, srv.tokens.a, await save(await baseDoc())); const D = `/api/docs/${up.id}`;
    const original = (await working(A, D)).doc.formattingFingerprint(ref);
    const first = await A(`${D}/proposals`, { method: 'POST', body: { type: 'format', ref, start: 0, end: 2, format: { char: { bold: true } } } });
    const second = await A(`${D}/proposals`, { method: 'POST', body: { type: 'format', ref, start: 3, end: 8, format: { char: { italic: true } } } });
    await A(`${D}/proposals/${first.pid}/adopt-format`, { method: 'POST', body: {} });
    const both = await A(`${D}/proposals/${second.pid}/adopt-format`, { method: 'POST', body: {} });
    await A(`${D}/proposals/${first.pid}/undo-adopt-format`, { method: 'POST', body: {} });
    const partial = (await HwpxDoc.load(await A(`${D}/drafts/mine/file`))).inspectFormatting(ref);
    assert.equal(partial.runs[0].char.bold, false); assert.equal(partial.runs.at(-1).char.italic, true);
    await A(`${D}/proposals/${first.pid}/adopt-format`, { method: 'POST', body: {} });
    const merged = await A(`${D}/change-requests/${both.cr.cid}/merge`, { method: 'POST' });
    assert.deepEqual(merged.report.adopted.applied.sort(), [first.pid, second.pid].sort());
    await A(`${D}/proposals/${first.pid}/undo`, { method: 'POST' });
    const after = (await working(A, D)).doc.inspectFormatting(ref);
    assert.equal(after.runs[0].char.bold, false); assert.equal(after.runs.at(-1).char.italic, true);
    await A(`${D}/proposals/${second.pid}/undo`, { method: 'POST' });
    assert.equal((await working(A, D)).doc.formattingFingerprint(ref), original);
  } finally { await srv.stop(); }
});
