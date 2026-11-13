// 실행기의 생존 보고와 Claude 채널 연결을 구분한다. 보고 자체가 모델 응답의 증거는 아니다.
import { ServiceError } from './service.js';

export function createOrchestrationRuntime({ profile, listRuns, getRun, connections, now = Date.now }) {
  const users = new Map();
  const ttlMs = 90000;
  function report(user, input) {
    if (!profile(user).agents.some(agent => agent.id === input.agent_id)) throw new ServiceError('AGENT_NOT_CONFIGURED', '개인 설정에 등록한 실행기 ID를 지정하세요');
    if (!['idle', 'working', 'error', 'stopping'].includes(input.phase) || typeof input.session !== 'string' || !input.session) throw new ServiceError('BAD_WORKER_STATUS', '실행기 상태와 세션을 확인하세요');
    if (input.error_code != null && !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.error_code)) throw new ServiceError('BAD_WORKER_STATUS', '오류 종류는 짧은 코드만 전달하세요');
    if (input.run_id) getRun(user, input.run_id);
    let entries = users.get(user.name);
    if (!entries) { entries = new Map(); users.set(user.name, entries); }
    for (const [key, entry] of entries) if (entry.seen < now() - 3600000) entries.delete(key);
    const key = `${input.agent_id}\0${input.session}`;
    if (!entries.has(key) && entries.size >= 128) throw new ServiceError('WORKER_LIMIT', '실행기 연결 수 한도입니다', 409);
    const item = { agent_id: input.agent_id, phase: input.phase, seen: now(), last_seen: new Date(now()).toISOString(), expires_at: new Date(now() + ttlMs).toISOString(), ...(input.run_id ? { run_id: input.run_id } : {}), ...(input.task_id ? { task_id: input.task_id } : {}), ...(input.error_code ? { error_code: input.error_code } : {}) };
    entries.set(key, item);
    return { ok: true, expires_at: item.expires_at };
  }
  function status(user) {
    const settings = profile(user);
    const workers = [...(users.get(user.name)?.values() || [])].map(({ seen, ...entry }) => ({ ...entry, online: entry.phase !== 'stopping' && now() - seen < ttlMs }));
    const channels = connections(user).filter(connection => connection.channel && /claude/i.test(`${connection.agent || ''} ${connection.client || ''}`));
    const agents = settings.agents.map(agent => {
      const worker = workers.filter(worker => worker.agent_id === agent.id).sort((a, b) => Number(b.online) - Number(a.online) || Number(b.phase === 'working') - Number(a.phase === 'working') || b.last_seen.localeCompare(a.last_seen))[0];
      const channel = agent.kind === 'claude-code' ? channels.at(-1) : null;
      return { id: agent.id, label: agent.label, kind: agent.kind, effort: agent.effort, online: !!(worker?.online || channel), source: worker?.online ? 'worker' : channel ? 'channel' : null, phase: worker?.online ? worker.phase : channel ? 'connected' : 'offline', last_seen: worker?.last_seen || channel?.lastSeen || null, ...(worker?.error_code ? { error_code: worker.error_code } : {}) };
    });
    const queue = { active_runs: 0, pending_tasks: 0, running_tasks: 0 };
    const waiting = [];
    const addWaiting = (run, task) => {
      const noWorker = task.kind === 'plan' && !run.profile?.agents?.some(agent => agent.roles.includes('worker') && agents.find(online => online.id === agent.id)?.online);
      waiting.push({ run_id: run.id, task_id: task.id, agent_id: task.agent_id, kind: task.kind, reason: !agents.find(agent => agent.id === task.agent_id)?.online ? 'agent_offline' : noWorker ? 'worker_unavailable' : 'waiting_for_claim' });
    };
    for (const info of listRuns(user)) {
      if (!['planning', 'running', 'awaiting_review'].includes(info.status)) continue;
      const run = getRun(user, info.id); queue.active_runs++;
      for (const task of run.tasks) {
        if (task.status === 'running') queue.running_tasks++;
        if (task.status !== 'pending') continue;
        queue.pending_tasks++;
        if (task.depends_on.every(id => run.tasks.find(other => other.id === id)?.status === 'completed')) addWaiting(run, task);
      }
      if (run.status === 'awaiting_review') {
        const task = [...run.tasks].reverse().find(task => task.kind === 'synthesize' && task.status === 'completed');
        if (task) addWaiting(run, task);
      }
    }
    return { enabled: settings.enabled, conductor: settings.conductor, workers, agents, queue, waiting, checked_at: new Date(now()).toISOString() };
  }
  return { report, status };
}
