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
import { createTutorialTimeline, createTutorialRecoveryWatch, createTutorialRecoveryHistory, tutorialRecoveryPoint, tutorialViewSnapshot, tutorialStoredView, restoreTutorialView } from './tutorial-recovery.js';
import { tutorialStepKey } from './tutorial-step-id.js';
import { observeTutorialInput } from './tutorial-interaction.js';

const progress = createTutorialProgress({ request: api, token: () => state.token, onError: e => toastError(e, '안내 진행을 서버에 저장하지 못했습니다: ') });
export const tourState = progress.state;
export const saveTour = progress.save;
export const clearTour = progress.clear;
export const loadTour = progress.load;
export const flushTour = progress.flush;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
const pad = (r, n = 6) => (r ? { x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n } : null);
const visible = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };

/**
 * 따라 하기 시작 → { stop() }.
 * @param o { d(문서 store), docId, me, onEnd(끝·그만 — 저장 상태는 여기서 정리) }
 */
export function runTour({ d, docId, me, config = {}, showIntro = false, onComplete = async () => true, onRestore = async () => {}, onReload = () => location.reload(), onNext = null, onEnd = () => {} }) {
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
  let stopped = false; let i = Math.max(0, Number(st.i) || 0); let entered = -1; let clickedAt = 0; let actionBusy = false; let actionError = '';
  let enterCleanup = null;
  let exampleCleanup = null;
  let resumeAfterIntro = null;
  const timeline = createTutorialTimeline();
  const recoveryWatch = createTutorialRecoveryWatch();
  let recoveryStorage; try { recoveryStorage = window.sessionStorage; } catch { /* 저장소 사용 불가 */ }
  const recoveryHistory = createTutorialRecoveryHistory(recoveryStorage, docId);
  let viewSnapshot = null; let reviewView = null; let recoveryNote = ''; let recoveryBusy = false; let exitChoice = false; let leaveResolve = null;
  let entryPending = false; let entryReady = false; let finishing = false;
  let entryNeedsRecovery = false;
  const saveCurrent = () => { if (!entryNeedsRecovery) saveTour(st); };
  let progressChanged = false; let restoreOperation = null; let stepCrashed = false;
  // 저장된 창은 안내를 다시 열 때 한 번만 복원합니다. 정상 단계 이동에서 창을
  // 복제하면 Composer가 잡은 모델과 store가 갈라져 보내기·반영을 감지하지 못합니다.
  let restoreSavedView = true;
  function activate(control) {
    if (!control?.isConnected || control.disabled) throw new Error('실행할 버튼이 아직 준비되지 않았습니다.');
    control.click();
  }

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
  /** 요청 준비 단계에서 예시 문장의 범위를 찾습니다. */
  async function selectFor(phrase) {
    const ticket = timeline.ticket();
    const at = locate(phrase); if (!at) return null;
    focusIn(d, at, { select: true, quiet: true });
    // 앞 네 글자만 보면 앞 단계의 선택('재수강 …')이 남아 있어도 새로 고른 것으로 여겨, 앞 작업의 문단을 요청 대상으로 열었다(2026-11-12)
    const probe = phrase.slice(0, 12);
    for (let k = 0; k < 20 && !selHas(probe); k++) await sleep(100);
    let sel = null; try { sel = await d.editor?.getSelection?.(); } catch { sel = null; }
    if (!timeline.current(ticket)) return null;
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
    locate, selectFor, activate, phraseRect, toolbarBtn, toolbarShown, selHas, clipboard, touch, dragHow, besideOrBelow, saveButton,
    advance: () => go(i + 1), isCurrentStep: (title, moduleKey) => !stopped && (STEPS[i]?.originalTitle || STEPS[i]?.title) === title && (moduleKey == null || STEPS[i]?.moduleKey === moduleKey),
    stepIdentity: () => stopped ? null : timeline.ticket(),
    docEnv: () => docWorkEnv(s), motionReduced,
  };
  const STEPS = s.info?.tutorialModules
    ? buildComposedTutorialSteps({ sourceId: course, modules: s.info.tutorialModules, title: s.info.tutorialTitle || s.info.title, description: s.info.tutorialDescription }, env)
    : buildTutorialSteps(course, env);
  ({ index: i, resumeAfterIntro } = resolveTutorialPosition(STEPS, st, showIntro));
  const resumeIndex = resumeAfterIntro ?? i;
  if (ctx.tourView?.i === st.i && ctx.currentStepId && tutorialStepKey(ctx.currentStepId) === tutorialStepKey(STEPS[resumeIndex]?.id)) ctx.tourView.i = resumeIndex;
  const checkpointAt = index => {
    const key = tutorialStepKey(STEPS[index]?.id);
    return st.checkpoints?.find(point => key && point.stepId === key)
      || st.checkpoints?.find(point => point.i === index && (point.stepId === undefined || !key && point.stepId === null));
  };
  motionStep = STEPS[i];
  const navigation = tutorialNavigation(i, resumeIndex);
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
    appliedReview.visit(); appliedReview.confirm(); saveCurrent();
    showSince = 0;
    if (!range) { showing = false; return; }
    holdUntil = performance.now() + 2500;
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
  const actionOf = step => step.action && (!step.action.show || step.action.show()) ? step.action : null;
  const signature = step => JSON.stringify([
    i, timeline.ticket(), typeof step.text === 'function' ? step.text() : step.text, actionOf(step)?.label,
    st.checkpointId, progressChanged, actionError, navigation.reviewing, appliedReview.active, ctx.motionEnabled, motionReduced(),
    recoveryNote, exitChoice, !!leaveResolve, recoveryBusy, entryReady, actionBusy, finishing,
  ]);

  const canInteract = () => !stopped && entryReady && !progressChanged && !actionBusy && !recoveryBusy && !exitChoice && !finishing && !s.busy && !appliedReview.active && performance.now() >= holdUntil;
  async function runAction(run) {
    if (!canInteract() || navigation.reviewing) return;
    const step = STEPS[i];
    const ticket = timeline.ticket();
    actionBusy = true; actionError = ''; recoveryNote = '';
    let target;
    try {
      target = await run();
    } catch (e) {
      if (timeline.current(ticket)) actionError = e.message || '동작을 완료하지 못했습니다. 다시 눌러 주세요.';
    } finally {
      if (timeline.current(ticket)) actionBusy = false;
    }
    if (!timeline.current(ticket) || actionError) return;
    if (typeof target === 'number' && !step.until) go(target);
  }

  // ── 화면 ──
  const root = document.createElement('div'); root.className = 'tour';
  const ring = document.createElement('div'); ring.className = 'tour-ring'; root.append(ring);
  const bubble = document.createElement('div'); bubble.className = 'tour-bubble'; bubble.setAttribute('role', 'region'); bubble.setAttribute('aria-label', '튜토리얼 안내'); bubble.setAttribute('aria-live', 'polite'); root.append(bubble);
  document.body.append(root);
  const motion = createTutorialMotion(root, { reduced: motionReduced });
  function nudge(note) {
    if (recoveryNote === note) return;
    recoveryNote = note;
  }

  function render(step) {
    exampleCleanup?.(); exampleCleanup = null;
    const stepKey = String(i);
    const changedStep = bubble.dataset.step !== stepKey;
    const renderedTicket = timeline.ticket();
    if (changedStep) stepShownAt = performance.now();
    root.dataset.mode = 'guide';
    root.setAttribute('aria-label', '튜토리얼 안내');
    const n = STEPS.length - 2; const num = Math.min(n, Math.max(0, i));
    const text = typeof step.text === 'function' ? step.text() : step.text;
    const act = actionOf(step);
    bubble.innerHTML = '';
    const head = document.createElement('div'); head.className = 'tour-head';
    head.innerHTML = `<b></b><span class="tour-count"></span>`;
    head.querySelector('b').textContent = step.title;
    head.querySelector('.tour-count').textContent = i === 0 || step.last ? '' : `${num}/${n}`;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tour-close'; close.textContent = '×'; close.title = '안내 중단 선택'; close.setAttribute('aria-label', '안내 중단 선택'); close.addEventListener('click', () => { if (timeline.current(renderedTicket) && !recoveryBusy && !actionBusy && !finishing) exitChoice = true; }); head.append(close);
    // 반영을 감지해 바뀐 본문을 불러오는 동안(showApplied 전)에는 단계 이동 단추를 잠근다 — 이때 누른 [다음]이 단계를 건너뛰게 하지 않는다
    const loadingApplied = appliedReview.active;
    const body = document.createElement('p'); body.className = 'tour-text'; body.textContent = loadingApplied ? '반영했습니다. 바뀐 본문을 불러오는 중입니다…' : text;
    if (step.wait && !step.idle?.()) { const sp = document.createElement('span'); sp.className = 'spin dark'; body.prepend(sp); }
    const row = document.createElement('div'); row.className = 'tour-row';
    // 첫 시작은 즉시 반응합니다. 이후 단계는 직전 버튼의 연속 클릭으로 두 단계를 넘기지 않게 잠깐 보호합니다.
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `small ${cls}`; b.textContent = label; b.addEventListener('click', (e) => { if (!timeline.current(renderedTicket) || (i !== 0 && performance.now() < stepShownAt + 400)) return; fn(e); }); row.append(b); return b; };
    const previous = btn('이전 단계', 'tour-prev', () => go(i - 1, true)); previous.disabled = i === 0;
    {
      const locked = step.motionEnabled === false || systemMotionReduced();
      const toggle = btn(locked ? '효과 꺼짐' : motionReduced() ? '동작 예시 켜기' : '동작 예시 끄기', 'tour-motion-toggle', () => { ctx.motionEnabled = motionReduced(); saveCurrent(); });
      toggle.setAttribute('aria-pressed', String(!motionReduced()));
      toggle.disabled = locked;
      toggle.title = step.motionEnabled === false ? '이 모듈 또는 단계의 효과가 구성에서 꺼져 있습니다' : systemMotionReduced() ? '기기의 동작 줄이기 설정을 따릅니다' : '화면 속 가상 커서·타이핑의 움직임을 켜거나 끕니다';
    }
    const sp = document.createElement('span'); sp.className = 'spacer'; row.append(sp);
    let inputExample = null;
    if (act && !navigation.reviewing) {
      const actionButton = btn(act.label, 'tour-act', () => runAction(act.run));
      if (act.exampleText != null) {
        inputExample = document.createElement('div'); inputExample.className = 'tour-input-example';
        const label = document.createElement('b'); label.textContent = '예시 문장';
        const sample = document.createElement('p'); sample.textContent = act.exampleText;
        actionButton.classList.add('tour-example-fill');
        inputExample.append(label, sample, actionButton);
      }
    }
    // nextTo: 몇 단계를 건너뛰는 '다음'(휴대폰의 복사 실습 건너뛰기)
    const branchIndex = step.nextIndex ?? (step.nextTo ? STEPS.findIndex(x => x.title === step.nextTo) : null);
    if (step.next || navigation.reviewing) btn(navigation.reviewing && !step.last ? '다음 단계' : step.next, step.nextPlain && !navigation.reviewing ? 'tour-next' : 'primary tour-next',   // nextPlain: 건너뛰는 길이라 누를 단추(초록 테두리)보다 눈에 띄지 않게
      () => (step.last ? finish(true) : go(!navigation.reviewing && branchIndex > i ? branchIndex : i + 1, false, { branch: branchIndex > i })));
    if (step.last && onNext && !navigation.reviewing) btn('다음 튜토리얼로 가기', 'primary tour-next-course', () => finish(true, true));
    const content = document.createElement('div'); content.className = 'tour-content'; content.append(body);
    if (inputExample) content.append(inputExample);
    bubble.append(head, content);
    if (navigation.reviewing && !step.review) { const note = document.createElement('p'); note.className = 'tour-review-note'; note.textContent = '이전 단계의 안내를 다시 보는 중입니다.'; content.append(note); }
    bubble.classList.toggle('tour-with-example', !!step.example);
    if (step.example) { const cleanup = step.example(content); if (typeof cleanup === 'function') exampleCleanup = cleanup; }
    if (actionError) { const error = document.createElement('p'); error.className = 'tour-error'; error.setAttribute('role', 'alert'); error.textContent = actionError; content.append(error); }
    if (loadingApplied || actionBusy || recoveryBusy || !entryReady || finishing || exitChoice) {
      for (const b of [...row.querySelectorAll('button'), ...(inputExample?.querySelectorAll('button') || [])]) b.disabled = true;
    }
    bubble.append(row);
    const recovery = document.createElement('div'); recovery.className = 'tour-recovery';
    const recoveryButton = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = `small ${cls}`; b.textContent = label; b.addEventListener('click', () => { if (timeline.current(renderedTicket)) fn(); }); recovery.append(b); return b; };
    if (exitChoice) {
      const note = document.createElement('p'); note.textContent = leaveResolve ? '문서를 나가도 현재 단계와 복구 지점은 보관됩니다.' : '잠시 중단해도 현재 단계와 복구 지점은 보관됩니다.'; recovery.append(note);
      if (recoveryNote) { const error = document.createElement('p'); error.setAttribute('role', 'status'); error.textContent = recoveryNote; recovery.append(error); }
      recoveryButton('안내 계속하기', 'primary tour-continue', () => { exitChoice = false; leaveResolve?.(false); leaveResolve = null; });
      if (progressChanged) recoveryButton('저장된 진행 다시 열기', 'tour-reload', reloadProgress);
      recoveryButton(leaveResolve ? '진행 보관하고 나가기' : '잠시 중단하기', 'tour-pause', async () => {
        if (await finish(false)) { leaveResolve?.(true); leaveResolve = null; }
      });
    } else {
      if (recoveryNote) { const note = document.createElement('p'); note.setAttribute('role', 'status'); note.textContent = recoveryNote; recovery.append(note); }
      if (progressChanged) recoveryButton('저장된 진행 다시 열기', 'primary tour-reload', reloadProgress);
      else if (navigation.reviewing) recoveryButton('진행하던 단계로 돌아가기', 'tour-return', () => go(navigation.high));
      else recoveryButton('현재 단계로 돌아가기', 'tour-return', returnToStep);
      if (!progressChanged && s.info?.tutorialSession && !s.info?.tutorialCompletedAt && Number.isInteger(st.revision)) {
        if (tutorialRecoveryPoint(i, i, checkpointAt)) recoveryButton(recoveryBusy ? '복구 중…' : '이 단계 다시하기', 'tour-retry', () => restartStep(i));
      }
    }
    close.disabled = recoveryBusy || actionBusy || finishing;
    for (const b of recovery.querySelectorAll('button')) b.disabled = recoveryBusy || actionBusy || finishing;
    bubble.append(recovery);
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
    // 반영한 본문을 보여 주는 동안은 테두리를 걷어 본문이 그대로 보이게 한다
    const bodyShown = performance.now() < holdUntil;
    const open = step.center || bodyShown ? null : clippedRect(step.open?.(), viewport);
    const target = exitChoice || step.center || bodyShown ? null : clippedRect(step.ring?.(), viewport);
    root.classList.toggle('tour-body-shown', bodyShown);   // 본문을 보여 주는 동안 말풍선이 바뀐 글을 가리지 않게 잠깐 숨긴다
    if (target) Object.assign(ring.style, { display: 'block', left: `${target.x}px`, top: `${target.y}px`, width: `${target.w}px`, height: `${target.h}px` });
    else ring.style.display = 'none';
    // press: 눌러야 할 단추(반영·보내기 등) — 금빛 대신 초록 테두리와 단추 이름표로 '여기를 누르세요'를 알린다(초점을 옮기지 않는다)
    // pressHidden: 누를 단추가 아니라 살펴볼 곳을 잠깐 가리킬 때(예: 요청 글을 치는 동안의 첨부 칸) 금빛 테두리만 둔다
    const press = target && entryReady && !step.review && !navigation.reviewing && !step.pressHidden?.() ? (typeof step.press === 'function' ? step.press() : step.press) : null;
    ring.classList.toggle('tour-ring-press', !!press);
    if (press) { if (ring.dataset.label !== press) ring.dataset.label = press; } else if (ring.dataset.label) delete ring.dataset.label;
    const visual = window.visualViewport;
    const vp = { x: visual?.offsetLeft || 0, y: visual?.offsetTop || 0, w: visual?.width || W, h: visual?.height || H };
    // 가운데 안내(누를 곳 없음)는 화면 전체 높이를 쓴다 — 휴대폰에서 편집기 칸 안에만 갇혀 예시가 잘렸다
    const large = course === 'ai-connect' || !!step.example; const editor = step.center ? null : frameRect();
    // 내용 높이를 재고(최대 높이까지) 지금 누를 곳 — 작업 창처럼 작은 열린 자리면 그 창 전체 — 을 가리지 않는 자리에 둔다
    // 요청·메모 창이 열리면 같은 안내 요소를 그 창에 넣습니다. 복제된 안내창은 만들지 않습니다.
    const host = q('.composer-win') || q('.popover') || q('.quickreply') || q('.rcard .memoedit');
    const container = host?.querySelector('.fw-body') || host || root;
    if (bubble.parentElement !== container) container.prepend(bubble);
    bubble.classList.toggle('tour-inline', container !== root);
    if (container === root) {
      const limit = tutorialDock(vp, editor, large, { center: !!step.center });
      Object.assign(bubble.style, { width: `${Math.round(limit.w)}px`, maxHeight: `${Math.round(limit.max)}px`, height: 'auto' });
      const avoid = open && open.w * open.h < W * H * 0.6 ? open : target;
      const dock = tutorialDock(vp, editor, large, { height: bubble.offsetHeight, avoid, target, center: !!step.center });
      Object.assign(bubble.style, { left: `${Math.round(dock.x)}px`, top: `${Math.round(dock.y)}px` });
    } else bubble.removeAttribute('style');
    // 모든 코스의 입력·선택·클릭 위치를 같은 가상 커서로 보여 준다.
    const example = bubble.querySelector('.tour-example-target');
    const exampleRect = example && clippedRect(rectOf(example), rectOf(bubble.querySelector('.tour-content')));
    const typing = q('[data-tutorial-typing="true"]') || (s.composer?.tutorialTyping ? q('.composer-win .cmp-instr') : null);
    const frameTyping = fdoc()?.querySelector('[data-tutorial-typing="true"]');
    const typingRect = typing ? clippedRect(rectOf(typing), viewport) : frameTyping ? inFrame(frameTyping) : null;
    motion.update(bodyShown || navigation.reviewing || motionReduced() ? null : tutorialMotionSpec(step, { target, exampleRect, typingRect }), performance.now(), i);
  }

  function go(k, previous = false, { branch = false } = {}) {
    if (stopped || !canInteract()) return;
    const cur = STEPS[i];
    if (!previous && !navigation.reviewing && !branch) {
      if (cur.until && !cur.until()) return;
      if (!cur.next && !cur.until && cur.click && !clickedAt) return;
    }
    if (!navigation.reviewing && collectApplied()) return; // 자동 조건·건너뛰기·늦게 끝난 클릭도 확인 창을 넘지 못한다.
    recoveryWatch.reset();
    const wasReviewing = navigation.reviewing;
    if (previous && !wasReviewing) reviewView = tutorialViewSnapshot(s);
    timeline.renew();
    enterCleanup?.(); enterCleanup = null;
    if (!navigation.reviewing && (!previous || cur.closeOnBack)) try { cur?.leave?.(); } catch (e) { console.warn('[체험]', e); }
    if (i === 0 && k === 1 && resumeAfterIntro != null) { k = resumeAfterIntro; resumeAfterIntro = null; }
    i = Math.max(0, Math.min(STEPS.length - 1, k)); clickedAt = 0; actionError = ''; recoveryNote = ''; entryReady = false; entryNeedsRecovery = false; entered = -1; viewSnapshot = null;
    motionStep = STEPS[i];
    navigation.move(i, previous); ctx.tourHigh = navigation.high;
    if (wasReviewing && !navigation.reviewing && reviewView) {
      viewSnapshot = reviewView; reviewView = null;
      restoreTutorialView(viewSnapshot, s, kind => d.closeWindow(kind));
      if (s.info?.tutorialSession) ctx.tourView = { i, view: tutorialStoredView(s) };
    }
    if (!navigation.reviewing) {
      recoveryHistory.advance(i);
      st.i = i; ctx.currentStepId = STEPS[i]?.id || null;
      if (ctx.tourView?.i !== i && s.info?.tutorialSession && !s.info?.tutorialCompletedAt) ctx.tourView = { i, view: tutorialStoredView(s) };
      // 첫 PUT는 enterStep이 필요한 창 정보를 준비한 뒤 보냅니다.
    }
  }
  function closeFrameWindows() {
    const fd = fdoc();
    for (const box of fd?.querySelectorAll('.dialog-overlay, [role="dialog"], .modal-overlay') || []) {
      const close = box.querySelector('.dialog-close, [aria-label="닫기"]') || [...box.querySelectorAll('button')].find(b => /^(취소|닫기|Cancel)$/.test(b.textContent.trim()));
      if (close && !close.disabled) activate(close);
    }
  }
  function returnToStep() {
    if (stopped || recoveryBusy || actionBusy || entryPending || finishing || s.busy) return;
    timeline.renew(); recoveryWatch.reset(); enterCleanup?.(); enterCleanup = null;
    closeFrameWindows();
    phraseCache.clear();
    if (viewSnapshot) restoreTutorialView(viewSnapshot, s, kind => d.closeWindow(kind));
    else for (const kind of ['composer', 'popover', 'reply']) d.closeWindow(kind);
    entered = -1; entryReady = false; clickedAt = 0; actionError = '';
    stepCrashed = false;
    recoveryNote = '현재 단계로 돌아왔습니다. 문서 내용도 되돌리려면 [이 단계 다시하기]를 선택하세요.';
  }
  function progressConflict(error) {
    if (error.code !== 'TUTORIAL_PROGRESS_CHANGED') return false;
    progressChanged = true;
    entryReady = false;
    recoveryNote = '다른 창에서 진행을 바꿨습니다. [저장된 진행 다시 열기]를 눌러 이어가세요.';
    return true;
  }
  function reloadProgress() { stop(false); onReload(); }
  async function restartStep(targetIndex = null, { automatic = false } = {}) {
    if (stopped || recoveryBusy || actionBusy || entryPending || finishing || !s.info?.tutorialSession || s.info?.tutorialCompletedAt) return;
    // 서버 복구는 임시 연습 문서에만 사용하며 실행 중인 저장과 겹치지 않습니다.
    if (s.draft?.saving || s.busy) { nudge('진행 중인 작업이 끝난 뒤 [이 단계 다시하기]를 눌러 주세요.'); return; }
    const target = targetIndex ?? st.i;
    if (!automatic) recoveryHistory.clear();
    const recovered = tutorialRecoveryPoint(target, i, checkpointAt, automatic ? recoveryHistory.attempted : undefined);
    const checkpoint = recovered?.point;
    if (!checkpoint) { nudge('이 단계에서 사용할 수 있는 복구 지점을 찾지 못했습니다.'); return; }
    // 임시 연습만 복구하며, 서버가 복구 전 문서와 기록을 별도 사본으로 보관합니다.
    recoveryNote = `‘${STEPS[recovered.index].title}’ 준비 상태를 불러오는 중입니다…`;
    recoveryBusy = true;
    if (!automatic) recoveryWatch.reset();
    try {
      // 이미 저장 중인 작업은 위에서 기다리게 합니다. 저장에 실패한 현재 편집도 복구할 수 있어야 합니다.
      await progress.flush(docId, { strict: true });
      if (automatic && (STEPS[i].until?.() || STEPS[i].lost?.() !== target)) return;
      timeline.renew(); enterCleanup?.(); enterCleanup = null;
      if (automatic) recoveryHistory.mark(checkpoint.checkpointId, i);
      if (restoreOperation?.checkpointId !== checkpoint.checkpointId || restoreOperation.revision !== st.revision) {
        const operationId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        restoreOperation = { checkpointId: checkpoint.checkpointId, i: checkpoint.i, revision: st.revision, operationId };
      }
      const value = await api(`/api/tutorial/${docId}/restore`, { method: 'POST', body: restoreOperation, signal: AbortSignal.timeout(30000) });
      if (stopped) return;
      progress.adopt(value); stopped = true; timeline.stop(); root.remove(); detach();
      await onRestore(value);
    } catch (e) {
      if (!progressConflict(e)) {
        if (e.status) restoreOperation = null;
        recoveryNote = `${e.message || '복구하지 못했습니다.'} [이 단계 다시하기]로 다시 시도할 수 있습니다.`;
      }
    } finally { recoveryBusy = false; }
  }
  async function finish(done, nextCourse = false) {
    if (finishing || recoveryBusy || actionBusy || (done && (!canInteract() || navigation.reviewing || !STEPS[i]?.last || collectApplied()))) return;
    finishing = true;
    if (done) {
      const buttons = [...bubble.querySelectorAll('button')];
      buttons.forEach(b => { b.disabled = true; });
      try { if (!await onComplete()) return; }
      finally { finishing = false; buttons.forEach(b => { b.disabled = false; }); }
    } else {
      collectApplied(); appliedReview.pause(); ctx.guidePaused = true;
      try { if (!progressChanged) { saveCurrent(); await progress.flush(docId, { strict: true }); } }
      catch (e) { ctx.guidePaused = false; if (!progressConflict(e)) recoveryNote = `진행을 보관하지 못했습니다. ${e.message || '다시 시도해 주세요.'}`; return false; }
      finally { finishing = false; }
    }
    stopped = true; timeline.stop(); root.remove();
    detach();
    if (done) clearTour(docId); else saveTour(null);
    onEnd({ done, step: i });
    if (done && nextCourse && onNext) await onNext();
    return true;
  }

  // 완료 조건이 없는 직접 클릭 단계에서만 클릭 자체를 완료로 사용합니다.
  const onClick = (ev) => {
    if (stopped || recoveryBusy) return;
    const step = STEPS[i]; if (navigation.reviewing || !step?.click || step.until) return;
    const el = step.click();
    // 편집기 iframe 안 요소는 바깥 창의 Node 가 아니다(instanceof 가 늘 거짓이라 편집기 단추 누름을 놓쳤다) — nodeType 으로 본다
    if (el && ev.target?.nodeType && el.contains(ev.target)) clickedAt = performance.now();
  };
  const onGuideKey = event => {
    if (event.key !== 'Escape' || !bubble.contains(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    if (recoveryBusy || actionBusy || finishing) return;
    if (exitChoice) { exitChoice = false; leaveResolve?.(false); leaveResolve = null; }
    else exitChoice = true;
  };
  bubble.addEventListener('keydown', onGuideKey);
  let frameDocRef = null; let offFrame = null;
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
      offFrame = observeTutorialInput(fd, { onClick, onClipboard });
    }
  }
  const offDocument = observeTutorialInput(document, { onClick });
  function detachFrame() {
    offFrame?.(); offFrame = null;
    frameDocRef = null;
  }
  function detach() {
    enterCleanup?.(); enterCleanup = null; exampleCleanup?.(); exampleCleanup = null;
    motion.destroy(); bubble.remove(); offDocument(); detachFrame();
  }

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
  async function enterStep(step) {
    const ticket = timeline.ticket(); entryPending = true;
    try {
      if (navigation.reviewing) { entered = i; entryReady = true; return; }
      if (i === 0 && resumeAfterIntro != null) { entered = i; entryReady = true; return; }
      st.i = i; ctx.currentStepId = step.id || null;
      // 자유 조작으로 준비 상태가 이미 사라졌다면 그 상태를 복구 기준으로 저장하지 않습니다.
      if (!step.until?.() && Number.isInteger(step.lost?.())) {
        entryNeedsRecovery = true; entered = i; entryReady = true; return;
      }
      entryNeedsRecovery = false;
      if (s.info?.tutorialSession && !s.info?.tutorialCompletedAt) {
        if (restoreSavedView && !viewSnapshot && ctx.tourView?.i === i && ctx.tourView.view) {
          viewSnapshot = ctx.tourView.view;
          restoreTutorialView(viewSnapshot, s, kind => d.closeWindow(kind));
        }
        ctx.tourView = { i, view: tutorialStoredView(s) };
      }
      restoreSavedView = false;
      progress.save(st, { force: true }); await progress.flush(docId, { strict: true });
      if (!timeline.current(ticket)) return;
      viewSnapshot ||= tutorialViewSnapshot(s);
      // 이미 끝난 행동은 준비 동작을 다시 실행하지 않습니다(선택·창·기준 목록 보존).
      const cleanup = step.until?.() ? null : await step.enter?.();
      if (!timeline.current(ticket)) { if (typeof cleanup === 'function') cleanup(); return; }
      if (typeof cleanup === 'function') enterCleanup = cleanup;
      viewSnapshot = tutorialViewSnapshot(s); entryReady = true; entered = i;
      if (s.info?.tutorialSession && !s.info?.tutorialCompletedAt) ctx.tourView = { i, view: tutorialStoredView(s) };
    } catch (e) {
      if (timeline.current(ticket)) { entered = i; if (!progressConflict(e)) recoveryNote = `이 단계를 준비하지 못했습니다: ${e.message || '연결 상태를 확인해 주세요.'} [현재 단계로 돌아가기]로 다시 시도하거나 잠시 중단할 수 있습니다.`; }
    } finally { if (timeline.current(ticket)) entryPending = false; }
  }
  function updateFrame(t) {
    if (stopped) return;
    if (stepCrashed) {
      const recovery = { title: STEPS[i].title, text: '이 단계 화면에서 오류가 발생했습니다. 복구 지점에서 다시 시작할 수 있습니다.', center: true };
      if (bubble.dataset.sig !== signature(recovery)) render(recovery);
      place(recovery);
      return;
    }
    attachFrame();
    if (!exitChoice && !recoveryBusy && !actionBusy && entryReady && !navigation.reviewing) collectApplied();
    const step = displayStep();
    if (entered !== i && !entryPending && !exitChoice && !recoveryBusy) enterStep(step);
    if (t - lastTick > 200) {
      lastTick = t;
      const writeError = progress.failure(docId);
      if (writeError && !progressChanged) progressConflict(writeError);
      if (viewSnapshot && entryReady && !navigation.reviewing && !exitChoice && !recoveryBusy) {
        const currentView = tutorialViewSnapshot(s);
        for (const kind of ['composer', 'popover', 'reply']) {
          if (viewSnapshot.windows[kind] && s[kind]?.key === viewSnapshot.windows[kind].key) viewSnapshot.windows[kind] = currentView.windows[kind];
        }
        // 문서를 다시 열 때 필요한 창만 같은 단계의 문맥에 둡니다. 서버의 최초 checkpoint는 그대로입니다.
        const view = tutorialStoredView({ ...s, ...viewSnapshot.windows, tab: viewSnapshot.tab, active: viewSnapshot.active, activeRid: viewSnapshot.activeRid });
        ctx.tourView = { i, view };
      }
      if (entryNeedsRecovery && !Number.isInteger(step.lost?.())) {
        entryNeedsRecovery = false; entered = -1; entryReady = false; return;
      }
      if (entryReady && !entryNeedsRecovery && !navigation.reviewing && !recoveryBusy && resumeAfterIntro == null) {
        if (!writeError) saveCurrent();
        else nudge('진행을 보관하지 못했습니다. [현재 단계로 돌아가기]를 눌러 다시 시도할 수 있습니다.');
      }
      const complete = () => step.until ? step.until() : step.click && clickedAt && t - clickedAt >= 400;
      if (canInteract() && !navigation.reviewing && complete()) { go(i + 1); return; }
      const back = entryReady && !exitChoice && !step.review && !navigation.reviewing && step.lost?.();
      const busy = !canInteract() || entryPending || s.draft?.dirty || s.draft?.saving || d.editor?.dirty || d.editor?.loading || s.sending;
      if (recoveryWatch.poll({ step: i, target: back, version: s.info?.version, busy, now: t })) {
        restartStep(back, { automatic: true });
      }
      if (bubble.dataset.sig !== signature(step)) render(step);
      revealTarget(step, t);
    }
    place(step);
  }
  function frameLoop(t) {
    try { updateFrame(t); }
    catch (e) {
      if (!stepCrashed) console.warn('[체험] 단계 표시 오류', e);
      stepCrashed = true; entryReady = false;
    } finally { if (!stopped) requestAnimationFrame(frameLoop); }
  }
  requestAnimationFrame(frameLoop);
  // 첫 저장은 enterStep에서 창 문맥을 채운 뒤 실행합니다.
  // 완료한 연습은 진행을 다시 저장하지 않는다(save: false — 완료 뒤 409 응답을 남기지 않게)
  function stop(save) {
    if (stopped) return;
    if (save && !progressChanged) saveCurrent();
    stopped = true; timeline.stop(); root.remove(); detach(); leaveResolve?.(false); leaveResolve = null;
  }
  return {
    stop({ save = true } = {}) { stop(save); },
    requestLeave() { if (stopped) return Promise.resolve(true); exitChoice = true; return new Promise(resolve => { leaveResolve = resolve; }); },
    go: (k) => go(k), get step() { return i; },
  };
}
