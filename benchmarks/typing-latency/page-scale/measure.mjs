// Run one document size in one Windows Job. The launcher supplies the input and profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HwpDocument, pkgDir } from '../../../tests/helpers/rhwp.mjs';

const [inputFile, out, profile, repetitions = '5', openMode = 'progressive', onlyOp = 'all', scope = 'complete'] = process.argv.slice(2);
const bytes = fs.readFileSync(inputFile);
const pages = Number(/scale-(\d+)\.hwpx$/.exec(inputFile)[1]);
const middle = pages === 3 ? 2 : Math.floor(pages / 2);
const hash = value => createHash('sha256').update(value).digest('hex');
const meta = {
  profile, pages, openMode, scope, node: process.version, cpu: os.cpus()[0].model, logicalCpu: os.cpus().length,
  os: os.release(), memoryBytes: os.totalmem(), pkgDir, inputSha256: hash(bytes),
  wasmSha256: hash(fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm'))),
  pageBreakUndo: typeof HwpDocument.prototype.savePageBreakUndo === 'function' ? 'page-break' : 'full-snapshot',
};
fs.writeFileSync(out, JSON.stringify({ meta }) + '\n', { flag: 'wx' });
let phase = 'initialize', context = {};
const previousError = console.error;
console.error = (...messages) => {
  fs.appendFileSync(out, JSON.stringify({ ...context, phase, stderr: messages.map(String).join(' ') }) + '\n');
  previousError(...messages);
};
process.on('uncaughtException', error => {
  fs.appendFileSync(out, JSON.stringify({ ...context, phase, error: String(error.stack ?? error) }) + '\n');
  process.exit(1);
});
const marker = page => 'P' + String(page).padStart(4, '0');
assert.ok(['all', 'text', 'cell', 'break', 'body'].includes(onlyOp), 'unknown operation: ' + onlyOp);
const ops = onlyOp === 'all' ? ['text', 'cell', 'break'] : [onlyOp];

function checkPageData(doc, op, page, sec, base, raw) {
  const { runs } = JSON.parse(raw);
  if (op === 'cell') {
    const cell = runs.filter(r => r.parentParaIdx === base + 3 && r.cellIdx === 1);
    assert.deepEqual(cell.map(r => [r.cellParaIdx, r.text]), [[0, '대'], [1, '기']]);
    assert.ok(cell[1].y > cell[0].y);
    assert.equal(doc.getCellParagraphCount(sec, base + 3, 0, 1), 2);
  } else if (op === 'text') {
    const value = runs.filter(r => r.parentParaIdx == null && r.paraIdx === base + 1)
      .map(r => r.text).join('');
    assert.equal(value, '자료 교정 전 원문을 확인합니다.');
  } else if (op === 'body') {
    assert.equal(doc.getTextRange(sec, base + 1, 0, 3), '자료 ');
    const second = runs.filter(r => r.parentParaIdx == null && r.paraIdx === base + 2);
    assert.equal(second.map(r => r.text).join(''), '수정 전 원문을 확인합니다.');
  } else {
    assert.ok(runs.map(r => r.text).join('').includes(marker(page)));
    assert.equal(JSON.parse(doc.getPageText(page - 1)).trim(), '');
  }
}

function measure(page, op) {
  phase = 'open';
  const traceWarm = context.round === 0;
  const milestone = (step, detail = {}) => {
    if (traceWarm) fs.appendFileSync(out, JSON.stringify({ ...context, milestone: step, ...detail }) + '\n');
  };
  milestone('opening');
  const openStart = performance.now();
  const doc = openMode === 'progressive' ? HwpDocument.openProgressive(bytes, 2) : new HwpDocument(bytes);
  doc.setTypesetTailDeferral(true);
  if (openMode === 'progressive') {
    let state = JSON.parse(doc.progressiveOpenState());
    while (state.state === 'pending') state = JSON.parse(doc.stepProgressiveOpen(16));
    assert.equal(state.state, 'complete');
  }
  const openMs = performance.now() - openStart;
  milestone('opened', { openMs });
  phase = 'before-edit';
  assert.equal(doc.pageCount(), pages);
  const { sec, para: base } = JSON.parse(doc.getPositionOfPage(page - 1));
  assert.equal(doc.getTextRange(sec, base, 0, 5), marker(page));
  const cellPath = cp => JSON.stringify([{ controlIndex: 0, cellIndex: 1, cellParaIndex: cp }]);
  const before = op === 'cell' ? doc.getCursorRectByPathNear(sec, base + 3, cellPath(0), 1, page - 1)
    : doc.getCursorRect(sec, op === 'break' ? base : base + 1, op === 'break' ? 0 : 3);
  assert.equal(JSON.parse(before).pageIndex, page - 1);
  assert.ok(doc.getPageTextLayout(page - 1).includes(marker(page)));
  assert.equal(doc.typesetTailPending(), false);
  milestone('ready-to-edit');

  phase = 'snapshot';
  const start = performance.now();
  if (op === 'break') {
    if (typeof doc.savePageBreakUndo === 'function') doc.savePageBreakUndo(sec, base, 0);
    else doc.saveSnapshot();
  }
  const beforeEdit = performance.now();
  phase = 'mutation';
  let response;
  if (op === 'break') response = doc.insertPageBreak(sec, base, 0);
  else if (op === 'cell') response = doc.splitParagraphInCell(sec, base + 3, 0, 1, 0, 1);
  else if (op === 'body') response = doc.splitParagraph(sec, base + 1, 3);
  else response = doc.replaceBodyTextLocal(sec, base + 1, 3, 1, '교');
  const edited = performance.now();
  phase = 'caret';
  const result = JSON.parse(response);
  const rect = JSON.parse(op === 'cell'
    ? doc.getCursorRectByPathNear(sec, base + 3, cellPath(result.cellParaIndex), 0, page - 1)
    : doc.getCursorRect(sec, op === 'text' ? base + 1 : result.paraIdx, result.charOffset));
  const caret = performance.now();
  phase = 'page-data';
  const localLayout = doc.getPageTextLayout(rect.pageIndex);
  const local = performance.now();
  phase = 'finish';
  context.partialForegroundMs = local - start;
  assert.equal(result.ok, true);
  assert.equal(rect.pageIndex, op === 'break' ? page : page - 1);
  // Keep diagnostic reads and consistency checks outside the measured stage.
  const tailAtLocal = doc.typesetTailPending();
  const provisionalPages = doc.pageCount();
  checkPageData(doc, op, page, sec, base, localLayout);
  milestone('local-ready', { tailAtLocal, provisionalPages });
  if (scope === 'local') {
    assert.equal(op, 'text');
    assert.equal(result.documentPaginationPending, true);
    doc.free();
    return { page, op, localOnly: true, openMs, mutationMs: edited - beforeEdit,
      caretReadyMs: caret - start, foregroundMs: local - start, provisionalPages };
  }
  let tailSteps = 0, slowestStepMs = 0, flushStatus = null;
  const tailStart = performance.now();
  if (result.documentPaginationPending) {
    const flush = JSON.parse(doc.flushDeferredPagination());
    assert.equal(flush.ok, true);
    flushStatus = flush.status;
  }
  while (doc.typesetTailPending()) {
    const stepStart = performance.now();
    const step = JSON.parse(doc.stepTypesetTail(8));
    slowestStepMs = Math.max(slowestStepMs, performance.now() - stepStart);
    assert.ok(['complete', 'pending'].includes(step.status), JSON.stringify(step));
    assert.ok(++tailSteps < 100000);
  }
  const finishMs = performance.now() - tailStart;
  phase = 'checks';
  const finalPages = doc.pageCount();
  assert.equal(finalPages, pages + (op === 'break' ? 1 : 0));
  checkPageData(doc, op, page, sec, base, doc.getPageTextLayout(rect.pageIndex));
  const probes = [page - 1, page, page + 1, Math.floor((pages + page) / 2), pages];
  for (const p of new Set(probes.filter(p => p >= 1 && p <= pages))) {
    const slot = p - 1 + (op === 'break' && p >= page ? 1 : 0);
    assert.ok(JSON.parse(doc.getPageText(slot)).includes(marker(p)), 'page marker ' + p);
  }
  const measurement = {
    page, op, openMs, snapshotMs: beforeEdit - start, mutationMs: edited - beforeEdit,
    caretMs: caret - edited, pageDataMs: local - caret, foregroundMs: local - start,
    caretReadyMs: caret - start, finishMs, tailAtLocal, tailSteps, slowestStepMs, flushStatus,
    documentPaginationPending: !!result.documentPaginationPending, flowChanged: result.flowChanged,
    provisionalPages, finalPages, rssMiB: process.memoryUsage.rss() / 1048576,
  };
  // A trapped Rust borrow can make free() throw again. On failure the isolated worker exits.
  doc.free();
  return measurement;
}

for (let round = 0; round <= Number(repetitions); round++) {
  const isolatedFullEdit = onlyOp !== 'all' && scope !== 'local';
  const middleFirst = isolatedFullEdit ? round % 2 === 0 : round % 2 !== 0;
  const targets = pages === 3 ? [2] : middleFirst ? [middle, 3] : [3, middle];
  for (const page of targets) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[(i + round) % ops.length];
      context = { page, op, round };
      const result = measure(page, op);
      fs.appendFileSync(out, JSON.stringify({ round, ...result }) + '\n');
    }
  }
}
