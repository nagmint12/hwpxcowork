// 기능별 튜토리얼 단계. 실행기와 코스 구성은 이 파일 밖에서 관리합니다.
import { proposalControl } from '../tutorial-targets.js';
import { stepHelpers, applyTutorialProposal, typeInTutorialComposer } from './common.js';

export function buildAiReview(env) {
  const { d, s, ctx, config, focusIn, rectOf, pad, q, fdoc, inFrame, frameRect, selectFor, locate, phraseRect, cw } = env;
  const { finish, intro, top } = stepHelpers(env);
  const exampleInstruction = '조사 시기·인원·응답률은 그대로 두고, 이 문단 전체를 간결한 보고서 문체로 다듬어 줘';
    // 3장 설명 표에도 '예시 문단 A'라는 글이 있어 그 표를 가리켰다 — 4장 본문의 첫 글로 찾는다
    const aLead = () => { const p = sample('A'); return p ? [...String(p.text).replace(/^예시 문단 A\s*[—–-]\s*/, '')].slice(0, 14).join('') : null; };
    const aPicked = () => env.toolbarShown?.() && (env.selHas?.('본 조사') || env.selHas?.('예시 문단 A'));
    const sample = letter => (s.paragraphs || []).find(p => new RegExp(`^예시 문단 ${letter}\\s*[—–-]\\s*`).test(String(p.text || '')));
    const done = () => (s.requests || []).find(r => r.example && r.status === 'done');
    const sampleTarget = target => { const p = sample('A'); const body = p && String(p.text).replace(/^예시 문단 A\s*[—–-]\s*/, ''); return !!p && !!target && target.ref === p.ref && (!target.endRef || target.endRef === p.ref) && String(target.text || '').includes(body); };
    const proposals = () => (s.proposals || []).filter(p => p.rid === done()?.rid).sort((a, b) => a.pid - b.pid);
    const proposal = index => proposals()[index];
    const onlyTwo = () => proposals().slice(2).every(p => p.status === 'pending');
    const reviewStart = 4;
    const firstLost = () => !['pending', 'applied'].includes(proposal(0)?.status) || proposal(1)?.status !== 'pending' || !onlyTwo() ? reviewStart : null;
    const rejectLost = () => proposal(0)?.status !== 'applied' || !['pending', 'rejected'].includes(proposal(1)?.status) || !onlyTwo() ? reviewStart : null;
    const undone = () => proposal(0)?.status === 'undone' || (proposal(0)?.status === 'pending' && ctx.undone === proposal(0).pid);
    const undoLost = () => (proposal(0)?.status !== 'applied' && !undone()) || proposal(1)?.status !== 'rejected' || !onlyTwo() ? reviewStart : null;
    const showRequest = request => { if (!request) return; s.tab = 'ai'; s.activeRid = request.rid; s.active = { kind: 'request', id: String(request.rid) }; s.panelPing = (Number(s.panelPing) || 0) + 1; };
    const control = (index, action) => proposalControl(document, proposal(index)?.pid, action, done()?.rid);
    const showControl = (index, action) => {
      showRequest(done()); let cancelled = false; let timer; let tries = 0;
      const locateControl = () => {
        if (cancelled || ++tries > 30) return;
        const button = control(index, action); const r = button?.getBoundingClientRect();
        if (!button || r.left >= innerWidth || r.right <= 0) { timer = setTimeout(locateControl, 80); return; }
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // 초점 대신 초록 테두리(press)로 누를 곳을 알린다
      };
      timer = setTimeout(locateControl, 0); return () => { cancelled = true; clearTimeout(timer); };
    };
    return [
      intro('AI 작업 맡기기 — 결과를 판단하는 연습', '완료·대기·실패한 요청과 제안·메모 예시를 미리 준비했습니다. 이 예시를 반영·거절·되돌리는 동안 실제 유료 AI 요청은 보내지 않습니다.'),
      // 1번과 같은 실제 고르기 → 도구 막대 [AI에게 맡기기]. 긴 문단을 끌어 고르기 어려우면 안내 단추가 본문 전체를 고른다
      { title: '글을 골라 요청 준비하기', text: () => (aPicked() ? '도구 막대의 [AI에게 맡기기]를 누르세요. 요청에는 원하는 결과를 구체적으로 적고, 자료가 있으면 첨부합니다.' : `4장 ‘예시 문단 A’의 본문을 ${env.dragHow || '끌어'} 고르세요. 문단이 길어 고르기 어려우면 아래 [예시 문단의 AI 요청 열기]를 누르세요.`),
        enter: () => { const p = sample('A'); if (p) focusIn(d, { ref: p.ref }, { quiet: true }); },
        ring: () => (aPicked() ? pad(inFrame(env.toolbarBtn('instruct')), 4) : phraseRect(aLead() || '예시 문단 A')), open: frameRect,
        quick: true, action: { label: '예시 문단의 AI 요청 열기', run: async () => { const ticket = env.stepIdentity?.(); const p = sample('A'); if (!p) throw new Error('4장의 예시 문단 A를 찾지 못했습니다'); const body = String(p.text).replace(/^예시 문단 A\s*[—–-]\s*/, ''); const t = await selectFor(body); if (env.stepIdentity && env.stepIdentity() !== ticket) return; if (!t) throw new Error('예시 문단 본문을 찾지 못했습니다'); if (env.isCurrentStep?.('글을 골라 요청 준비하기') === false) return; d.openComposer(t, 'instruct', { instruction: exampleInstruction }); ctx.reviewPromptPending = true; } }, until: () => s.composer?.kind === 'instruct' && sampleTarget(s.composer.target) },
      { title: '요청·자료·보낼 곳 확인', text: '요청 창의 지시와 첨부, 보낼 곳을 확인합니다. 실제 [보내기]는 연결된 AI로 작업을 보냅니다. 이번에는 준비된 결과를 사용하므로 다음 버튼으로 요청 창을 닫습니다.', ring: top('.composer-win'), open: () => rectOf(q('.composer-win')), next: '준비된 결과 보기',
        enter: () => { if (ctx.reviewPromptPending && s.composer?.phase === 'edit' && s.composer.instruction === exampleInstruction) { ctx.reviewPromptPending = false; s.composer.instruction = ''; typeInTutorialComposer(env, exampleInstruction, '요청·자료·보낼 곳 확인').catch(() => {}); } },
        action: { label: '예시 요청 타이핑', run: () => typeInTutorialComposer(env, exampleInstruction, '요청·자료·보낼 곳 확인') }, leave: () => d.closeWindow('composer') },
      { title: '완료된 요청과 제안', text: '완료된 요청에는 원문·수정문·이유가 있는 제안이 있습니다. 요청이 완료되어도 본문에 자동으로 들어간 것은 아닙니다. 사람이 반영 여부를 정합니다.', enter: () => showRequest(done()), ring: top('.panel'), next: '제안 반영 연습' },
      { title: '제안 하나 반영하기', press: '반영', text: '첫 번째 예시 제안의 초록 테두리 [반영]을 직접 누르세요.', enter: () => showControl(0, 'apply'),
        quick: () => applyTutorialProposal(d, proposal(0)), lost: firstLost,
        lostText: '첫 번째만 반영하고 두 번째는 거절해야 합니다. [이 단계 다시하기]로 두 제안이 대기 중이던 상태를 복구하세요.',
        reviewApplied: () => [proposal(0)].filter(Boolean),
        ring: () => pad(rectOf(control(0, 'apply')), 4), open: () => pad(rectOf(control(0, 'apply')?.closest('[data-pid]')), 6), click: () => control(0, 'apply'), until: () => !firstLost() && proposal(0)?.status === 'applied' },
      { title: '마음에 들지 않는 제안 거절', press: '거절', text: '이번에는 두 번째 예시 제안의 초록 테두리 [거절]을 직접 누르세요. 해당 제안의 원문은 그대로 남고 검토 기록에 판단이 남습니다.', enter: () => showControl(1, 'reject'),
        lost: rejectLost, quick: async () => { const p = proposal(1); if (!rejectLost() && p?.status === 'pending') await d.rejectProposal(p); },
        ring: () => pad(rectOf(control(1, 'reject')), 4), open: () => pad(rectOf(control(1, 'reject')?.closest('[data-pid]')), 6), click: () => control(1, 'reject'), until: () => !rejectLost() && proposal(1)?.status === 'rejected' },
      { title: '반영한 제안 되돌리기', press: '되돌리기', text: '방금 반영한 첫 제안의 초록 테두리 [되돌리기]를 직접 누르세요. 다른 편집과 겹친 경우에는 현재 문서 상태를 확인해야 하므로 되돌림이 보류될 수 있습니다.', enter: () => showControl(0, 'undo'),
        ring: () => pad(rectOf(control(0, 'undo')), 4) || top('.panel, .review-rail')(), open: () => pad(rectOf(control(0, 'undo')?.closest('[data-pid]')), 6), click: () => control(0, 'undo'), reveal: () => control(0, 'undo'),
        lost: undoLost, quick: true, action: { label: '첫 제안 반영 되돌리기', run: async () => { const ticket = env.stepIdentity?.(); const p = proposal(0); if (p?.status !== 'applied') throw new Error('되돌릴 반영 제안이 없습니다. [이 단계 다시하기]로 복구해 주세요.'); await d.undoProposal(p); if (env.stepIdentity && env.stepIdentity() !== ticket) return; ctx.undone = p.pid; } },
        until: () => !undoLost() && undone() },
      { title: '대기 중인 요청', text: '대기는 요청을 가져갈 AI를 기다리는 상태입니다. 내 API 키, ChatGPT MCP, 개인 실행기 중 사용할 연결이 있어야 처리됩니다. 예시 요청을 실제로 보낼 필요는 없습니다.', enter: () => showRequest((s.requests || []).find(r => r.status === 'pending')), ring: top('.panel'), next: '실패한 요청 보기' },
      { title: '실패 원인과 다시 요청', text: '실패한 요청의 오류를 먼저 확인합니다. 이 예시는 첨부 파일이 없어 실패한 경우입니다. 실제 작업에서는 자료나 연결을 보완한 뒤 다시 요청합니다.', enter: () => showRequest((s.requests || []).find(r => r.status === 'failed')), ring: top('.panel'), next: '메모와 답글 보기' },
      { title: '메모의 근거와 답글', text: '예시 문단 C의 87%에는 수치의 근거를 요청한 메모와 답글이 있습니다. 메모에서 의견을 주고받고, 필요하면 그 의견을 AI에게 요청할 수 있습니다.', enter: () => { const p = sample('C'); if (p) focusIn(d, { ref: p.ref }, { quiet: true }); s.tab = 'review'; }, ring: () => phraseRect('87%'), open: frameRect, next: '내 AI 연결 안내로 이어가기' },
      { title: '실제 작업을 보내기 전', text: '실제 작업은 내 AI에게 맡깁니다. 튜토리얼 메뉴의 ‘AI 연결’에서 내 PC의 Codex·Claude Code를 연결하면 구독 요금제 그대로, 추가 비용 없이 요청을 바로 처리합니다. ChatGPT 웹과 API 키(유료)는 선택입니다.', center: true, next: '완료 단계로' }, finish,
    ];
}
