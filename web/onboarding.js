import { DEPLOYMENTS, SUBSCRIPTIONS, setupPlan, safeNext, appDestination } from './onboarding-model.js';

const query = new URLSearchParams(location.search);
const next = safeNext(query.get('next') || '/');
const root = document.getElementById('welcome');
const labels = ['사용 방식', 'AI 연결', '설치'];
let step = 0;
let deployment = null;
let subscription = null;
let installOs = /Mac/i.test(navigator.platform) ? 'mac' : 'windows';
let releasePackages = [];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const go = intent => appDestination(next, intent);
document.getElementById('skip').href = go('start');

function card(option, selected) {
  return `<button type="button" class="choice" data-choice="${option.id}" aria-pressed="${selected === option.id}">
    <img src="/onboarding-assets/${option.icon}.webp" alt="" width="56" height="56">
    <span class="choice-text"><strong>${option.title}</strong><span>${option.detail}</span></span>
    <span class="choice-arrow" aria-hidden="true">→</span>
  </button>`;
}

function command(text, id, title) {
  return `<div class="command"><div class="command-head"><label for="${id}">${title}</label><button type="button" class="copy" data-copy="${id}" aria-label="${title} 복사">복사</button></div><textarea id="${id}" readonly spellcheck="false" rows="2">${escape(text)}</textarea></div>`;
}

const instructions = steps => `<ol class="instructions">${steps.map(text => `<li>${escape(text)}</li>`).join('')}</ol>`;
function downloadLink(pkg, label, fallback) {
  return `<a class="action primary" href="${pkg ? '/download/' + encodeURIComponent(pkg.file) : fallback}" ${pkg ? 'download' : ''}>${label} <span aria-hidden="true">${pkg ? '↓' : '↗'}</span></a>`;
}

function windowsInstall(plan) {
  const legacy = releasePackages.find(p => p.target === plan.target && p.file.endsWith('.zip'));
  const app = releasePackages.find(p => p.target === 'windows-app' && p.file.endsWith('.exe'));
  const pkg = legacy || app;
  if (!pkg) return `<p class="note">다운로드 페이지에서 Windows 설치 파일과 안내를 확인하세요.</p>${downloadLink(null, 'Windows 다운로드 페이지', '/download#windows')}`;
  const mode = deployment === 'personal' ? '혼자 쓰기' : '여러 사람과 함께 쓰기';
  const label = legacy ? 'Windows ZIP 다운로드' : 'Windows 설치 파일 다운로드';
  const steps = legacy ? plan.steps : [
    '받은 .exe 파일을 실행해 설치합니다.',
    `첫 실행에서 [${mode}]를 선택합니다.`,
    ...(plan.needsLogin ? [`[AI → 실행기 관리]에서 ${subscription === 'chatgpt' ? 'Codex' : 'Claude Code'}를 추가하고 로그인합니다.`] : []),
  ];
  const size = Number.isSafeInteger(pkg.bytes) ? ` · ${(pkg.bytes / 1_000_000).toFixed(1)} MB` : '';
  return `${downloadLink(pkg, label, '/download#windows')}<p class="compat">Windows 10·11 (64비트)${size}</p>${instructions(steps)}`;
}

function macInstall(plan) {
  if (deployment === 'shared') {
    return '<p class="note">공동 작업 서버를 설치하려면 Windows를 선택하세요. Mac에서는 브라우저로 기존 서버에 접속할 수 있습니다.</p><a href="/download#mac">Mac 편집기 보기 ↗</a>';
  }
  const packages = releasePackages.filter(p => /^(?:macos-editor|local-editor-macos)-/.test(p.target || '') && p.file.endsWith('.zip'));
  const links = (packages.length ? packages : [null]).map(pkg => {
    const arch = pkg?.arch === 'arm64' ? ' · Apple Silicon' : pkg?.arch === 'x64' ? ' · Intel' : '';
    return downloadLink(pkg, pkg ? `Mac 편집기 다운로드${arch}` : 'Mac 다운로드 페이지', '/download#mac');
  });
  return `<div class="actions">${links.join('')}</div><p class="compat">macOS 12.1 이상</p>${instructions(['ZIP을 풀고 앱을 응용 프로그램 폴더로 옮깁니다.', 'Hwpx Editor를 엽니다.'])}${plan.needsLogin ? '<p class="note">구독 AI 연결은 Windows용 Hwpx Cowork에서 설정합니다.</p>' : ''}`;
}

function render(focus = true) {
  const progress = `<ol class="progress" aria-label="시작 안내 단계">${labels.map((label, index) => `<li ${index === step ? 'aria-current="step"' : ''}><span aria-hidden="true">${index + 1}</span>${label}</li>`).join('')}</ol>`;
  if (step < 2) {
    const first = step === 0;
    const options = first ? DEPLOYMENTS : SUBSCRIPTIONS;
    root.innerHTML = `${progress}<div class="step-head">
      <h1 id="step-title" tabindex="-1">${first ? '나에게 맞게 시작하기' : 'AI 구독을 연결할까요?'}</h1>
      <p class="lead">${first ? '프로그램을 어떻게 사용하시겠어요?' : '사용 중인 구독을 고르세요. AI 연결은 나중에도 할 수 있습니다.'}</p>
      </div><div class="choices ${first ? '' : 'three'}" role="group" aria-label="${labels[step]}">${options.map(option => card(option, first ? deployment : subscription)).join('')}</div>
      ${first ? '' : '<button type="button" class="back" data-back>← 사용 방식 다시 고르기</button>'}`;
  } else {
    const plan = setupPlan(deployment, subscription);
    root.innerHTML = `${progress}<div class="step-head"><h1 id="step-title" tabindex="-1">설치 방법</h1>
      <p class="selection">${DEPLOYMENTS.find(x => x.id === deployment).title} · ${SUBSCRIPTIONS.find(x => x.id === subscription).title}</p></div>
      <div class="result-grid">
        <section class="plan" aria-labelledby="install-title">
          <h2 id="install-title">프로그램 설치</h2>
          <div class="install-os" role="group" aria-label="설치할 운영체제"><button type="button" data-os="windows" aria-pressed="${installOs === 'windows'}">Windows</button><button type="button" data-os="mac" aria-pressed="${installOs === 'mac'}">Mac</button></div>
          <div id="platform-install">${installOs === 'windows' ? windowsInstall(plan) : macInstall(plan)}</div>
          <details class="advanced-install"><summary>저장소에서 직접 설치</summary>
            ${command(plan.command, 'setup-command', 'Windows 터미널')}${command(plan.commandNode, 'setup-node-command', 'Mac·Linux · Node.js 22 이상')}
            <p id="copy-status" class="status" role="status"></p>
          </details>
          <a class="detail-link" id="install-help" href="${plan.help}-${installOs}" target="_blank" rel="noopener">설치 설명서 ↗</a>
          <a class="detail-link" href="https://github.com/nagmint12/hwpxcowork/releases" target="_blank" rel="noopener">GitHub에서 설치 파일 받기 ↗</a>
        </section>
        <section class="launch" aria-labelledby="launch-title">
          <h2 id="launch-title">웹에서 사용해 보기</h2>
          <p class="note">현재 서버에서 편집을 시작하거나 튜토리얼을 볼 수 있습니다.</p>
          <div class="actions"><a class="action" id="direct-start" href="${escape(go('start'))}">웹에서 시작하기</a><a class="action" id="tutorial-start" href="${escape(go('tutorial'))}">튜토리얼 보기</a></div>
        </section>
      </div><div class="back-row"><button type="button" class="back" data-back>← AI 구독 다시 고르기</button><button type="button" class="back" data-reset>처음부터 다시 선택</button></div>`;
  }

  root.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => {
    if (step === 0) deployment = button.dataset.choice;
    else subscription = button.dataset.choice;
    step++; render();
  }));
  root.querySelector('[data-back]')?.addEventListener('click', () => { step--; render(); });
  root.querySelector('[data-reset]')?.addEventListener('click', () => { step = 0; deployment = subscription = null; render(); });
  root.querySelectorAll('[data-os]').forEach(button => button.addEventListener('click', () => {
    installOs = button.dataset.os;
    for (const option of root.querySelectorAll('[data-os]')) option.setAttribute('aria-pressed', option === button ? 'true' : 'false');
    refreshInstaller();
  }));
  root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = '명령을 복사했습니다.';
    } catch {
      field.focus(); field.select();
      status.textContent = '내용을 선택했습니다. Ctrl+C(또는 ⌘C)로 복사해 주세요.';
    }
  }));
  if (focus) root.querySelector('h1').focus();
}

function refreshInstaller() {
  const area = root.querySelector('#platform-install');
  if (!area) return;
  const hadFocus = area.contains(document.activeElement);
  const plan = setupPlan(deployment, subscription);
  area.innerHTML = installOs === 'windows' ? windowsInstall(plan) : macInstall(plan);
  root.querySelector('#install-help').href = `${plan.help}-${installOs}`;
  if (hadFocus) area.querySelector('a')?.focus();
}

render(false);
const releaseManifest = new URL('/download/release.json', location.href);
if (releaseManifest.origin === location.origin) {
  fetch(releaseManifest).then(response => response.ok ? response.json() : null).then(manifest => {
    if (!Array.isArray(manifest?.packages)) return;
    releasePackages = manifest.packages.filter(p => p && !p.archived && !/previous|archive/.test(p.target || '') && typeof p.file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|zip)$/.test(p.file));
    refreshInstaller();
  }).catch(() => { /* 다운로드 페이지 링크는 계속 쓸 수 있다. */ });
}
