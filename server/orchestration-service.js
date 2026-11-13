// 개인 작업 큐와 기존 문서 서비스를 연결한다. 실행기는 결과만 제출하고 지휘자가 한 번 발행한다.
import { createOrchestration } from './orchestration.js';
import { ServiceError } from './service.js';
import { xmlSafe } from './memotext.js';
import { createOrchestrationRuntime } from './orchestration-runtime.js';

export function createDocumentOrchestration({ service, config }) {
  const storage = createOrchestration({ config });
  // REST의 공통 오류 처리와 같은 오류 형식으로 맞춘다.
  const core = new Proxy(storage, { get(target, key) {
    const method = target[key];
    if (typeof method !== 'function') return method;
    return (...args) => {
      try { return method(...args); }
      catch (e) { if (e.code && Number.isInteger(e.status)) throw new ServiceError(e.code, e.message, e.status); throw e; }
    };
  } });
  const operations = new Map();
  function serial(runId, operation) {
    const pending = (operations.get(runId) || Promise.resolve()).catch(() => {}).then(operation);
    operations.set(runId, pending);
    const release = () => { if (operations.get(runId) === pending) operations.delete(runId); };
    pending.then(release, release);
    return pending;
  }
  function access(user, id, edit = false) {
    service.assertDocRead(id, user);
    const meta = service._meta(id);
    if (edit) service._assertCanEdit(user, meta);
    return meta;
  }
  function getRun(user, id) {
    const run = core.getRun(user, id);
    access(user, run.doc_id);
    return run;
  }
  function check(user, input) { const run = getRun(user, input.run_id); access(user, run.doc_id, true); return run; }
  function readyTasks(user, connection) {
    if (!connection?.channel || !/claude/i.test(`${connection.agent || ''} ${connection.client || ''}`)) return [];
    const ready = [];
    for (const info of core.listRuns(user)) {
      if (!['planning', 'running'].includes(info.status)) continue;
      let run;
      try { run = check(user, { run_id: info.id }); } catch { continue; }
      if (run.tasks.filter(task => task.status === 'running').length >= run.profile.maxParallel) continue;
      for (const task of run.tasks) {
        if (task.status !== 'pending' || !task.depends_on.every(id => run.tasks.find(item => item.id === id)?.status === 'completed')) continue;
        if (run.profile.agents.find(agent => agent.id === task.agent_id)?.kind !== 'claude-code') continue;
        ready.push({ run_id: run.id, task_id: task.id, agent_id: task.agent_id, kind: task.kind, title: task.title, attempt: task.attempt });
      }
    }
    return ready;
  }
  function notify(user) {
    try {
      const sessions = service.agents?.sessions(user.name) || [];
      for (const connection of sessions) for (const task of readyTasks(user, connection)) service.agents.sendSession(user.name, connection.session, 'orchestration_task', task);
    } catch { /* 알림은 힌트이며 실제 큐·권한은 claim에서 확인한다. 재연결 snapshot으로 복구한다. */ }
  }
  const runtime = createOrchestrationRuntime({
    profile: user => core.profile(user),
    listRuns: user => core.listRuns(user).filter(run => { try { access(user, run.doc_id); return true; } catch { return false; } }),
    getRun,
    connections: user => service.agents?.sessions(user.name) || [],
  });
  return {
    readyTasks,
    status: user => runtime.status(user),
    reportWorker: (user, input) => runtime.report(user, input),
    profile: user => core.profile(user),
    saveProfile: (user, body) => core.saveProfile(user, body),
    listRuns(user, options = {}) {
      if (options.doc_id) access(user, options.doc_id);
      return core.listRuns(user, options).filter(run => {
        try { access(user, run.doc_id); return true; } catch { return false; }
      });
    },
    getRun,
    createRun(user, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('BAD_ORCHESTRATION', '문서와 작업 목표를 지정하세요');
      const meta = access(user, body.doc_id, true);
      const run = core.createRun(user, { doc_id: body.doc_id, goal: body.goal, base_version: meta.version });
      notify(user); return run;
    },
    claim(user, input) {
      if (input.run_id) check(user, input);
      // 목록을 먼저 권한으로 거른다. 문서 접근이 취소된 실행을 선점하지 않는다.
      const candidates = input.run_id ? [{ id: input.run_id }] : this.listRuns(user).reverse();
      let waitingForWorkers = false;
      for (const run of candidates) {
        try { access(user, getRun(user, run.id).doc_id, true); } catch { continue; }
        if (input.require_online_workers) {
          const detail = getRun(user, run.id);
          const planning = detail.tasks.some(task => task.agent_id === input.agent_id && task.kind === 'plan' && task.status === 'pending');
          const agents = runtime.status(user).agents;
          if (planning && !detail.profile.agents.some(agent => agent.roles.includes('worker') && agents.some(online => online.id === agent.id && online.online))) { waitingForWorkers = true; continue; }
        }
        const out = core.claim(user, { ...input, run_id: run.id });
        if (!out.none) return { ...out, runtime: runtime.status(user) };
      }
      return { none: true, ...(waitingForWorkers ? { reason: 'worker_unavailable' } : {}) };
    },
    heartbeat(user, input) { check(user, input); return core.heartbeat(user, input); },
    plan(user, input) { check(user, input); const run = core.plan(user, input); notify(user); return run; },
    submit(user, input) { check(user, input); const run = core.submit(user, input); notify(user); return run; },
    fail(user, input) { check(user, input); const run = core.fail(user, input); notify(user); return run; },
    advance(user, input) { return serial(input.run_id, () => {
      const run = check(user, input);
      if (input.action === 'complete') {
        const record = access(user, run.doc_id).orchestrationPublications?.[run.id];
        if (!record) throw new ServiceError('RESULT_NOT_PUBLISHED', '통합 결과를 publish_orchestration_result로 먼저 발행하세요', 409);
      }
      if (input.action === 'revise' && access(user, run.doc_id).orchestrationPublications?.[run.id]) throw new ServiceError('ALREADY_PUBLISHED', '발행한 실행은 새 실행으로 개선하세요', 409);
      const changed = core.advance(user, input); notify(user); return changed;
    }); },
    async publish(user, input) { return serial(input.run_id, async () => {
      const run = check(user, input);
      const task = run.tasks.find(item => item.id === input.task_id);
      if (run.status !== 'awaiting_review' && run.status !== 'completed') throw new ServiceError('RUN_STATE', '통합 작업이 끝난 뒤 결과를 발행하세요', 409);
      if (!task || task.kind !== 'synthesize' || task.status !== 'completed' || task.round !== run.round) throw new ServiceError('BAD_TASK', '현재 회차의 완료된 통합 작업을 지정하세요');
      const receipt = access(user, run.doc_id).orchestrationPublications?.[run.id];
      if (receipt?.task_id === task.id) return { ...receipt, duplicate: true };
      core.authorizeConductor(user, input);
      const result = task.result;
      if (!result || typeof result !== 'object') throw new ServiceError('BAD_RESULT', '통합 결과가 없습니다');
      const fields = ['proposals', 'inserts', 'formats', 'tables', 'comments'];
      for (const key of fields) if (result[key] != null && !Array.isArray(result[key])) throw new ServiceError('BAD_RESULT', `${key}는 배열이어야 합니다`);
      const proposals = [
        ...(result.proposals || []).map(p => ({ type: 'replace', ref: p.ref, find: p.find, replace: p.replace, occurrence: p.occurrence, format: p.format, runs: p.runs, reason: p.reason })),
        ...(result.inserts || []).map(p => ({ type: 'insert', afterRef: p.afterRef, text: p.text, format: p.format, runs: p.runs, reason: p.reason })),
        ...(result.formats || []).map(p => ({ type: 'format', ref: p.ref, find: p.find, occurrence: p.occurrence, format: p.format, reason: p.reason })),
        ...(result.tables || []).map(p => ({ type: 'table', afterRef: p.afterRef, table: { rows: p.rows, headerRows: p.headerRows, caption: p.caption }, reason: p.reason })),
      ];
      const comments = (result.comments || []).filter(comment => {
        try { const value = JSON.parse(comment.text); return !(value?.orchestration && typeof value.orchestration.needs_revision === 'boolean'); }
        catch { return true; }
      });
      if (proposals.length + comments.length > 100) throw new ServiceError('BAD_RESULT', '한 번에 발행할 결과는 100건까지입니다');
      const out = await service._tx(run.doc_id, async () => {
        // 문서 큐를 기다리는 동안 취소/인수가 되었을 수 있으므로 다시 검사한다.
        const { doc, meta } = await service._load(run.doc_id);
        const current = check(user, input);
        core.authorizeConductor(user, input);
        const previous = meta.orchestrationPublications?.[run.id];
        if (previous) {
          if (previous.task_id !== task.id) throw new ServiceError('ALREADY_PUBLISHED', '이미 발행한 실행은 다시 개선할 수 없습니다', 409);
          return { ...previous, duplicate: true };
        }
        if (current.status !== 'awaiting_review') throw new ServiceError('RUN_STATE', '검토 대기 상태에서만 발행할 수 있습니다', 409);
        if (meta.version !== run.base_version) throw new ServiceError('DOCUMENT_CHANGED', '작업 중 문서가 바뀌었습니다. 현재 문서로 새 실행을 시작하세요. 결과는 실행 기록에 보관됩니다.', 409);
        const author = service.authorName(user, '오케스트레이터');
        const ctx = service._ctx(run.doc_id, doc, meta, author);
        const ids = proposals.map(p => service._proposeCore(ctx, { ...p, memo: false }, author).pid);
        const memos = [];
        for (const comment of comments) {
          const text = xmlSafe(comment.text || '');
          if (!text.trim()) throw new ServiceError('EMPTY', '검토 의견이 비었습니다');
          const range = service._range(doc, comment.ref, { find: comment.find, occurrence: comment.occurrence });
          const mid = service._memoEdit(ctx, comment.ref, () => service._engine(() => doc.addMemo(comment.ref, { start: range.start, end: range.end ?? undefined, author, text })));
          memos.push(mid); ctx.dirty = true;
        }
        const record = { task_id: task.id, round: run.round, proposals: ids, comments: memos, summary: xmlSafe(result.summary || '').slice(0, 2000), at: new Date().toISOString() };
        meta.orchestrationPublications ||= {};
        meta.orchestrationPublications[run.id] = record;
        service.store.log(meta, author, 'orchestration.publish', `통합 제안 ${ids.length}건 · 의견 ${memos.length}건`);
        const version = await service._finish(ctx, '멀티에이전트 통합 결과');
        return { ...record, version };
      });
      if (!out.duplicate) service.hub.broadcast(run.doc_id, { type: 'proposal', action: 'batch', count: out.proposals.length, by: service.authorName(user, '오케스트레이터'), version: out.version });
      return out;
    }).catch(error => {
      try { core.recordPublicationIssue(user, { ...input, code: error.code }); } catch { /* 취소·인수 뒤에는 옛 실행의 오류도 쓰지 않는다. */ }
      throw error;
    }); },
  };
}
