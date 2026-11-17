import { DEPLOYMENTS, SUBSCRIPTIONS, setupPlan, safeNext, appDestination } from './onboarding-model.js';

const query = new URLSearchParams(location.search);
const next = safeNext(query.get('next') || '/');
const root = document.getElementById('welcome');
let step = 0;
let deployment = null;
let subscription = null;
let installOs = /Mac/i.test(navigator.platform) ? 'mac' : 'windows';
let releasePackages = [];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const go = intent => appDestination(next, intent);
document.getElementById('skip').href = go('start');

function card(option, selected) {
  return `<button type="button" class="choice" data-choice="${option.id}" aria-pressed="${selected === option.id}"><img src="/onboarding-assets/${option.icon}.webp" alt="" width="106" height="106"><strong>${option.title}</strong><span>${option.detail}</span><span class="choose">선택하기 →</span></button>`;
}
function command(text, id, title, rows = 2) {
  return `<div class="command"><div class="command-head"><label for="${id}">${title}</label><button type="button" class="copy" data-copy="${id}" aria-label="${title} 복사">복사</button></div><textarea id="${id}" readonly spellcheck="false" rows="${rows}">${escape(text)}</textarea></div>`;
}
// 머리 한 줄은 고른 운영체제를 따른다 — Mac 에는 시작.bat 이 없다(그전에는 Mac 에서도 Windows 글이 그대로 보였다, 2026-11-16).
// Mac 공동 서버는 아래 안내 상자('Windows PC에 설치합니다')가 대신 말하므로 줄을 두지 않는다
function installLead() {
  if (installOs === 'windows') return '<p class="lead">파일을 받아 압축을 풀고 시작.bat을 실행하세요.</p>';
  return deployment === 'personal' ? '<p class="lead">파일을 받아 압축을 풀고 Hwpx Editor.app을 여세요.</p>' : '';
}
function installer(plan) {
  const pkg = releasePackages.find(p => !p.archived && p.target === plan.target);
  const label = deployment === 'personal' ? '개인용' : '공동 작업용';
  const windows = `<div class="install-step"><span class="step-number">1</span><div><h3>Windows ${label} ZIP 다운로드</h3><p>${deployment === 'personal' ? '내 PC의 HWPX 파일을 열어 고치고 원래 파일에 저장합니다.' : '이 PC를 서버로 삼아 여러 사람이 같은 문서를 함께 고칩니다. 참여자는 브라우저로 접속합니다.'}</p><a class="action primary download-action" href="${pkg ? '/download/' + encodeURIComponent(pkg.file) : '/download#windows'}" ${pkg ? 'download' : ''}>Windows ${label} 다운로드 <span aria-hidden="true">↓</span></a><small>Windows 10·11 (64비트)${pkg ? ' · ' + (pkg.bytes / 1000000).toFixed(1) + ' MB' : ''} · 설치 안내.txt 포함</small></div></div>
    <div class="install-step"><span class="step-number">2</span><div><h3><code>시작.bat</code> 실행</h3><p>처음 한 번 Node.js와 라이브러리를 인터넷으로 받은 뒤 ${deployment === 'personal' ? '편집기가' : '관리자 문서함이'} 열립니다. 다음부터 같은 파일로 시작하고, 끌 때는 <b>종료.bat</b>을 실행합니다.</p></div></div>
    <div class="install-step"><span class="step-number">3</span><div>${plan.needsLogin ? `<h3><code>AI 연결.bat</code> 실행</h3><p>${escape(plan.aiChoice)}를 고르고 브라우저에서 본인 계정으로 로그인합니다. 연결되면 편집기의 AI 작업 창에서 요청합니다.</p>` : deployment === 'personal' ? '<h3>PC 폴더 연결</h3><p>문서함의 <b>PC 폴더 연결</b>로 문서 폴더를 연결하면, 열어서 고친 내용이 그 파일에 저장됩니다.</p>' : '<h3>참여자 추가·외부 접속</h3><p><b>관리자 → 사용자</b>에서 참여자를 추가하고, <b>외부 접속 열기.bat</b>이 알려 주는 주소와 토큰을 전달합니다.</p>'}</div></div>`;
  const macs = releasePackages.filter(p => !p.archived && /^(?:macos-editor|local-editor-macos)-/.test(p.target || ''));
  const mac = deployment === 'shared'
    ? '<div class="platform-message"><h3>공동 작업 서버는 Windows PC에 설치합니다.</h3><p>Mac 사용자는 참여자로 브라우저에서 서버 주소에 접속합니다. 내 Mac의 파일을 직접 고치려면 Mac 편집기를 쓰세요.</p><a href="/download#mac">Mac 편집기 보기 →</a></div>'
    : `<div class="install-step"><span class="step-number">1</span><div><h3>Hwpx Editor (Mac) 다운로드</h3><p>HWP·HWPX·HML 문서를 열어 고치고 원래 파일에 저장합니다. 서버·인터넷 없이 동작합니다.</p><div class="actions">${macs.length ? macs.map(p => `<a class="action primary" href="/download/${encodeURIComponent(p.file)}" download>Mac 편집기 다운로드 ↓</a>`).join('') : '<a class="action primary" href="/download#mac">Mac 편집기 다운로드 →</a>'}</div><small>macOS 12.1 이상 · Intel·Apple Silicon 공용</small></div></div><div class="install-step"><span class="step-number">2</span><div><h3><code>Hwpx Editor.app</code> 열기</h3><p>ZIP을 풀어 응용 프로그램 폴더로 옮기고, 처음 열 때는 Control-클릭 → <b>열기</b> → <b>열기</b>를 누릅니다.</p>${plan.needsLogin ? '<p class="note">AI 연결은 Windows 설치본에서 제공합니다.</p>' : ''}</div></div>`;
  return `<div class="install-os" role="group" aria-label="설치할 운영체제"><button type="button" data-os="windows" aria-pressed="${installOs === 'windows'}">Windows</button><button type="button" data-os="mac" aria-pressed="${installOs === 'mac'}">Mac</button></div>${installOs === 'windows' ? windows : mac}`;
}
function render(focus = true) {
  if (step === 0) {
    root.innerHTML = `<p class="eyebrow">시작하기 · 1 / 2</p><h1 id="step-title" tabindex="-1">어떻게 사용하실 건가요?</h1><p class="lead">두 가지만 고르면, 필요한 시작 방법을 바로 알려드릴게요.</p><div class="choices" aria-label="서버 운영 방식">${DEPLOYMENTS.map(x => card(x, deployment)).join('')}</div>`;
  } else if (step === 1) {
    root.innerHTML = `<p class="eyebrow">시작하기 · 2 / 2</p><h1 id="step-title" tabindex="-1">연결할 구독 AI가 있나요?</h1><p class="lead">쓰고 계신 구독을 골라 주세요. AI는 나중에 연결해도 괜찮습니다.</p><div class="choices three" aria-label="개인 AI 구독">${SUBSCRIPTIONS.map(x => card(x, subscription)).join('')}</div><button type="button" class="back" data-back>← 운영 방식 다시 고르기</button>`;
  } else {
    const plan = setupPlan(deployment, subscription);
    root.innerHTML = `<p class="eyebrow">선택한 설정으로 시작하기</p><h1 id="step-title" tabindex="-1">${plan.title}</h1>${installLead()}<div class="summary"><span class="pill">${DEPLOYMENTS.find(x => x.id === deployment).title}</span><span class="pill">${SUBSCRIPTIONS.find(x => x.id === subscription).title}</span></div>
      <section class="plan" aria-labelledby="install-title"><h2 id="install-title">${deployment === 'personal' ? '내 PC에 설치하기' : '함께 쓸 서버에 설치하기'}</h2>${installer(plan)}${installOs === 'windows' ? `<p class="note">${plan.aiNote}</p>` : ''}
      <details class="more advanced-install"><summary>저장소 폴더에서 직접 설치할 때(Mac·Linux 서버 포함)</summary><p class="note">새 설치는 위 다운로드 단추를 씁니다. 저장소 폴더에서 직접 설치할 때만 아래 명령을 씁니다.</p>${command(plan.command, 'setup-command', 'Windows · app 폴더의 터미널')}${command(plan.commandNode, 'setup-node-command', 'Mac·Linux · Node.js 22 이상 필요')}</details>
      <p class="more"><a href="${plan.help}" target="_blank" rel="noopener">이 설치 방법 자세히 보기 ↗</a></p><p id="copy-status" class="status" role="status" aria-live="polite"></p></section>
      <details class="launch"><summary>설치 전에 현재 웹 서버에서 사용해 보기</summary><p>현재 서버에서 튜토리얼을 보거나 편집을 시작할 수 있습니다. 내 PC에 설치한 문서함은 설치 후 자동으로 열립니다.</p><p class="current">현재 서버: ${escape(location.origin)}</p><div class="actions"><a class="action" id="tutorial-start" href="${escape(go('tutorial'))}">튜토리얼 보기</a><a class="action" id="direct-start" href="${escape(go('start'))}">웹에서 시작하기</a></div></details><button type="button" class="back" data-back>← 구독 다시 고르기</button> <button type="button" class="back" data-reset style="margin-left:20px">처음부터 다시 선택</button>`;
  }
  root.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => {
    if (step === 0) deployment = button.dataset.choice;
    else subscription = button.dataset.choice;
    step++; render();
  }));
  root.querySelector('[data-back]')?.addEventListener('click', () => { step--; render(); });
  root.querySelector('[data-reset]')?.addEventListener('click', () => { step = 0; render(); });
  root.querySelectorAll('[data-os]').forEach(button => button.addEventListener('click', () => { installOs = button.dataset.os; render(false); root.querySelector(`[data-os="${installOs}"]`)?.focus(); }));
  root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = '복사했습니다. 프로그램 폴더의 터미널에 붙여넣어 주세요.';
    } catch {
      field.focus(); field.select();
      status.textContent = '내용을 선택했습니다. Ctrl+C(또는 ⌘C)로 복사해 주세요.';
    }
  }));
  if (focus) root.querySelector('h1').focus();
}
render(false);
fetch('/download/release.json').then(response => response.ok ? response.json() : null).then(manifest => {
  if (Array.isArray(manifest?.packages)) releasePackages = manifest.packages.filter(p => typeof p.file === 'string' && /^[A-Za-z0-9._-]+\.zip$/.test(p.file));
  if (step === 2) render(false);
}).catch(() => { /* 다운로드 센터 링크로 계속 진행할 수 있다. */ });
