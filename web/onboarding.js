import { DEPLOYMENTS, SUBSCRIPTIONS, setupPlan, safeNext, appDestination } from './onboarding-model.js';

const query = new URLSearchParams(location.search);
const next = safeNext(query.get('next') || '/');
const root = document.getElementById('welcome');
let step = 0;
let deployment = null;
let subscription = null;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const go = intent => appDestination(next, intent);
document.getElementById('skip').href = go('start');

function card(option, selected) {
  return `<button type="button" class="choice" data-choice="${option.id}" aria-pressed="${selected === option.id}"><img src="/onboarding-assets/${option.icon}.webp" alt="" width="106" height="106"><strong>${option.title}</strong><span>${option.detail}</span><span class="choose">선택하기 →</span></button>`;
}
function command(text, id, title, rows = 2) {
  return `<div class="command"><div class="command-head"><label for="${id}">${title}</label><button type="button" class="copy" data-copy="${id}" aria-label="${title} 복사">복사</button></div><textarea id="${id}" readonly spellcheck="false" rows="${rows}">${escape(text)}</textarea></div>`;
}
function render(focus = true) {
  if (step === 0) {
    root.innerHTML = `<p class="eyebrow">시작하기 · 1 / 2</p><h1 id="step-title" tabindex="-1">어떻게 사용하실 건가요?</h1><p class="lead">두 가지만 고르면, 필요한 시작 방법을 바로 알려드릴게요.</p><div class="choices" aria-label="서버 운영 방식">${DEPLOYMENTS.map(x => card(x, deployment)).join('')}</div>`;
  } else if (step === 1) {
    root.innerHTML = `<p class="eyebrow">시작하기 · 2 / 2</p><h1 id="step-title" tabindex="-1">연결할 구독 AI가 있나요?</h1><p class="lead">쓰고 계신 구독을 골라 주세요. AI는 나중에 연결해도 괜찮습니다.</p><div class="choices three" aria-label="개인 AI 구독">${SUBSCRIPTIONS.map(x => card(x, subscription)).join('')}</div><button type="button" class="back" data-back>← 운영 방식 다시 고르기</button>`;
  } else {
    const plan = setupPlan(deployment, subscription);
    root.innerHTML = `<p class="eyebrow">준비됐어요</p><h1 id="step-title" tabindex="-1">${plan.title}</h1><p class="lead">설명서 전체를 읽지 않아도, 이 순서대로 시작할 수 있습니다.</p><div class="summary"><span class="pill">${DEPLOYMENTS.find(x => x.id === deployment).title}</span><span class="pill">${SUBSCRIPTIONS.find(x => x.id === subscription).title}</span></div>
      <section class="plan" aria-labelledby="install-title"><h2 id="install-title">${deployment === 'personal' ? '내 PC에 설치하기' : '함께 쓸 서버에 설치하기'}</h2><ol class="steps">${plan.steps.map(text => `<li>${text}</li>`).join('')}</ol>
      ${command(plan.prompt, 'setup-prompt', 'VS Code의 Codex·Claude Code 대화창에 붙여넣을 내용', 4)}<details class="more"><summary>터미널에서 직접 설치하기</summary>${command(plan.command, 'setup-command', 'Windows · scripts 폴더가 있는 위치에서 실행')}<p class="note">필요한 Node.js와 프로그램 의존성, 선택한 공식 CLI를 프로그램 폴더 안에 준비합니다. macOS·Linux는 Node.js 22 이상을 먼저 준비하세요.</p>${command(plan.commandNode, 'setup-node-command', 'macOS · Linux · 터미널')}</details><p class="note">${plan.aiNote}</p>
      ${deployment === 'shared' ? '<p class="note">외부에서 접속할 서버라면 HTTPS 주소와 접근 권한을 준비하세요. 개인 구독 로그인은 실제 AI 실행기를 사용할 PC에서 진행합니다. 다른 참여자는 각자 자신의 AI를 연결합니다.</p>' : ''}
      <p class="more"><a href="${plan.help}" target="_blank" rel="noopener">이 설치 방법 자세히 보기 ↗</a></p><p id="copy-status" class="status" role="status" aria-live="polite"></p></section>
      <section class="launch" aria-labelledby="launch-title"><h2 id="launch-title">지금 보고 있는 서버에서 먼저 사용해 볼까요?</h2><p>현재 서버에 접속해 튜토리얼을 보거나 바로 시작할 수 있습니다. 새로 설치한 서버는 터미널에 표시된 주소에서 열어 주세요.</p><p class="current">현재 서버: ${escape(location.origin)}</p><div class="actions"><a class="action primary" id="tutorial-start" href="${escape(go('tutorial'))}">튜토리얼 보기</a><a class="action" id="direct-start" href="${escape(go('start'))}">바로 시작하기</a></div><p class="note">서버 주소와 토큰을 이미 받으셨다면 이 서버에 그대로 접속하시면 됩니다.</p></section><button type="button" class="back" data-back>← 구독 다시 고르기</button> <button type="button" class="back" data-reset style="margin-left:20px">처음부터 다시 선택</button>`;
  }
  root.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => {
    if (step === 0) deployment = button.dataset.choice;
    else subscription = button.dataset.choice;
    step++; render();
  }));
  root.querySelector('[data-back]')?.addEventListener('click', () => { step--; render(); });
  root.querySelector('[data-reset]')?.addEventListener('click', () => { step = 0; render(); });
  root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = button.dataset.copy === 'setup-prompt'
        ? '복사했습니다. VS Code의 Codex·Claude Code 대화창에 붙여넣어 주세요.'
        : '복사했습니다. 프로그램 폴더의 터미널에 붙여넣어 주세요.';
    } catch {
      field.focus(); field.select();
      status.textContent = '내용을 선택했습니다. Ctrl+C(또는 ⌘C)로 복사해 주세요.';
    }
  }));
  if (focus) root.querySelector('h1').focus();
}
render(false);
