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
export function runTour({ d, docId, host = document, topBar, me, config = {}, showIntro = false, onComplete = async () => true, onRestore = async () => {}, onReload = () => location.reload(), onNext = null, onEnd = () => {} }) {
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
  // 2026-11-18 사용자 요청: 잘못 눌러 연습 대상이 사라지면 저절로 다시 불러오지 않고 '다시 해 볼까요?' 화면에서
  // [다시 하기] 한 번으로 그 단계 직전 상태로 돌아간다(게임의 재시작처럼). lostTarget = 돌아갈 단계 번호.
  let lostTarget = null; let confirmRestart = false; let entryMark = null;
  // 단계 준비(enter)가 실패하면 그 단계 단추가 잠긴 채 남지 않게 '다시 해 볼까요?' 화면으로 보낸다(2026-11-18 검증 지적)
  let entryFailed = false;
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
  const q = (sel, root = [host, topBar]) => {
    for (const area of Array.isArray(root) ? root : [root]) {
      if (area?.matches?.(sel) && visible(area)) return area;
      const element = Array.from(area?.querySelectorAll(sel) || []).find(visible);
      if (element) return element;
    }
    return null;
  };
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
  // 예시 글이 이미 그 칸에 들어 있으면(준비 동작이 채웠거나 [대신 예시 작성하기]를 눌렀으면) 예시와 단추를 다시 보이지 않는다
  const norm = value => String(value ?? '').trim();
  function exampleFilled(text) {
    const want = norm(text); if (!want) return false;
    if (norm(s.composer?.instruction) === want || norm(s.popover?.text) === want) return true;
    for (const input of host.querySelectorAll('.memoedit textarea, .composer-win textarea')) if (norm(input.value) === want) return true;
    return false;
  }
  // 준비 동작이 예시를 한 글자씩 치는 동안에는 같은 글을 카드에 또 보이지 않는다
  const exampleOf = step => { const act = actionOf(step); return act?.exampleText != null && entryReady && !s.composer?.tutorialTyping && !exampleFilled(act.exampleText) ? act : null; };
  // 단계에 들어온 때의 문서 상태 — [다시 하기]에서 문서를 바꾸지 않았으면 창·대상만 다시 열고, 바꿨으면 저장 지점으로 되돌린다
  const docMark = () => JSON.stringify([s.info?.version ?? null, (s.memos || []).map(m => m.id), (s.requests || []).map(r => r.rid), (s.proposals || []).map(p => `${p.pid}:${p.status}`)]);
  const docChanged = () => entryMark == null || docMark() !== entryMark || !!(s.draft?.dirty || s.draft?.saving || d.editor?.dirty);
  const modeOf = () => exitChoice ? 'pause' : recoveryBusy ? 'busy' : progressChanged ? 'conflict'
    : !navigation.reviewing && (stepCrashed || entryFailed || lostTarget != null) ? 'retry' : 'guide';
  const signature = step => JSON.stringify([
    i, timeline.ticket(), stepCrashed ? null : typeof step.text === 'function' ? step.text() : step.text, stepCrashed ? null : actionOf(step)?.label,
    stepCrashed ? null : !!exampleOf(step), modeOf(), lostTarget, confirmRestart, entryFailed, !!progress.failure(docId),
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

  // ── 안내 카드(2026-11-18 정리): 진행 막대 · 제목 · 글 · (예시 한 줄) · 단추 한 줄 ──
  // 단추는 한 줄에만 둔다: 왼쪽 [‹ 이전] [↻ 다시 하기], 오른쪽 이 단계의 동작과 [다음]. 효과 끄기·처음부터 다시·닫기는 ✕ 의 '잠시 멈춤' 안으로.
  // 모드: guide(보통) · retry(대상이 사라짐·화면 오류 — 다시 하기 한 단추) · pause(✕) · busy(되돌리는 중) · conflict(다른 창이 진행을 바꿈)
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const motionLocked = step => step.motionEnabled === false || systemMotionReduced();
  const serverRestore = () => !!s.info?.tutorialSession && !s.info?.tutorialCompletedAt && Number.isInteger(st.revision);
  const canRestartAll = () => serverRestore() && !leaveResolve && !!tutorialRecoveryPoint(0, 0, checkpointAt);
  // [다시 하기]는 사용자가 직접 무엇을 해야 넘어가는 단계(until·click)에만 — 소개·알림·보기만 하는 단계·AI 처리를 기다리는 동안·마지막에는 두지 않는다
  const retryable = step => i > 0 && !step.last && !step.center && !(step.wait && !step.idle?.()) && !!(step.until || step.click);

  function render(step) {
    exampleCleanup?.(); exampleCleanup = null;
    const stepKey = String(i);
    const changedStep = bubble.dataset.step !== stepKey;
    const renderedTicket = timeline.ticket();
    if (changedStep) stepShownAt = performance.now();
    const mode = modeOf();
    root.dataset.mode = mode;
    root.setAttribute('aria-label', '튜토리얼 안내');
    bubble.innerHTML = '';
    bubble.dataset.mode = mode;
    bubble.classList.toggle('tour-with-example', mode === 'guide' && !!step.example);
    // 반영을 감지해 바뀐 본문을 불러오는 동안(showApplied 전)에는 단계 이동 단추를 잠근다 — 이때 누른 [다음]이 단계를 건너뛰게 하지 않는다
    const loadingApplied = appliedReview.active;
    const locked = loadingApplied || actionBusy || recoveryBusy || !entryReady || finishing;
    const total = STEPS.length - 2; const num = Math.min(total, Math.max(0, i));

    const bar = make('div', 'tour-progress'); bar.setAttribute('aria-hidden', 'true');
    const fill = make('span'); fill.style.width = `${Math.round(Math.min(1, Math.max(0, i / Math.max(1, STEPS.length - 1))) * 100)}%`; bar.append(fill);
    const head = make('div', 'tour-head');
    const headTitle = { pause: '잠시 멈춤', busy: '다시 준비하는 중', conflict: '다른 창에서 진행했습니다', retry: stepCrashed || (entryFailed && lostTarget == null) ? '화면을 다시 준비할게요' : '다시 해 볼까요?' }[mode] || step.title;
    head.append(make('b', null, headTitle));
    if (mode === 'guide' && i > 0 && !step.last && total > 0) head.append(make('span', 'tour-count', `${num} / ${total}`));
    const close = make('button', 'tour-close', '×'); close.type = 'button';
    const closeLabel = mode === 'pause' ? '안내 계속하기' : '잠시 멈춤 — 처음부터 다시·효과 끄기·안내 닫기';
    close.title = closeLabel; close.setAttribute('aria-label', closeLabel);
    close.addEventListener('click', () => {
      if (!timeline.current(renderedTicket) || recoveryBusy || actionBusy || finishing) return;
      if (exitChoice) { exitChoice = false; confirmRestart = false; leaveResolve?.(false); leaveResolve = null; } else exitChoice = true;
    });
    close.disabled = recoveryBusy || actionBusy || finishing;
    head.append(close);

    const content = make('div', 'tour-content');
    const foot = make('div', 'tour-foot');
    const spacer = make('span', 'spacer');
    // 첫 시작은 즉시 반응합니다. 이후 단계는 직전 버튼의 연속 클릭으로 두 단계를 넘기지 않게 잠깐 보호합니다.
    const btn = (parent, label, cls, fn, { guard = true } = {}) => {
      const b = make('button', `small ${cls}`, label); b.type = 'button';
      b.addEventListener('click', e => {
        if (!timeline.current(renderedTicket) || (guard && i !== 0 && performance.now() < stepShownAt + 400)) return;
        fn(e);
      });
      parent.append(b); return b;
    };
    const say = (cls, text, role = null) => { if (!text) return null; const p = make('p', cls, text); if (role) p.setAttribute('role', role); content.append(p); return p; };

    if (mode === 'pause') {
      if (confirmRestart) {
        say('tour-text', '연습 문서를 처음 상태로 되돌리고 첫 단계부터 다시 시작합니다. 지금까지 연습한 내용은 이 연습 문서에서 사라집니다.');
        btn(foot, '취소', 'tour-quiet', () => { confirmRestart = false; }, { guard: false });
        foot.append(spacer);
        btn(foot, '처음부터 다시 시작', 'primary tour-restart-confirm', () => restartAll(), { guard: false });
      } else {
        say('tour-text', leaveResolve ? '이 문서를 나가도 지금 단계까지의 진행은 보관됩니다.' : '지금 단계까지의 진행은 보관됩니다. 언제든 이어서 할 수 있어요.');
        say('tour-note', recoveryNote, 'status');
        const menu = make('div', 'tour-menu'); content.append(menu);
        btn(menu, '안내 계속하기', 'primary tour-continue', () => { exitChoice = false; leaveResolve?.(false); leaveResolve = null; }, { guard: false });
        if (progressChanged) btn(menu, '저장된 진행 다시 열기', 'tour-reload', reloadProgress, { guard: false });
        else if (canRestartAll()) btn(menu, '↻ 처음부터 다시', 'tour-restart', () => { confirmRestart = true; }, { guard: false });
        if (!motionLocked(step)) {
          const toggle = btn(menu, motionReduced() ? '동작 예시 켜기' : '동작 예시 끄기', 'tour-motion-toggle', () => { ctx.motionEnabled = motionReduced(); saveCurrent(); }, { guard: false });
          toggle.setAttribute('aria-pressed', String(!motionReduced()));
          toggle.title = '화면 속 가상 커서·타이핑의 움직임을 켜거나 끕니다';
        }
        btn(menu, leaveResolve ? '진행 보관하고 나가기' : '안내 닫기', 'tour-pause', async () => {
          if (await finish(false)) { leaveResolve?.(true); leaveResolve = null; }
        }, { guard: false });
        for (const b of menu.querySelectorAll('button')) b.disabled = recoveryBusy || actionBusy || finishing;
      }
    } else if (mode === 'busy') {
      const p = say('tour-text', recoveryNote || '준비 상태를 불러오는 중입니다…', 'status');
      p.prepend(make('span', 'spin dark'));
    } else if (mode === 'conflict') {
      say('tour-text', recoveryNote || '다른 창에서 이 연습의 진행을 바꿨습니다. 저장된 진행을 다시 열어 이어가세요.', 'status');
      foot.append(spacer);
      btn(foot, '저장된 진행 다시 열기', 'primary tour-reload', reloadProgress, { guard: false });
    } else if (mode === 'retry') {
      const why = stepCrashed
        ? '이 단계 화면을 그리다 문제가 생겼습니다.'
        : entryFailed && lostTarget == null ? '이 단계를 준비하다 멈췄습니다.'
        : step.lostText || '다른 단추를 눌러 연습할 글·창·제안이 사라졌어요. 걱정하지 마세요.';
      say('tour-text', `${why}\n[다시 하기]를 누르면 이 단계 직전 상태로 되돌려 다시 할 수 있습니다.`);
      say('tour-note', recoveryNote, 'status');
      if (actionError) say('tour-error', actionError, 'alert');
      foot.append(spacer);
      const act = stepCrashed ? null : actionOf(step);
      if (act && act.exampleText == null) btn(foot, act.label, 'tour-act', () => runAction(act.run)).disabled = actionBusy || recoveryBusy || finishing;
      btn(foot, '↻ 다시 하기', 'primary tour-retry', () => retry(), { guard: false }).disabled = recoveryBusy || actionBusy || finishing;
    } else {
      const text = loadingApplied ? '반영했습니다. 바뀐 본문을 불러오는 중입니다…' : typeof step.text === 'function' ? step.text() : step.text;
      const body = say('tour-text', text || '');
      if (step.wait && !step.idle?.()) body.prepend(make('span', 'spin dark'));
      const act = navigation.reviewing ? null : actionOf(step);
      // 예시 글은 안내 글 아래 한 줄로, 채우는 단추는 다른 단추와 같은 줄에 둔다(2026-11-18 — 금빛 상자를 따로 두지 않는다)
      const sample = !navigation.reviewing ? exampleOf(step) : null;
      if (sample) {
        const line = make('div', 'tour-sample'); line.append(make('span', 'tour-sample-label', '예시'), make('span', 'tour-sample-text', sample.exampleText));
        content.append(line);
      }
      if (navigation.reviewing && !step.review) say('tour-note', '앞 단계 안내를 다시 보는 중입니다.');
      if (step.example) { const cleanup = step.example(content); if (typeof cleanup === 'function') exampleCleanup = cleanup; }
      if (actionError) say('tour-error', actionError, 'alert');
      say('tour-note', recoveryNote, 'status');

      if (i > 0) btn(foot, '‹ 이전', 'tour-quiet tour-prev', () => go(i - 1, true));
      if (navigation.reviewing) btn(foot, '진행하던 단계로', 'tour-quiet tour-return', () => go(navigation.high));
      else if (retryable(step) || progress.failure(docId)) {
        const again = btn(foot, '↻ 다시 하기', 'tour-quiet tour-retry', () => retry());
        again.title = '이 단계를 처음 상태로 되돌려 다시 합니다';
      }
      foot.append(spacer);
      if (act && (act.exampleText == null || sample)) btn(foot, act.label, 'tour-act', () => runAction(act.run));
      // nextTo: 몇 단계를 건너뛰는 '다음'(휴대폰의 복사 실습 건너뛰기)
      const branchIndex = step.nextIndex ?? (step.nextTo ? STEPS.findIndex(x => x.title === step.nextTo) : null);
      const nextCourse = step.last && onNext && !navigation.reviewing;
      if (step.next || navigation.reviewing) btn(foot, navigation.reviewing && !step.last ? '다음 ›' : step.next,
        // nextPlain: 건너뛰는 길이라 누를 단추(초록 테두리)보다 눈에 띄지 않게. 마지막에 다음 튜토리얼이 있으면 그쪽이 주 단추
        (step.nextPlain && !navigation.reviewing) || nextCourse ? 'tour-next' : 'primary tour-next',
        () => (step.last ? finish(true) : go(!navigation.reviewing && branchIndex > i ? branchIndex : i + 1, false, { branch: branchIndex > i })));
      if (nextCourse) btn(foot, '다음 튜토리얼로 가기', 'primary tour-next-course', () => finish(true, true));
      if (locked) for (const b of foot.querySelectorAll('button')) b.disabled = true;
    }
    bubble.append(bar, head, content);
    if (foot.childElementCount) bubble.append(foot);
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
    // 잠시 멈춤·다시 하기·준비 중에는 누를 곳을 가리키지 않고 카드를 화면 가운데에 둔다
    const guide = modeOf() === 'guide'; const centered = !!step.center || !guide;
    const open = centered || bodyShown ? null : clippedRect(step.open?.(), viewport);
    const target = centered || bodyShown ? null : clippedRect(step.ring?.(), viewport);
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
    const large = guide && (course === 'ai-connect' || !!step.example); const editor = centered ? null : frameRect();
    // 내용 높이를 재고(최대 높이까지) 지금 누를 곳 — 작업 창처럼 작은 열린 자리면 그 창 전체 — 을 가리지 않는 자리에 둔다
    // 넓은 화면(PC)에서는 안내 카드를 요청·메모 창 안에 넣지 않고 그 창을 피한 자리에 띄운다 — 창 위에 안내·예시 상자가 겹겹이 쌓여 복잡했다(2026-11-18).
    // 좁은 화면(휴대폰)은 떠 있는 창이 화면을 거의 덮으므로 같은 안내 요소를 그 창 맨 위에 얇게 넣는다(복제하지 않는다).
    const host = vp.w <= 900 ? q('.composer-win') || q('.popover') || q('.quickreply') : null;
    const container = host?.querySelector('.fw-body') || host || root;
    if (bubble.parentElement !== container) container.prepend(bubble);
    bubble.classList.toggle('tour-inline', container !== root);
    if (container === root) {
      const limit = tutorialDock(vp, editor, large, { center: centered });
      Object.assign(bubble.style, { width: `${Math.round(limit.w)}px`, maxHeight: `${Math.round(limit.max)}px`, height: 'auto' });
      const avoid = open && open.w * open.h < W * H * 0.6 ? open : target;
      const dock = tutorialDock(vp, editor, large, { height: bubble.offsetHeight, avoid, target, center: centered });
      Object.assign(bubble.style, { left: `${Math.round(dock.x)}px`, top: `${Math.round(dock.y)}px` });
    } else bubble.removeAttribute('style');
    // 모든 코스의 입력·선택·클릭 위치를 같은 가상 커서로 보여 준다.
    const example = bubble.querySelector('.tour-example-target');
    const exampleRect = example && clippedRect(rectOf(example), rectOf(bubble.querySelector('.tour-content')));
    const typing = q('[data-tutorial-typing="true"]') || (s.composer?.tutorialTyping ? q('.composer-win .cmp-instr') : null);
    const frameTyping = fdoc()?.querySelector('[data-tutorial-typing="true"]');
    const typingRect = typing ? clippedRect(rectOf(typing), viewport) : frameTyping ? inFrame(frameTyping) : null;
    motion.update(bodyShown || !guide || navigation.reviewing || motionReduced() ? null : tutorialMotionSpec(step, { target, exampleRect, typingRect }), performance.now(), i);
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
    lostTarget = null; confirmRestart = false; entryMark = null; stepCrashed = false; crashRetried = false; entryFailed = false;
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
  // 문서는 그대로 두고 이 단계에 필요한 창·대상·입력만 다시 연다(문서를 바꾸지 않았을 때의 [다시 하기])
  function returnToStep() {
    if (stopped || recoveryBusy || actionBusy || entryPending || finishing) return;
    if (s.busy) { nudge('진행 중인 작업이 끝난 뒤 [다시 하기]를 눌러 주세요.'); return; }
    timeline.renew(); recoveryWatch.reset(); enterCleanup?.(); enterCleanup = null;
    closeFrameWindows();
    phraseCache.clear();
    if (viewSnapshot) restoreTutorialView(viewSnapshot, s, kind => d.closeWindow(kind));
    else for (const kind of ['composer', 'popover', 'reply']) d.closeWindow(kind);
    entered = -1; entryReady = false; clickedAt = 0; actionError = '';
    stepCrashed = false; lostTarget = null; entryFailed = false;
    recoveryNote = '';
  }
  // [↻ 다시 하기] 하나로 이 단계를 처음 상태로: 대상이 사라졌으면 그 준비 단계의 저장 지점으로, 문서를 바꿨으면 이 단계의 저장 지점으로,
  // 아무것도 바꾸지 않았으면(창만 닫았으면) 창·대상만 다시 연다 — 새로 불러오지 않아 빠르다
  let crashRetried = false;
  async function retry() {
    if (stopped || recoveryBusy || actionBusy || finishing) return;
    if (stepCrashed) {
      if (!crashRetried || !serverRestore() || !tutorialRecoveryPoint(i, i, checkpointAt)) { crashRetried = true; returnToStep(); return; }
      return restartStep(i);
    }
    if (entryFailed && lostTarget == null) { returnToStep(); return; }
    let back = lostTarget;
    if (back == null) { try { const value = STEPS[i].lost?.(); if (Number.isInteger(value)) back = value; } catch { back = null; } }
    if (back != null && !serverRestore()) { recoveryNote = '이 문서에서는 연습 상태를 되돌릴 수 없습니다. 튜토리얼 메뉴에서 새로 시작해 주세요.'; return; }
    if (back != null) return restartStep(back, { automatic: lostTarget != null });
    if (!docChanged()) { returnToStep(); return; }
    if (serverRestore() && tutorialRecoveryPoint(i, i, checkpointAt)) return restartStep(i);
    returnToStep();
  }
  async function restartAll() {
    confirmRestart = false;
    if (!canRestartAll()) { recoveryNote = '처음 상태를 찾지 못했습니다. 튜토리얼 메뉴에서 새로 시작해 주세요.'; return; }
    exitChoice = false;
    await restartStep(0);
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
    if (s.draft?.saving || s.busy) { nudge('진행 중인 작업이 끝난 뒤 [다시 하기]를 눌러 주세요.'); return; }
    const target = targetIndex ?? st.i;
    const skipTried = automatic && entryNeedsRecovery;
    if (!skipTried) recoveryHistory.clear();
    const recovered = tutorialRecoveryPoint(target, i, checkpointAt, skipTried ? recoveryHistory.attempted : undefined);
    const checkpoint = recovered?.point;
    if (!checkpoint) { nudge('이 단계에서 사용할 수 있는 복구 지점을 찾지 못했습니다.'); return; }
    // 임시 연습만 복구하며, 서버가 복구 전 문서와 기록을 별도 사본으로 보관합니다.
    recoveryNote = recovered.index === 0 ? '처음 상태를 불러오는 중입니다…' : `‘${STEPS[recovered.index].title}’ 직전 상태로 되돌리는 중입니다…`;
    recoveryBusy = true;
    if (!automatic) recoveryWatch.reset();
    try {
      // 이미 저장 중인 작업은 위에서 기다리게 합니다. 저장에 실패한 현재 편집도 복구할 수 있어야 합니다.
      await progress.flush(docId, { strict: true });
      if (automatic && (STEPS[i].until?.() || STEPS[i].lost?.() !== target)) { recoveryNote = ''; lostTarget = null; return; }
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
        recoveryNote = `${e.message || '되돌리지 못했습니다.'} [다시 하기]를 한 번 더 눌러 주세요.`;
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
    if (exitChoice) { exitChoice = false; confirmRestart = false; leaveResolve?.(false); leaveResolve = null; }
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
        entryNeedsRecovery = true; entered = i; entryReady = true; entryMark = docMark(); return;
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
      viewSnapshot = tutorialViewSnapshot(s); entryReady = true; entered = i; entryMark = docMark();
      if (s.info?.tutorialSession && !s.info?.tutorialCompletedAt) ctx.tourView = { i, view: tutorialStoredView(s) };
    } catch (e) {
      if (timeline.current(ticket)) { entered = i; if (!progressConflict(e)) { entryFailed = true; recoveryNote = `이 단계를 준비하지 못했습니다: ${e.message || '연결 상태를 확인해 주세요.'}`; } }
    } finally { if (timeline.current(ticket)) entryPending = false; }
  }
  function updateFrame(t) {
    if (stopped) return;
    if (stepCrashed) {
      const recovery = { title: STEPS[i]?.title || '튜토리얼', center: true };
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
        else nudge('진행을 보관하지 못했습니다. [다시 하기]를 눌러 다시 시도할 수 있습니다.');
      }
      const complete = () => step.until ? step.until() : step.click && clickedAt && t - clickedAt >= 400;
      if (canInteract() && !navigation.reviewing && complete()) { go(i + 1); return; }
      // 연습 대상이 사라졌으면(잠깐의 갱신이 아니라 0.8초 넘게, 작업 중이 아닐 때) '다시 해 볼까요?'로 바꾼다.
      // 예전처럼 저절로 되돌려 새로 불러오지 않는다 — 사용자가 [다시 하기]로 고른다(2026-11-18)
      const back = entryReady && !exitChoice && !recoveryBusy && !step.review && !navigation.reviewing ? step.lost?.() : null;
      const busy = actionBusy || finishing || entryPending || appliedReview.active || t < holdUntil || s.busy || s.draft?.dirty || s.draft?.saving || d.editor?.dirty || d.editor?.loading || s.sending;
      if (!Number.isInteger(back)) { if (!recoveryBusy) lostTarget = null; recoveryWatch.poll({ step: i, target: null, now: t }); }
      else if (recoveryWatch.poll({ step: i, target: back, version: s.info?.version, busy, now: t })) lostTarget = back;
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
