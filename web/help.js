import { connectionUrls } from './connections.js';
import { renderManual } from './manual.js';

if (new URLSearchParams(location.search).get('embedded') === '1') {
  document.documentElement.classList.add('embedded-help');
  document.body.classList.add('embedded-help');
}

let config = {}; let diagnostics = null; let selectedWebUrl = ''; let statusTimer; let me = null; let manualLoaded = false;
const $ = (id) => document.getElementById(id);
/** 칸이 있을 때만 글을 넣는다 — 설명서 HTML 과 이 파일이 잠깐 다른 판이어도 오류 없이 넘어간다 */
const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
const browserPersonal = document.documentElement.hasAttribute('data-browser-personal');
const readToken = () => { try { return localStorage.getItem('hwpx.token') || ''; } catch { return ''; } };
const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
const hashAnchor = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };

async function loadManual() {
  const content = $('manual-content');
  const status = $('manual-status');
  const retry = $('manual-retry');
  content.setAttribute('aria-busy', 'true');
  status.textContent = '상세 운영 매뉴얼을 불러오는 중입니다…';
  retry.hidden = true;
  try {
    const response = await fetch('/manual.md', { cache: 'no-cache' });
    if (!response.ok) throw new Error();
    const markdown = await response.text();
    if (!markdown.trim()) throw new Error();
    // 원문 HTML·링크를 제한하는 로컬 표시기를 거친 결과만 삽입한다.
    content.innerHTML = renderManual(markdown, { headingOffset: 1 });
    manualLoaded = true;
    status.textContent = '전체 매뉴얼을 불러왔습니다.';
    const anchor = hashAnchor();
    if (anchor === 'manual' || anchor?.startsWith('manual-')) document.getElementById(anchor)?.scrollIntoView();
  } catch {
    status.textContent = '상세 운영 매뉴얼을 불러오지 못했습니다. 다시 불러오거나 Markdown 원문을 여세요.';
    retry.hidden = false;
  } finally {
    content.setAttribute('aria-busy', 'false');
  }
}
$('manual-retry').addEventListener('click', loadManual);

/** 관리자 절(data-admin)은 /api/me 의 role 이 admin 일 때만 보인다 — 토큰이 없거나 확인에 실패하면 숨긴 채로 둔다. */
async function revealAdmin() {
  if (browserPersonal) {
    $('manual').hidden = false;
    document.querySelector('nav a[href="#manual"]').hidden = false;
    $('manual').querySelector('.admin-tag').hidden = true;
    if (!manualLoaded) loadManual();
    return;
  }
  const token = readToken();
  me = null;
  if (token) {
    try {
      const response = await fetch('/api/me', { headers: authHeaders(token), cache: 'no-store' });
      if (response.ok) me = await response.json();
    } catch { /* 숨긴 채로 둔다 */ }
  }
  const admin = me?.role === 'admin';
  document.documentElement.classList.toggle('help-admin', admin);
  for (const el of document.querySelectorAll('[data-admin]')) el.hidden = !admin;
  if (!admin) return;
  if (!manualLoaded) loadManual();
  // 숨어 있던 관리자 절을 주소(#host 등)로 열었으면 드러낸 뒤 그 자리로 간다
  const anchor = hashAnchor();
  const target = anchor ? document.getElementById(anchor) : null;
  if (target?.closest('[data-admin]')) target.scrollIntoView();
}

/** 주소 조각이 접어 둔 안내(고급 ② ChatGPT 웹 등)를 가리키면 펼친 뒤 그 자리로 간다 — 다른 화면·OAuth 안내 링크가 그 절을 연다 */
function revealHash() {
  const anchor = hashAnchor();
  const target = anchor ? document.getElementById(anchor) : null;
  if (!target) return;
  let opened = false;
  for (const d of document.querySelectorAll('details[data-open-on]')) {
    if (!d.open && d.dataset.openOn.split(/\s+/).includes(anchor)) { d.open = true; opened = true; }
  }
  for (let d = target.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) { d.open = true; opened = true; }
  if (opened) target.scrollIntoView();
}
function markTopic() {
  const target = document.getElementById(hashAnchor() || 'start');
  const current = target?.closest('section[id]')?.id;
  for (const link of document.querySelectorAll('.help-layout nav a[href^="#"]')) {
    if (link.hash === `#${current}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
markTopic();
// 프로그램 안 설명서(iframe)는 로그인 전에 열렸다가 로그인 뒤 다시 쓰일 수 있다 — 토큰이 바뀌거나 숨은 관리자 절로 가면 다시 확인한다
window.addEventListener('storage', (event) => { if (event.key === 'hwpx.token' || event.key === null) revealAdmin(); });
window.addEventListener('hashchange', () => {
  const anchor = hashAnchor();
  const target = anchor ? document.getElementById(anchor) : null;
  if (target?.closest('[data-admin]')?.hidden) revealAdmin();
  revealHash();
  markTopic();
});

function urls() { return connectionUrls({ browserOrigin: browserPersonal ? null : location.origin, publicUrl: config.publicUrl, diagnostics, selectedWebUrl }); }
const psQuote = (s) => `'${String(s).replaceAll("'", "''")}'`;
// Claude Code 는 머리글의 ${HWPX_COWORK_TOKEN} 을 연결할 때 환경 변수로 바꾼다 — 작은따옴표 안에 두어 셸이 미리 풀지 않게(토큰이 설정 파일에 적히지 않음)
const TOKEN_REF = '${HWPX_COWORK_TOKEN}';
function render() {
  const u = urls();
  const oauth = config.oauth;
  setText('oauth-status', oauth?.enabled ? '연결 준비됨. 아래 주소를 ChatGPT에 등록하세요.' : (oauth?.reason || '이 서버의 https 주소가 아직 준비되지 않았습니다. 관리자에게 ChatGPT 연결용 주소를 확인받으세요.'));
  setText('oauth-mcp', oauth?.enabled ? oauth.mcpUrl : 'https 주소 확인 필요');
  setText('current-web', (browserPersonal && new URL('./', location.href).href) || u.currentWebUrl || '서버에서 설명서를 여세요');
  setText('shared-web', u.sharedWebUrl || '서버 주소 확인 필요');
  setText('shared-mcp', u.mcpUrl || '중앙 MCP 주소 확인 필요');
  setText('address-note', browserPersonal ? 'AI 연결에는 설치한 서버의 MCP 주소를 사용하세요.' : u.localOnly ? '지금 주소는 이 PC 전용입니다. 다른 PC나 웹 AI에서 쓸 주소는 관리자에게 받으세요.'
    : u.source === 'diagnostic' ? '서버 점검에서 찾은 주소 후보입니다. 다른 PC에서 실제로 접속되는지 확인한 뒤 공유하세요.'
      : '주소에는 토큰을 넣지 않습니다. AI는 연결할 때 내 토큰으로 인증합니다.');
  const mcp = u.mcpUrl || 'CENTRAL_MCP_URL';
  // 이 PC 의 서버(localhost)면 채널 시작 파일(start-agent.bat)이 주소를 스스로 맞춘다. 다른 PC 의 서버면 주소를 넘긴다
  const here = !u.mcpUrl || u.localOnly;
  setText('codex-mcp-command', `codex mcp add hwpx --url ${psQuote(`${mcp}?agent=Codex`)} --bearer-token-env-var HWPX_COWORK_TOKEN`);
  setText('codex-mcp-config', `[mcp_servers.hwpx]\nurl = "${mcp}?agent=Codex"\nbearer_token_env_var = "HWPX_COWORK_TOKEN"`);
  // 2026-11-17: 실행기 bat(start-codex-agent·start-claude-worker)을 지웠다 — Windows 앱 [AI → 실행기 관리…] 또는 명령줄 npm run worker(기본 새 MCP 연결 --mcp 2).
  // 주소를 모르면 --url 없이(ai-worker 기본 http://localhost:8787/mcp)
  const urlArg = u.mcpUrl ? ` --url ${psQuote(mcp)}` : '';
  setText('codex-start', `npm.cmd run worker -- --provider codex${urlArg}`);
  setText('codex-command', `$env:HWPX_COWORK_URL = ${psQuote(mcp)}\nnpm.cmd run worker -- --provider codex --check\nnpm.cmd run worker -- --provider codex`);
  setText('claude-start', `npm.cmd run worker -- --provider claude-code${urlArg}`);
  setText('claude-command', `$env:HWPX_COWORK_URL = ${psQuote(mcp)}\nnpm.cmd run worker -- --provider claude-code --check\nnpm.cmd run worker -- --provider claude-code`);
  setText('claude-mcp-command', `claude mcp add --scope user --transport http hwpx ${psQuote(mcp)} --header 'Authorization: Bearer ${TOKEN_REF}'`);
  // 채널 작업 공간(setup-agent.mjs)은 기본 v3, 다른 연결은 --v2 또는 --v1로 고른다
  setText('channel-command', here ? '.\\start-agent.bat'
    : `node scripts/setup-agent.mjs --url ${psQuote(mcp)}\ncd agent\nclaude --dangerously-load-development-channels server:hwpx`);
  mcpSurfaceText(mcp);
  workerCommand();
}
// MCP 기본 연결(/api/config features.mcpDefault — server/mcp2.js mcpSurface, 2026-11-17): 'v3'(기본, TSV) | 'v2' | 'v1'(관리자가 예전 연결로 되돌린 서버).
// 주소에 ?v= 를 붙이지 않은 연결은 이 값대로 열린다 — ChatGPT 프롬프트와 '다른 연결 주소'를 그에 맞춘다
const QUEUE_PROMPT = {
  v1: 'HWPX 공동 검토에서 내 대기 요청을 처리해 줘. claim_next_request로 가장 오래된 요청부터 하나씩 가져와 지시와 첨부를 읽고, 필요한 수정 제안과 의견을 남긴 뒤 complete_request에 짧은 요약을 적어 완료해 줘. 수정안은 기본 1개, 비교를 요청한 경우에만 여러 안을 만들어 줘. 본문에 직접 반영하지 마. CLAIMED·NOT_OWNER·REQUEST_CLOSED 오류가 나면 그 요청은 건너뛰어 줘. 더 가져올 요청이 없으면 몇 건을 처리했는지 알려 주고 끝내 줘.',
  v2: 'HWPX 공동 검토에서 내 대기 요청을 처리해 줘. task를 인자 없이 불러 가장 오래된 요청부터 하나씩 맡고, 함께 온 지시·대상·주변 글을 보고 필요한 범위만 read로 읽어 줘. 수정 제안과 의견은 edit 한 번에 모아 남기고 done에 짧은 공유 요약을 적어 완료해 줘. 고칠 것이 없으면 finish에 확인한 범위와 사유를 적어 끝내 줘. 수정안은 기본 1개, 비교를 요청한 경우에만 여러 안을 만들어 줘. 본문에 직접 반영하지 마. CLAIMED·NOT_OWNER·REQUEST_CLOSED·ATTEMPT_CHANGED 오류가 나면 그 요청은 건너뛰어 줘. task가 none을 돌려주면 몇 건을 처리했는지 알려 주고 끝내 줘.',
};
function mcpSurfaceText(mcp) {
  // features 는 있는데 mcpDefault 가 없으면 기본이 예전 연결이던 판의 서버(2026-11-17 전 — web/ 은 재시작 없이 바로 보이므로 그 사이에도 맞게).
  // /api/config 를 아직 못 읽었으면 HTML 의 글(새 연결)을 그대로 둔다
  const f = config.features;
  const legacy = !!f && !['v2', 'v3'].includes(f.mcpDefault);
  setText('queue-prompt', legacy ? QUEUE_PROMPT.v1 : QUEUE_PROMPT.v2);
  setText('mcp-other-title', legacy ? '새 연결 주소 · 고급' : '예전 연결 주소 · 고급');
  setText('mcp-other-note', legacy
    ? '이 서버는 위 주소를 예전 연결(claim_next_request·complete_request 등)로 엽니다. 작업 도구 넷(task·read·edit·finish)은 아래 주소로 연결합니다.'
    : '위 주소는 작업 도구 넷(task·read·edit·finish)으로 연결됩니다. 예전 도구 이름(claim_next_request·propose_changes·complete_request 등)을 쓰는 스크립트·프롬프트만 아래 주소를 씁니다.');
  const label = document.querySelector('#mcp-other .address-card span');
  if (label) label.textContent = legacy ? '새 연결 MCP 주소' : '예전 연결 MCP 주소';
  setText('other-mcp', `${mcp}${mcp.includes('?') ? '&' : '?'}v=${legacy ? '2' : '1'}`);
  setText('queue-prompt-note', legacy
    ? '이 서버는 ChatGPT 연결을 예전 도구(claim_next_request·complete_request)로 엽니다.'
    : '이 주소는 작업 도구 넷(task·read·edit·finish)으로 연결됩니다. 예전 도구(claim_next_request·complete_request)를 쓰던 프롬프트는 위 MCP 서버의 예전 연결 주소로 연결합니다.');
}
function workerCommand() {
  if (!$('worker-command')) return;
  const provider = ['openai','anthropic','gemini'].includes($('provider').value) ? $('provider').value : 'openai';
  // API(--gateway baze) 경유면 제공업체 키 대신 API 키 하나(server/ai.js AI_GATEWAYS)
  const baze = $('gateway').value === 'baze';
  const effort = ['low','medium','high'].includes($('effort').value) ? $('effort').value : '';
  const envName = baze ? 'BAZE_API_KEY' : { openai:'OPENAI_API_KEY', anthropic:'ANTHROPIC_API_KEY', gemini:'GEMINI_API_KEY' }[provider];
  const raw = $('model-id').value.trim(); const valid = !raw || /^[a-zA-Z0-9._:/-]+$/.test(raw);
  const model = valid && raw ? raw : 'MODEL_ID';
  $('model-note').textContent = !valid ? '모델 ID에 공백이나 셸 문자를 넣지 마세요.'
    : baze ? 'MODEL_ID 자리에 API 모델 목록의 ID(예: gpt-6.1-sol)를 넣으세요. 키는 API 제공업체에서 발급한 키 하나만 씁니다. 추론 강도는 OpenAI·Claude 추론 모델에만 적용됩니다.'
      : 'MODEL_ID 자리에 제공업체에서 확인한 모델 ID를 넣으세요. 키와 개인 토큰은 예제의 자리표시자를 본인 값으로 바꿉니다.';
  $('worker-command').textContent = `$env:HWPX_COWORK_URL = ${psQuote(urls().mcpUrl || 'CENTRAL_MCP_URL')}\n`
    + "$env:HWPX_COWORK_TOKEN = '관리자에게_받은_개인_토큰'\n"
    + `$env:${envName} = '발급받은_API_키'\nnpm.cmd run worker -- --provider ${provider}${baze ? ' --gateway baze' : ''} --model ${psQuote(model)}${effort ? ` --effort ${effort}` : ''}`;
}
function notice(message) {
  const el = $('copy-status'); el.textContent = message; el.classList.add('on'); clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('on'), 3500);
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); return true; } catch { /* HTTP 내부망에서도 직접 선택한 예제를 복사할 수 있게 */ }
  const area = document.createElement('textarea'); area.value = value; area.style.position='fixed'; area.style.opacity='0'; document.body.append(area); area.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } finally { area.remove(); } return ok;
}
const COPY_MESSAGES = {
  'agent-setup-prompt': '설치 요청문을 복사했습니다. 에이전트 채팅에 붙여넣으세요.',
  'token-command': '복사했습니다. 내-토큰 자리를 내 토큰으로 바꿔 실행하고, VS Code를 다시 여세요.',
  'codex-login': '복사했습니다. 터미널에서 실행해 ChatGPT 계정으로 로그인하세요.',
  'codex-mcp-command': '복사했습니다. VS Code 터미널에 붙여넣어 실행하세요.',
  'codex-mcp-config': '설정을 복사했습니다. Codex 설정 파일(config.toml)에 붙여 넣으세요.',
  'codex-start': '복사했습니다. 프로그램 폴더의 터미널에서 실행하고 창을 켜 두세요.',
  'codex-command': '예제를 복사했습니다. --check 로 점검한 뒤 마지막 줄을 켜 두세요.',
  'claude-login': '복사했습니다. 터미널에서 실행해 Claude 계정으로 로그인하세요.',
  'claude-mcp-command': '복사했습니다. VS Code 터미널(PowerShell)에 그대로 붙여넣어 실행하세요.',
  'claude-start': '복사했습니다. 프로그램 폴더의 터미널에서 실행하고 창을 켜 두세요.',
  'claude-command': '예제를 복사했습니다. --check 로 점검한 뒤 마지막 줄을 켜 두세요.',
  'channel-command': '복사했습니다. 프로그램 폴더의 터미널에서 실행하고 창을 켜 두세요.',
  'queue-short': '복사했습니다. Codex·Claude Code 대화창에 붙여넣어 보내세요.',
  'queue-prompt': '프롬프트를 복사했습니다. HWPX를 연결한 ChatGPT 채팅에 붙여 넣어 보내세요.',
};
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const key = b.dataset.copy;
  const value = $(key)?.textContent || '';
  const message = COPY_MESSAGES[key] || (key.endsWith('-command') ? '복사했습니다. 예제의 개인 토큰·API 키·모델 ID는 본인 값으로 바꾸세요.' : '주소를 복사했습니다.');
  notice(await copyText(value) ? message : '복사하지 못했습니다. 내용을 직접 선택해 복사하세요.');
}));
$('download-agent-prompt')?.addEventListener('click', () => {
  const markdown = $('agent-setup-prompt').textContent.trim() + '\n';
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'hwpx-cowork-install-prompt.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const id of ['provider', 'gateway', 'effort']) $(id)?.addEventListener('change', workerCommand);
$('model-id')?.addEventListener('input', workerCommand);
function append(parent, tag, value, cls) { const el = document.createElement(tag); el.textContent = value; if (cls) el.className=cls; parent.append(el); return el; }
$('automation-status').addEventListener('click', async () => {
  const out = $('automation-result'); const button = $('automation-status'); out.replaceChildren();
  const token = readToken();
  if (!token) { append(out, 'p', '먼저 같은 HWPX 서버에 내 토큰으로 로그인하세요.'); return; }
  button.disabled = true;
  try {
    const response = await fetch('/api/automation/status', { headers: authHeaders(token), cache: 'no-store' });
    if (!response.ok) throw new Error('연결 상태를 읽지 못했습니다. 로그인 상태를 확인하세요.');
    const status = await response.json();
    if (!me) { try { const r = await fetch('/api/me', { headers: authHeaders(token), cache: 'no-store' }); if (r.ok) me = await r.json(); } catch { /* 없으면 키 줄을 뺀다 */ } }
    append(out, 'p', status.automatic.message);
    append(out, 'p', status.channels.online ? `① 내 PC의 AI(실행기·채널): ${status.channels.primary?.agent || '연결됨'}` : '① 내 PC의 AI(실행기·채널): 연결 없음');
    const key = me?.personalAi;
    if (key) append(out, 'p', `③ API 키: ${key.configured ? (key.active ? '등록됨 — 내 요청을 바로 처리' : '등록됨 — 이 서버에서는 지금 쓰지 않음') : '등록 안 됨'}`);
    if (me?.role === 'admin') append(out, 'p', `서버 AI(관리자 확인용): ${status.serverAi.enabled ? (status.serverAi.mock ? '모의 실행(시험용)' : '켜짐') : '꺼짐'}`);
    append(out, 'p', `내 요청: 대기 ${status.queue.pending}건 · 처리 중 ${status.queue.working}건`);
    append(out, 'p', '연결은 처리 완료와 다릅니다. 결과는 AI 작업 탭에서 확인하세요. 대화창의 “대기열을 처리해 줘”(VS Code 대화창·② ChatGPT 웹)는 여기 연결로 보이지 않습니다.', 'muted');
  } catch (error) { append(out, 'p', error.message); }
  finally { button.disabled = false; }
});
async function loadOAuthConnections() {
  const out = $('oauth-connections'); out.replaceChildren();
  const token = readToken();
  if (!token) { append(out, 'p', '먼저 같은 서버의 문서 화면에서 내 토큰으로 로그인하세요.'); return; }
  try {
    const response = await fetch('/api/oauth/connections', { headers: authHeaders(token), cache: 'no-store' });
    if (!response.ok) throw new Error('연결 목록을 읽지 못했습니다. 로그인 상태를 확인하세요.');
    const list = await response.json();
    if (!list.length) append(out, 'p', '연결된 ChatGPT·웹 AI가 없습니다.');
    for (const item of list) {
      const row = append(out, 'p', `${item.clientName} · 만료 ${new Date(item.expiresAt * 1000).toLocaleDateString('ko-KR')} `);
      const button = append(row, 'button', '이 연결 끊기', 'button'); button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const r = await fetch(`/api/oauth/connections/${encodeURIComponent(item.id)}`, { method: 'DELETE', headers: authHeaders(token) });
          if (!r.ok) throw new Error();
          await loadOAuthConnections();
        } catch { button.disabled = false; notice('연결을 끊지 못했습니다. 다시 시도하세요.'); }
      });
    }
  } catch (e) { append(out, 'p', e.message); }
}
$('oauth-list')?.addEventListener('click', loadOAuthConnections);
$('download-worker')?.addEventListener('click', async () => {
  const token = readToken(); const status = $('worker-download-status'); const button = $('download-worker');
  if (!token) { status.textContent = '문서 화면에서 먼저 내 토큰으로 로그인한 뒤 내려받으세요.'; return; }
  button.disabled = true; status.textContent = '실행기를 준비하고 있습니다…';
  try {
    const response = await fetch('/api/worker-package', { headers: authHeaders(token) });
    if (!response.ok) throw new Error(response.status === 401 ? '내 토큰으로 다시 로그인한 뒤 내려받으세요.' : `실행기를 내려받지 못했습니다(응답 ${response.status}).`);
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'hwpx-cowork-worker.zip'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = '내려받았습니다. ZIP 안의 hwpx-ai-worker 폴더에서 npm.cmd install 을 실행한 다음 아래 예제로 시작하세요.';
  } catch (e) { status.textContent = e.message; }
  finally { button.disabled = false; }
});
$('check-connections')?.addEventListener('click', async () => {
  const button = $('check-connections'); const out = $('connection-result'); const token = readToken();
  out.replaceChildren();
  if (!token) { append(out,'p','먼저 같은 서버의 문서 화면에서 관리자 토큰으로 로그인하세요.'); return; }
  button.disabled = true;
  try {
    const response = await fetch('/api/connections', { headers: authHeaders(token) });
    if (!response.ok) throw new Error(response.status === 401 ? '접속 토큰을 다시 확인한 뒤 로그인하세요.' : `서버 점검 응답 ${response.status}`);
    diagnostics = await response.json(); render();
    append(out,'p',diagnostics.binding?.message || '서버 연결 정보를 확인했습니다.');
    append(out,'h3','내부망 주소 후보');
    if (diagnostics.lan?.length) for (const address of diagnostics.lan) {
      const row = append(out,'div',`${address.label ? address.label + ' · ' : ''}${address.webUrl} — ${address.note || '다른 PC에서 접속 확인 필요'}`,'address');
      const choose = append(row,'button','이 주소 사용','button'); choose.type='button';
      choose.addEventListener('click', () => { selectedWebUrl = address.webUrl; render(); notice('선택한 주소로 예제를 바꿨습니다. 다른 PC에서 실제 접속해 확인하세요.'); });
    }
    else append(out,'p','내부망에서 쓸 주소 후보가 없습니다. 서버의 접속 허용 설정(host)을 확인하세요.','muted');
    append(out,'h3','외부 접속'); append(out,'p',diagnostics.external?.message || '외부 접속은 다른 네트워크에서 직접 확인해야 합니다.');
    if (diagnostics.warnings?.length) { const list = append(out,'ul',''); for (const w of diagnostics.warnings) append(list,'li',w.message); }
    append(out,'p','이 점검은 서버 설정과 주소 후보를 보여 줍니다. 외부 네트워크에서의 실제 접속 성공을 보증하지 않습니다.','muted');
  } catch (e) { append(out,'p',e.message,'error'); }
  finally { button.disabled = false; }
});
render();
revealHash();
revealAdmin();
if (browserPersonal) {
  for (const button of document.querySelectorAll('[data-copy="shared-mcp"], [data-copy="other-mcp"], [data-copy="oauth-mcp"]')) button.disabled = true;
  $('download-worker').disabled = true;
  setText('worker-download-status', '실행기 ZIP은 설치한 서버의 사용 설명서에서 받을 수 있습니다.');
  $('oauth-list').disabled = true;
  setText('oauth-connections', 'ChatGPT 연결은 설치한 서버에서 관리합니다.');
} else fetch('/api/config').then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((c) => { config = c; render(); }).catch(() => {});
