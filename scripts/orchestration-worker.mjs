// 개인별 오케스트레이션 참여 실행기. 키는 환경에서만 받고 서버 설정 파일은 읽지 않는다.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexProposer } from '../server/codex-ai.js';
import { GoogleCliProposer } from '../server/google-cli-ai.js';
import { AiProposer, AI_EFFORTS } from '../server/ai.js';
import { createOrchestrationWorker, orchestrationErrorMessage } from '../server/orchestration-worker.js';
import { parseWorkerArgs } from './ai-worker.mjs';

const HELP = `개인 멀티에이전트 실행기
  npm run orchestrator -- --agent-id codex --provider codex
  npm run orchestrator -- --agent-id gemini --provider gemini-cli
  npm run orchestrator -- --agent-id antigravity --provider antigravity
  npm run orchestrator -- --agent-id api-worker --provider openai --gateway baze --model <모델 ID>
  npm run orchestrator -- --agent-id claude-api --provider anthropic --model <모델 ID>
  필수: HWPX_COWORK_TOKEN (본인 토큰)
  API: 제공자 키 환경 변수 또는 BAZE_API_KEY(API)
  --url <중앙 MCP 주소>, --check(모델 호출·작업 선점 없이 점검)
  --session <영문·숫자·_- 8~64자 실행기 세션> 또는 HWPX_COWORK_ORCHESTRATION_SESSION
  --effort <추론 강도>: 개인 프로필 권장값보다 우선
  지휘자·작업자별로 이 실행기를 따로 실행하세요. 실제 모델·계정은 실행기의 옵션으로 선택합니다.
  Claude Code 채널 등 외부 에이전트는 새 orchestration MCP 도구로 같은 대기열에 참여할 수 있습니다.
  지휘자가 완료한 문서 개선안은 편집기의 제안으로 저장됩니다.`;

export function parseOrchestrationArgs(argv, env = process.env) {
  if (argv.some(arg => ['--help', '-h'].includes(arg))) return { help: true };
  const passthrough = []; const extra = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!['--agent-id', '--session', '--effort'].includes(arg)) { passthrough.push(arg); continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 뒤에 값이 필요합니다.`);
    extra[arg.slice(2)] = value;
  }
  const options = parseWorkerArgs(passthrough, env);
  const agentId = extra['agent-id'] || env.HWPX_COWORK_ORCHESTRATION_AGENT;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId || '')) throw new Error('--agent-id에 개인 프로필의 에이전트 ID를 지정하세요.');
  const session = extra.session || env.HWPX_COWORK_ORCHESTRATION_SESSION;
  if (session != null && !/^[A-Za-z0-9_-]{8,64}$/.test(session)) throw new Error('--session은 영문·숫자·_- 8~64자로 지정하세요.');
  const effort = extra.effort || env.HWPX_COWORK_AI_EFFORT || null;
  if (effort && !AI_EFFORTS.includes(effort)) throw new Error(`--effort는 ${AI_EFFORTS.join('|')} 중 하나입니다.`);
  // gateway·키·모델은 실행기만 선택한다. 서버 프로필에서 API 목적지를 가져오지 않는다.
  return { ...options, agentId, session, effort };
}

export function createOrchestrationAi(options, agent = {}, env = process.env) {
  const effort = options.effort || agent.effort || 'medium';
  const rawModel = options.model || agent.model;
  const model = typeof rawModel === 'string' ? rawModel.trim() || undefined : rawModel;
  if (options.provider === 'codex') return new CodexProposer({ model, command: options.command, effort }, { env });
  if (['gemini-cli', 'antigravity'].includes(options.provider)) return new GoogleCliProposer({ provider: options.provider, model, command: options.command }, { env });
  return new AiProposer({ ai: { provider: options.provider, model, gateway: options.gateway, baseUrl: options.baseUrl,
    effort, enabled: true, workspace: 'mcp', maxProposals: 40 } }, { key: options.key });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options; let worker;
  try {
    options = parseOrchestrationArgs(argv, env);
    if (options.help) { process.stdout.write(`${HELP}\n`); return; }
    worker = createOrchestrationWorker({ url: options.url, token: options.token, agentId: options.agentId, session: options.session,
      aiFactory: agent => createOrchestrationAi(options, agent, env) });
    const { profile, agent } = await worker.profile();
    const client = await worker.connected();
    const tools = (await client.listTools()).tools;
    const required = ['claim_orchestration_task', 'plan_orchestration_run', 'heartbeat_orchestration_task', 'submit_orchestration_task', 'fail_orchestration_task', 'publish_orchestration_result', 'advance_orchestration_run'];
    if (required.some(name => !tools.some(tool => tool.name === name))) throw Object.assign(new Error('오케스트레이션 도구가 없습니다.'), { code: 'SERVER_UPDATE_REQUIRED' });
    const ai = createOrchestrationAi(options, agent, env);
    if (typeof ai.check === 'function') {
      const auth = await ai.check();
      if (!auth.ready) throw Object.assign(new Error('개인 CLI 준비 상태를 확인하세요.'), { code: auth.code || 'PREFLIGHT_FAILED' });
    } else if (!ai.enabled) throw Object.assign(new Error('개인 모델과 API 키 설정을 확인하세요.'), { code: 'AI_NOT_READY' });
    if (options.check) {
      process.stdout.write(`${JSON.stringify({ connected: true, enabled: profile.enabled, agent: options.agentId, provider: options.provider,
        effort: options.effort || agent.effort, modelCalled: false, queueClaimed: false }, null, 2)}\n`);
      await worker.stop(); return;
    }
    worker.start();
    process.stderr.write(`[hwpx 오케스트레이션] ${options.agentId} 실행기를 시작했습니다. 세션 ${worker.session}\n`);
    if (!profile.enabled) process.stderr.write('[hwpx 오케스트레이션] enabled=false: 개인 협업 사용이 꺼져 있습니다. 설정을 켤 때까지 작업을 맡지 않고 대기합니다.\n');
    process.stderr.write('재시작 후 통합 작업을 이어가려면 같은 --session 값을 사용하세요. 종료하려면 Ctrl+C를 누르세요.\n');
    const stop = async () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); await worker.stop(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    await worker?.stop();
    // 키나 API 원시 오류를 출력하지 않는다.
    process.stderr.write(`[hwpx 오케스트레이션] ${options ? orchestrationErrorMessage(error) : error.message}\n`);
    if (!options) process.stderr.write(`${HELP}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
