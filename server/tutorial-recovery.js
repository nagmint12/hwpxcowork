// 단계 진입 직전의 연습 상태를 보존한다. 일반 문서·완료본에는 호출하지 않는다.
// 기준 사본과 실패 상태는 불변 파일로 남기고, 복구는 기존 기록을 보존한 새 커밋이다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HwpxDoc } from '../engine/doc.js';
import { writeFileAtomic } from './store.js';
import { ServiceError } from './service.js';

const RESTORE_FIELDS = ['title', 'fileName', 'settings', 'proposals', 'requests', 'attachments',
  'changeRequests', 'memoThreads', 'memoTrash', 'seq', 'breakView', 'legacyProposalMemos'];
const ASSET_DIRS = ['attachments', 'drafts', 'undo'];
const SAFE_ID = /^[a-f0-9]{32}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const revisionOf = meta => meta.tutorialProgress?.revision || 0;
const inFlight = meta => (meta.requests || []).some(r => r.status === 'working' || (r.status === 'pending' && !r.example));

function fail(code, message, status = 409) { throw new ServiceError(code, message, status); }
function assertRevision(meta, value, { optional = false } = {}) {
  // 이전 클라이언트도 복구 전에는 진행을 저장할 수 있다. 복구 경계를 넘은 무판번호 저장은 거절한다.
  if (optional && value == null && !meta.tutorialRestoreVersion) return;
  if (!Number.isSafeInteger(value) || value < 0) fail('BAD_TUTORIAL_REVISION', '안내 진행 판 번호가 올바르지 않습니다', 400);
  if (value !== revisionOf(meta)) fail('TUTORIAL_PROGRESS_CHANGED', '다른 창이나 복구 작업에서 안내가 바뀌었습니다. 현재 안내를 다시 열어 주세요');
}

export function tutorialProgress(meta) {
  const progress = meta.tutorialProgress || {};
  return { docId: meta.id, i: progress.i || 0, ctx: progress.ctx || {}, revision: revisionOf(meta),
    checkpointId: progress.checkpointId || null, checkpoints: (meta.tutorialCheckpoints || []).map(clone) };
}

export function createTutorialRecovery({ service }) {
  const store = service.store;
  const recoveryDir = id => path.join(store._docDir(id), 'tutorial-recovery');
  const snapshotDir = (id, key) => {
    if (!SAFE_ID.test(String(key || ''))) fail('BAD_TUTORIAL_CHECKPOINT', '단계 복구 번호가 올바르지 않습니다', 400);
    return path.join(recoveryDir(id), key);
  };

  // 문서별 큐 안에서 호출한다. 메타 참조와 실제 첨부/수정본/되돌리기 파일을 함께 보관한다.
  function capture(meta, progress, kind) {
    const key = crypto.randomBytes(16).toString('hex');
    const target = snapshotDir(meta.id, key);
    fs.mkdirSync(target, { recursive: true });
    const bytes = store.currentBytes(meta.id);
    const assets = [];
    for (const sub of ASSET_DIRS) {
      const source = path.join(store._docDir(meta.id), sub);
      if (!fs.existsSync(source)) continue;
      for (const name of fs.readdirSync(source)) {
        const file = path.join(source, name);
        if (!fs.lstatSync(file).isFile() || name.includes('.tmp-')) continue;
        const data = fs.readFileSync(file);
        const rel = `${sub}/${name}`;
        fs.mkdirSync(path.join(target, sub), { recursive: true });
        writeFileAtomic(path.join(target, sub, name), data);
        assets.push({ path: rel, sha256: hash(data) });
      }
    }
    // 첨부 메타만 남고 원본이 없는 상태를 정상 기준으로 고정하지 않는다.
    for (const a of meta.attachments || []) {
      if (!a.file || !assets.some(x => x.path === `attachments/${path.basename(a.file)}`))
        fail('TUTORIAL_CHECKPOINT_INCOMPLETE', '연습 첨부 원본이 없어 복구 기준을 만들 수 없습니다');
    }
    writeFileAtomic(path.join(target, 'document.hwpx'), bytes);
    const snapshot = { checkpointId: key, kind, at: new Date().toISOString(), version: meta.version,
      i: progress.i, ctx: clone(progress.ctx), sha256: hash(bytes), assets, meta: clone(meta) };
    // snapshot.json을 마지막에 쓰므로 중간 실패한 폴더는 기준 목록에 올라가지 않는다.
    writeFileAtomic(path.join(target, 'snapshot.json'), JSON.stringify(snapshot));
    return snapshot;
  }

  function read(meta, checkpointId) {
    const target = snapshotDir(meta.id, checkpointId);
    let value;
    try { value = JSON.parse(fs.readFileSync(path.join(target, 'snapshot.json'), 'utf8')); }
    catch { fail('TUTORIAL_CHECKPOINT_CORRUPT', '저장된 단계 복구 기준을 읽지 못했습니다'); }
    let bytes;
    try { bytes = fs.readFileSync(path.join(target, 'document.hwpx')); }
    catch { fail('TUTORIAL_CHECKPOINT_CORRUPT', '단계 문서 원본이 없어 복구하지 않았습니다'); }
    if (!value?.meta || !Array.isArray(value.assets) || value.meta.id !== meta.id || value.meta.tutorialOwnerKey !== meta.tutorialOwnerKey || hash(bytes) !== value.sha256)
      fail('TUTORIAL_CHECKPOINT_CORRUPT', '단계 복구 기준의 무결성을 확인하지 못했습니다');
    const assets = value.assets.map(item => {
      if (!item || typeof item.path !== 'string' || !/^(attachments|drafts|undo)\/[A-Za-z0-9_.-]+$/.test(item.path)) fail('TUTORIAL_CHECKPOINT_CORRUPT', '단계 파일 경로가 올바르지 않습니다');
      let data;
      try { data = fs.readFileSync(path.join(target, item.path)); }
      catch { fail('TUTORIAL_CHECKPOINT_CORRUPT', '단계 복구에 필요한 파일이 없어 복구하지 않았습니다'); }
      if (hash(data) !== item.sha256) fail('TUTORIAL_CHECKPOINT_CORRUPT', '단계 파일의 무결성을 확인하지 못했습니다');
      return { ...item, data };
    });
    return { value, bytes, assets };
  }

  function save(meta, input) {
    assertRevision(meta, input.revision, { optional: true });
    let checkpoint = (meta.tutorialCheckpoints || []).find(x => x.i === input.i);
    if (!checkpoint) {
      const captured = capture(meta, input, 'step');
      checkpoint = { checkpointId: captured.checkpointId, i: input.i, at: captured.at, version: captured.version, resumable: !inFlight(meta) };
      (meta.tutorialCheckpoints ||= []).push(checkpoint);
    }
    meta.tutorialProgress = { docId: meta.id, i: input.i, ctx: clone(input.ctx),
      revision: revisionOf(meta) + 1, checkpointId: checkpoint.checkpointId };
    store.saveMeta(meta);
    return { saved: true, ...tutorialProgress(meta) };
  }

  async function restore(meta, input, user) {
    if (!input || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId))
      fail('BAD_TUTORIAL_OPERATION', '단계 복구 작업 번호가 올바르지 않습니다', 400);
    const fingerprint = hash(JSON.stringify({ checkpointId: input.checkpointId ?? null, i: input.i ?? null, revision: input.revision }));
    const existing = (meta.tutorialRestores || []).find(x => x.operationId === input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('TUTORIAL_OPERATION_CHANGED', '같은 복구 작업 번호에 다른 내용이 전달되었습니다');
      // 늦게 도착한 중복 응답으로 현재 진행을 뒤로 돌리지 않는다.
      return { ...tutorialProgress(meta), version: meta.version, restored: true, duplicate: true };
    }
    assertRevision(meta, input.revision);
    let selected = input.checkpointId
      ? meta.tutorialCheckpoints?.find(x => x.checkpointId === input.checkpointId)
      : meta.tutorialCheckpoints?.find(x => x.i === (input.i ?? meta.tutorialProgress?.i ?? 0));
    if (!selected) fail('NO_TUTORIAL_CHECKPOINT', '아직 저장되지 않은 단계는 다시 실행할 수 없습니다', 404);
    if (input.i != null && input.i !== selected.i) fail('BAD_TUTORIAL_CHECKPOINT', '단계와 복구 기준이 다릅니다', 400);
    let recoveryFallback = null;
    if (selected.resumable === false) {
      const requestedI = selected.i;
      selected = [...(meta.tutorialCheckpoints || [])].filter(x => x.i < requestedI && x.resumable !== false).sort((a, b) => b.i - a.i)[0];
      if (!selected) fail('TUTORIAL_BUSY', '이 단계의 작업 전 복구 기준이 없습니다. 작업을 마친 뒤 다시 실행해 주세요');
      recoveryFallback = { requestedI, reason: 'AI_IN_FLIGHT' };
    }
    const { value: checkpoint, bytes, assets } = read(meta, selected.checkpointId);
    let doc;
    try { doc = await HwpxDoc.load(bytes); }
    catch { fail('TUTORIAL_CHECKPOINT_CORRUPT', '단계 문서 구조를 읽지 못해 복구하지 않았습니다'); }
    // 현재 실패 상태도 재현 가능한 불변 사본으로 남긴다. 원본/과거 버전은 지우지 않는다.
    const archive = capture(meta, tutorialProgress(meta), 'before-restore');
    const next = clone(meta);
    for (const key of RESTORE_FIELDS) {
      if (Object.hasOwn(checkpoint.meta, key)) next[key] = clone(checkpoint.meta[key]);
      else delete next[key];
    }
    next.seq ||= {};
    for (const [key, n] of Object.entries(meta.seq || {})) next.seq[key] = Math.max(Number(n) || 0, Number(next.seq[key]) || 0);
    // 같은 rid를 되살려도 과거 실행의 attempt/claim은 다시 유효해질 수 없다.
    for (const r of next.requests || []) {
      const previous = meta.requests?.find(x => x.rid === r.rid);
      const attempts = Math.max(service._attempt(r), previous ? service._attempt(previous) : 0);
      r.log ||= [];
      while (service._attempt(r) <= attempts) r.log.push({ at: new Date().toISOString(), by: user.name, action: 'retry', detail: '튜토리얼 단계 복구 — 이전 실행 무효화' });
      r.claim = null; r.delivery = null;
    }
    next.locks = {}; next.liveTouch = {};
    next.tutorialProgress = { docId: meta.id, i: checkpoint.i, ctx: clone(checkpoint.ctx),
      revision: revisionOf(meta) + 1, checkpointId: selected.checkpointId };
    // 복구 뒤 새 시도에서 만든 rid·memoId를 다음 단계 기준으로 다시 잡는다. 옛 기준 파일은 archive와 함께 보존된다.
    next.tutorialCheckpoints = (next.tutorialCheckpoints || []).filter(x => x.i <= checkpoint.i);
    next.tutorialRestoreVersion = meta.version + 1;
    const record = { operationId: input.operationId, fingerprint, checkpointId: selected.checkpointId,
      archiveId: archive.checkpointId, at: new Date().toISOString(), version: next.tutorialRestoreVersion };
    (next.tutorialRestores ||= []).push(record);
    // 파일을 바꾸기 전에 모두 읽는다. assets/commit이 실패하면 기존 파일을 되돌릴 원본도 메모리와 archive에 있다.
    const previousAssets = assets.map(asset => {
      const file = path.join(store._docDir(meta.id), asset.path);
      return { file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
    });
    const operationDir = snapshotDir(meta.id, archive.checkpointId);
    writeFileAtomic(path.join(operationDir, 'restore-prepared.json'), JSON.stringify(record));
    store.log(next, user.name, 'tutorial.restore', `안내 ${checkpoint.i + 1}단계 다시 실행 (${archive.checkpointId})`);
    // _finish의 요청 메모 재작성은 불변 HWPX 기준을 바꾸므로, 원본 바이트를 새 기록으로 직접 저장한다.
    let committed = false;
    try {
      for (const asset of assets) {
        const file = path.join(store._docDir(meta.id), asset.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, asset.data);
      }
      await store.commit(meta.id, doc, { by: user.name, note: '튜토리얼 단계 다시 실행', meta: next,
        bytes, milestone: { kind: 'tutorial-restore', note: `안내 ${checkpoint.i + 1}단계 다시 실행` } });
      committed = true;
      next.formatVersion = next.version;
      store.saveMeta(next);
    } catch (error) {
      const rollbackFailures = [];
      if (!committed) for (const previous of previousAssets) {
        if (previous.bytes == null) continue; // 새로 생긴 참조 없는 파일은 지우지 않는다.
        try { writeFileAtomic(previous.file, previous.bytes); }
        catch { rollbackFailures.push(path.basename(previous.file)); }
      }
      try { writeFileAtomic(path.join(operationDir, 'restore-failed.json'), JSON.stringify({ ...record,
        committed, rollbackFailures, code: error.code || 'IO_ERROR', at: new Date().toISOString() })); } catch { /* prepared 기록과 불변 archive는 남아 있다 */ }
      throw new ServiceError('TUTORIAL_RESTORE_IO', '단계 복구를 저장하지 못했습니다. 복구 전 사본을 보존했습니다', 500,
        { archiveId: archive.checkpointId, committed, recoveryRequired: committed || rollbackFailures.length > 0 });
    }
    if (service._wc?.id === meta.id) service._wc = null;
    service.hub.broadcast(meta.id, { type: 'doc', action: 'changed', version: next.version,
      formatVersion: next.version, formatting: true, tutorialRestored: true, by: user.name });
    return { ...tutorialProgress(next), version: next.version, restored: true, ...(recoveryFallback ? { recoveryFallback } : {}) };
  }

  return { save, restore };
}
