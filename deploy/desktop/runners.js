'use strict';
// AI 실행기 창(2026-11-17). 상태는 주 프로세스(runners.mjs)가 보내고, 이 창은 보이기·누르기만 한다. 토큰은 [확인] 때 한 번 보내고 다시 받지 않는다.
const api = window.hwpxDesktop;
const $ = (selector) => document.querySelector(selector);
const NEW_SERVER = '__new';
let state = null; let logFor = null; let logCount = -1; let runnersKey = ''; let serversKey = ''; let aiBuilt = false;
const openSettings = new Set(); const busy = new Set();

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}
const time = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
function notice(message) { const n = $('#notice'); n.textContent = message || ''; n.hidden = !message; }
function formError(message) { const n = $('#formError'); n.textContent = message || ''; n.hidden = !message; }
async function act(action, value, { quiet = false } = {}) {
  let result;
  try { result = await api.action(action, value); } catch (error) { result = { ok: false, message: error?.message }; }
  if (!result?.ok) { if (!quiet) notice(result?.message || '요청을 처리하지 못했습니다.'); return null; }
  return result;
}

// ── 실행기 목록 ──
const chipTitle = (r) => `${r.message || r.stateLabel}${r.since ? ` · ${time(r.since)}부터` : ''}`;
const showMessage = (r) => r.message && ['preparing', 'waiting', 'error'].includes(r.state);
async function toggleRunner(r) {
  busy.add(r.id); renderRunners(true);
  await act(r.active ? 'stop' : 'start', r.id);
  busy.delete(r.id); renderRunners(true);
}
async function removeRunner(r) {
  if (!window.confirm(`${r.aiLabel} · ${r.serverLabel} 실행기를 삭제할까요?\n켜져 있으면 먼저 정상 종료합니다. 기록 파일은 남습니다.`)) return;
  busy.add(r.id); renderRunners(true);
  await act('remove-runner', r.id);
  busy.delete(r.id); openSettings.delete(r.id);
  if (logFor === r.id) closeLog();
}
function settingsPanel(r) {
  const parts = [el('label', { class: 'check' }, [
    el('input', { type: 'checkbox', checked: r.autoStart, onchange: (e) => void act('update-runner', { id: r.id, autoStart: e.target.checked }) }),
    el('span', { text: '자동 시작', title: '앱을 켜면 이 실행기도 켭니다' }),
  ])];
  if (r.mcp) {
    const select = el('select', { title: '다음에 켤 때부터 적용됩니다', onchange: (e) => void act('update-runner', { id: r.id, mcp: Number(e.target.value) }) },
      [el('option', { value: '2', text: '새 연결(v2)' }), el('option', { value: '1', text: '예전 연결(v1)' })]);
    select.value = String(r.mcp);
    parts.push(el('label', { class: 'field inline' }, [el('span', { text: '연결' }), select]));
  }
  parts.push(el('button', { class: 'ghost danger', text: '삭제', disabled: busy.has(r.id), onclick: () => void removeRunner(r) }));
  return el('div', { class: 'settings' }, parts);
}
function runnerRow(r) {
  const toggle = el('button', { class: r.active ? 'secondary' : 'primary', text: r.stopping ? '끄는 중' : r.active ? '끄기' : '켜기', disabled: r.stopping || busy.has(r.id),
    title: r.active ? '진행 중인 저장을 마치고 끕니다' : '실행기를 켭니다(처음이면 연결 프로그램 설치·로그인)', onclick: () => void toggleRunner(r) });
  const who = el('div', { class: 'who' }, [el('b', { text: r.aiLabel, title: r.account }),
    el('small', { text: [r.serverLabel, r.mcp ? `v${r.mcp}` : null, r.autoStart ? '자동 시작' : null].filter(Boolean).join(' · ') })]);
  const actions = el('div', { class: 'actions' }, [toggle,
    el('button', { class: 'ghost', text: '기록', 'aria-pressed': String(logFor === r.id), onclick: () => void openLog(r.id) }),
    el('button', { class: 'ghost', text: '설정', 'aria-expanded': String(openSettings.has(r.id)), onclick: () => { if (openSettings.has(r.id)) openSettings.delete(r.id); else openSettings.add(r.id); renderRunners(true); } })]);
  const li = el('li', { class: `runner st-${r.state}`, 'data-id': r.id }, [el('div', { class: 'line' }, [who, el('span', { class: `chip st-${r.state}`, title: chipTitle(r), text: r.stateLabel }), actions])]);
  if (showMessage(r)) li.append(el('p', { class: r.state === 'error' ? 'msg error' : 'msg', text: r.message }));
  if (openSettings.has(r.id)) li.append(settingsPanel(r));
  return li;
}
function renderRunners(force = false) {
  const runners = state?.runners || [];
  const key = JSON.stringify([runners.map((r) => ({ ...r, lines: 0 })), [...openSettings], [...busy], logFor]);
  if (!force && key === runnersKey) return;
  runnersKey = key;
  $('#runners').replaceChildren(...runners.map(runnerRow));
  $('#empty').hidden = runners.length > 0;
  $('#stopAll').hidden = !runners.some((r) => r.active);
}

// ── 실행기 추가 ──
const chosenAi = () => document.querySelector('input[name="ai"]:checked')?.value;
function buildAiChoice() {
  if (aiBuilt || !state?.ais) return;
  aiBuilt = true;
  const box = $('#aiChoice');
  state.ais.forEach((ai, i) => {
    box.append(el('label', { class: 'choice', title: ai.managed ? `${ai.account}으로 로그인 — 처음 켤 때 연결 프로그램을 준비합니다` : `${ai.command} 를 설치하고 Google 계정으로 먼저 로그인해 두세요` }, [
      el('input', { type: 'radio', name: 'ai', value: ai.id, checked: i === 0, onchange: syncAdvanced }),
      el('span', {}, [el('b', { text: ai.label }), el('small', { text: ai.account })]),
    ]));
  });
  syncAdvanced();
}
function syncAdvanced() {
  const ai = state?.ais?.find((a) => a.id === chosenAi());
  $('#advanced').hidden = !ai?.mcp;
}
function renderServerChoice() {
  const select = $('#server');
  const servers = state?.servers || [];
  const key = JSON.stringify([state?.localSupported, servers.map((s) => [s.id, s.host, s.user])]);
  if (key === serversKey) return;
  serversKey = key;
  const previous = select.value;
  const options = [];
  if (state?.localSupported) options.push(el('option', { value: 'local', text: '이 앱의 서버' }));
  for (const s of servers) options.push(el('option', { value: s.id, text: `${s.host} · ${s.user}` }));
  options.push(el('option', { value: NEW_SERVER, text: '다른 서버 추가…' }));
  select.replaceChildren(...options);
  select.value = [...select.options].some((o) => o.value === previous) ? previous : select.options[0].value;
  syncNewServer();
  $('#serverSection').hidden = servers.length === 0;
  $('#servers').replaceChildren(...servers.map(serverRow));
}
function syncNewServer() { $('#newServer').hidden = $('#server').value !== NEW_SERVER; }
$('#checkServer').addEventListener('click', async () => {
  formError('');
  const button = $('#checkServer'); button.disabled = true; button.textContent = '확인 중…';
  let result;
  try { result = await api.action('add-server', { url: $('#url').value, token: $('#token').value }); } catch (error) { result = { ok: false, message: error?.message }; }
  button.disabled = false; button.textContent = '확인';
  if (!result?.ok) { formError(result?.message || '서버를 확인하지 못했습니다.'); return; }
  $('#token').value = ''; $('#url').value = '';
  if (state) { serversKey = ''; state.servers = [...(state.servers || []).filter((s) => s.id !== result.server.id), result.server]; renderServerChoice(); }
  $('#server').value = result.server.id; syncNewServer();
});
$('#server').addEventListener('change', () => { formError(''); syncNewServer(); });
$('#addRunner').addEventListener('click', async () => {
  formError('');
  const server = $('#server').value;
  if (!chosenAi()) { formError('AI를 골라 주세요.'); return; }
  if (server === NEW_SERVER) { formError('서버 주소와 내 토큰을 적고 [확인]을 눌러 주세요.'); return; }
  const button = $('#addRunner'); button.disabled = true;
  let result;
  try { result = await api.action('add-runner', { ai: chosenAi(), server, autoStart: $('#auto').checked, mcp: Number($('#mcp').value), start: true }); } catch (error) { result = { ok: false, message: error?.message }; }
  button.disabled = false;
  if (!result?.ok) { formError(result?.message || '실행기를 추가하지 못했습니다.'); return; }
  $('#add').open = false;
});

// ── 다른 서버 ──
async function removeServer(s) {
  if (!window.confirm(`${s.host} 서버를 목록에서 삭제할까요?\n저장한 토큰도 이 PC에서 지웁니다.`)) return;
  if (await act('remove-server', s.id)) serversKey = '';
}
function serverRow(s) {
  return el('li', { class: 'server' }, [
    el('div', { class: 'who' }, [el('b', { text: s.host, title: s.url }), el('small', { text: [s.user, s.roleLabel, s.mcp2 ? null : '새 연결 미지원'].filter(Boolean).join(' · ') })]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'ghost', text: '웹 열기', title: '이 서버의 웹 화면을 기본 브라우저에서 엽니다', onclick: () => void act('open-server', s.id) }),
      el('button', { class: 'ghost danger', text: '삭제', disabled: s.inUse, title: s.inUse ? '이 서버를 쓰는 실행기를 먼저 삭제해 주세요' : '저장한 주소와 토큰을 지웁니다', onclick: () => void removeServer(s) }),
    ]),
  ]);
}

// ── 기록 ──
async function openLog(id) { logFor = id; logCount = -1; $('#logPanel').hidden = false; renderRunners(true); await refreshLog(); $('#logPanel').scrollIntoView({ block: 'nearest' }); }
function closeLog() { logFor = null; $('#logPanel').hidden = true; renderRunners(true); }
async function refreshLog() {
  if (!logFor) return;
  const runner = state?.runners?.find((r) => r.id === logFor);
  if (!runner) { closeLog(); return; }
  $('#logTitle').textContent = `기록 — ${runner.aiLabel} · ${runner.serverLabel}`;
  if (runner.lines === logCount) return;
  logCount = runner.lines;
  const result = await act('log', logFor, { quiet: true });
  if (!result) return;
  const pre = $('#log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = result.lines.length ? result.lines.map((l) => `${time(l.at)}  ${l.text}`).join('\n') : '아직 기록이 없습니다.';
  if (atBottom || logCount <= 1) pre.scrollTop = pre.scrollHeight;
}
$('#closeLog').addEventListener('click', closeLog);
$('#openLogs').addEventListener('click', () => void act('open-logs'));
$('#stopAll').addEventListener('click', () => void act('stop-all'));
$('#close').addEventListener('click', () => void act('close'));

function render(next) {
  state = next;
  document.body.classList.toggle('runner-mode', state.mode === 'runner');
  $('#close').hidden = state.mode === 'runner';
  if (!state.aiSupported) notice(state.aiSupportMessage);
  buildAiChoice();
  renderServerChoice();
  renderRunners();
  if (!state.runners.length && !$('#add').dataset.touched) $('#add').open = true;
  void refreshLog();
}
$('#add').addEventListener('toggle', () => { $('#add').dataset.touched = '1'; });
api.onState((next) => render(next));
act('state').then((result) => { if (result) render(result.state); });
