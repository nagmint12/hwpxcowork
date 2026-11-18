// 결과보고서 실습의 내용과 동작. 숫자 이동은 이 모듈 내부 단계 좌표입니다.
import { tutorialWaitText } from '../request-wait.js';
import { openTutorialMemoReply, typeInTutorialComposer, typeInTutorialField, tutorialExampleAction } from './common.js';
import { proposalControl } from '../tutorial-targets.js';
const P1 = '일정 부분 기여한 것으로 보인다';
const P2 = '학생 만족도';
const INSTR1 = '‘보인다’ 말고, 적절한 표현으로';
const MEMO = '근거로 [표 1]을 함께 제시해 주세요.';
const REPLY = '이 메모대로 문장을 고쳐 줘';
const TOC = '차례 새로고침해줘';

export function buildReportFlow(env) {
  const { d, s, ctx, dragHow, phraseRect, frameRect, locate, focusIn, selHas, toolbarShown, pad, inFrame, toolbarBtn, rectOf, q, besideOrBelow, saveButton } = env;
  // 기준 목록은 행동 전에 잡습니다. 안내보다 먼저 만든 요청·메모도 놓치지 않습니다.
  ctx.firstRequests ??= (s.requests || []).map(r => r.rid);
  ctx.memoIds0 ??= (s.memos || []).map(m => m.id);
  ctx.reqs0 ??= (s.requests || []).map(r => r.rid);
  ctx.reqs1 ??= (s.requests || []).map(r => r.rid);
  const rememberToc = () => {
    const p = (s.paragraphs || []).find(x => /제목 차례|차례 새로 고침/.test(String(x.text || '')));
    if (p && ctx.tocOriginal == null) { ctx.tocRef = p.ref; ctx.tocOriginal = p.text; ctx.tocText = [...String(p.text || '')].slice(0, 7).join(''); }
  };
  rememberToc();
  ctx.reportTargets ||= {};
  for (const phrase of [P1, P2]) { const at = locate(phrase); if (at) ctx.reportTargets[phrase] = at; }
  const remembered = phrase => locate(phrase) || ctx.reportTargets[phrase];
  const composerEl = () => q('.composer-win');
  const reqOf = (rid) => (rid != null ? d.request?.(rid) : null);
  const propsOf = (rid) => (s.proposals || []).filter((p) => p.rid === rid);
  const pendingOf = (rid) => propsOf(rid).filter((p) => p.status === 'pending');
  const current = ticket => !env.stepIdentity || env.stepIdentity() === ticket;
  // 요청·메모를 실제 처리할 때는 연습 문구를 사용합니다. 드래그 완료 여부는
  // 더 넓은 선택이나 검토 도구 막대만 나타난 경우도 인정합니다.
  const exactTarget = (target, phrase) => { const at = remembered(phrase); return !!at && !!target && target.ref === at.ref
    && (!target.endRef || target.endRef === at.ref) && target.start === at.start && target.end === at.end && target.text === phrase; };
  // 선택뿐 아니라 이미 열린 창과 저장된 결과도 진행 근거입니다.
  const selected = phrase => toolbarShown() || selHas(phrase);
  const memoFor = (m, phrase) => { const at = remembered(phrase); return !!at && m.ref === at.ref && (!m.endRef || m.endRef === at.ref) && m.start <= at.start && m.end >= at.end; };
  const freshMemo = () => (s.memos || []).find(m => !(ctx.memoIds0 || []).includes(m.id) && !m.link && memoFor(m, P2));
  const firstLive = (root) => root && q('.rs-live, .rs-adopt, .rs-apply, .rc-live, .rc-adopt, .rc-apply', root);
  /** rid 제안의 레일 카드 [반영] 단추 */
  function railApply(rid) {
    if (rid == null) return null;
    for (const p of pendingOf(rid)) {
      const b = proposalControl(document, p.pid, 'apply', rid); if (b) return b;
    }
    return null;
  }
  const composerApply = rid => s.composer?.rid === rid && rid != null ? firstLive(composerEl()) : null;
  const memoCard = (mid) => mid != null ? q(`.rcard[data-kind="memo"][data-id="${mid}"]`) : null;
  // 휴대폰처럼 편집기 아래에 작업 창이 붙은 화면에서는 메모·제안 카드가 '문서 옆'이 아니라 '아래'에 있다
  const replyBox = () => (memoCard(ctx.memoId) && q('.memoedit', memoCard(ctx.memoId)) ? memoCard(ctx.memoId) : s.reply?.memoId === ctx.memoId && ctx.memoId != null ? q('.quickreply') : null);
  const replyInput = () => { const box = replyBox(); return box && q('.memoedit textarea', box); };
  const replyTarget = () => { const ta = replyInput(); return ta && String(ta.value || '').trim() ? q('.me-ask', replyBox()) : ta; };
  const examples = () => s.info?.tutorialOwnAi === true;
  const targetFor = phrase => { const at = locate(phrase); if (!at) throw new Error('연습 문장을 찾지 못했습니다. [다시 하기]를 눌러 주세요.'); return { ...at, endRef: at.ref, text: phrase, refs: [at.ref] }; };
  const newFirst = () => (s.requests || []).find(r => !(ctx.firstRequests || []).includes(r.rid) && (exactTarget(r.target, P1) || String(r.target?.text || '').includes(P1)));
  const firstRid = () => ctx.rid1 ?? (exactTarget(s.composer?.target, P1) ? s.composer?.rid : null) ?? newFirst()?.rid;
  const firstSent = () => firstRid() != null && !!reqOf(firstRid());
  const firstOpen = () => s.composer?.kind === 'instruct' && !!s.composer.target?.ref;
  const memoOpen = () => s.popover?.kind === 'memo' && !!s.popover.target?.ref;
  const followUp = () => (s.requests || []).find(r => !(ctx.reqs0 || []).includes(r.rid) && ctx.memoId != null && r.followUp?.memoId === ctx.memoId);
  const terminal = rid => ['failed', 'cancelled', 'done'].includes(reqOf(rid)?.status);
  const retryable = rid => terminal(rid) && !pendingOf(rid).length;
  const tocTarget = () => {
    const matches = (s.paragraphs || []).filter(p => ctx.tocOriginal != null && p.text === ctx.tocOriginal);
    if (matches.length !== 1) throw new Error('차례 문단을 찾지 못했습니다. [다시 하기]로 복구해 주세요.');
    const p = matches[0]; ctx.tocRef = p.ref;
    return { ref: p.ref, start: 0, end: [...p.text].length, endRef: p.ref, refs: [p.ref], text: p.text };
  };
  const tocDone = () => propsOf(ctx.rid3).some(p => p.type === 'toc' && p.status === 'applied');
  const tocRequest = () => reqOf(ctx.rid3) || (s.requests || []).find(x => !(ctx.reqs1 || []).includes(x.rid) && ctx.tocRef && x.target?.ref === ctx.tocRef && /차례/.test(x.instruction || ''));
  const waitLine = (r) => (r?.status === 'failed' ? `AI 처리에 실패했습니다: ${r.error || ''}`
    // 실제 AI 가 의견만 남기고 제안을 만들지 않은 경우 — 계속 '찾는 중'으로 보이던 문제
    : r?.status === 'cancelled' ? '요청이 취소되었습니다. [다시 요청]을 눌러 주세요.'
    : r?.status === 'done' ? 'AI 작업은 끝났지만 제안이 없습니다. [다시 하기]로 요청부터 다시 할 수 있습니다.'
    : tutorialWaitText(r, env.docEnv?.() || {}));
  const idle = terminal;
  // 문장 수정 실습에서 빈 지시를 보내면 일반 검토가 되어 의견만 남을 수 있다.
  // 이미 그렇게 끝난 요청은 같은 검토를 반복하지 않고 명시적인 수정 요청으로 이어 간다.
  const retryFirst = async () => {
    const ticket = env.stepIdentity?.();
    const r = reqOf(ctx.rid1); if (!r) return null;
    if (r.status === 'done' && (examples() || !String(r.instruction || '').trim())) {
      const result = await d.createRequest({ kind: 'instruct', target: r.target, instruction: INSTR1, attachments: [], ...(examples() ? { route: 'example' } : {}) });
      const next = result?.request;
      if (!current(ticket)) return null;
      if (next?.rid != null) {
        ctx.rid1 = next.rid;
        if (s.composer?.rid === r.rid) s.composer.rid = next.rid;
      }
    } else await d.retryRequest(r);
    return null;
  };
  const tocPicked = () => toolbarShown() && selHas('차례');
  return [
    // AI 처리 안내는 서버가 정한 이 문서의 작업 환경대로 — 연습 문서는 예시 답변(2026-11-12, 서버 _exampleDoc), 예시를 끈 설정이면 관리자 API
    { title: '튜토리얼을 시작합니다', text: () => `임시 「결과보고서」에서 연습합니다. 완료할 때만 내 문서함에 저장됩니다. ${env.docEnv?.()?.ownAi ? 'AI 답변은 미리 준비한 예시로 보여 줍니다 — AI 연결이나 사용료가 필요 없습니다.' : 'AI 요청은 관리자가 공유한 API로 처리합니다.'} 금빛 테두리가 다음 행동을 안내합니다. 다른 버튼도 자유롭게 눌러 보세요 — 잘못 눌러도 [↻ 다시 하기]로 그 단계를 처음부터 다시 할 수 있습니다. 3~5분.`, center: true, next: '시작하기' },
    // 1) 첫 문장: AI 요청
    { title: '1. 고칠 글 고르기', text: `‘${P1}’ 주변을 ${dragHow} 고르세요. 문구가 포함되거나 작은 검토 도구 막대가 나타나면 됩니다. 앞뒤 글자가 함께 골라져도 괜찮습니다.`,
      ring: () => phraseRect(P1), open: () => frameRect(), enter: () => { const at = locate(P1); if (at) focusIn(d, at, { quiet: true }); },
      until: () => selected(P1) || firstOpen() || firstSent(), lost: () => !locate(P1) && !firstSent() ? 1 : null },
    { title: '2. AI에게 맡기기', text: () => toolbarShown() ? '도구 막대의 [AI에게 맡기기]를 누르세요.' : '글을 다시 고르면 도구 막대가 나타납니다. [AI에게 맡기기]를 눌러 요청 창을 여세요.', ring: () => pad(inFrame(toolbarBtn('instruct')), 4) || phraseRect(P1), open: frameRect, click: () => toolbarBtn('instruct'),
      until: () => firstOpen() || firstSent(), lost: () => !locate(P1) ? 1 : null },
    { title: '3. AI 에게 말하기', text: () => (String(s.composer?.instruction || '').trim() ? '좋습니다. [✦ 보내기]를 누르세요.' : '원하는 수정을 직접 적거나 아래 예시를 입력하세요.'),
      enter: () => {
        ctx.firstRequests ??= (s.requests || []).map(r => r.rid);
        if (s.composer?.phase === 'edit') {
          // 대충 고른 범위로 창을 열어도 준비된 예시 답변은 연습 문장을 대상으로 합니다.
          if (s.composer.target && !exactTarget(s.composer.target, P1)) s.composer.target = targetFor(P1);
          if (!String(s.composer.instruction || '').trim()) s.composer.instruction = INSTR1;
        }
      },
      ring: () => pad(rectOf(String(s.composer?.instruction || '').trim() ? q('.composer-win .cmp-send') : q('.composer-win .cmp-instr')), 4),
      open: () => rectOf(composerEl()), until: () => { const rid = firstRid(); if (rid == null || !reqOf(rid) || s.sending) return false; ctx.rid1 = rid; return true; },
      lost: () => !firstSent() && !locate(P1) ? 1 : null,
      action: tutorialExampleAction(INSTR1, () => typeInTutorialComposer(env, INSTR1, '3. AI 에게 말하기', { instant: true }), () => s.composer?.phase === 'edit') },
    { title: '4. AI 가 처리하는 중', text: () => waitLine(reqOf(s.composer?.rid ?? ctx.rid1)), wait: true, idle: () => idle(ctx.rid1), ring: () => pad(rectOf(composerEl()), 4),
      enter: () => { if (s.composer?.rid != null) ctx.rid1 = s.composer.rid; },
      until: () => reqOf(ctx.rid1)?.status === 'done' && propsOf(ctx.rid1).some(p => ['pending', 'applied'].includes(p.status)),
      lost: () => !reqOf(ctx.rid1) || (reqOf(ctx.rid1)?.status === 'done' && !propsOf(ctx.rid1).some(p => ['pending', 'applied'].includes(p.status))) ? 3 : null,
      action: { label: '다시 요청', show: () => retryable(ctx.rid1), run: retryFirst } },
    { title: '5. 제안 반영', press: '반영', text: '빨간 줄은 지울 글, 파란 글은 새 글입니다. 마음에 들면 초록 테두리의 [반영]을 누르세요 — 연습 문서에 바로 들어갑니다.',
      ring: () => pad(rectOf(composerApply(ctx.rid1) || railApply(ctx.rid1)), 4), click: () => composerApply(ctx.rid1) || railApply(ctx.rid1),
      reveal: () => composerApply(ctx.rid1) || railApply(ctx.rid1), open: () => rectOf(composerEl()) || pad(rectOf(railApply(ctx.rid1)), 40),
      lost: () => !pendingOf(ctx.rid1).length && !propsOf(ctx.rid1).some(p => p.status === 'applied') ? 3 : null,
      until: () => propsOf(ctx.rid1).some((p) => p.status === 'applied'), reviewApplied: () => propsOf(ctx.rid1), leave: () => { try { d.closeWindow('composer'); } catch { /* 이미 닫힘 */ } } },
    // 2) 메모 → 답글로 AI 에게 요청
    { title: '6. 메모 달기 — 고르기', text: `이번엔 ‘${P2}’ 주변을 ${dragHow} 고르세요. 문구가 포함되거나 검토 도구 막대가 나타나면 됩니다. 의견은 메모로 남깁니다.`, ring: () => phraseRect(P2), open: () => frameRect(),
      enter: () => { ctx.memoIds0 ??= (s.memos || []).map(m => m.id); const at = locate(P2); if (at) focusIn(d, at, { quiet: true }); },
      until: () => selected(P2) || memoOpen() || !!freshMemo(), lost: () => !locate(P2) && !freshMemo() ? 6 : null },
    { title: '7. 메모', text: () => toolbarShown() ? '도구 막대의 [메모]를 누르세요.' : '글을 다시 고르면 도구 막대가 나타납니다. [메모]를 눌러 메모 창을 여세요.', ring: () => pad(inFrame(toolbarBtn('memo')), 4) || phraseRect(P2), open: frameRect, click: () => toolbarBtn('memo'),
      until: () => memoOpen() || !!freshMemo(), lost: () => !locate(P2) ? 6 : null },
    { title: '8. 메모 쓰기', text: () => (String(s.popover?.text || '').trim() ? '[메모 달기]를 누르세요. 한/글에서도 메모로 보입니다.' : '의견을 직접 적거나 아래 예시를 입력하세요.'),
      enter: () => { if (s.popover?.kind === 'memo' && !exactTarget(s.popover.target, P2)) s.popover.target = targetFor(P2); },
      ring: () => pad(rectOf(String(s.popover?.text || '').trim() ? q('.popover .memoedit button.primary') : q('.popover .memoedit textarea')), 4),
      open: () => rectOf(q('.popover')), until: () => !!freshMemo(), lost: () => !freshMemo() && !locate(P2) ? 6 : null,
      action: tutorialExampleAction(MEMO, () => typeInTutorialField(env, q('.popover .memoedit textarea'), MEMO, '8. 메모 쓰기', { instant: true })),
      leave: () => { ctx.memoId = freshMemo()?.id || null; } },
    { title: '9. 메모에 답글 — AI 에게 맡기기', text: () => `${besideOrBelow(memoCard(ctx.memoId))} 메모에서 [답글]을 누르세요. 답글을 그대로 AI 에게 보낼 수 있습니다.`,
      ring: () => pad(rectOf(q('.rc-reply', memoCard(ctx.memoId))), 4), click: () => q('.rc-reply', memoCard(ctx.memoId)), reveal: () => q('.rc-reply', memoCard(ctx.memoId)),
      open: () => pad(rectOf(memoCard(ctx.memoId)), 4), until: () => !!followUp() || ctx.memoId != null && (!!(memoCard(ctx.memoId) && q('.me-ask', memoCard(ctx.memoId))) || s.reply?.memoId === ctx.memoId),
      enter: () => { const m = d.memo?.(ctx.memoId); if (m) focusIn(d, { ref: m.ref, start: m.start, end: m.end }, { quiet: true }); s.active = ctx.memoId ? { kind: 'memo', id: ctx.memoId } : s.active; },
      lost: () => !d.memo?.(ctx.memoId) ? 8 : null },
    { title: '10. AI 에게 요청', text: '답글을 직접 적거나 아래 예시를 입력한 뒤 [✦ AI에게 요청]을 누르세요. 메모와 함께 AI에게 보냅니다.',
      ring: () => pad(rectOf(replyTarget()), 4), reveal: replyTarget, open: () => pad(rectOf(replyBox()), 4),
      enter: () => { ctx.reqs0 ??= (s.requests || []).map((r) => r.rid); if (d.memo?.(ctx.memoId) && !replyBox() && !(s.requests || []).some(r => !(ctx.reqs0 || []).includes(r.rid) && r.followUp?.memoId === ctx.memoId)) openTutorialMemoReply(d, d.memo(ctx.memoId)); },
      until: () => { const r = (s.requests || []).find((x) => !(ctx.reqs0 || []).includes(x.rid) && ctx.memoId != null && x.followUp?.memoId === ctx.memoId); if (r) ctx.rid2 = r.rid; return !!r; },
      action: tutorialExampleAction(REPLY, () => typeInTutorialField(env, replyInput(), REPLY, '10. AI 에게 요청', { instant: true })),
      lost: () => !d.memo?.(ctx.memoId) ? 8 : null },
    { title: '11. AI 가 처리하는 중', text: () => waitLine(reqOf(ctx.rid2)), wait: true, idle: () => idle(ctx.rid2),
      until: () => { const r = reqOf(ctx.rid2); return !!r && r.status === 'done' && propsOf(ctx.rid2).some(p => ['pending', 'applied'].includes(p.status)); },
      lost: () => !reqOf(ctx.rid2) || (reqOf(ctx.rid2)?.status === 'done' && !propsOf(ctx.rid2).some(p => ['pending', 'applied'].includes(p.status))) ? 10 : null,
      action: { label: '다시 요청', show: () => retryable(ctx.rid2), run: async () => { const r = reqOf(ctx.rid2); if (examples() && r?.status === 'done') { const sent = await d.askAiFromMemo(ctx.memoId, REPLY, { route: 'example' }); if (sent?.request?.rid != null) ctx.rid2 = sent.request.rid; } else if (r) await d.retryRequest(r); } } },
    { title: '12. 제안 반영', press: '반영', text: () => `메모대로 고친 제안이 ${besideOrBelow(railApply(ctx.rid2)) === '아래' ? '아래 목록에' : '문서 옆에'} 왔습니다. 초록 테두리의 [반영]을 누르세요.`, reveal: () => railApply(ctx.rid2),
      enter: () => { const p = pendingOf(ctx.rid2)[0]; if (p) { s.active = { kind: 'proposal', id: String(p.pid) }; focusIn(d, { ref: p.ref || p.afterRef }, { quiet: true }); } },
      ring: () => pad(rectOf(railApply(ctx.rid2)), 4), click: () => railApply(ctx.rid2), open: () => pad(rectOf(railApply(ctx.rid2)?.closest('.rcard') || railApply(ctx.rid2)), 6),
      until: () => propsOf(ctx.rid2).some((p) => p.status === 'applied'), reviewApplied: () => propsOf(ctx.rid2),
      lost: () => !pendingOf(ctx.rid2).length && !propsOf(ctx.rid2).some(p => p.status === 'applied') ? 10 : null,
      action: { label: 'AI 작업 탭에서 보기', run: () => { s.activeRid = ctx.rid2; s.tab = 'ai'; return null; } } },
    // 3) 차례 새로 고침
    // 고르기 → 도구 막대 [AI에게 맡기기] → 적기 → 보내기를 차례로 가리킨다(어떻게 창을 여는지 설명이 없던 단계)
    { title: '13. 차례도 AI 에게', text: () => (s.composer ? (String(s.composer.instruction || '').trim() ? '좋습니다. [✦ 보내기]를 누르세요.' : '요청 칸에 아래 예시를 입력하세요.')
      : tocPicked() ? '도구 막대의 [AI에게 맡기기]를 누르세요.' : `앞쪽 차례는 아직 비어 있습니다. ‘${ctx.tocText || '<제목 차례>'}’를 ${dragHow} 고르고 AI 에게 「${TOC}」라고 요청해 보세요.`),
      enter: () => { rememberToc(); if (ctx.tocRef) focusIn(d, { ref: tocTarget().ref }, { quiet: true }); },
      // 창이 열리기 전엔 차례 문단·도구 막대를 가리킨다(말풍선 자기 단추를 가리키면 말풍선이 제 자리를 쫓아 계속 움직인다)
      ring: () => (s.composer ? pad(rectOf(String(s.composer.instruction || '').trim() ? q('.composer-win .cmp-send') : q('.composer-win .cmp-instr')), 4)
        : tocPicked() ? pad(inFrame(toolbarBtn('instruct')), 4) : (ctx.tocText ? phraseRect(ctx.tocText) : null)),
      open: () => rectOf(composerEl()) || frameRect(),
      until: () => { const r = tocRequest(); if (r) ctx.rid3 = r.rid; return !!r && !s.sending; },
      lost: () => !tocRequest() && (s.paragraphs || []).filter(p => ctx.tocOriginal != null && p.text === ctx.tocOriginal).length !== 1 ? 13 : null,
      action: tutorialExampleAction(TOC, async () => {
        if (!s.composer || s.composer.target?.ref !== ctx.tocRef) d.openComposer(tocTarget(), 'instruct', { instruction: '' });
        await typeInTutorialComposer(env, TOC, '13. 차례도 AI 에게', { instant: true });
      }) },
    { title: '14. 차례를 새로 고치는 중', text: () => tocDone() ? '차례가 채워졌습니다 — 제목·표 항목과 쪽 번호를 문서에서 다시 뽑았습니다.' : waitLine(reqOf(ctx.rid3)), wait: true, idle: () => terminal(ctx.rid3),
      reviewApplied: () => propsOf(ctx.rid3 ?? s.composer?.rid),
      until: () => reqOf(ctx.rid3)?.status === 'done' && tocDone(),
      lost: () => !reqOf(ctx.rid3) || (reqOf(ctx.rid3)?.status === 'done' && !tocDone()) ? 13 : null,
      action: { label: '차례 다시 요청', show: () => ['failed', 'cancelled'].includes(reqOf(ctx.rid3)?.status), run: async () => { const r = reqOf(ctx.rid3); if (r) await d.retryRequest(r); } },
      leave: () => { try { d.closeWindow('composer'); } catch { /* 없음 */ } if (ctx.tocRef) focusIn(d, { ref: ctx.tocRef }, { quiet: true }); } },
    // 4) 한글로 저장
    // 좁은 화면은 [한글로 저장]이 위 ⋯ 메뉴 안에 있다 — 메뉴 단추 → 메뉴의 [한글로 저장] 순서로 가리킨다
    { title: '15. 한글로 저장', text: () => (saveButton() || !q('[data-testid="bar-more-toggle"]') ? '고친 문서를 한/글 파일(HWPX)로 내려받습니다. [한글로 저장]을 누르세요.' : '고친 문서를 한/글 파일(HWPX)로 내려받습니다. 위 [⋯] 메뉴를 열고 [한글로 저장]을 누르세요.'),
      ring: () => pad(rectOf(saveButton() || q('[data-testid="bar-more-toggle"]')), 4),
      enter: () => { ctx.exportStart = s.hangulDownloads || 0; }, until: () => (s.hangulDownloads || 0) > (ctx.exportStart || 0),
      open: () => pad(rectOf(saveButton() || q('[data-testid="bar-more-toggle"]')), 4) },
    { title: '튜토리얼을 마쳤습니다', text: 'AI 요청·제안 반영·메모·차례 갱신을 연습했습니다. 아래 버튼을 누르면 지금 연습한 문서와 기록을 내 문서함에 보관합니다. 튜토리얼 메뉴에서 언제든 처음부터 다시 시작할 수 있습니다.', center: true, next: '완료하고 문서함에 저장', last: true },
  ];
}
