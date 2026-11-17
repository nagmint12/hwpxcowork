// 시작 파일 하나로 일반 요청과 멀티에이전트 작업을 함께 처리한다. 인증값은 환경에서만 받는다.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWorkerArgs, createWorkerAi, checkWorkerConnection } from './ai-worker.mjs';
import { createOrchestrationAi } from './orchestration-worker.mjs';
import { createApiWorker } from '../server/worker.js';
import { createOrchestrationWorker } from '../server/orchestration-worker.js';

const HELP = `Codex MCP 직접 자동 처리 실행기
  start-codex-agent.bat [--check] [--model <모델 ID>] [--effort low|medium|high|xhigh|max|ultra] [--url <중앙 MCP 주소>] [--mcp 2]
  --mcp 2 는 새 MCP 연결(작업 도구 넷 task·read·edit·finish — docs/MCP_REDESIGN_2026-11-16.md)로 일반 요청을 처리합니다(기본 1 = 예전 연결).
  모델·추론 강도는 웹 문서함의 'AI 모델·추론 강도'에서 정하면 요청마다 그 값이 우선합니다
  또는 node scripts/codex-agent.mjs [같은 옵션]
  이 실행기 하나가 일반 AI 요청과 내 Codex 협업 작업을 함께 처리합니다.
  Codex가 MCP로 원문·메모·첨부를 조회하고 표·서식·그림 제안과 완료를 직접 등록합니다.
  필수: HWPX_COWORK_TOKEN, 최초 로그인: codex login
  선택: --codex-command <실행 파일>, HWPX_COWORK_URL
  --check는 로그인과 두 큐의 도구만 확인하며 모델을 호출하거나 작업을 선점하지 않습니다.
  프로필의 Codex 지휘자를 우선 선택하고, 없으면 첫 Codex 작업자를 선택합니다.
  협업 사용이 꺼져 있으면 설정을 켤 때까지 기다립니다. 종료: Ctrl+C`;

const REQUIRED = ['get_orchestration_profile', 'claim_orchestration_task', 'plan_orchestration_run', 'heartbeat_orchestration_task',
  'submit_orchestration_task', 'fail_orchestration_task', 'publish_orchestration_result', 'advance_orchestration_run'];

export function parseCodexAgentArgs(argv, env = process.env) {
  return parseWorkerArgs([...argv, '--provider', 'codex'], env);
}

async function toolNames(worker) {
  const client = await worker.connected();
  const names = new Set(); const seen = new Set(); let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools || []) names.add(tool.name);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Object.assign(new Error('도구 목록을 읽지 못했습니다.'), { code: 'PREFLIGHT_FAILED' });
    if (cursor) seen.add(cursor);
  } while (cursor);
  return names;
}

export async function runCodexAgent({ options, env = process.env, dependencies = {} }) {
  const log = dependencies.log || (line => process.stderr.write(`[hwpx Codex] ${line}\n`));
  const normalAi = (dependencies.createWorkerAi || createWorkerAi)(options, env);
  const makeNormal = dependencies.createApiWorker || createApiWorker;
  const makeOrchestration = dependencies.createOrchestrationWorker || createOrchestrationWorker;
  const makeOrchestrationAi = dependencies.createOrchestrationAi || createOrchestrationAi;
  const workers = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    await Promise.allSettled(workers.map(worker => worker.stop()));
  };
  try {
    log('Codex 로그인과 실행 준비 상태를 확인합니다.');
    const auth = await normalAi.check();
    if (!auth.ready) throw Object.assign(new Error('Codex 로그인 점검에 실패했습니다.'), { code: auth.code || 'CODEX_AUTH_REQUIRED' });
    const normal = makeNormal({ url: options.url, token: options.token, ai: normalAi, agent: 'ChatGPT (Codex)', clientName: 'hwpx-codex-worker' });
    workers.push(normal);
    log('중앙 서버의 일반 요청 도구를 확인합니다.');
    const connection = await (dependencies.checkWorkerConnection || checkWorkerConnection)(normal);
    const names = await toolNames(normal);
    let orchestration; let profile; let agent;
    if (REQUIRED.every(name => names.has(name))) {
      profile = await normal.callJson('get_orchestration_profile', {});
      agent = profile.agents?.find(item => item.id === profile.conductor && item.kind === 'codex')
        || profile.agents?.find(item => item.kind === 'codex');
      if (agent) {
        // 모델이 비어 있는 기본 프로필도 시작 전에 검증한다. 생성 호출은 하지 않는다.
        makeOrchestrationAi(options, agent, env);
        orchestration = makeOrchestration({ url: options.url, token: options.token, agentId: agent.id,
          aiFactory: currentAgent => makeOrchestrationAi(options, currentAgent, env) });
        workers.push(orchestration);
        await orchestration.profile();
      } else log('내 프로필에 Codex 협업 에이전트가 없어 일반 요청만 처리합니다.');
    } else log('협업 도구가 없는 서버입니다. 일반 요청만 처리하며 서버 업데이트 후 다시 시작하세요.');
    // 일반 요청을 처리할 MCP 연결: 2 = 새 연결(작업 도구 넷 — --mcp 2), 1 = 예전 연결
    const mcp = normalAi.mcpSurface === 'v2' ? 2 : 1;
    const summary = { provider: 'codex', connected: !!connection.connected, ordinaryReady: true, mcp,
      orchestrationReady: !!orchestration, orchestrationEnabled: !!profile?.enabled, agentId: agent?.id || null,
      modelCalled: false, queueClaimed: false };
    if (options.check) { await stop(); return { summary, stop, workers }; }
    normal.start();
    if (orchestration) orchestration.start();
    log(orchestration ? '일반 요청과 Codex 협업 작업의 자동 처리를 시작했습니다.' : '일반 요청 자동 처리를 시작했습니다.');
    log(mcp === 2 ? '일반 요청은 새 MCP 연결(작업 도구 넷 task·read·edit·finish)로 처리합니다.' : '일반 요청은 예전 MCP 연결로 처리합니다(새 연결은 --mcp 2 또는 start-codex-agent-v2.bat).');
    if (orchestration && !profile.enabled) log('협업 사용이 꺼져 있습니다. 웹 문서함의 AI 협업 설정을 켜면 협업 큐도 처리합니다.');
    log('작업이 없으면 대기합니다. 종료하려면 Ctrl+C를 누르세요.');
    return { summary, stop, workers };
  } catch (error) { await stop(); throw error; }
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  let control;
  try {
    const options = parseCodexAgentArgs(argv, env);
    if (options.help) { process.stdout.write(`${HELP}\n`); return; }
    control = await runCodexAgent({ options, env, dependencies });
    if (options.check) { process.stdout.write(`${JSON.stringify(control.summary, null, 2)}\n`); return; }
    const shutdown = async () => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); await control.stop(); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) {
    await control?.stop();
    const code = /^[A-Z_]{2,64}$/.test(error.code || '') ? error.code : 'START_FAILED';
    process.stderr.write(`[hwpx Codex] 시작 실패(${code}). 서버 연결·본인 토큰·codex login·프로필 모델 설정을 확인하세요.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
