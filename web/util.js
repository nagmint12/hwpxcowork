// 공용: 로그인 상태·REST 호출·알림·형식 도우미
import { reactive, ref } from '/vendor/vue.esm-browser.prod.js';

const readToken = () => { try { return localStorage.getItem('hwpx.token') || ''; } catch { return ''; } };
export const state = reactive({ token: readToken(), me: null, config: null, route: location.hash || '#/' });

export async function api(path, { method = 'GET', body, raw, headers = {}, signal, keepalive } = {}) {
  const h = { Authorization: `Bearer ${state.token}`, ...headers };
  if (body !== undefined && !raw) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  if (raw) h['Content-Type'] = h['Content-Type'] || 'application/octet-stream';
  const r = await fetch(path, { method, headers: h, body, signal, keepalive });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
  if (!r.ok) throw Object.assign(new Error((data && data.message) || `${r.status}`), { code: data && data.error, status: r.status, data });
  return data;
}

// ── 알림(토스트) ──
export const toasts = ref([]); let toastSeq = 0;
export function toast(msg, { kind = 'info', ms = 3800, action } = {}) {
  const id = ++toastSeq; toasts.value = [...toasts.value.slice(-3), { id, msg, kind, action }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, ms);
}
export const toastError = (e, prefix = '') => toast(`${prefix}${e?.message || e}`, { kind: 'error', ms: 6000 });

// ── 형식 ──
export const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
export function fmtShort(iso) {
  if (!iso) return ''; const d = new Date(iso); const now = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
export function fmtSize(n) { if (n == null) return ''; if (n < 1024) return `${n}B`; if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`; return `${(n / 1048576).toFixed(1)}MB`; }
export const clip = (s, n = 40) => { const a = Array.from(String(s ?? '')); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
export function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export function markup(text) {
  return esc(text).replace(/\{\+([\s\S]*?)\+\}/g, '<span class="ins">$1</span>').replace(/\[-([\s\S]*?)-\]/g, '<span class="del">$1</span>');
}

// ── 종류·다듬기 이름(서버 /api/config 가 주면 그것) ──
export const DEFAULT_KINDS = [
  { id: 'review', label: 'AI 검토' }, { id: 'suggest', label: '문장 제안' }, { id: 'polish', label: '다듬기' },
  { id: 'instruct', label: '지시' }, { id: 'fill_table', label: '표 채우기' }, { id: 'make_table', label: '표 만들기' }, { id: 'insert', label: '문단 추가' },
];
export const DEFAULT_PRESETS = [
  { id: 'concise', label: '간결하게' }, { id: 'formal', label: '공문서체로' }, { id: 'spelling', label: '맞춤법·띄어쓰기' },
  { id: 'plain', label: '쉽게 풀어쓰기' }, { id: 'factcheck', label: '수치·사실 확인' },
];
export const kinds = () => (state.config?.kinds?.length ? state.config.kinds : DEFAULT_KINDS);
export const presets = () => (state.config?.presets?.length ? state.config.presets : DEFAULT_PRESETS);
export const kindLabel = (id) => kinds().find((k) => k.id === id)?.label || id || '요청';
export const presetLabel = (id) => presets().find((k) => k.id === id)?.label || id || '';
// 요청 상태 칩은 ui.js requestBadge(대기열·전달됨·처리 중·확인 필요·완료·실패·취소됨 — docs/UI_TERMS.md §1-3). 이 표는 제안 상태와 그 밖의 대비용
export const STATUS_LABEL = { pending: '대기', working: '처리 중', done: '완료', failed: '실패', cancelled: '취소됨', applied: '적용됨', rejected: '거절됨', undone: '복구됨', superseded: '다른 안 적용', withdrawn: '거둠' };   // withdrawn: 에이전트가 거둔 제안(2026-11-17 MCP_REDESIGN §10.4 나-4 — 서버 목록에는 기본으로 오지 않는다)

// ───────── 연결된 작업 환경 이름(보낼 곳·보내기 단추·경로 칩·연결 알약·자동 처리 상태 줄) ─────────
// 참여자에게는 '내 에이전트'·'서버 AI' 대신 실제로 일을 맡는 환경 이름(API·Codex·ChatGPT·Claude Code …)을 보인다.
// 근거: 채널 에이전트 세션의 agent·client(server/agents.js — 브리지는 clientInfo, 실행기는 scripts/ai-worker.mjs workerAgentName),
// 내 AI 키(state.me.personalAi — gateway 'baze' = API). 중앙 공용 서버 AI 는 배포 전이라 이름을 드러내지 않는다('AI').
// 앞 규칙이 이긴다: 'ChatGPT (Codex)' → Codex, 'OpenAI API (BAZE)'·'… (API)' → API
const ENV_RULES = [
  // '… API (게이트웨이 이름)' — 예전 실행기가 게이트웨이 이름을 괄호에 넣었다. 그 이름은 그대로 보이지 않고 'API' 로
  [/\bAPI\s*\(|\bbaze\b|\bAPI\b.*게이트웨이|^API(?:\s|$)/i, 'API'],
  [/codex/i, 'Codex'],
  [/claude[\s_-]*code/i, 'Claude Code'],
  [/chatgpt|openai-mcp/i, 'ChatGPT'],
  [/cursor/i, 'Cursor'],
  [/gemini[\s_-]*cli/i, 'Gemini CLI'],
];
const PROVIDER_NAME = { openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini' };
/** 채널 에이전트 세션(agent·client) → 환경 이름. 모르는 이름은 그대로(짧게), 이름이 없거나 'AI' 면 '' */
export function agentEnvName(agent, client = '') {
  const a = String(agent ?? '').trim(); const c = String(client ?? '').trim();
  for (const s of [a, c]) if (s) for (const [re, name] of ENV_RULES) if (re.test(s)) return name;
  return a && a !== 'AI' ? clip(a, 24) : '';
}
/** 내 AI 키(state.me.personalAi) → 환경 이름. 꺼져 있거나 없으면 '' */
export function personalEnvName(p) {
  if (!p?.active) return '';
  if (p.gateway === 'baze') return 'API';
  return PROVIDER_NAME[p.provider] ? `${PROVIDER_NAME[p.provider]} API` : '내 AI 키';
}
/** 서버 경로(route 'server')로 처리한 이 — 내 키면 그 환경 이름, 공용 서버 AI·모의 AI 는 'AI'(이름을 드러내지 않는다) */
export function serverEnvName(handledBy) {
  const h = String(handledBy ?? '');
  if (h === '예시 답변') return h;   // 튜토리얼 6 — 연결이 없을 때의 준비된 답변
  if (/\bAPI\s*\(|\bbaze\b|^API(?:\s|$)/i.test(h)) return 'API';
  if (/개인 키/.test(h)) return '내 AI 키';
  return 'AI';
}
/**
 * 지금 연결된 작업 환경(순수 함수 — tests/util.test.mjs).
 * @param agentMe { online, sessions:[{ agent, client, channel }] } — store 의 agentMe(서버는 가장 최근 채널 세션에 알린다)
 * @param personalAi state.me.personalAi · @param serverAi 공용 서버 AI 켜짐(state.config.aiEnabled)
 * @param agentName 세션 목록이 아직 없을 때 쓸 이름(d.s.agents 지도)
 * @returns { agent: 채널 환경 이름|'', personal: 내 키 환경 이름|'', server: 서버 경로 이름|'', serverOn, connected: 연결된 환경|'',
 *            auto: 자동이 갈 곳 이름(없으면 '대기열'), autoRoute: 'agent'|'server'|'queue' }
 */
export function workEnv({ agentMe = null, personalAi = null, serverAi = false, agentName = '', apiOnly = false, ownAi = false } = {}) {
  if (!ownAi && (apiOnly || personalAi?.apiOnly)) {
    const serverOn = !!personalAi?.active;
    if (personalAi?.method === 'codex-worker') {
      const server = serverOn ? '관리자 Codex' : '';
      return { apiOnly: true, agent: '', personal: server, server, serverOn, connected: server, auto: server || 'Codex 연결 대기', autoRoute: 'agent' };
    }
    if (personalAi?.method === 'mcp-events') {
      const server = serverOn ? '관리자 ChatGPT' : '';
      return { apiOnly: true, sharedChatGPT: true, agent: '', personal: server, server, serverOn, connected: server, auto: server || 'ChatGPT 구독 대기', autoRoute: 'queue' };
    }
    const server = serverOn ? '관리자 API' : '';
    return { apiOnly: true, agent: '', personal: server, server, serverOn, connected: server, auto: server || 'API 연결 필요', autoRoute: 'server' };
  }
  const ss = Array.isArray(agentMe?.sessions) ? agentMe.sessions.filter((x) => x && x.channel) : [];
  const last = ss[ss.length - 1];
  const agent = agentMe?.online ? (agentEnvName(last?.agent || agentName, last?.client) || '연결된 AI') : '';
  const personal = personalEnvName(personalAi);
  const server = personal || (serverAi ? 'AI' : '');
  // 튜토리얼 6: 개인 AI 연결 없이 늘 준비된 예시 답변(서버 routeRequest 와 같은 규칙, 2026-11-04)
  if (ownAi) return { ownAi: true, agent: '', personal: '', server: '', serverOn: false, connected: '', auto: '예시 답변', autoRoute: 'example' };
  const autoRoute = agent ? 'agent' : server ? 'server' : 'queue';
  return { agent, personal, server, serverOn: !!server, connected: agent || personal, auto: agent || server || '대기열', autoRoute };
}
/**
 * 문서 화면의 작업 환경: 체험 문서(관리자 공유 API)·튜토리얼 6(본인 연결 — 문서 정보의 ownAi, 공용 서버 AI 는 쓰지 않음)을 함께 본다.
 * @param s 문서 store 의 s(agentMe·info)
 */
export function docWorkEnv(s, { agentName = '' } = {}) {
  const own = !!s?.info?.tutorialOwnAi;
  // 공용 서버 AI 는 켜져 있어도 관리자가 허용한 계정만(/api/me 의 serverAi — 옛 서버는 값이 없어 config.aiEnabled 를 본다)
  const serverAi = typeof state.me?.serverAi === 'boolean' ? state.me.serverAi : !!state.config?.aiEnabled;
  return workEnv({ agentMe: s?.agentMe, personalAi: own ? s.info.ownAi?.personal : (s?.info?.tutorialAi || state.me?.personalAi), serverAi: !own && serverAi,
    agentName, apiOnly: !!s?.info?.tutorialApiOnly, ownAi: own });
}
/**
 * 바로 보내는 단추·메뉴의 보낼 곳 이름표(docs/UI_TERMS.md §4 색 구분): 'Claude Code로 보내기'·'API로 보내기', 대기열이면 '대기열에 넣기'.
 * @param name 환경 이름(workEnv 의 auto 등) · @param route 'agent'|'server'|'queue'
 */
export function sendToLabel(name, route) {
  return route === 'queue' || !name || name === '대기열' ? '대기열에 넣기' : `${josa(name, '으로/로')} 보내기`;
}
/**
 * 자동 경로의 보낼 곳 이름표(workEnv 결과로). 체험 문서에서 관리자 AI 가 아직 연결되지 않았을 때의 auto 는 환경 이름이 아니라
 * 상태 글('Codex 연결 대기'·'API 연결 필요')이라 그대로 붙이면 'Codex 연결 대기로 보내기'가 된다 — 그때 요청은 대기열에서 기다리므로 '대기열에 넣기'(2026-11-16)
 */
export function autoSendLabel(env) {
  return sendToLabel(env?.apiOnly && !env.serverOn ? '' : env?.auto, env?.autoRoute);
}
/** 보낼 곳 선택 칸의 항목(연결된 것만): 자동 · 채널 환경 · 내 키 환경 · 대기열. 공용 서버 AI 는 따로 고르지 않는다(자동에 들어 있음).
 *  내 AI 키는 늘 '(내 키)'를 붙인다 — 사용료가 따로 드는 길임을 이름표에서 알 수 있게(2026-11-13) */
export function routeOptions(env) {
  if (env.apiOnly) return [{ value: 'server', label: env.server || (env.sharedChatGPT ? 'ChatGPT 구독 대기' : 'API 연결 필요') }];
  if (env.ownAi) return [{ value: 'auto', label: '예시 답변' }];
  const out = [{ value: 'auto', label: env.auto && env.auto !== 'AI' ? `자동 · ${env.auto}` : '자동' }];
  const same = !!env.agent && env.agent === env.personal;   // 같은 이름(API 실행기 + API 키)이면 구분해 적는다
  if (env.agent) out.push({ value: 'agent', label: same ? `${env.agent} (실행기)` : env.agent });
  if (env.personal) out.push({ value: 'server', label: env.personal === '내 AI 키' ? env.personal : `${env.personal} (내 키)` });
  out.push({ value: 'queue', label: '대기열' });
  return out;
}

// ───────── AI 연결 차례(2026-11-13 운영 결정) ─────────
// ① 기본: 내 PC 의 구독 AI 를 MCP 로 — Codex(ChatGPT 로그인: CLI·IDE 확장)·Claude Code(Claude 로그인, 채널 start-agent.bat)의 실행기를
//    Windows 앱 [AI → 실행기 관리…] 또는 npm run worker -- --provider codex|claude-code 로 켠다(2026-11-17 실행기 bat 을 지움).
//    켜 두는 동안 실시간, 추가 비용 없음(구독 사용 한도에서 차감)
// ② 선택: ChatGPT 앱(웹)에 주소로 연결(OAuth) — 대화로 대기열 처리  ③ 선택: 내 AI 키·API — 사용료 별도, 기본으로 권하지 않는다
// 연결 안내 글(상단 AI 알약·요청 창·대기 중 카드·문서 목록 'AI 연결')은 이 차례로 쓴다. '연결 방법' 단추·'?'는 사용 설명서 ①절 '#agents'(내 PC의 AI)로
// — 세 길을 한눈에 보는 '#ai' 는 문서 목록 'AI 연결'의 [연결 방법]만
export const CONNECT_HELP = '/help.html#agents';
export const SUB_AI_TIP = '내 PC에서 Codex(ChatGPT 로그인)나 Claude Code(Claude 로그인) 실행기를 켜 두면 추가 비용 없이 바로 처리합니다';
export const NO_AI_TIP = `연결된 AI가 없습니다. 요청은 대기열에 보관됩니다. ${SUB_AI_TIP}. ChatGPT 앱 연결이나 내 AI 키(사용료 별도)도 쓸 수 있습니다`;

/** 파일 이름 → 첨부 종류 */
export function fileKind(name = '', mime = '') {
  const ext = (/\.([^.]+)$/.exec(name)?.[1] || '').toLowerCase();
  if (['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(ext)) return 'sheet';
  if (['txt', 'md', 'json'].includes(ext)) return 'text';
  if (['docx', 'hwpx', 'pptx', 'hwp'].includes(ext)) return 'doc';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (/^image\//.test(mime) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  return 'other';
}
export const KIND_ICON = { sheet: '▦', text: '≡', doc: '▤', pdf: '◫', image: '◩', other: '◇' };

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 권한 없음 → 대체 */ }
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); return ok;
}

/** 입력 중인가(단축키를 가로채지 않으려고) */
export const isTyping = (el = document.activeElement) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export const cps = (s) => Array.from(String(s ?? ''));
export const cpSlice = (s, a, b) => cps(s).slice(a, b).join('');
export const cpLen = (s) => cps(s).length;

// ── 역할 이름(서버 role → 화면 글) ──
const ROLE_KO = { admin: '관리자', editor: '편집자', viewer: '보기만' };   // viewer 가 빠져 문서함 머리에 영문 'viewer' 가 그대로 보였다(관리자 표 ROLE_LABELS 와 같은 글, 2026-11-16)
/** 'admin' → '관리자', 'editor' → '편집자'(모르는 역할은 그대로) */
export const roleLabel = (role) => ROLE_KO[role] || String(role ?? '');

// ── 조사(을/를·이/가·은/는·과/와·으로/로) ──
// 받침이 있을 때 쓰는 꼴 → [받침 있음, 받침 없음]. '으로/로'는 ㄹ 받침 뒤에도 '로'
const JOSA = { 을: ['을', '를'], 를: ['을', '를'], 이: ['이', '가'], 가: ['이', '가'], 은: ['은', '는'], 는: ['은', '는'], 과: ['과', '와'], 와: ['과', '와'], 으로: ['으로', '로'], 로: ['으로', '로'] };
// 숫자를 한국어로 읽은 끝소리(0 영·1 일·2 이·3 삼·4 사·5 오·6 육·7 칠·8 팔·9 구): 받침 종류 — '' 없음, 'ㄹ', 그 밖은 'o'(있음)
const DIGIT_END = ['o', 'ㄹ', '', 'o', '', '', 'o', 'ㄹ', 'ㄹ', ''];
// 끝이 0 인 수: 0 이 몇 개냐로 읽는 끝 — 십(ㅂ)·백(ㄱ)·천(ㄴ)·만(ㄴ, 4~7개)·억(ㄱ, 8~11개)·조(없음, 12개~)
const ZEROS_END = (z) => (z === 1 || z === 2 || z === 3 || (z >= 4 && z <= 11) ? 'o' : '');
// 영문자는 글자 이름으로(엘·알 = ㄹ, 엠·엔 = 받침, 그 밖은 받침 없음 — 'AI가', 'URL을', 'PDF를')
const LATIN_END = { l: 'ㄹ', r: 'ㄹ', m: 'o', n: 'o' };
/**
 * 영문 끝소리. 줄임말(끝이 대문자 2자 이상 — AI·URL·ChatGPT)·대문자로만·한 글자·파일 확장자(.xlsx·.png)는 글자 이름(LATIN_END).
 * 그 밖의 영어 낱말은 흔한 끝만 소리로 읽는다: 홀소리 + r(-er·-or — Server 서버·Paper 페이퍼)은 받침 없음, -le(Google 구글·Table 테이블) = ㄹ,
 * -me·-ne·-ng(Game 게임·Line 라인·Meeting 미팅) = 받침. 나머지는 글자 이름과 같다(-l = ㄹ, -m·-n = 받침, 그 밖은 없음 — 'Book'·'Web' 은 틀릴 수 있다)
 */
function latinEnd(w) {
  const run = /[A-Za-z]+$/.exec(w)[0];
  const spelled = run.length === 1 || !/[a-z]/.test(run) || /[A-Z]{2,}$/.test(run) || /\.$/.test(w.slice(0, w.length - run.length));
  if (!spelled) {
    const s = run.toLowerCase();
    if (/[aeiouy]r$/.test(s)) return '';
    if (/le$/.test(s)) return 'ㄹ';
    if (/(?:me|ne|ng)$/.test(s)) return 'o';
    if (/[^aeiou][aeiou]t$/.test(s)) return 'o';   // 짧은 홀소리 + t = ㅅ 받침(Chat 챗·Robot 로봇 — Sheet 시트·Report 리포트는 아님)
  }
  return LATIN_END[run[run.length - 1].toLowerCase()] ?? '';
}
/** 낱말의 끝소리 받침: '' 없음 · 'ㄹ' · 'o' 그 밖 받침 · null 모름(기호·빈 글) */
function finalOf(word) {
  let w = String(word ?? '').replace(/[\s'"’”」』>》〉\]]+$/u, '');
  // 끝의 괄호 덧붙임은 건너뛴다: '변경 요청 #3(홍길동)' → '#3' 을 읽는다
  for (let k = 0; k < 3 && /\)$/.test(w); k++) w = w.replace(/\s*\([^()]*\)$/u, '').replace(/[\s'"’”」』]+$/u, '');
  const ch = Array.from(w).pop();
  if (!ch) return null;
  const c = ch.codePointAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) { const jong = (c - 0xAC00) % 28; return jong === 0 ? '' : jong === 8 ? 'ㄹ' : 'o'; }
  if (/[0-9]/.test(ch)) {
    const run = /([0-9]+)$/.exec(w)[1];
    if (/^0+$/.test(run)) return 'o';   // 영
    const z = /0*$/.exec(run)[0].length;
    return z ? ZEROS_END(z) : DIGIT_END[Number(ch)];
  }
  if (/[a-z]/i.test(ch)) return latinEnd(w);
  return null;
}
/**
 * 낱말 + 끝소리에 맞는 조사. pair = '을/를'·'이/가'·'은/는'·'과/와'·'으로/로'(어느 쪽을 앞에 써도 된다).
 *   josa('제안 #3', '을/를') → '제안 #3을'(삼) · josa('메모', '을/를') → '메모를' · josa('파일', '으로/로') → '파일로'
 * 숫자는 한국어로 읽은 소리, 영문 줄임말·확장자는 글자 이름(엘·엠·엔·알…), 영어 낱말은 흔한 끝소리(latinEnd)로 본다. 끝을 읽을 수 없으면(기호 등) '을(를)' 꼴.
 */
export function josa(word, pair) {
  const [x, y] = String(pair || '').split('/');
  const [withF, noF] = JOSA[x] || JOSA[y] || [x || '', y || ''];
  const f = finalOf(word);
  const w = String(word ?? '');
  if (f === null) return `${w}${withF}(${noF})`;
  if (withF === '으로') return w + (f === '' || f === 'ㄹ' ? '로' : '으로');
  return w + (f === '' ? noF : withF);
}

// ── AI 작업 '내 눈의 진행'(docs/V3_SPEC.md §9.7) ──
/** 그 제안을 자기 수정본에 반영해 둔 사람 이름들(사람마다 기록 adoptedBy, 옛 모양 adopted = { by }) */
export function adopterNames(p) {
  const by = p?.adoptedBy && typeof p.adoptedBy === 'object' && !Array.isArray(p.adoptedBy) ? Object.keys(p.adoptedBy) : [];
  const old = p?.adopted && typeof p.adopted === 'object' && p.adopted.by ? [String(p.adopted.by)] : [];
  return [...new Set([...by, ...old])];
}
/**
 * 내 눈으로 '반영'인 제안인가: 기준에 적용됨, 또는 대기 + (남이 자기 수정본에 반영해 둠 | 내가 반영해 두었고 지금 편집기 글에 들어 있음).
 * o = { adoptedByMe(p), inEffect(p), me? } — me(내 이름)를 주면 남의 반영을 이름으로 가린다(내 끝난 변경 요청의 옛 기록은 '남'이 아니다).
 * me 가 없으면 기록 수로 어림한다(나 말고 더 있으면 남)
 */
export function proposalAccepted(p, o = {}) {
  if (!p) return false;
  if (p.status === 'applied') return true;
  if (p.status !== 'pending') return false;
  const mine = typeof o.adoptedByMe === 'function' ? !!o.adoptedByMe(p) : false;
  const names = adopterNames(p);
  const others = o.me ? names.some((n) => n !== String(o.me)) : names.length > (mine ? 1 : 0);
  if (others) return true;
  return mine && (typeof o.inEffect === 'function' ? !!o.inEffect(p) : true);
}
/**
 * AI 작업 하나의 '내 눈의 진행'(§9.7) — 서버 outcome(§9.2, server/memotext.js requestOutcome)과 같은 항목 규칙: 여러 안 묶음(같은 gid)은
 * 묶음 하나가 항목 하나, 그 밖 제안은 하나씩. 반영 = 적용됨 또는 대기 + 반영해 둠(proposalAccepted — 내가 반영해 둔 것은 지금 편집기 글에
 * 들어 있을 때만: Ctrl+Z 로 되돌렸으면 다시 남음), 거절 = 반영 없이 대기 안도 없음(거절·복구·대체), 남음 = 그 밖(대기).
 * @param r 요청 { status } @param proposals 그 요청의 제안들 @param o { adoptedByMe(p), inEffect(p), me? }
 * 묶음 제안(같은 bundle, 구성원 2개 이상 — docs/UI_TERMS.md §9)도 항목 하나: 남은 구성원이 있으면 남음(일부 반영돼도), 없고 반영이 있으면 반영, 그 밖은 거절.
 * @returns { items, accepted, declined, open, openPids, openAlt, tables, adoptOpen, resolved, applied, adopted, entries }
 *   openPids = 남은 항목 중 여러 안 묶음이 아닌 대기 제안 pid(pid 순, 표 포함 — 묶음 제안은 남은 구성원 모두), openAlt = 고를 묶음 수,
 *   tables = openPids 중 표·그림 제안 수(기준에만 적용 — 제안 수), adoptOpen = 내 수정본에 넣을 바꿈·문단 추가가 있는 남은 항목 수(단추 [모두 반영 (n)]),
 *   resolved = 요청이 끝났고(완료·취소) 남음 0, applied·adopted = 반영의 나눔(기준 적용 / 수정본에만),
 *   entries = 항목 [{ gid, bundle?, list(제안들, 안 차례·묶음은 pid 차례), state: 'open'|'accepted'|'declined', via?: 'applied'|'adopted', open(남은 대기 pid) }](처음 나온 차례)
 */
export function requestProgress(r, proposals = [], o = {}) {
  // 거둔 제안(withdrawn — 에이전트가 자기 대기 제안을 거둠)은 항목·셈에서 아예 뺀다. 거르는 자리는 여기 한 곳(server/memotext.js requestItems 와 같다)
  const all = (Array.isArray(proposals) ? proposals : []).filter((p) => p && p.status !== 'withdrawn');
  // 묶음 제안(p.bundle, 2026-11-17 — docs/UI_TERMS.md §9): 구성원 2개 이상이면 항목 하나. 1개만 남으면 보통 항목
  const bsize = new Map();
  for (const p of all) if (p.gid == null && p.bundle != null) bsize.set(String(p.bundle), (bsize.get(String(p.bundle)) || 0) + 1);
  const entries = []; const groups = new Map();
  for (const p of all) {
    const key = p.gid != null ? `g${p.gid}` : p.bundle != null && bsize.get(String(p.bundle)) > 1 ? `b${p.bundle}` : null;
    if (key) {
      let g = groups.get(key);
      if (!g) { g = p.gid != null ? { gid: p.gid, list: [] } : { gid: null, bundle: String(p.bundle), list: [] }; groups.set(key, g); entries.push(g); }
      g.list.push(p);
    } else entries.push({ gid: null, list: [p] });
  }
  let accepted = 0; let declined = 0; let open = 0; let openAlt = 0; let tables = 0; let applied = 0; let adopted = 0; let adoptOpen = 0;
  const openPids = [];
  for (const it of entries) {
    if (it.gid != null) it.list.sort((a, b) => (Number(a.option) || 0) - (Number(b.option) || 0) || Number(a.pid) - Number(b.pid));
    if (it.bundle != null) {
      // 묶음: 남은(대기 + 반영해 두지 않은) 구성원이 있으면 남음(일부 반영돼도), 없고 반영이 하나라도 있으면 반영, 그 밖은 거절
      it.list.sort((a, b) => Number(a.pid) - Number(b.pid));
      const acc = it.list.filter((p) => proposalAccepted(p, o));
      const left = it.list.filter((p) => p.status === 'pending' && !proposalAccepted(p, o));
      it.open = left.map((p) => Number(p.pid));
      if (left.length) {
        it.state = 'open'; open++; openPids.push(...it.open);
        const objs = left.filter((p) => OBJECT_TYPES.includes(p.type)).length;
        tables += objs; if (objs < left.length) adoptOpen++;
      } else if (acc.length) {
        const ap = acc.some((p) => p.status === 'applied');
        it.state = 'accepted'; it.via = ap ? 'applied' : 'adopted'; accepted++;
        if (ap) applied++; else adopted++;
      } else { it.state = 'declined'; declined++; }
      continue;
    }
    const ap = it.list.find((p) => p.status === 'applied');
    const ad = ap ? null : it.list.find((p) => p.status === 'pending' && proposalAccepted(p, o));
    it.open = [];
    if (ap || ad) {
      it.state = 'accepted'; it.via = ap ? 'applied' : 'adopted'; accepted++;
      if (ap) applied++; else adopted++;
    } else if (it.list.some((p) => p.status === 'pending')) {
      it.state = 'open'; open++;
      it.open = it.list.filter((p) => p.status === 'pending').map((p) => Number(p.pid));
      if (it.gid != null) openAlt++;
      else { const p = it.list[0]; openPids.push(Number(p.pid)); if (OBJECT_TYPES.includes(p.type)) tables++; else adoptOpen++; }
    } else { it.state = 'declined'; declined++; }
  }
  openPids.sort((a, b) => a - b);
  const done = r?.status === 'done' || r?.status === 'cancelled';
  const archived = entries.filter(it => it.state === 'declined' && it.list.some(p => p.supersededByRequest)).length;
  return { items: entries.length, accepted, declined, archived, open, openPids, openAlt, tables, adoptOpen, resolved: done && open === 0, applied, adopted, entries };
}
/** 수정본에 넣지 못하고 기준에만 적용하는 제안 종류(표·그림·개체·차례·쪽 구성·묶음·문단 지우기·옮기기 — [모두 반영]이 내 수정본에 넣지 않는 것).
 *  para_delete·para_move(2026-11-17, server/paragraph-ops.js)도 문서에 바로 적용만이다(web/store.js 의 수정본 넣기가 막는다) */
const OBJECT_TYPES = ['table', 'table_edit', 'toc', 'figure', 'page_layout', 'delete', 'edit_batch', 'para_delete', 'para_move'];
/** 묶음 제안의 머리 이름(server/memotext.js bundleLabel 과 같은 규칙): '새 문단 50 · 표 2 · 그림 1 넣기' · '바꿈 61곳' · '서식 12곳' · '개체 지우기 5문단' · '문단 지우기 8곳' · '제안 n건' */
export function bundleLabel(list = []) {
  const n = {};
  const add = (k) => { n[k] = (n[k] || 0) + 1; };
  for (const p of Array.isArray(list) ? list : []) {
    if (!p) continue;
    const t = p.type || 'replace';
    if (t === 'insert') add('para');
    else if (t === 'table') add('table');
    else if (t === 'figure') add(p.figure?.nativeChart ? 'chart' : p.figure?.replace ? 'figswap' : 'figure');
    else if (t === 'replace') add('replace');
    else if (t === 'format') add('format');
    else if (t === 'delete') add('delete');
    else if (t === 'para_delete') add('paradel');   // 2026-11-17 같은 종류 묶음(server/mcp2/ops.js markBundles (d))
    else add('other');
  }
  const ins = [n.para ? `새 문단 ${n.para}` : '', n.table ? `표 ${n.table}` : '', n.figure ? `그림 ${n.figure}` : '', n.chart ? `차트 ${n.chart}` : ''].filter(Boolean);
  return [ins.length ? `${ins.join(' · ')} 넣기` : '', n.replace ? `바꿈 ${n.replace}곳` : '', n.format ? `서식 ${n.format}곳` : '', n.figswap ? `그림 교체 ${n.figswap}` : '',
    n.delete ? `개체 지우기 ${n.delete}문단` : '', n.paradel ? `문단 지우기 ${n.paradel}곳` : '', n.other ? `제안 ${n.other}건` : ''].filter(Boolean).join(' · ');
}
/** 개체 지우기 제안 설명: '글상자 206개 · 사각형 51개'(server/memotext.js deleteSummary 와 같음) */
export function deleteNote(p) {
  const names = Array.isArray(p?.delete?.names) ? p.delete.names.filter((x) => x && x.name) : [];
  if (names.length) return names.map((x) => `${x.name} ${Number(x.n) || 1}개`).join(' · ');
  return `개체 ${Number(p?.delete?.count) || 0}개`;
}
/** 차례 새로 고침 제안 설명: ' — 스타일 차례제목·차례1·차례2 · 한 줄로 입력 (항목 108개)' */
export function tocNote(p) {
  const t = p?.toc || {}; const r = p?.tocResult || null;
  const opts = [t.styles ? `스타일 ${[t.styles.title, t.styles.level1, t.styles.level2].filter(Boolean).join('·')}` : '', t.oneLine ? '한 줄로 입력' : ''].filter(Boolean);
  const done = r ? [r.entries != null ? `항목 ${r.entries}개` : '', r.styled ? `스타일 ${r.styled}문단` : '', r.squeezed ? `한 줄로 ${r.squeezed}문단` : ''].filter(Boolean) : [];
  return `${opts.length ? ` — ${opts.join(' · ')}` : ''}${done.length ? ` (${done.join(', ')})` : ''}`;
}
/** 진행 줄: '제안 16건 — 반영 3 · 거절 1 · 남음 12'(0 인 쪽은 뺌). 항목이 없으면 '' */
export function progressText(g) {
  if (!g || !g.items) return '';
  const parts = [];
  if (g.accepted) parts.push(`반영 ${g.accepted}`);
  if (g.declined > (g.archived || 0)) parts.push(`거절 ${g.declined - (g.archived || 0)}`);
  if (g.archived) parts.push(`이전 제안 보관 ${g.archived}`);
  if (g.open) parts.push(`남음 ${g.open}`);
  return `제안 ${g.items}건 — ${parts.join(' · ')}`;
}
/**
 * 끝난 요청 한 줄: '✓ 완료 · 반영 14 · 거절 2'(0 인 쪽은 뺌). 제안이 없으면 의견 수 또는 '고칠 곳 없음', 취소된 요청이면 끝에 '취소됨'.
 * comments = AI 의견 수(서버 outcome.comments — 없으면 r.comments 길이).
 * head=false: 상태 칩이 곁에 있는 곳(레일·검토 탭·AI 작업 탭 카드·결과 창 — ui.js RequestActions, 칩이 이미 '완료'·'취소됨')에서 '✓ 완료'·'취소됨'을 빼고 수만(없으면 '')
 */
export function resolvedText(g, r = null, { head = true } = {}) {
  const parts = head ? ['✓ 완료'] : [];
  if (g?.accepted) parts.push(`반영 ${g.accepted}`);
  if (g?.declined > (g?.archived || 0)) parts.push(`거절 ${g.declined - (g.archived || 0)}`);
  if (g?.archived) parts.push(`이전 제안 보관 ${g.archived}`);
  if (!g?.items) {
    const nc = Number(r?.outcome?.comments ?? (Array.isArray(r?.comments) ? r.comments.length : 0)) || 0;
    if (nc) parts.push(`의견 ${nc}`);
    else if (r?.status !== 'cancelled') parts.push('고칠 곳 없음');
  }
  if (head && r?.status === 'cancelled') parts.push('취소됨');
  return parts.join(' · ');
}
/** 편집기에 한 번에 넣지 못한 항목(applyBatch results)의 이유별 수 → ' · 2건은 찾지 못함 · 1건은 다른 제안과 겹침'(없으면 '') */
const BATCH_WHY = { NOT_FOUND: '찾지 못함', NO_PARAGRAPH: '문단이 편집기에 없음', OVERLAP: '다른 제안과 겹침' };
export function batchFailText(results) {
  const n = new Map();
  for (const x of Array.isArray(results) ? results : []) {
    if (!x || x.ok) continue;
    const why = BATCH_WHY[x.reason] || '반영하지 못함';
    n.set(why, (n.get(why) || 0) + 1);
  }
  return [...n].map(([why, k]) => ` · ${k}건은 ${why}`).join('');
}

// ── 사람용 버전(이정표, §9.4) — 기록 번호(내부 판 n)는 화면에 내지 않는다 ──
const pad2 = (x) => String(x).padStart(2, '0');
/** 'MM-dd HH:mm'(서버 memotext fmtTime 과 같은 꼴, 이 컴퓨터 시각) — 모르면 '' */
export function fmtStamp(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 내려받기 이름용 'MM-dd_HHmm' */
export function fileStamp(iso) { return fmtStamp(iso).replace(' ', '_').replace(':', ''); }
/** 기록 n 이하의 마지막 이정표(없으면 null) — 서버 _milestoneAt 과 같은 규칙 */
export function milestoneAt(milestones, n) {
  let best = null;
  for (const x of Array.isArray(milestones) ? milestones : []) if (x && Number(x.n) <= Number(n) && (!best || Number(x.n) >= Number(best.n))) best = x;
  return best;
}
/** 상단 버전 알약 설명: '버전 v3 · 10-23 01:16 · AI 작업 #2 완료 — 적용 14건(관리자) · 그 뒤 변경 이력 5개 — 이력 탭에서 보기' */
export function versionTip(ms, since = 0) {
  if (!ms) return '이력 탭에서 보기';
  const head = [`버전 v${ms.v}`, fmtStamp(ms.at), `${ms.note || ''}${ms.by ? `(${ms.by})` : ''}`].filter(Boolean).join(' · ');
  const n = Number(since) || 0;
  return `${head} · ${n ? `그 뒤 변경 이력 ${n}개` : '그 뒤 변경 없음'} — 이력 탭에서 보기`;
}
/** 내려받기 파일 이름: 버전이면 '제목_v3.hwpx', 기록이면 '제목_10-23_0116.hwpx'(기록 번호는 쓰지 않는다) */
export function downloadName(title, { v = null, at = null } = {}) {
  const t = String(title || 'document').replace(/[\\/:*?"<>|]+/g, '_');
  if (v != null) return `${t}_v${v}.hwpx`;
  const st = fileStamp(at);
  return `${t}_${st || '기록'}.hwpx`;
}
