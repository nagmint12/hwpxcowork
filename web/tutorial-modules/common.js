// 실습 모듈이 공유하는 표시와 문서 조작 도우미.
import { shapeDialog } from '../tutorial-targets.js';
import { typeTutorialInput, typeTutorialPrompt } from '../tutorial-motion.js';
export const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
export const length = text => [...String(text || '')].length;
const examples = {
  chatMenu: { src: 'chatgpt-add-menu.png', width: 1908, height: 951, crop: [630, 0, 1000, 200], caption: '실제 ChatGPT 계정의 Plugins 화면과 Add 버튼. 계정 정보는 가렸습니다.' },
  chatForm: { src: 'chatgpt-mcp-form.png', width: 1200, height: 1520, caption: '실제 계정의 Add custom MCP server 입력창을 배경 없이 캡처했습니다. 등록은 본인 계정에서 진행합니다.' },
  apiKeys: { src: 'api-keys.png', width: 1200, height: 480, caption: 'API 키 관리 화면의 일반 예시입니다. 실제 화면과 메뉴는 제공업체마다 다릅니다.' },
  apiCreate: { src: 'api-create-key.png', width: 1200, height: 480, caption: 'API 키 생성 양식의 일반 예시입니다. 실제 키를 생성하거나 저장하지 않습니다.' },
};

export function image(root, key, target = null, activate = null, crop = null) {
  const spec = examples[key]; const figure = el('figure', null, 'tour-example');
  const [x, y, w, h] = crop || spec.crop || [0, 0, spec.width, spec.height];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`); svg.setAttribute('role', target ? 'group' : 'img'); svg.setAttribute('aria-label', spec.caption);
  const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  img.setAttribute('href', `/tutorial-assets/${spec.src}`); img.setAttribute('width', spec.width); img.setAttribute('height', spec.height); svg.append(img);
  if (target && activate) {
    const button = document.createElementNS('http://www.w3.org/2000/svg', 'g'); button.setAttribute('role', 'button'); button.setAttribute('tabindex', '0'); button.setAttribute('aria-label', '금빛으로 표시된 예시 위치를 확인하고 다음 단계');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [name, value] of Object.entries({ x: target[0], y: target[1], width: target[2], height: target[3], rx: 8 })) ring.setAttribute(name, value);
    ring.setAttribute('class', 'tour-example-target'); button.append(ring);
    button.addEventListener('click', activate); button.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }); svg.append(button);
  }
  figure.append(svg, el('figcaption', spec.caption)); root.append(figure);
}

export function practice(root, fields, note = '입력 예시입니다. 실제 계정 설정이나 키를 저장하지 않습니다.') {
  const box = el('div', null, 'tour-practice'); box.append(el('p', note, 'tour-demo-note'));
  for (const field of fields) {
    const label = el('label', field.label); const input = el('input');
    input.value = field.value || ''; input.readOnly = true; input.type = field.secret ? 'password' : 'text';
    input.dataset.tutorialPreview = input.value;
    input.setAttribute('aria-label', `${field.label} 예시`); label.append(input); box.append(label);
    if (/^https?:\/\//.test(field.value || '')) {
      const copy = el('button', '주소 복사'); copy.type = 'button';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(field.value); copy.textContent = '주소를 복사했습니다'; } catch { input.select(); copy.textContent = '선택한 주소를 복사해 주세요'; } });
      box.append(copy);
    }
  }
  root.append(box); return box;
}

export function external(root, url, text) {
  const a = el('a', text, 'tour-link'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; root.append(a);
}

export function commandExample(root, label, value) {
  const box = el('div', null, 'tour-practice');
  const code = el('code', value); const pre = el('pre', null, 'tour-command'); pre.append(code);
  const copy = el('button', '복사'); copy.type = 'button'; copy.setAttribute('aria-label', `${label} 복사`);
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(value); copy.textContent = '복사했습니다'; }
    catch { const range = document.createRange(); range.selectNodeContents(code); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = '선택한 내용을 복사해 주세요'; }
  });
  box.append(el('p', label, 'tour-demo-note'), pre, copy); root.append(box);
}

const sameTutorialStep = (env, step, title) => (!env.stepIdentity || env.stepIdentity() === step)
  && (!title || env.isCurrentStep?.(title) !== false);

export function typeInTutorialField(env, input, value, title = null) {
  if (!input) throw new Error('입력 창을 먼저 열어 주세요');
  const step = env.stepIdentity?.(); input.focus?.();
  const popover = env.s?.popover; const reply = env.s?.reply;
  return typeTutorialInput({ input, text: value, reduced: env.motionReduced || (() => true),
    current: () => sameTutorialStep(env, step, title) && env.s?.popover === popover && env.s?.reply === reply });
}

export function typeInTutorialComposer(env, value, title = null) {
  const composer = env.s.composer; if (!composer) return Promise.resolve();
  const step = env.stepIdentity?.();
  return typeTutorialPrompt({ composer, text: value, reduced: env.motionReduced || (() => true),
    current: () => env.s.composer === composer && sameTutorialStep(env, step, title) });
}

export async function sendTutorialExample(d, target, instruction, options = {}) {
  const model = d.s.composer;
  const result = await d.createRequest({ kind: 'instruct', target, instruction, attachments: [], ...options, route: 'example' });
  if (result?.request?.rid == null) throw new Error(result?.message || '연습 요청을 만들지 못했습니다.');
  if (model && d.s.composer === model) {
    model.rid = result.request.rid; model.phase = 'result'; model.error = result.failed ? result.message : '';
  }
  return result.request;
}

export function openTutorialMemoReply(d, memo) {
  if (!memo) throw new Error('연습 메모를 찾지 못했습니다. 준비 단계부터 다시해 주세요.');
  d.s.active = { kind: 'memo', id: memo.id };
  d.openReply({ key: Date.now(), kind: 'memo', memoId: memo.id, ref: memo.ref, quote: memo.body ?? memo.text ?? '', anchor: null });
}

export async function applyTutorialProposal(d, proposal) {
  if (proposal?.status !== 'pending') throw new Error('반영할 연습 제안이 없습니다. 준비 단계의 상태를 확인해 주세요.');
  await d.applyProposal(proposal);
}

export function enableTutorialTools(env) {
  const button = () => env.q('[data-testid="toggle-editor-tools"]');
  const menu = () => env.q('[data-testid="bar-more-toggle"]');
  return {
    allowControl: control => control === button() || control === menu(),
    quick: async () => {
      if (!button()) { env.activate(menu()); await Promise.resolve(); }
      env.activate(button());
    },
  };
}

export function stepHelpers(env) {
  const { d, s, ctx, config, focusIn, rectOf, pad, q, fdoc, inFrame, frameRect, selectFor, locate, phraseRect, cw } = env;
  const finish = { title: '연습을 마쳤습니다', text: '완료하면 지금의 연습 문서와 메모·검토 기록을 내 문서함에 보관합니다. 새 연습은 튜토리얼 메뉴에서 언제든 다시 시작할 수 있습니다.', center: true, next: '완료하고 문서함에 저장', last: true };
  const intro = (title, text) => ({ title, text, center: true, next: '시작하기' });
  const paragraph = prefix => (s.paragraphs || []).find(p => String(p.text || '').includes(prefix));
  const focus = prefix => { const p = paragraph(prefix); if (p) focusIn(d, { ref: p.ref, start: 0, end: length(p.text) }, { quiet: true }); return p; };
  const frameButton = (...labels) => [...(fdoc()?.querySelectorAll('button') || [])].find(b => {
    const name = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.textContent || ''}`.replace(/\s/g, '');
    return b.getBoundingClientRect().width && labels.some(label => name.includes(label.replace(/\s/g, '')));
  });
  const frameDialog = kind => shapeDialog(fdoc(), kind);
  const activate = button => env.activate ? env.activate(button) : button.click();
  const closeFrameDialog = kind => { const box = frameDialog(kind); const b = box?.querySelector('.dialog-close') || [...(box?.querySelectorAll('button') || [])].find(b => /^(취소|닫기|Cancel)/.test(b.textContent.replace(/\s/g, ''))); if (b) activate(b); };
  const openShape = async (kind, title) => {
    const ticket = env.stepIdentity?.();
    // 글자 모양은 실제 선택 범위가 있어야 열린다. 앞 단계를 건너뛰었어도 같은 예시를 선택한다.
    const selected = await selectFor(kind === 'char' ? '장평 50%' : '줄 간격 250%');
    if (env.isCurrentStep?.(title) === false || (env.stepIdentity && env.stepIdentity() !== ticket)) return;
    if (!selected) throw new Error('모양을 확인할 예시 글을 찾지 못했습니다');
    closeFrameDialog(kind === 'char' ? 'para' : 'char');
    const b = fdoc()?.querySelector(`button[data-cmd="format:${kind === 'char' ? 'char' : 'para'}-shape"]`);
    if (!b) throw new Error('편집기 도구 막대의 모양 단추가 보이지 않습니다');
    activate(b);
  };
  const reveal = element => element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const top = selector => () => pad(rectOf(q(selector)), 4);
  const memo = () => (s.memos || []).find(m => String(m.text || m.body || '').includes('튜토리얼에서 남긴 메모')) || s.memos?.at(-1);
  const memoCard = () => memo() ? q(`.rcard[data-kind="memo"][data-id="${memo().id}"]`) : null;
  const fill = (selector, value) => typeInTutorialField(env, q(selector), value);

  return { finish, intro, paragraph, focus, frameButton, frameDialog, closeFrameDialog, openShape, reveal, top, memo, memoCard, fill };
}
