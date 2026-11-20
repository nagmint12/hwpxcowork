// 연결별 모델·추론 강도(2026-10-31): 참여자가 웹에서 자기 AI 연결(내 PC 의 실행기·채널 에이전트)의 모델과 추론 강도를 정한다.
//   저장: <dataDir>/ai-run.json { version: 1, users: { 이름: { 종류: { model, effort, at } } }, catalogs: { 이름: { 종류: { at, models } } } }
//   - 실행기(server/worker.js — Codex·Gemini CLI·Antigravity·개인 API)는 요청마다 GET /api/me/ai-run 을 읽어 그 값으로 부른다(비워 두면
//     실행할 때 준 --model·--effort, 그것도 없으면 그 AI 의 기본값). 쓸 수 있는 모델 목록은 실행기가 알려 준다(PUT /api/me/ai-run/catalog —
//     Codex 는 `codex debug models`, 개인 API 는 제공자의 모델 목록 조회 — 둘 다 생성 호출·과금 없음).
//   - Claude Code: 실행기(ai-worker --provider claude-code — server/claude-cli-ai.js, 2026-11-13)는 요청마다 읽고,
//     채널 에이전트는 띄울 때(start-agent.bat → scripts/run-settings.mjs) --model·--effort 로 넘긴다(다음 실행부터 — launchNote).
//   - 실행기를 켜는 곳(RUN_KINDS[].start — 웹 '모델·추론 강도' 표의 마우스 올림 글): 2026-11-17 실행기 bat(start-codex-agent·start-claude-worker·
//     start-gemini-agent·start-antigravity-agent)을 지웠다(사용자 결정). Windows 앱 [AI → 실행기 관리…] 또는 명령줄 npm run worker 가 대신한다.
//   - ChatGPT·Claude 웹 대화, 직접 띄운 Claude Code·Codex 대화의 모델은 그 앱이 고른다 — MCP 서버가 바꿀 수 없다.
//   - 관리자 Codex 자동 실행기는 modelSelection=auto가 기본이다. 기존 model/effort는 판단용·실패 시 값으로 보존한다.
import fs from 'node:fs';
import path from 'node:path';
import { AI_EFFORTS } from './ai.js';
import { CODEX_EFFORTS } from './codex-ai.js';
import { MODEL_SELECTION_MODES } from './codex-model-selection.js';
import { CLAUDE_EFFORTS } from './claude-cli-ai.js';
import { ServiceError } from './service.js';
import { writeFileAtomic } from './store.js';

export const CLAUDE_CODE_EFFORTS = CLAUDE_EFFORTS;
// Claude Code 는 목록 명령이 없다(2.1.327 확인) — 별칭(fable·opus·sonnet·haiku)을 앞에 둔다. 별칭은 그 PC 의 Claude Code 가
// 아는 가장 새 모델로 풀리므로 새 모델이 나와도 이 목록을 고치지 않고 따라간다(2026-11-18 — `claude --help` 의 --model 설명). 뒤는 고정 ID.
const CLAUDE_CODE_MODELS = Object.freeze([
  { id: 'fable', label: 'Fable 최신 (자동)' }, { id: 'opus', label: 'Opus 최신 (자동)' },
  { id: 'sonnet', label: 'Sonnet 최신 (자동)' }, { id: 'haiku', label: 'Haiku 최신 (자동)' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]);

/** 연결 종류 — applies: 'request'(요청마다 적용) | 'launch'(다음 실행부터), launchNote: 같은 값을 띄울 때 쓰는 다른 연결(채널)의 안내.
 *  차례 = 웹 표의 차례: 구독 AI(Codex·Claude Code — 추가 비용 없음) 먼저, API 실행기(사용료 별도) 마지막(2026-11-13 운영 결정) */
// start: 켜는 곳 — Windows 앱의 실행기 관리 창(deploy/desktop/runners.mjs RUNNER_AIS — Codex·Claude Code·Gemini CLI·Antigravity) · 명령줄.
// API 실행기는 앱 창에 없다 — 명령줄 또는 실행기 ZIP 의 start-worker.bat(deploy/portable/worker)
const APP_RUNNERS = 'Windows 앱 [AI → 실행기 관리…]';
const workerCmd = (provider) => `npm run worker -- --provider ${provider}`;
export const RUN_KINDS = Object.freeze([
  { id: 'codex', label: 'Codex (ChatGPT 로그인)', efforts: CODEX_EFFORTS, applies: 'request', start: `${APP_RUNNERS} · ${workerCmd('codex')}` },
  { id: 'claude-code', label: 'Claude Code (Claude 로그인)', efforts: CLAUDE_CODE_EFFORTS, applies: 'request', start: `${APP_RUNNERS} · ${workerCmd('claude-code')}`, launchNote: '채널(start-agent.bat)은 다음에 띄울 때부터', models: CLAUDE_CODE_MODELS },
  { id: 'gemini-cli', label: 'Gemini CLI', efforts: [], applies: 'request', start: `${APP_RUNNERS} · ${workerCmd('gemini-cli')}` },
  { id: 'antigravity', label: 'Antigravity', efforts: [], applies: 'request', start: `${APP_RUNNERS} · ${workerCmd('antigravity')}` },
  { id: 'api', label: 'API 실행기 (사용료 별도)', efforts: AI_EFFORTS.filter((e) => e !== 'none' && e !== 'minimal'), applies: 'request', start: `${workerCmd('openai|anthropic|gemini')} --model <모델 ID> · 실행기 ZIP 의 start-worker.bat` },
]);
const KIND = new Map(RUN_KINDS.map((k) => [k.id, k]));
// 모델 ID: 실행 파일 인자·배치 파일로 넘어가므로 영문·숫자와 . _ : / @ - 만
export const RUN_MODEL_RE = /^[A-Za-z0-9._:/@-]{1,200}$/;
const MODELS_MAX = 300;
const bad = (message) => new ServiceError('BAD_AI_RUN', message, 400);

function cleanRunSettings(kind, body) {
  const model = body.model == null ? '' : String(body.model).trim();
  if (model && (!RUN_MODEL_RE.test(model) || model.startsWith('-'))) throw bad('모델 ID는 영문·숫자와 . _ : / @ - 만 쓸 수 있고 -로 시작할 수 없습니다(200자 이내)');
  const effort = body.effort == null ? '' : String(body.effort).trim().toLowerCase();
  if (effort && !kind.efforts.includes(effort)) throw bad(kind.efforts.length ? `${kind.label}의 추론 강도는 ${kind.efforts.join('·')} 중 하나입니다` : `${kind.label}은 추론 강도를 정할 수 없습니다`);
  return { model, effort };
}

/** 실행기가 알려 준 모델 목록 정리 → [{ id, label?, efforts?, defaultEffort? }] */
function cleanModels(kind, list) {
  if (!Array.isArray(list)) throw bad('models 는 목록이어야 합니다');
  const allowed = new Set(kind.efforts);
  const seen = new Set(); const out = [];
  for (const m of list.slice(0, MODELS_MAX)) {
    const id = String(m?.id ?? '').trim();
    if (!RUN_MODEL_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const item = { id };
    const label = String(m?.label ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (label && label !== id) item.label = label;
    if (Array.isArray(m?.efforts)) { const ef = m.efforts.map(String).filter((e) => allowed.has(e)); if (ef.length) item.efforts = [...new Set(ef)]; }
    if (allowed.has(String(m?.defaultEffort ?? ''))) item.defaultEffort = String(m.defaultEffort);
    out.push(item);
  }
  return out;
}

export function createAiRun({ config }) {
  const file = path.join(config.dataDir, 'ai-run.json');
  let state = null;
  function data() {
    if (!state) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') throw new ServiceError('AI_RUN_STORAGE', '연결별 모델 설정 파일을 읽지 못했습니다(관리자에게 알리세요)', 500);
        state = null;
      }
      if (!state || state.version !== 1 || typeof state.users !== 'object' || typeof state.catalogs !== 'object') state = { version: 1, users: {}, catalogs: {} };
    }
    return state;
  }
  function save() { fs.mkdirSync(config.dataDir, { recursive: true }); writeFileAtomic(file, JSON.stringify(data(), null, 1)); }
  const kindOr400 = (id) => { const k = KIND.get(String(id ?? '')); if (!k) throw bad(`연결 종류는 ${RUN_KINDS.map((x) => x.id).join('·')} 중 하나입니다`); return k; };

  /** GET /api/me/ai-run → { kinds: [{ id, label, efforts, applies, start, models(목록), modelsFrom('reported'|'builtin'|null), modelsAt }], settings: { 종류: { model, effort } } } */
  function view(user) {
    const mine = data().users[user.name] || {}; const cat = data().catalogs[user.name] || {};
    return {
      kinds: RUN_KINDS.map((k) => {
        const reported = cat[k.id];
        const models = reported?.models?.length ? reported.models : (k.models || []);
        return { id: k.id, label: k.label, efforts: [...k.efforts], applies: k.applies, start: k.start, ...(k.launchNote ? { launchNote: k.launchNote } : {}), models, modelsFrom: reported?.models?.length ? 'reported' : k.models ? 'builtin' : null, modelsAt: reported?.at || null,
          ...(k.id === 'codex' && user.role === 'admin' ? { canSelectModel: true } : {}) };
      }),
      settings: {
        ...Object.fromEntries(Object.entries(mine).filter(([id]) => KIND.has(id)).map(([id, v]) => [id, { model: v.model || null, effort: v.effort || null,
          ...(id === 'codex' && user.role === 'admin' ? { modelSelection: v.modelSelection || 'auto' } : {}) }])),
        // 관리자 기존 model/effort는 판단용·실패 시 설정으로 보존한다. 조회는 저장 파일을 바꾸지 않는다.
        ...(user.role === 'admin' && !mine.codex ? { codex: { model: null, effort: null, modelSelection: 'auto' } } : {}),
      },
    };
  }

  /** PUT /api/me/ai-run { kind, model?, effort?, modelSelection? } — 관리자 Codex만 auto/manual 선택 */
  function saveFor(user, body = {}) {
    const k = kindOr400(body.kind);
    const { model, effort } = cleanRunSettings(k, body);
    if (body.modelSelection != null && (k.id !== 'codex' || user.role !== 'admin' || !MODEL_SELECTION_MODES.includes(body.modelSelection))) {
      throw bad('관리자 Codex의 모델 선택 방식은 manual·auto 중 하나입니다');
    }
    const users = data().users; const mine = users[user.name] || (users[user.name] = {});
    const modelSelection = k.id === 'codex' && user.role === 'admin' ? body.modelSelection || mine[k.id]?.modelSelection : null;
    if (!model && !effort && !modelSelection) delete mine[k.id];
    else mine[k.id] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(modelSelection ? { modelSelection } : {}), at: new Date().toISOString() };
    if (!Object.keys(mine).length) delete users[user.name];
    save();
    return view(user);
  }

  /** 요청에 저장할 실행기 설정. 계정 기본값은 실행기가 처리 시 읽는다. */
  function requestSettings(user, body) {
    if (body == null) return null;
    const k = kindOr400(body.kind);
    if (k.applies !== 'request') throw bad('요청에서 설정을 바꿀 수 없는 실행기입니다');
    const { model, effort } = cleanRunSettings(k, body);
    if (!model && !effort) return null;
    const savedModel = data().users[user.name]?.[k.id]?.model;
    const reported = data().catalogs[user.name]?.[k.id]?.models;
    const models = reported?.length ? reported : k.models;
    const allowed = models?.find(m => m.id === (model || savedModel))?.efforts;
    if (effort && allowed?.length && !allowed.includes(effort)) throw bad(`이 모델의 추론 강도는 ${allowed.join('·')} 중 하나입니다`);
    return { kind: k.id, model: model || null, effort: effort || null };
  }

  /** PUT /api/me/ai-run/catalog { kind, models } — 실행기가 그 사람 계정으로 쓸 수 있는 모델 목록을 알린다 */
  function report(user, body = {}) {
    const k = kindOr400(body.kind);
    const models = cleanModels(k, body.models);
    const cats = data().catalogs; const mine = cats[user.name] || (cats[user.name] = {});
    mine[k.id] = { at: new Date().toISOString(), models };
    save();
    return { kind: k.id, count: models.length };
  }

  return { view, save: saveFor, report, requestSettings };
}
