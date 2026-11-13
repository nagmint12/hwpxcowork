// 튜토리얼 공통 실행기: 화면 초점·진행 저장·단계 이동·반영 결과 확인을 담당합니다.
// 실습 내용과 동작은 tutorial-modules/, 구성 계약은 tutorial-definition.js에 둡니다.
import { focusIn } from './ui.js';
import { buildTutorialSteps } from './tutorial-steps.js';
import { buildComposedTutorialSteps, resolveTutorialPosition } from './tutorial-modules/compose.js';
import { createTutorialProgress } from './tutorial-progress.js';
import { api, state, toastError, docWorkEnv } from './util.js';
import { tutorialNavigation } from './tutorial-navigation.js';
import { tutorialDock, clippedRect } from './tutorial-layout.js';
import { createAppliedReview, appliedReviewRange } from './tutorial-apply-review.js';
import { createTutorialMotion, tutorialMotionSpec, typeTutorialInput } from './tutorial-motion.js';

const progress = createTutorialProgress({ request: api, token: () => state.token, onError: e => toastError(e, '안내 진행을 서버에 저장하지 못했습니다: ') });
export const tourState = progress.state;
export const saveTour = progress.save;
export const clearTour = progress.clear;
export const loadTour = progress.load;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
const pad = (r, n = 6) => (r ? { x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n } : null);
const visible = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };

/**
 * 따라 하기 시작 → { stop() }.
 * @param o { d(문서 store), docId, me, onEnd(끝·그만 — 저장 상태는 여기서 정리) }
 */
export function runTour({ d, docId, me, config = {}, showIntro = false, onComplete = async () => true, onNext = null, onEnd = () => {} }) {
  const s = d.s;
  const st = tourState(docId) || { docId, i: 0 };
  if (st.docId !== docId) { st.docId = docId; st.i = 0; }
  if (!s.info?.tutorialModules && s.info?.tutorialId === 'clipboard' && st.ctx?.clipboardGuideVersion !== 2) { st.i = 0; st.ctx = { clipboardGuideVersion: 2 }; }
  if (!s.info?.tutorialModules && s.info?.tutorialId === 'ai-advanced' && st.ctx?.advancedGuideVersion !== 3) {
    // 2026-11-04: 15작업(작업당 4단계)을 5작업(작업당 2단계, 예시 답변)으로 줄였다 — 예전 위치는 맞지 않아 처음부터 안내한다
    st.i = 0; st.ctx = { advancedGuideVersion: 3 };
  }
  const ctx = st.ctx || (st.ctx = {});
  let motionStep = null;
  const systemMotionReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionReduced = () => systemMotionReduced() || ctx.motionEnabled === false || motionStep?.motionEnabled === false;
  const clipboard = { seq: 0, type: '', text: '', html: '', tables: 0, images: 0 };
  let stopped = false; let i = Math.max(0, Number(st.i) || 0); let entered = -1; let clicked = false; let actionBusy = false; let actionError = '';
  let enterCleanup = null;
  let exampleCleanup = null;
  let resumeAfterIntro = null;

  // ── 편집기 iframe ──
  const frame = () => { try { return d.editor?.frame?.() || null; } catch { return null; } };
  const fdoc = () => { try { return frame()?.contentDocument || null; } catch { return null; } };
  const cw = () => { try { return frame()?.contentWindow?.rhwpCowork || null; } catch { return null; } };
  const frameRect = () => rectOf(frame());
  /** iframe 안 요소 → 바깥 좌표 사각형 */
  const inFrame = (el) => {
    const r = rectOf(el); const f = frameRect();
    return r && f ? clippedRect({ x: r.x + f.x, y: r.y + f.y, w: r.w, h: r.h }, f) : null;
  };
  const toolbarBtn = (action) => { const el = fdoc()?.querySelector(`.cw-mini button[data-cowork-action="${action}"]`); return el && visible(el) ? el : null; };
  const toolbarShown = () => { const el = fdoc()?.querySelector('.cw-mini'); return !!el && el.style.display !== 'none' && visible(el); };
  /** 편집기 글 phrase 의 자리(바깥 좌표, 0.25초마다만 잰다) — 그 문단 안 글자 몇 곳을 재어 줄이 바뀐 끝 글자까지 감싼다.
   *  끝 세 글자를 문서 전체에서 다시 찾던 방식은 앞쪽의 같은 글('년 10' 등)로 편집기를 0.25초마다 오가게 했다(2026-11-01) */
  const phraseCache = new Map();
  function phraseRect(phrase) {
    const hit = phraseCache.get(phrase); const now = performance.now();
    if (hit && now - hit.t < 250) return hit.r;
    let r = null;
    try {
      const dbg = cw()?.debug; const f = frameRect(); const at = locate(phrase);
      if (f && at && dbg?.pointFor) {
        const n = at.end - at.start; const picks = new Set([0, Math.max(0, n - 2), Math.max(0, n - 1)]);
        for (let k = 1; k < 10; k++) picks.add(Math.floor((n - 1) * k / 10));
        const pts = [...picks].sort((p, q) => p - q).map((k) => dbg.pointFor(at.ref, at.start + k)).filter(Boolean);
        if (pts.length) {
          const last = pts[pts.length - 1]; const prev = pts.length > 1 ? pts[pts.length - 2] : null;
          const charW = prev && Math.abs(prev.y - last.y) < 3 && last.x > prev.x ? Math.min(30, last.x - prev.x) : 15;
          const z = Math.max(14, Math.min(30, charW * 1.7)); // 줄 높이 — 휴대폰처럼 축소한 화면에서는 글자 폭에 맞춰 작게
          const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
          const x1 = Math.min(...xs); const x2 = Math.max(...xs) + charW; const y1 = Math.min(...ys); const y2 = Math.max(...ys);
          r = { x: f.x + x1 - 6, y: f.y + y1 - z / 2 - 4, w: x2 - x1 + 12, h: y2 - y1 + z + 8 };
        }
      } else {
        const a = dbg?.pointForText?.(phrase);
        if (a && f) r = { x: f.x + a.x - 6, y: f.y + a.y - 17, w: [...phrase].length * 15 + 12, h: 34 };
      }
    } catch { r = null; }
    phraseCache.set(phrase, { t: now, r });
    return r;
  }
  /** 기준 문단에서 phrase 자리 → { ref, start, end } */
  function locate(phrase) {
    for (const p of s.paragraphs || []) {
      const t = String(p.text ?? ''); const k = t.indexOf(phrase);
      if (k >= 0) { const start = [...t.slice(0, k)].length; return { ref: p.ref, start, end: start + [...phrase].length }; }
    }
    return null;
  }
  const selHas = (part) => !!s.selection && String(s.selection.text || '').includes(part);
  /** '대신 골라 주기': 편집기에서 그 글을 고르고 → 도구 막대를 거치지 않고 다음 창을 연다 */
  async function selectFor(phrase) {
    const at = locate(phrase); if (!at) return null;
    focusIn(d, at, { select: true, quiet: true });
    // 앞 네 글자만 보면 앞 단계의 선택('재수강 …')이 남아 있어도 새로 고른 것으로 여겨, 앞 작업의 문단을 요청 대상으로 열었다(2026-11-12)
    const probe = phrase.slice(0, 12);
    for (let k = 0; k < 20 && !selHas(probe); k++) await sleep(100);
    let sel = null; try { sel = await d.editor?.getSelection?.(); } catch { sel = null; }
    return sel && !sel.collapsed && selHas(probe) ? d.targetFromCw(sel) : { ...at, text: phrase, refs: [at.ref], endRef: at.ref };
  }
  const q = (sel, root = document) => { const el = root?.querySelector(sel); return el && visible(el) ? el : null; };
  const besideOrBelow = (el) => { const f = frameRect(); const r = el?.getBoundingClientRect?.(); return f && r && r.top >= f.y + f.h - 2 ? '아래' : '문서 옆'; };
  const saveButton = () => q('[data-testid="save-hangul"]') || q('[data-testid="more-save-hangul"]');
  // 휴대폰·태블릿은 마우스 대신 길게 누른 뒤 끌어 고른다(studio 터치 선택)
  const touch = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const dragHow = touch ? '길게 누른 뒤 끌어' : '마우스로 끌어';
  // 실행기는 모듈 내용을 모르며, 새 세션은 시작 시 저장한 구성을 실행합니다.
  // 이전 세션은 기존 숫자 단계와 평평한 ctx를 그대로 이어갑니다.
  const course = s.info?.tutorialSourceId || s.info?.tutorialId || 'report';
  const env = {
    d, s, docId, me, config, ctx, focusIn, frameRect, fdoc, cw, inFrame, rectOf, pad, q,
    locate, selectFor, phraseRect, toolbarBtn, toolbarShown, selHas, clipboard, touch, dragHow, besideOrBelow, saveButton,
    advance: () => go(i + 1), isCurrentStep: (title, moduleKey) => !stopped && (STEPS[i]?.originalTitle || STEPS[i]?.title) === title && (moduleKey == null || STEPS[i]?.moduleKey === moduleKey),
    stepIdentity: () => stopped ? null : STEPS[i],
    docEnv: () => docWorkEnv(s), motionReduced,
  };
  const STEPS = s.info?.tutorialModules
    ? buildComposedTutorialSteps({ sourceId: course, modules: s.info.tutorialModules, title: s.info.tutorialTitle || s.info.title, description: s.info.tutorialDescription }, env)
    : buildTutorialSteps(course, env);
  ({ index: i, resumeAfterIntro } = resolveTutorialPosition(STEPS, st, showIntro));
  motionStep = STEPS[i];
  const navigation = tutorialNavigation(i, Math.max(i, Math.min(STEPS.length - 1, ctx.tourHigh || 0)));
  const appliedReview = createAppliedReview(ctx, s.proposals || [], { once: true });   // AI 요청 하나 = 확인 한 번(2026-11-04)
  // 반영 뒤 본문 보여 주기(2026-11-04 사용자 요청): '본문 확인 완료'를 누르게 하지 않고, 반영을 감지하면 뒤에서 바뀐 본문으로 이동해
  // 잠깐 깜빡여 보여 준다. 그동안(약 2.5초) 자동 다음 단계를 늦춰 다음 단계가 화면을 곧바로 옮기지 않게 한다.
  const reviewReady = () => !!d.editor?.ready && !d.editor.loading && !s.busy
    && Number(d.editor.baseVersion || 0) >= Number(s.paraVersion || 0);
  const reviewRange = () => {
    const group = appliedReview.current; if (!group) return null;
    const table = /^(s\d+\/p\d+(?:\/n\d+)*)#t(\d+)$/.exec(group.key);
    if (table && (s.paragraphs || []).some(p => p.ref === table[1])) return { ref: table[1], object: 'table', objectIndex: Number(table[2]) };
    return group.proposals.map(p => appliedReviewRange(p, s.paragraphs)).find(Boolean) || null;
  };
  let showing = false; let showSince = 0; let holdUntil = 0; let stepShownAt = 0;
  // 변경 추적 표시(지운 자리·넣은 글)와 그 앞뒤 낱말까지 함께 비춘다 — 바뀐 글자만 비추면 무엇이 달라졌는지 읽기 어렵다
  const CONTEXT = 12;
  const withContext = (range) => {
    if (!range || range.object || range.start == null) return range;
    const chars = [...String((s.paragraphs || []).find(p => p.ref === range.ref)?.text || '')];
    if (!chars.length) return range;
    let start = Math.max(0, range.start - CONTEXT); let end = Math.min(chars.length, Math.max(range.end, range.start) + CONTEXT);
    while (start > 0 && !/\s/.test(chars[start - 1]) && range.start - start < CONTEXT * 2) start--;   // 낱말 중간에서 끊지 않는다
    while (end < chars.length && !/\s/.test(chars[end]) && end - range.end < CONTEXT * 2) end++;
    return { ...range, start, end };
  };
  function showApplied() {
    showing = true;
    const range = reviewReady() ? withContext(reviewRange()) : null;
    appliedReview.visit(); appliedReview.confirm(); saveTour(st);
    showSince = 0;
    if (!range) { showing = false; return; }
    holdUntil = performance.now() + 2500;
    try { d.closeWindow('composer'); } catch { /* 이미 닫힘 */ }
    // 문서 갱신 직후의 사라진 주소 등으로 동기 예외가 나도 안내의 RAF 루프가 끊기지 않게 한다.
    Promise.resolve().then(() => d.editor?.focusRange?.({ ...range, flash: true })).catch(() => null).finally(() => { showing = false; });
  }
  // reviewWait: [모두 반영]이 아직 진행 중이면 기다렸다가 끝난 뒤 한 번만 보여 준다
  const collectApplied = () => {
    if (!appliedReview.active && STEPS[i]?.reviewWait?.()) return false;
    if (!appliedReview.observe(s.proposals || [], STEPS[i]?.reviewApplied?.() || [], s.paragraphs || [])) { showSince = 0; return false; }
    if (!showSince) showSince = performance.now();
    // 편집기가 새 본문을 불러온 뒤 이동한다(6초가 지나도 안 되면 이동 없이 넘어간다)
    if (!showing && (reviewReady() || performance.now() - showSince > 6000)) showApplied();
    return appliedReview.active;
  };
  const displayStep = () => STEPS[i];
  const signature = step => `${i}|${typeof step.text === 'function' ? step.text() : step.text}|${step.action && (!step.action.show || step.action.show()) ? step.action.label : ''}|${actionError}|${navigation.reviewing}|${appliedReview.active}|${ctx.motionEnabled}|${motionReduced()}`;

  // ── 화면 ──
  const root = document.createElement('div'); root.className = 'tour'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-live', 'polite');
  const shades = ['t', 'b', 'l', 'r'].map((k) => { const e = document.createElement('div'); e.className = `tour-shade tour-shade-${k}`; root.append(e); return e; });
  const ring = document.createElement('div'); ring.className = 'tour-ring'; root.append(ring);
  const bubble = document.createElement('div'); bubble.className = 'tour-bubble'; root.append(bubble);
  document.body.append(root);
  const motion = createTutorialMotion(root, { reduced: motionReduced });
  // 덮개를 누르면 말풍선을 흔들어 '여기를 누르세요'를 알린다
  for (const e of shades) e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); bubble.classList.remove('nudge'); void bubble.offsetWidth; bubble.classList.add('nudge'); });

  function render(step) {
    exampleCleanup?.(); exampleCleanup = null;
    const stepKey = String(i);
    const changedStep = bubble.dataset.step !== stepKey;
    if (changedStep) stepShownAt = performance.now();
    root.dataset.mode = 'guide';
    root.setAttribute('aria-label', '튜토리얼 안내');
    const n = STEPS.length - 2; const num = Math.min(n, Math.max(0, i));
    const text = typeof step.text === 'function' ? step.text() : step.text;
    const act = step.action && (!step.action.show || step.action.show()) ? step.action : null;
    bubble.innerHTML = '';
    const head = document.createElement('div'); head.className = 'tour-head';
    head.innerHTML = `<b></b><span class="tour-count"></span>`;
    head.querySelector('b').textContent = step.title;
    head.querySelector('.tour-count').textContent = i === 0 || step.last ? '' : `${num}/${n}`;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tour-close'; close.textContent = '×'; close.title = '안내 닫고 자유롭게 편집'; close.setAttribute('aria-label', '안내 닫고 자유롭게 편집'); close.addEventListener('click', () => finish(false)); head.append(close);
    // 반영을 감지해 바뀐 본문을 불러오는 동안(showApplied 전)에는 단계 이동 단추를 잠근다 — 이때 누른 [다음]이 단계를 건너뛰게 하지 않는다
    const loadingApplied = appliedReview.active;
    const body = document.createElement('p'); body.className = 'tour-text'; body.textContent = loadingApplied ? '반영했습니다. 바뀐 본문을 불러오는 중입니다…' : text;
    if (step.wait && !step.idle?.()) { const sp = document.createElement('span'); sp.className = 'spin dark'; body.prepend(sp); }
    const row = document.createElement('div'); row.className = 'tour-row';
    // 첫 시작은 즉시 반응합니다. 이후 단계는 직전 버튼의 연속 클릭으로 두 단계를 넘기지 않게 잠깐 보호합니다.
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `small ${cls}`; b.textContent = label; b.addEventListener('click', (e) => { if (i !== 0 && performance.now() < Math.max(stepShownAt, holdUntil) + 400) return; fn(e); }); row.append(b); return b; };
    const previous = btn('이전 단계', 'tour-prev', () => go(i - 1, true)); previous.disabled = i === 0;
    {
      const locked = step.motionEnabled === false || systemMotionReduced();
      const toggle = btn(locked ? '효과 꺼짐' : motionReduced() ? '동작 예시 켜기' : '동작 예시 끄기', 'tour-motion-toggle', () => { ctx.motionEnabled = motionReduced(); saveTour(st); });
      toggle.setAttribute('aria-pressed', String(!motionReduced()));
      toggle.disabled = locked;
      toggle.title = step.motionEnabled === false ? '이 모듈 또는 단계의 효과가 구성에서 꺼져 있습니다' : systemMotionReduced() ? '기기의 동작 줄이기 설정을 따릅니다' : '화면 속 가상 커서·타이핑의 움직임을 켜거나 끕니다';
    }
    const sp = document.createElement('span'); sp.className = 'spacer'; row.append(sp);
    if (act && !navigation.reviewing) btn(act.label, 'tour-act', async () => {
      if (actionBusy) return;
      const actionStep = i;
      actionBusy = true; actionError = '';
      try { const to = await act.run(); if (!stopped && i === actionStep && typeof to === 'number') go(to); }
      catch (e) { if (!stopped && i === actionStep) actionError = e.message || '동작을 완료하지 못했습니다. 다시 눌러 주세요.'; }
      finally { actionBusy = false; }
    });
    // nextTo: 몇 단계를 건너뛰는 '다음'(휴대폰의 복사 실습 건너뛰기)
    const nextIndex = () => (!navigation.reviewing && Number.isInteger(step.nextIndex) ? Math.max(i + 1, step.nextIndex) : step.nextTo && !navigation.reviewing ? Math.max(i + 1, STEPS.findIndex((x) => x.title === step.nextTo)) : i + 1);
    if (step.next || navigation.reviewing) btn(navigation.reviewing && !step.last ? '다음 단계' : step.next, step.nextPlain && !navigation.reviewing ? 'tour-next' : 'primary tour-next',   // nextPlain: 건너뛰는 길이라 누를 단추(초록 테두리)보다 눈에 띄지 않게
      () => (step.last ? finish(true) : go(nextIndex())));
    else if (!step.center || step.until) btn('건너뛰기', 'tour-skip', () => go(i + 1)); // 가운데 안내라도 조건을 기다리면 막히지 않게
    if (step.last && onNext) btn('다음 튜토리얼로 가기', 'primary tour-next-course', () => finish(true, true));
    const content = document.createElement('div'); content.className = 'tour-content'; content.append(body);
    bubble.append(head, content);
    if (navigation.reviewing && !step.review) { const note = document.createElement('p'); note.className = 'tour-review-note'; note.textContent = '이전 단계의 안내를 다시 보는 중입니다.'; content.append(note); }
    bubble.classList.toggle('tour-with-example', !!step.example);
    if (step.example) { const cleanup = step.example(content); if (typeof cleanup === 'function') exampleCleanup = cleanup; }
    if (actionError) { const error = document.createElement('p'); error.className = 'tour-error'; error.setAttribute('role', 'alert'); error.textContent = actionError; content.append(error); }
    if (loadingApplied) for (const b of row.querySelectorAll('button')) b.disabled = true;
    bubble.append(row);
    if (changedStep) content.scrollTop = 0;
    bubble.dataset.step = stepKey;
    bubble.dataset.sig = signature(step);
    // 연결 안내의 읽기 전용 입력 예시도 같은 효과 설정과 취소 규칙을 사용한다.
    const fields = [...content.querySelectorAll('[data-tutorial-preview]')];
    for (const input of fields) input.value = motionReduced() ? input.dataset.tutorialPreview : '';
    (async () => {
      for (const input of fields) {
        if (!input.isConnected || stopped || STEPS[i] !== step) return;
        await typeTutorialInput({ input, text: input.dataset.tutorialPreview, reduced: motionReduced,
          current: () => !stopped && STEPS[i] === step && input.isConnected });
      }
    })().catch(() => {});
  }

  function place(step) {
    const W = innerWidth; const H = innerHeight;
    const viewport = { x: 0, y: 0, w: W, h: H };
    // 반영한 본문을 보여 주는 동안은 덮개·테두리를 걷어 본문이 그대로 보이게 한다
    const bodyShown = performance.now() < holdUntil;
    const open = step.center || bodyShown ? null : clippedRect(step.open?.(), viewport);
    const target = step.center || bodyShown ? null : clippedRect(step.ring?.(), viewport);
    const hole = open || target;
    // 덮개 4장: 구멍(hole) 밖만 덮는다(구멍 안은 실제 화면을 누를 수 있다)
    if (!hole) { Object.assign(shades[0].style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` }); for (const e of shades.slice(1)) e.style.width = '0px'; }
    else {
      const x1 = Math.max(0, hole.x); const y1 = Math.max(0, hole.y); const x2 = Math.min(W, hole.x + hole.w); const y2 = Math.min(H, hole.y + hole.h);
      Object.assign(shades[0].style, { left: '0px', top: '0px', width: `${W}px`, height: `${y1}px` });
      Object.assign(shades[1].style, { left: '0px', top: `${y2}px`, width: `${W}px`, height: `${Math.max(0, H - y2)}px` });
      Object.assign(shades[2].style, { left: '0px', top: `${y1}px`, width: `${x1}px`, height: `${Math.max(0, y2 - y1)}px` });
      Object.assign(shades[3].style, { left: `${x2}px`, top: `${y1}px`, width: `${Math.max(0, W - x2)}px`, height: `${Math.max(0, y2 - y1)}px` });
    }
    root.classList.toggle('tour-dim', !bodyShown && (!step.wait || !!hole));
    root.classList.toggle('tour-body-shown', bodyShown);   // 본문을 보여 주는 동안 말풍선이 바뀐 글을 가리지 않게 잠깐 숨긴다
    if (target) Object.assign(ring.style, { display: 'block', left: `${target.x}px`, top: `${target.y}px`, width: `${target.w}px`, height: `${target.h}px` });
    else ring.style.display = 'none';
    // press: 눌러야 할 단추(반영·보내기 등) — 금빛 대신 초록 테두리와 단추 이름표로 '여기를 누르세요'를 알린다(초점을 옮기지 않는다)
    // pressHidden: 누를 단추가 아니라 살펴볼 곳을 잠깐 가리킬 때(예: 요청 글을 치는 동안의 첨부 칸) 금빛 테두리만 둔다
    const press = target && !step.review && !navigation.reviewing && !step.pressHidden?.() ? (typeof step.press === 'function' ? step.press() : step.press) : null;
    ring.classList.toggle('tour-ring-press', !!press);
    if (press) { if (ring.dataset.label !== press) ring.dataset.label = press; } else if (ring.dataset.label) delete ring.dataset.label;
    const visual = window.visualViewport;
    const vp = { x: visual?.offsetLeft || 0, y: visual?.offsetTop || 0, w: visual?.width || W, h: visual?.height || H };
    // 가운데 안내(누를 곳 없음)는 화면 전체 높이를 쓴다 — 휴대폰에서 편집기 칸 안에만 갇혀 예시가 잘렸다
    const large = course === 'ai-connect' || !!step.example; const editor = step.center ? null : frameRect();
    // 내용 높이를 재고(최대 높이까지) 지금 누를 곳 — 작업 창처럼 작은 열린 자리면 그 창 전체 — 을 가리지 않는 자리에 둔다
    const limit = tutorialDock(vp, editor, large, { center: !!step.center });
    Object.assign(bubble.style, { width: `${Math.round(limit.w)}px`, maxHeight: `${Math.round(limit.max)}px`, height: 'auto' });
    const avoid = open && open.w * open.h < W * H * 0.6 ? open : target;
    const dock = tutorialDock(vp, editor, large, { height: bubble.offsetHeight, avoid, target, center: !!step.center });
    Object.assign(bubble.style, { left: `${Math.round(dock.x)}px`, top: `${Math.round(dock.y)}px` });
    // 모든 코스의 입력·선택·클릭 위치를 같은 가상 커서로 보여 준다.
    const example = bubble.querySelector('.tour-example-target');
    const exampleRect = example && clippedRect(rectOf(example), rectOf(bubble.querySelector('.tour-content')));
    const typing = q('[data-tutorial-typing="true"]') || (s.composer?.tutorialTyping ? q('.composer-win .cmp-instr') : null);
    const frameTyping = fdoc()?.querySelector('[data-tutorial-typing="true"]');
    const typingRect = typing ? clippedRect(rectOf(typing), viewport) : frameTyping ? inFrame(frameTyping) : null;
    motion.update(bodyShown || navigation.reviewing || motionReduced() ? null : tutorialMotionSpec(step, { target, exampleRect, typingRect }), performance.now(), i);
  }

  function go(k, previous = false) {
    if (collectApplied()) return; // 자동 조건·건너뛰기·늦게 끝난 클릭도 확인 창을 넘지 못한다.
    enterCleanup?.(); enterCleanup = null;
    const cur = STEPS[i];
    try { cur?.leave?.(); } catch (e) { console.warn('[체험]', e); }
    if (i === 0 && k === 1 && resumeAfterIntro != null) { k = resumeAfterIntro; resumeAfterIntro = null; }
    i = Math.max(0, Math.min(STEPS.length - 1, k)); clicked = false; actionError = '';
    motionStep = STEPS[i];
    navigation.move(i, previous); ctx.tourHigh = navigation.high;
    st.i = i; ctx.currentStepId = STEPS[i]?.id || null; saveTour(st);
  }
  let finishing = false;
  async function finish(done, nextCourse = false) {
    if (finishing) return;
    if (done && collectApplied()) return;
    finishing = true;
    if (done) {
      const buttons = [...bubble.querySelectorAll('button')];
      buttons.forEach(b => { b.disabled = true; });
      try { if (!await onComplete()) return; }
      finally { finishing = false; buttons.forEach(b => { b.disabled = false; }); }
    }
    stopped = true; root.remove();
    detach();
    if (!done) { collectApplied(); appliedReview.pause(); ctx.guidePaused = true; saveTour(st); }
    if (done) clearTour(docId); else saveTour(null);
    onEnd({ done, step: i });
    if (done && nextCourse && onNext) await onNext();
  }

  // 누를 곳(click)을 누르면 다음으로 — 편집기 iframe 안 단추도(그 문서의 click 을 잡는다). 단추 자기 동작이 먼저 끝나게 조금 뒤에 넘긴다
  const onClick = (ev) => {
    if (appliedReview.active) return;
    const step = STEPS[i]; if (navigation.reviewing || !step?.click) return;
    const el = step.click();
    // 편집기 iframe 안 요소는 바깥 창의 Node 가 아니다(instanceof 가 늘 거짓이라 편집기 단추 누름을 놓쳤다) — nodeType 으로 본다
    if (el && ev.target?.nodeType && el.contains(ev.target)) { clicked = true; if (!step.until || step.advanceOnClick) setTimeout(() => { if (!stopped && STEPS[i] === step) go(i + 1); }, 400); }
  };
  const onReviewKey = event => {
    if (!appliedReview.active || event.key !== 'Tab') return;
    const buttons = [...bubble.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const at = buttons.indexOf(document.activeElement);
    buttons[at < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  };
  let frameDocRef = null;
  const onClipboard = event => {
    if (!event.isTrusted || !event.defaultPrevented || !event.clipboardData) return;
    const text = event.clipboardData.getData('text/plain'); const html = event.clipboardData.getData('text/html');
    if (!text && !html) return;
    Object.assign(clipboard, { seq: clipboard.seq + 1, type: event.type, text, html, tables: (html.match(/<table\b/gi) || []).length, images: (html.match(/<img\b/gi) || []).length });
  };
  function attachFrame() {
    const fd = fdoc();
    if (fd && fd !== frameDocRef) {
      detachFrame(); frameDocRef = fd;
      fd.addEventListener('click', onClick, true); fd.addEventListener('copy', onClipboard); fd.addEventListener('cut', onClipboard); fd.addEventListener('keydown', onReviewKey, true);
    }
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onReviewKey, true);
  function detachFrame() { try { frameDocRef?.removeEventListener('click', onClick, true); frameDocRef?.removeEventListener('copy', onClipboard); frameDocRef?.removeEventListener('cut', onClipboard); frameDocRef?.removeEventListener('keydown', onReviewKey, true); } catch { /* 없음 */ } }
  function detach() { enterCleanup?.(); enterCleanup = null; exampleCleanup?.(); exampleCleanup = null; motion.destroy(); document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onReviewKey, true); detachFrame(); }

  // 누를 곳이 화면 밖(휴대폰의 아래 작업 창 목록 끝 등)이면 보이게 굴린다 — 사용자가 굴리는 것과 다투지 않게 0.8초에 한 번
  let revealAt = 0;
  function revealTarget(step, t) {
    if (!step.reveal || navigation.reviewing || t - revealAt < 800) return;
    revealAt = t;
    let el = null; try { el = step.reveal(); } catch { el = null; }
    if (!el?.isConnected) return;
    // 편집기(iframe) 안 도구 단추는 그 문서 창 기준 — 오른쪽 끝의 접힌 도구 묶음 화살표(») 아래에 있으면 가려진 것으로 본다
    const win = el.ownerDocument?.defaultView || window; const edge = win === window ? 0 : 36;
    const r = el.getBoundingClientRect(); const vh = (win === window && window.visualViewport?.height) || win.innerHeight;
    if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > win.innerWidth - edge) el.scrollIntoView({ block: 'nearest', inline: edge ? 'center' : 'nearest' });
  }

  let lastTick = 0;
  function frameLoop(t) {
    if (stopped) return;
    attachFrame();
    collectApplied();
    const step = displayStep();
    if (!step.review && entered !== i) { entered = i; try { const cleanup = step.enter?.(); if (typeof cleanup === 'function') enterCleanup = cleanup; } catch (e) { console.warn('[체험]', e); } }
    if (t - lastTick > 200) {
      lastTick = t;
      saveTour(st); // 요청 번호·메모 번호처럼 단계 안에서 바뀐 문맥도 서버에 보관한다.
      try {
        if (!navigation.reviewing && t >= holdUntil && step.until && step.until()) { go(i + 1); requestAnimationFrame(frameLoop); return; }
        const back = !step.review && !navigation.reviewing && step.lost?.(); if (typeof back === 'number' && back !== i) { go(back); requestAnimationFrame(frameLoop); return; }
      } catch (e) { console.warn('[체험]', e); }
      const text = typeof step.text === 'function' ? step.text() : step.text;
      const act = step.action && (!step.action.show || step.action.show()) ? step.action : null;
      if (bubble.dataset.sig !== signature(step)) render(step);
      revealTarget(step, t);
    }
    place(step);
    requestAnimationFrame(frameLoop);
  }
  collectApplied();
  render(displayStep());
  place(displayStep());
  requestAnimationFrame(frameLoop);
  saveTour(st);
  // 완료한 연습은 진행을 다시 저장하지 않는다(save: false — 완료 뒤 409 응답을 남기지 않게)
  return { stop({ save = true } = {}) { if (!stopped) { if (save) saveTour(st); stopped = true; root.remove(); detach(); } }, go: (k) => go(k), get step() { return i; } };
}
