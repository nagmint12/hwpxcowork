// 결과보고서 실습의 내용과 동작. 숫자 이동은 이 모듈 내부 단계 좌표입니다.
import { tutorialWaitText } from '../request-wait.js';
import { typeInTutorialField, typeInTutorialComposer } from './common.js';
const P1 = '일정 부분 기여한 것으로 보인다';
const P2 = '학생 만족도';
const INSTR1 = '‘보인다’ 말고, 적절한 표현으로';
const MEMO = '근거로 [표 1]을 함께 제시해 주세요.';
const REPLY = '이 메모대로 문장을 고쳐 줘';
const TOC = '차례 새로고침해줘';

export function buildReportFlow(env) {
  const { d, s, ctx, dragHow, phraseRect, frameRect, locate, focusIn, selHas, toolbarShown, selectFor, pad, inFrame, toolbarBtn, rectOf, q, besideOrBelow, saveButton } = env;
  const composerEl = () => document.querySelector('.composer-win');
  const reqOf = (rid) => (rid != null ? d.request?.(rid) : null);
  const propsOf = (rid) => (s.proposals || []).filter((p) => p.rid === rid);
  const pendingOf = (rid) => propsOf(rid).filter((p) => p.status === 'pending');
  const firstLive = (root) => q('.rs-live, .rs-adopt, .rs-apply, .rc-live, .rc-adopt, .rc-apply', root);
  /** rid 제안의 레일 카드 [반영] 단추 */
  function railApply(rid) {
    for (const p of pendingOf(rid)) {
      const card = document.querySelector(`.rcard[data-kind="proposal"][data-id*="${p.pid}"]`) || document.querySelector(`.rcard[data-rid="${rid}"]`);
      const b = card && firstLive(card); if (b) return b;
    }
    return firstLive(document.querySelector('.review-rail')) || firstLive(document.querySelector('.panel'));
  }
  const memoCard = (mid) => document.querySelector(`.rcard[data-kind="memo"][data-id="${mid}"]`);
  // 휴대폰처럼 편집기 아래에 작업 창이 붙은 화면에서는 메모·제안 카드가 '문서 옆'이 아니라 '아래'에 있다
  const replyBox = () => (memoCard(ctx.memoId) && q('.memoedit', memoCard(ctx.memoId)) ? memoCard(ctx.memoId) : q('.quickreply'));
  const replyTarget = () => { const box = replyBox(); const ta = q('.memoedit textarea', box); return ta && String(ta.value || '').trim() ? q('.me-ask', box) : ta; };
  const waitLine = (r) => (r?.status === 'failed' ? `AI 처리에 실패했습니다: ${r.error || ''}`
    // 실제 AI 가 의견만 남기고 제안을 만들지 않은 경우 — 계속 '찾는 중'으로 보이던 문제
    : r?.status === 'done' && !pendingOf(r.rid).length ? 'AI 가 작업을 마쳤지만 반영할 제안이 없습니다. 메모 목록에서 AI 의견을 확인하고 [다시 요청]을 누르거나 [건너뛰기]로 넘어가세요.'
    : tutorialWaitText(r, env.docEnv?.() || {}));
  const idle = (rid) => ['failed', 'done'].includes(reqOf(rid)?.status);
  // 문장 수정 실습에서 빈 지시를 보내면 일반 검토가 되어 의견만 남을 수 있다.
  // 이미 그렇게 끝난 요청은 같은 검토를 반복하지 않고 명시적인 수정 요청으로 이어 간다.
  const retryFirst = async () => {
    const r = reqOf(ctx.rid1); if (!r) return null;
    if (!String(r.instruction || '').trim()) {
      const result = await d.createRequest({ kind: 'instruct', target: r.target, instruction: INSTR1, count: 1 });
      const next = result?.request ?? result;
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
    { title: '튜토리얼을 시작합니다', text: () => `임시 「결과보고서」에서 연습합니다. 완료할 때만 내 문서함에 저장됩니다. ${env.docEnv?.()?.ownAi ? 'AI 답변은 미리 준비한 예시로 보여 줍니다 — AI 연결이나 사용료가 필요 없습니다.' : 'AI 요청은 관리자가 공유한 API로 처리합니다.'} 금빛 테두리 안을 눌러 따라오세요 — 3~5분.`, center: true, next: '시작하기' },
    // 1) 첫 문장: AI 요청
    { title: '1. 고칠 글 고르기', text: `‘${P1}’를 끝 글자 ‘다’까지 ${dragHow} 고르세요. 손을 떼면 글 위에 작은 도구 막대가 나옵니다.`,
      ring: () => phraseRect(P1), open: () => frameRect(), enter: () => { const at = locate(P1); if (at) focusIn(d, at, { quiet: true }); },
      until: () => selHas('보인') && toolbarShown(),
      action: { label: '대신 골라 주기', run: async () => { const t = await selectFor(P1); if (t) { d.openComposer(t, 'instruct', {}); return 3; } return null; } } },
    { title: '2. AI에게 맡기기', text: '도구 막대의 [AI에게 맡기기]를 누르세요.', ring: () => pad(inFrame(toolbarBtn('instruct')), 4), click: () => toolbarBtn('instruct'), frameClick: true,
      until: () => s.composer?.kind === 'instruct', lost: () => !toolbarShown() && !s.composer ? 1 : null },
    { title: '3. AI 에게 말하기', text: () => (String(s.composer?.instruction || '').trim() ? '좋습니다. [✦ 보내기]를 누르세요.' : `무엇을 바랄지 적으세요. 예: 「${INSTR1}」`),
      enter: () => { if (s.composer?.phase === 'edit' && !String(s.composer.instruction || '').trim()) s.composer.instruction = INSTR1; },
      ring: () => pad(rectOf(String(s.composer?.instruction || '').trim() ? q('.composer-win .cmp-send') : q('.composer-win .cmp-instr')), 4),
      open: () => rectOf(composerEl()), until: () => !!s.composer && s.composer.phase !== 'edit', lost: () => (!s.composer ? 1 : null),
      action: { label: '예시 글 넣기', run: () => typeInTutorialComposer(env, INSTR1, '3. AI 에게 말하기') } },
    { title: '4. AI 가 처리하는 중', text: () => waitLine(reqOf(s.composer?.rid ?? ctx.rid1)), wait: true, idle: () => idle(ctx.rid1), ring: () => pad(rectOf(composerEl()), 4),
      enter: () => { if (s.composer?.rid != null) ctx.rid1 = s.composer.rid; },
      until: () => { const c = s.composer; if (c?.rid != null) ctx.rid1 = c.rid; const r = reqOf(ctx.rid1); return !!r && r.status === 'done' && pendingOf(ctx.rid1).length > 0; },
      action: { label: '다시 요청', show: () => reqOf(ctx.rid1)?.status === 'failed' || (reqOf(ctx.rid1)?.status === 'done' && !pendingOf(ctx.rid1).length), run: retryFirst } },
    { title: '5. 제안 반영', press: '반영', text: '빨간 줄은 지울 글, 파란 글은 새 글입니다. 마음에 들면 초록 테두리의 [반영]을 누르세요 — 연습 문서에 바로 들어갑니다.',
      ring: () => pad(rectOf(firstLive(composerEl()) || railApply(ctx.rid1)), 4), click: () => firstLive(composerEl()) || railApply(ctx.rid1),
      reveal: () => firstLive(composerEl()) || railApply(ctx.rid1), open: () => rectOf(composerEl()) || pad(rectOf(railApply(ctx.rid1)), 40),
      until: () => propsOf(ctx.rid1).some((p) => p.status === 'applied'), reviewApplied: () => propsOf(ctx.rid1), leave: () => { try { d.closeWindow('composer'); } catch { /* 이미 닫힘 */ } } },
    // 2) 메모 → 답글로 AI 에게 요청
    { title: '6. 메모 달기 — 고르기', text: `이번엔 ‘${P2}’를 ${dragHow} 고르세요. 의견은 메모로 남깁니다.`, ring: () => phraseRect(P2), open: () => frameRect(),
      enter: () => { ctx.memos0 = (s.memos || []).length; const at = locate(P2); if (at) focusIn(d, at, { quiet: true }); },
      until: () => selHas('만족') && toolbarShown(),
      action: { label: '대신 골라 주기', run: async () => { const t = await selectFor(P2); if (t) { d.openPopover('memo', t, null); return 8; } return null; } } },
    { title: '7. 메모', text: '도구 막대의 [메모]를 누르세요.', ring: () => pad(inFrame(toolbarBtn('memo')), 4), click: () => toolbarBtn('memo'), frameClick: true,
      until: () => s.popover?.kind === 'memo', lost: () => (!toolbarShown() && !s.popover ? 6 : null) },
    { title: '8. 메모 쓰기', text: () => (String(s.popover?.text || '').trim() ? '[메모 달기]를 누르세요. 한/글에서도 메모로 보입니다.' : `의견을 적으세요. 예: 「${MEMO}」`),
      ring: () => pad(rectOf(String(s.popover?.text || '').trim() ? q('.popover .memoedit button.primary') : q('.popover .memoedit textarea')), 4),
      open: () => rectOf(q('.popover')), until: () => (s.memos || []).length > (ctx.memos0 ?? 0), lost: () => (!s.popover && (s.memos || []).length <= (ctx.memos0 ?? 0) ? 6 : null),
      action: { label: '예시 글 넣기', show: () => !String(s.popover?.text || '').trim(), run: () => typeInTutorialField(env, q('.popover .memoedit textarea'), MEMO, '8. 메모 쓰기') },
      leave: () => { const list = s.memos || []; const mine = list.filter((m) => !m.link && String(m.body ?? m.text ?? '').includes('표 1')); ctx.memoId = (mine[mine.length - 1] || list[list.length - 1])?.id || null; } },
    { title: '9. 메모에 답글 — AI 에게 맡기기', text: () => `${besideOrBelow(memoCard(ctx.memoId))} 메모에서 [답글]을 누르세요. 답글을 그대로 AI 에게 보낼 수 있습니다.`,
      ring: () => pad(rectOf(q('.rc-reply', memoCard(ctx.memoId))), 4), click: () => q('.rc-reply', memoCard(ctx.memoId)), reveal: () => q('.rc-reply', memoCard(ctx.memoId)),
      open: () => pad(rectOf(memoCard(ctx.memoId)), 4), until: () => !!q('.me-ask', memoCard(ctx.memoId)) || s.reply?.memoId === ctx.memoId,
      enter: () => { const m = d.memo?.(ctx.memoId); if (m) focusIn(d, { ref: m.ref, start: m.start, end: m.end }, { quiet: true }); s.active = ctx.memoId ? { kind: 'memo', id: ctx.memoId } : s.active; },
      action: { label: '답글 창 열기', run: () => { const m = d.memo?.(ctx.memoId); if (m) d.openReply({ key: Date.now(), kind: 'memo', memoId: m.id, ref: m.ref, quote: m.body ?? m.text ?? '', anchor: null }); return null; } } },
    { title: '10. AI 에게 요청', text: () => `답글을 적고 보라색 [✦ AI에게 요청]을 누르세요. 예: 「${REPLY}」 — 메모와 함께 AI 에게 갑니다.`,
      ring: () => pad(rectOf(replyTarget()), 4), reveal: replyTarget, open: () => pad(rectOf(replyBox()), 4),
      enter: () => { ctx.reqs0 = (s.requests || []).map((r) => r.rid); },
      until: () => { const r = (s.requests || []).find((x) => !(ctx.reqs0 || []).includes(x.rid) && x.followUp); if (r) ctx.rid2 = r.rid; return !!r; },
      action: { label: '예시 글 넣기', run: () => typeInTutorialField(env, q('.memoedit textarea', replyBox()), REPLY, '10. AI 에게 요청') } },
    { title: '11. AI 가 처리하는 중', text: () => waitLine(reqOf(ctx.rid2)), wait: true, idle: () => idle(ctx.rid2),
      until: () => { const r = reqOf(ctx.rid2); return !!r && r.status === 'done' && pendingOf(ctx.rid2).length > 0; },
      action: { label: '다시 요청', show: () => reqOf(ctx.rid2)?.status === 'failed' || (reqOf(ctx.rid2)?.status === 'done' && !pendingOf(ctx.rid2).length), run: async () => { const r = reqOf(ctx.rid2); if (r) await d.retryRequest(r); return null; } } },
    { title: '12. 제안 반영', press: '반영', text: () => `메모대로 고친 제안이 ${besideOrBelow(railApply(ctx.rid2)) === '아래' ? '아래 목록에' : '문서 옆에'} 왔습니다. 초록 테두리의 [반영]을 누르세요.`, reveal: () => railApply(ctx.rid2),
      enter: () => { const p = pendingOf(ctx.rid2)[0]; if (p) { s.active = { kind: 'proposal', id: String(p.pid) }; focusIn(d, { ref: p.ref || p.afterRef }, { quiet: true }); } },
      ring: () => pad(rectOf(railApply(ctx.rid2)), 4), click: () => railApply(ctx.rid2), open: () => pad(rectOf(railApply(ctx.rid2)?.closest('.rcard') || railApply(ctx.rid2)), 6),
      until: () => propsOf(ctx.rid2).some((p) => p.status === 'applied'), reviewApplied: () => propsOf(ctx.rid2),
      action: { label: 'AI 작업 탭에서 보기', run: () => { s.activeRid = ctx.rid2; s.tab = 'ai'; return null; } } },
    // 3) 차례 새로 고침
    // 고르기 → 도구 막대 [AI에게 맡기기] → 적기 → 보내기를 차례로 가리킨다(어떻게 창을 여는지 설명이 없던 단계)
    { title: '13. 차례도 AI 에게', text: () => (s.composer ? (String(s.composer.instruction || '').trim() ? '좋습니다. [✦ 보내기]를 누르세요.' : `요청 칸에 「${TOC}」라고 적으세요.`)
      : tocPicked() ? '도구 막대의 [AI에게 맡기기]를 누르세요.' : `앞쪽 차례는 아직 비어 있습니다. ‘${ctx.tocText || '<제목 차례>'}’를 ${dragHow} 고르고 AI 에게 「${TOC}」라고 요청해 보세요.`),
      enter: () => { ctx.reqs1 = (s.requests || []).map((r) => r.rid); const p = (s.paragraphs || []).find((x) => /제목 차례|차례 새로 고침/.test(String(x.text || ''))); if (p) { ctx.tocRef = p.ref; ctx.tocText = [...String(p.text || '')].slice(0, 7).join(''); focusIn(d, { ref: p.ref }, { quiet: true }); } },
      // 창이 열리기 전엔 차례 문단·도구 막대를 가리킨다(말풍선 자기 단추를 가리키면 말풍선이 제 자리를 쫓아 계속 움직인다)
      ring: () => (s.composer ? pad(rectOf(String(s.composer.instruction || '').trim() ? q('.composer-win .cmp-send') : q('.composer-win .cmp-instr')), 4)
        : tocPicked() ? pad(inFrame(toolbarBtn('instruct')), 4) : (ctx.tocText ? phraseRect(ctx.tocText) : null)),
      open: () => rectOf(composerEl()) || frameRect(),
      until: () => { const r = (s.requests || []).find((x) => !(ctx.reqs1 || []).includes(x.rid)); if (r) ctx.rid3 = r.rid; return !!r || (s.composer && s.composer.phase !== 'edit'); },
      action: { label: '요청 창 열기', show: () => !s.composer, run: async () => { const p = ctx.tocRef ? (s.paragraphs || []).find((x) => x.ref === ctx.tocRef) : null; d.openComposer({ ref: ctx.tocRef || 's0/p0', start: 0, end: [...String(p?.text || '')].length, endRef: ctx.tocRef, refs: [ctx.tocRef], text: String(p?.text || '') }, 'instruct', { instruction: '' }); await typeInTutorialComposer(env, TOC, '13. 차례도 AI 에게'); } } },
    { title: '14. 차례를 새로 고치는 중', text: () => { const r = reqOf(ctx.rid3 ?? s.composer?.rid); return r?.status === 'done' ? '차례가 채워졌습니다 — 제목·표 항목과 쪽 번호를 문서에서 다시 뽑았습니다.' : waitLine(r); }, wait: true,
      reviewApplied: () => propsOf(ctx.rid3 ?? s.composer?.rid),
      until: () => { if (ctx.rid3 == null && s.composer?.rid != null) ctx.rid3 = s.composer.rid; const r = reqOf(ctx.rid3); return !!r && r.status !== 'pending' && r.status !== 'working'; },
      leave: () => { try { d.closeWindow('composer'); } catch { /* 없음 */ } if (ctx.tocRef) focusIn(d, { ref: ctx.tocRef }, { quiet: true }); } },
    // 4) 한글로 저장
    // 좁은 화면은 [한글로 저장]이 위 ⋯ 메뉴 안에 있다 — 메뉴 단추 → 메뉴의 [한글로 저장] 순서로 가리킨다
    { title: '15. 한글로 저장', text: () => (saveButton() || !q('[data-testid="bar-more-toggle"]') ? '고친 문서를 한/글 파일(HWPX)로 내려받습니다. [한글로 저장]을 누르세요.' : '고친 문서를 한/글 파일(HWPX)로 내려받습니다. 위 [⋯] 메뉴를 열고 [한글로 저장]을 누르세요.'),
      ring: () => pad(rectOf(saveButton() || q('[data-testid="bar-more-toggle"]')), 4), click: saveButton,
      open: () => pad(rectOf(saveButton() || q('[data-testid="bar-more-toggle"]')), 4) },
    { title: '튜토리얼을 마쳤습니다', text: 'AI 요청·제안 반영·메모·차례 갱신을 연습했습니다. 아래 버튼을 누르면 지금 연습한 문서와 기록을 내 문서함에 보관합니다. 튜토리얼 메뉴에서 언제든 처음부터 다시 시작할 수 있습니다.', center: true, next: '완료하고 문서함에 저장', last: true },
  ];
}
