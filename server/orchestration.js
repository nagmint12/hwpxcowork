// 개인별 멀티에이전트 작업 큐. 모델 실행과 문서 반영은 외부 실행기/기존 제안 흐름이 맡는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './store.js';

const ACTIVE = new Set(['planning', 'running', 'awaiting_review']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const KINDS = new Set(['codex', 'claude-code', 'api', 'mcp']);
const EFFORTS = new Set(['medium', 'high', 'xhigh', 'max']);
const ROLES = new Set(['conductor', 'worker', 'reviewer']);
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
const clone = value => structuredClone(value);
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const bad = message => error('BAD_ORCHESTRATION', message);
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const DEFAULT_ORCHESTRATION_PROFILE = {
  enabled: false,
  conductor: 'codex',
  agents: [
    { id: 'codex', label: 'Codex 지휘자', kind: 'codex', effort: 'xhigh', model: '', roles: ['conductor'] },
    { id: 'claude-code', label: 'Claude Code 작업자', kind: 'claude-code', effort: 'high', model: '', roles: ['worker', 'reviewer'] },
    { id: 'api-worker', label: 'API 작업자', kind: 'api', effort: 'medium', model: '', roles: ['worker', 'reviewer'] },
  ],
  maxParallel: 3, maxRounds: 3, maxTasks: 40, maxAttempts: 3, leaseSeconds: 180, maxRunMinutes: 60,
};

function string(value, name, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw bad(`${name} 값을 확인하세요(최대 ${max}자)`);
  return value.trim();
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${name} 값은 ${min}~${max} 정수입니다`);
  return value;
}
function userName(user) { return string(user?.name, '사용자', 200); }
function identifier(value, name) { if (typeof value !== 'string' || !ID.test(value)) throw bad(`${name} ID를 확인하세요`); return value; }
function sessionId(value) { return string(value, '실행 세션', 256); }
function jsonResult(value) {
  if (!object(value)) throw bad('작업 결과는 JSON 객체여야 합니다');
  let json;
  try { json = JSON.stringify(value); } catch { throw bad('작업 결과를 JSON으로 저장할 수 없습니다'); }
  if (Buffer.byteLength(json, 'utf8') > 100000) throw bad('작업 결과는 UTF-8 100KB까지 저장합니다');
  return JSON.parse(json);
}

function normalizeProfile(input, previous) {
  if (!object(input)) throw bad('개인 오케스트레이션 설정이 필요합니다');
  const allowed = new Set(Object.keys(DEFAULT_ORCHESTRATION_PROFILE));
  if (Object.keys(input).some(key => !allowed.has(key))) throw bad('지원하지 않는 설정입니다. API 키·셸 명령은 개인 실행기에만 설정하세요');
  const profile = { ...clone(previous), ...input };
  if (typeof profile.enabled !== 'boolean') throw bad('enabled 값은 true 또는 false입니다');
  profile.conductor = identifier(profile.conductor, '지휘자');
  if (!Array.isArray(profile.agents) || profile.agents.length < 1 || profile.agents.length > 16) throw bad('에이전트는 1~16개 등록하세요');
  const ids = new Set();
  profile.agents = profile.agents.map(agent => {
    if (!object(agent) || Object.keys(agent).some(key => !['id', 'label', 'kind', 'effort', 'model', 'roles'].includes(key))) throw bad('에이전트 설정에 지원하지 않는 항목이 있습니다');
    const id = identifier(agent.id, '에이전트');
    if (ids.has(id)) throw bad('에이전트 ID는 중복할 수 없습니다'); ids.add(id);
    if (!KINDS.has(agent.kind) || !EFFORTS.has(agent.effort)) throw bad('에이전트 실행 종류 또는 추론 강도를 확인하세요');
    if (!Array.isArray(agent.roles) || !agent.roles.length || agent.roles.some(role => !ROLES.has(role))) throw bad('에이전트 역할은 conductor·worker·reviewer입니다');
    return { id, label: string(agent.label || id, '에이전트 이름', 120), kind: agent.kind, effort: agent.effort, model: string(agent.model ?? '', '모델', 200, { empty: true }), roles: [...new Set(agent.roles)] };
  });
  if (!profile.agents.some(agent => agent.id === profile.conductor && agent.roles.includes('conductor'))) throw bad('지휘자에게 conductor 역할을 지정하세요');
  for (const [key, min, max] of [['maxParallel', 1, 8], ['maxRounds', 1, 10], ['maxTasks', 3, 200], ['maxAttempts', 1, 5], ['leaseSeconds', 30, 3600], ['maxRunMinutes', 1, 1440]]) profile[key] = integer(profile[key], key, min, max);
  return profile;
}

// 한 서버 프로세스의 동기 트랜잭션: 상태를 복제하고 원자 저장 성공 뒤에만 메모리에 게시한다.
// 중앙 서버를 여러 프로세스로 복제하는 배포에서는 이 파일 큐를 공유 DB의 원자적 claim으로 교체해야 한다.
export function createOrchestration({ config, now = Date.now }) {
  const file = path.join(config.dataDir, 'orchestration.json');
  let state;
  let serialized;
  const iso = () => new Date(now()).toISOString();
  function data() {
    if (!state) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (cause) {
        if (cause.code !== 'ENOENT') throw error('ORCHESTRATION_STORAGE', '오케스트레이션 저장 파일을 읽지 못했습니다', 500);
        state = { version: 1, profiles: {}, runs: {} };
      }
      if (state.version !== 1 || !object(state.profiles) || !object(state.runs)) { state = undefined; throw error('ORCHESTRATION_STORAGE', '오케스트레이션 저장 파일 형식이 올바르지 않습니다', 500); }
      serialized = JSON.stringify(state);
    }
    return state;
  }
  function mutate(operation) {
    const draft = clone(data());
    const result = operation(draft);
    const next = JSON.stringify(draft);
    if (next === serialized) return clone(result);
    try { fs.mkdirSync(config.dataDir, { recursive: true }); writeFileAtomic(file, next); }
    catch { throw error('ORCHESTRATION_STORAGE', '오케스트레이션 상태를 저장하지 못했습니다', 500); }
    state = draft; serialized = next;
    return clone(result);
  }
  const profileOf = (draft, name) => own(draft.profiles, name) || DEFAULT_ORCHESTRATION_PROFILE;
  function runOf(draft, name, id) {
    const run = typeof id === 'string' && own(draft.runs, id);
    if (!run || run.owner !== name) throw error('NO_ORCHESTRATION_RUN', '오케스트레이션 실행이 없습니다', 404);
    return run;
  }
  const publicTask = task => {
    const { lease, submission, ...result } = task;
    if (lease) result.lease_expires_at = lease.expires_at;
    return clone(result);
  };
  const publicRun = run => {
    const { conductor_session, review_lease, ...result } = run;
    result.tasks = run.tasks.map(publicTask);
    return clone(result);
  };
  function close(run, status, reason) {
    run.status = status; run.updated_at = iso(); run.finished_at = iso();
    run.review_lease = null;
    if (reason) run.error = reason;
    for (const task of run.tasks) if (['pending', 'running'].includes(task.status)) { task.status = 'cancelled'; task.lease = null; }
  }
  function sweep(run) {
    if (!ACTIVE.has(run.status)) return false;
    if (now() >= Date.parse(run.deadline_at)) { close(run, 'failed', '실행 시간 한도를 초과했습니다'); return true; }
    let changed = false;
    for (const task of run.tasks) {
      if (task.status !== 'running' || now() < Date.parse(task.lease.expires_at)) continue;
      changed = true; task.lease = null; task.error = '실행 임대 시간이 만료되었습니다';
      if (task.attempt >= run.profile.maxAttempts) { task.status = 'failed'; close(run, 'failed', '작업 재시도 한도를 초과했습니다'); break; }
      task.status = 'pending';
    }
    if (changed) run.updated_at = iso();
    return changed;
  }
  const needsSweep = run => ACTIVE.has(run.status) && (now() >= Date.parse(run.deadline_at) || run.tasks.some(task => task.status === 'running' && now() >= Date.parse(task.lease.expires_at)));
  function claimable(run, agentId, session) {
    if (!run.profile.agents.some(agent => agent.id === agentId)) return false;
    if (run.status === 'awaiting_review' && agentId === run.profile.conductor) return !run.review_lease || run.review_lease.session === session || now() >= Date.parse(run.review_lease.expires_at);
    return ['planning', 'running'].includes(run.status) && run.tasks.filter(task => task.status === 'running').length < run.profile.maxParallel && run.tasks.some(task => task.status === 'pending' && task.agent_id === agentId && task.depends_on.every(id => taskOf(run, id).status === 'completed'));
  }
  function active(run) { if (!ACTIVE.has(run.status)) throw error('RUN_CLOSED', `실행 상태가 ${run.status}입니다`, 409); }
  function taskOf(run, taskId) { const task = run.tasks.find(task => task.id === taskId); if (!task) throw error('NO_ORCHESTRATION_TASK', '작업이 없습니다', 404); return task; }
  function fence(run, task, input) {
    active(run);
    if (task.status !== 'running' || !task.lease || task.lease.session !== sessionId(input.session) || task.lease.token !== input.lease_token || task.attempt !== input.attempt || now() >= Date.parse(task.lease.expires_at)) throw error('LEASE_LOST', '작업 임대가 만료되었거나 다른 실행기가 맡았습니다', 409);
  }
  function sameSubmission(task, input, digest) {
    const entry = task.submission;
    return task.status === 'completed' && entry && entry.session === input.session && entry.token === input.lease_token && entry.attempt === input.attempt && entry.digest === digest;
  }
  function planTask(run) {
    return { id: `r${run.round}-plan`, agent_id: run.profile.conductor, kind: 'plan', title: `${run.round}회차 작업 계획`, instruction: run.goal, depends_on: [], round: run.round, status: 'pending', attempt: 0, result: null, created_at: iso(), lease: null };
  }
  function normalizePlan(run, input) {
    if (!Array.isArray(input) || input.length < 2) throw bad('작업자 작업과 지휘자의 통합 작업을 포함한 계획이 필요합니다');
    if (run.tasks.length + input.length > run.profile.maxTasks) throw error('TASK_LIMIT', '전체 작업 수 한도를 초과했습니다', 409);
    const prefix = `r${run.round}-`; const ids = new Set();
    const tasks = input.map(item => {
      if (!object(item)) throw bad('작업 계획 항목을 확인하세요');
      const rawId = identifier(item.id, '작업');
      if (ids.has(rawId) || rawId === 'plan') throw bad('작업 ID가 중복되었거나 예약 이름입니다'); ids.add(rawId);
      if (!['work', 'review', 'synthesize'].includes(item.kind)) throw bad('작업 종류는 work·review·synthesize입니다');
      const agent = run.profile.agents.find(agent => agent.id === item.agent_id);
      const role = item.kind === 'review' ? 'reviewer' : item.kind === 'synthesize' ? 'conductor' : 'worker';
      if (!agent || !agent.roles.includes(role) || (item.kind === 'synthesize' && agent.id !== run.profile.conductor)) throw bad('작업에 해당 역할의 에이전트를 배정하세요');
      if (!Array.isArray(item.depends_on ?? []) || (item.depends_on || []).some(id => typeof id !== 'string')) throw bad('depends_on은 작업 ID 배열입니다');
      return { id: prefix + rawId, agent_id: agent.id, kind: item.kind, title: string(item.title || rawId, '작업 제목', 200), instruction: string(item.instruction, '작업 지시', 20000), depends_on: [...new Set(item.depends_on || [])].map(id => prefix + id), round: run.round, status: 'pending', attempt: 0, result: null, created_at: iso(), lease: null };
    });
    const synthesis = tasks.filter(task => task.kind === 'synthesize');
    if (synthesis.length !== 1) throw bad('지휘자의 synthesize 통합 작업은 정확히 하나여야 합니다');
    const final = synthesis[0];
    for (const task of tasks) for (const id of task.depends_on) if (!tasks.some(other => other.id === id) || id === task.id) throw bad('존재하지 않거나 자기 자신인 의존 작업입니다');
    final.depends_on = tasks.filter(task => task !== final).map(task => task.id);
    const visited = new Set(); const visiting = new Set();
    function visit(task) {
      if (visiting.has(task.id)) throw bad('작업 의존 관계에 순환이 있습니다');
      if (visited.has(task.id)) return;
      visiting.add(task.id);
      for (const id of task.depends_on) visit(tasks.find(other => other.id === id));
      visiting.delete(task.id); visited.add(task.id);
    }
    tasks.forEach(visit);
    return tasks;
  }

  return {
    profile(user) { return clone(profileOf(data(), userName(user))); },
    saveProfile(user, input) {
      const name = userName(user);
      const normalized = normalizeProfile(input, profileOf(data(), name));
      return mutate(draft => { put(draft.profiles, name, normalized); return normalized; });
    },
    listRuns(user, { doc_id } = {}) {
      const name = userName(user);
      const runs = Object.values(data().runs).filter(run => run.owner === name);
      if (runs.some(needsSweep)) mutate(draft => { for (const run of Object.values(draft.runs)) if (run.owner === name) sweep(run); return null; });
      return Object.values(data().runs).filter(run => run.owner === name && (!doc_id || run.doc_id === doc_id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(run => ({ id: run.id, doc_id: run.doc_id, goal: run.goal, status: run.status, round: run.round, base_version: run.base_version, request_id: run.request_id, created_at: run.created_at, updated_at: run.updated_at, completed_tasks: run.tasks.filter(task => task.status === 'completed').length, total_tasks: run.tasks.length, ...(run.error ? { error: run.error } : {}) }));
    },
    createRun(user, input) {
      const name = userName(user); const profile = clone(profileOf(data(), name));
      if (!profile.enabled) throw error('ORCHESTRATION_DISABLED', '개인 설정에서 멀티에이전트를 먼저 켜 주세요', 409);
      if (!object(input)) throw bad('실행 정보가 필요합니다');
      const docId = string(input.doc_id, '문서', 64); if (!/^[A-Za-z0-9_-]+$/.test(docId)) throw bad('문서 ID를 확인하세요');
      const goal = string(input.goal, '작업 목표', 20000);
      const baseVersion = integer(input.base_version, '기준 문서 버전', 1, Number.MAX_SAFE_INTEGER);
      if (input.request_id != null) integer(input.request_id, '요청 번호', 1, Number.MAX_SAFE_INTEGER);
      return mutate(draft => {
        const previous = Object.values(draft.runs).filter(run => run.owner === name);
        for (const run of previous) sweep(run);
        if (previous.filter(run => ACTIVE.has(run.status)).length >= 10) throw error('RUN_LIMIT', '동시에 열 수 있는 실행은 10개입니다', 409);
        const ended = previous.filter(run => !ACTIVE.has(run.status)).sort((a, b) => a.created_at.localeCompare(b.created_at));
        while (previous.length >= 200 && ended.length) { const oldest = ended.shift(); delete draft.runs[oldest.id]; previous.splice(previous.indexOf(oldest), 1); }
        const run = { id: crypto.randomUUID(), owner: name, doc_id: docId, goal, base_version: baseVersion, request_id: input.request_id ?? null, profile, status: 'planning', round: 1, created_at: iso(), updated_at: iso(), deadline_at: new Date(now() + profile.maxRunMinutes * 60000).toISOString(), tasks: [], final_result: null };
        run.tasks.push(planTask(run)); put(draft.runs, run.id, run);
        return publicRun(run);
      });
    },
    getRun(user, id) {
      const name = userName(user); const run = runOf(data(), name, id);
      const next = clone(run);
      if (sweep(next)) return mutate(draft => { put(draft.runs, id, next); return publicRun(next); });
      return publicRun(run);
    },
    claim(user, input) {
      const name = userName(user); if (!object(input)) throw bad('선점 정보가 필요합니다');
      const agentId = identifier(input.agent_id, '에이전트'); const session = sessionId(input.session);
      // 빈 polling은 전체 파일 복제·직렬화·fsync 없이 읽기만 수행한다.
      const candidates = input.run_id ? [runOf(data(), name, input.run_id)] : Object.values(data().runs).filter(run => run.owner === name);
      if (!candidates.some(run => needsSweep(run) || claimable(run, agentId, session))) return { none: true };
      return mutate(draft => {
        const all = input.run_id ? [runOf(draft, name, input.run_id)] : Object.values(draft.runs).filter(run => run.owner === name).sort((a, b) => a.created_at.localeCompare(b.created_at));
        for (const run of all) {
          sweep(run);
          const agent = run.profile.agents.find(agent => agent.id === agentId); if (!agent) continue;
          if (run.status === 'awaiting_review' && agentId === run.profile.conductor) {
            if (run.review_lease && run.review_lease.session !== session && now() < Date.parse(run.review_lease.expires_at)) continue;
            const task = [...run.tasks].reverse().find(task => task.kind === 'synthesize' && task.status === 'completed');
            run.conductor_session = session;
            run.review_lease = { session, token: crypto.randomBytes(24).toString('hex'), expires_at: new Date(Math.min(now() + run.profile.leaseSeconds * 1000, Date.parse(run.deadline_at))).toISOString() };
            run.updated_at = iso();
            return { review: true, run: publicRun(run), task: publicTask(task), agent: clone(agent), lease_token: run.review_lease.token, attempt: task.attempt, lease_expires_at: run.review_lease.expires_at };
          }
          if (!['planning', 'running'].includes(run.status) || run.tasks.filter(task => task.status === 'running').length >= run.profile.maxParallel) continue;
          const task = run.tasks.find(task => task.status === 'pending' && task.agent_id === agentId && task.depends_on.every(id => taskOf(run, id).status === 'completed'));
          if (!task) continue;
          task.attempt++; task.status = 'running'; task.started_at = iso();
          task.lease = { session, token: crypto.randomBytes(24).toString('hex'), expires_at: new Date(now() + run.profile.leaseSeconds * 1000).toISOString() };
          if (['plan', 'synthesize'].includes(task.kind)) run.conductor_session = session;
          run.updated_at = iso();
          return { run: publicRun(run), task: publicTask(task), agent: clone(agent), lease_token: task.lease.token, attempt: task.attempt, lease_expires_at: task.lease.expires_at };
        }
        return { none: true };
      });
    },
    heartbeat(user, input) {
      const name = userName(user);
      return mutate(draft => {
        const run = runOf(draft, name, input.run_id); sweep(run); const task = taskOf(run, input.task_id);
        if (run.status === 'awaiting_review' && task.kind === 'synthesize' && run.review_lease?.session === input.session && run.review_lease?.token === input.lease_token && task.attempt === input.attempt && now() < Date.parse(run.review_lease.expires_at)) {
          run.review_lease.expires_at = new Date(Math.min(now() + run.profile.leaseSeconds * 1000, Date.parse(run.deadline_at))).toISOString();
          run.updated_at = iso(); return { lease_expires_at: run.review_lease.expires_at, attempt: task.attempt };
        }
        fence(run, task, input);
        task.lease.expires_at = new Date(Math.min(now() + run.profile.leaseSeconds * 1000, Date.parse(run.deadline_at))).toISOString(); run.updated_at = iso();
        return { lease_expires_at: task.lease.expires_at, attempt: task.attempt };
      });
    },
    plan(user, input) {
      const name = userName(user);
      return mutate(draft => {
        const run = runOf(draft, name, input.run_id); sweep(run); const task = taskOf(run, `r${run.round}-plan`);
        const digest = sha(input.tasks);
        if (run.status !== 'cancelled' && sameSubmission(task, input, digest)) return publicRun(run);
        fence(run, task, input);
        const tasks = normalizePlan(run, input.tasks);
        task.status = 'completed'; task.result = { planned_tasks: tasks.map(task => task.id) }; task.completed_at = iso(); task.submission = { session: input.session, token: input.lease_token, attempt: input.attempt, digest }; task.lease = null;
        run.tasks.push(...tasks); run.status = 'running'; run.updated_at = iso();
        return publicRun(run);
      });
    },
    submit(user, input) {
      const name = userName(user); const result = jsonResult(input.result); const digest = sha(result);
      return mutate(draft => {
        const run = runOf(draft, name, input.run_id); sweep(run); const task = taskOf(run, input.task_id);
        if (task.kind === 'plan') throw bad('계획 작업은 plan 도구로 제출하세요');
        if (run.status !== 'cancelled' && sameSubmission(task, input, digest)) return publicRun(run);
        fence(run, task, input);
        task.status = 'completed'; task.result = result; task.completed_at = iso(); task.error = null; task.submission = { session: input.session, token: input.lease_token, attempt: input.attempt, digest }; task.lease = null;
        if (task.kind === 'synthesize') { run.status = 'awaiting_review'; run.final_result = result; run.review_lease = { ...task.submission, expires_at: new Date(Math.min(now() + run.profile.leaseSeconds * 1000, Date.parse(run.deadline_at))).toISOString() }; }
        run.updated_at = iso();
        return publicRun(run);
      });
    },
    fail(user, input) {
      const name = userName(user);
      const message = string(typeof input.error === 'string' ? input.error : input.error?.message || '실행기가 작업을 처리하지 못했습니다', '오류 요약', 1000);
      return mutate(draft => {
        const run = runOf(draft, name, input.run_id); sweep(run); const task = taskOf(run, input.task_id); fence(run, task, input);
        task.error = message; task.lease = null;
        if (task.attempt < run.profile.maxAttempts) task.status = 'pending';
        else { task.status = 'failed'; close(run, 'failed', '작업 재시도 한도를 초과했습니다'); }
        run.updated_at = iso(); return publicRun(run);
      });
    },
    advance(user, input) {
      const name = userName(user);
      return mutate(draft => {
        const run = runOf(draft, name, input.run_id); sweep(run);
        if (!['revise', 'complete', 'cancel'].includes(input.action)) throw bad('실행 동작은 revise·complete·cancel입니다');
        if (input.action === 'cancel' && run.status === 'cancelled') return publicRun(run);
        if (input.action === 'complete' && run.status === 'completed' && run.conductor_session === input.session) return publicRun(run);
        active(run);
        if (input.action === 'cancel') { close(run, 'cancelled'); return publicRun(run); }
        if (!run.conductor_session || run.conductor_session !== sessionId(input.session) || !run.review_lease || now() >= Date.parse(run.review_lease.expires_at)) throw error('NOT_CONDUCTOR', '현재 지휘자 세션만 다음 회차 또는 완료를 결정할 수 있습니다', 403);
        if (run.status !== 'awaiting_review') throw error('RUN_NOT_READY', '지휘자의 통합 결과를 먼저 제출하세요', 409);
        if (input.summary != null) run.summary = string(input.summary, '공유 요약', 2000, { empty: true });
        if (input.action === 'complete') close(run, 'completed');
        else {
          if (run.round >= run.profile.maxRounds) throw error('ROUND_LIMIT', '반복 개선 회차 한도를 초과했습니다', 409);
          if (run.tasks.length + 3 > run.profile.maxTasks) throw error('TASK_LIMIT', '다음 회차에 필요한 작업 수가 남지 않았습니다', 409);
          run.round++; run.status = 'planning'; run.updated_at = iso(); run.review_lease = null; run.error = null; delete run.publication_error; run.tasks.push(planTask(run));
        }
        return publicRun(run);
      });
    },
    recordPublicationIssue(user, input) {
      const name = userName(user);
      const code = input.code === 'DOCUMENT_CHANGED' ? 'DOCUMENT_CHANGED' : 'PUBLISH_FAILED';
      return mutate(draft => {
        const run = runOf(draft, name, input.run_id);
        if (run.status !== 'awaiting_review' || run.conductor_session !== sessionId(input.session) || run.review_lease?.session !== input.session || now() >= Date.parse(run.review_lease.expires_at)) throw error('NOT_CONDUCTOR', '현재 지휘자 세션이 아닙니다', 403);
        run.error = code === 'DOCUMENT_CHANGED' ? '작업 중 문서가 바뀌어 발행을 중단했습니다. 결과를 확인하고 현재 문서로 새 실행을 시작하세요.' : '통합 결과를 발행하지 못했습니다. 작업 결과를 확인하고 다시 개선하거나 새 실행을 시작하세요.';
        run.publication_error = { code, at: iso() }; run.updated_at = iso();
        return publicRun(run);
      });
    },
    authorizeConductor(user, input) {
      const run = runOf(data(), userName(user), input.run_id);
      active(run);
      if (now() >= Date.parse(run.deadline_at) || run.conductor_session !== sessionId(input.session)) throw error('NOT_CONDUCTOR', '현재 지휘자 세션이 아닙니다', 403);
      const held = run.status === 'awaiting_review' ? run.review_lease : run.tasks.find(task => ['plan', 'synthesize'].includes(task.kind) && task.status === 'running' && task.lease?.session === input.session)?.lease;
      if (!held || held.session !== input.session || now() >= Date.parse(held.expires_at)) throw error('NOT_CONDUCTOR', '지휘자 임대가 만료되었습니다. 작업을 다시 선점하세요', 403);
      return true;
    },
  };
}
