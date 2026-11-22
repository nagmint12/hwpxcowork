// 기능별 튜토리얼 단계. 실행기와 코스 구성은 이 파일 밖에서 관리합니다.
import { stepHelpers, typeInTutorialField, tutorialExampleAction } from './common.js';

export function buildEditorBasics(env) {
  const { d, s, ctx, focusIn, rectOf, pad, q, inFrame, frameRect, locate, phraseRect, cw } = env;
  const { finish, intro, top } = stepHelpers(env);
    // 입력·선택·메모·답글은 실제 앱에서 자유롭게 조작합니다.
    ctx.overviewMemoIds ??= (s.memos || []).map(m => m.id);
    ctx.overviewReplies ??= 0;
    const preparePractice = () => {
      const paragraphs = s.paragraphs || [];
      const index = paragraphs.findIndex(p => String(p.text || '').includes('이 문단의 아무 글이나'));
      const p = paragraphs[index];
      if (p && ctx.overviewOriginal == null) { ctx.overviewEditRef = p.ref; ctx.overviewOriginal = p.text; }
      if (p && !ctx.overviewAnchor && p.text === ctx.overviewOriginal) ctx.overviewAnchor = { count: paragraphs.length, index, ref: p.ref };
    };
    // 첫 안내를 읽는 중에 문장을 고쳐도 변경 전 문장과 위치를 기억합니다.
    preparePractice();
    // 문단 삽입·삭제로 연습 위치가 없어지면 준비 지점으로 돌아갑니다.
    // 다른 문단의 글을 고치는 것은 이 실습의 완료 조건에 영향을 주지 않습니다.
    const anchoredPractice = () => {
      const baseline = ctx.overviewAnchor; if (!baseline) return null;
      const now = s.paragraphs || []; if (now.length !== baseline.count) return null;
      const index = baseline.index;
      if (!now[index] || now[index].ref !== baseline.ref) return null;
      return now[index];
    };
    const practiceRef = () => anchoredPractice()?.ref || null;
    const editorText = () => { try { const ref = practiceRef(); return ref ? cw()?.debug?.text?.(ref) ?? null : null; } catch { return null; } };
    const edited = () => editorText() != null && ctx.overviewOriginal != null && editorText() !== ctx.overviewOriginal;
    const saved = () => !s.draft?.dirty && !s.draft?.saving && !d.editor?.dirty && !s.live?.error;
    const practiceRing = () => phraseRect(['이 문단의 아무 글이나', '글을 고치는 연습을 했습니다', '이 문단'].find(t => locate(t)) || '이 문단');
    const memoPicked = () => env.toolbarShown?.() && env.selHas?.('아무 글');
    const filled = box => String(box?.querySelector('textarea')?.value || '').trim();
    const memoBox = () => q('.popover .memoedit');
    const replyBox = () => (memoCard() && q('.memoedit', memoCard())) || (s.reply?.memoId === ctx.overviewMemoId ? q('.quickreply .memoedit') : null);
    const memoOf = () => (s.memos || []).find(m => m.id === ctx.overviewMemoId);
    const memoCard = () => { const m = memoOf(); return m ? q(`.rcard[data-kind="memo"][data-id="${m.id}"]`) : null; };
    const memoTarget = target => { const at = locate('이 문단의 아무 글이나'); return !!at && !!target && target.ref === at.ref && (!target.endRef || target.endRef === at.ref) && Number(target.end) > Number(target.start); };
    const freshMemo = () => (s.memos || []).find(m => !(ctx.overviewMemoIds || []).includes(m.id) && !m.link && memoTarget(m));
    const replies = () => (memoOf()?.thread?.replies || []).length;
    return [
      intro('처음 쓰기 — 화면부터 익혀 봅니다', '임시 문서에서 글 고치기·저장 상태·메모·답글·작업 창·한글 저장을 직접 해 봅니다. 다른 버튼도 자유롭게 누를 수 있습니다. 연습을 계속할 수 없게 되면 준비 상태를 자동으로 불러옵니다.'),
      { title: '제목과 저장 상태', text: '위쪽은 문서 제목과 저장 상태입니다. 지금은 본인만 쓰는 임시 연습 문서입니다. ‘저장됨’이 되면 편집 내용이 연습 문서에 저장된 것입니다.', ring: top('[data-testid="doc-title"]'), open: () => rectOf(q('[data-testid="office-primary-row"]') || q('.v3bar')), next: '확인했어요' },
      { title: '문장을 직접 고쳐 보기', text: () => (edited() ? '잘했습니다. 위쪽 저장 상태가 ‘저장됨’이 되면 다음으로 넘어갑니다.' : `금빛 테두리 안 연습 문장을 ${env.touch ? '눌러' : '클릭해'} 커서를 놓고, 글자를 지우거나 덧붙여 보세요. 입력하면 위쪽 저장 상태가 ‘저장 중’을 거쳐 ‘저장됨’으로 바뀝니다.`),
        enter: () => { preparePractice(); const p = anchoredPractice(); if (p) focusIn(d, { ref: p.ref }, { quiet: true }); }, ring: practiceRing, open: frameRect,
        until: () => edited() && saved(), lost: () => !anchoredPractice() ? 2 : null },
      { title: '고친 글 되돌리기', text: '이번에는 편집기의 [되돌리기] 또는 Ctrl+Z로 고친 문장을 원래대로 돌려 놓으세요.',
        ring: practiceRing, open: frameRect,
        until: () => editorText() != null && editorText() === ctx.overviewOriginal && saved(), lost: () => !anchoredPractice() ? 2 : null },
      { title: '의견을 남길 글 선택', text: () => (memoPicked() ? '도구 막대의 [메모]를 누르세요.' : `‘이 문단의 아무 글이나’를 ${env.dragHow || '끌어'} 고르세요. 손을 떼면 글 위에 작은 도구 막대가 나옵니다.`),
        ring: () => (memoPicked() ? pad(inFrame(env.toolbarBtn('memo')), 4) : phraseRect('이 문단의 아무 글이나')), open: frameRect,
        until: () => !!freshMemo() || s.popover?.kind === 'memo' && memoTarget(s.popover.target),
        lost: () => !freshMemo() && !locate('이 문단의 아무 글이나') ? 4 : null },
      { title: '메모를 직접 남기기', text: () => (filled(memoBox()) ? '[메모 달기]를 누르세요. 이 의견은 완료한 HWPX와 한/글에서도 메모로 보입니다.' : '메모 칸에 의견을 직접 적거나 아래 예시를 입력하세요.'),
        ring: () => pad(rectOf(filled(memoBox()) ? q('.popover .memoedit button.primary') : q('.popover .memoedit textarea')), 4), open: () => rectOf(q('.popover')),
        enter: () => { ctx.overviewMemoIds ??= (s.memos || []).map(m => m.id); },
        until: () => !!freshMemo(), lost: () => !freshMemo() && !locate('이 문단의 아무 글이나') ? 4 : null,
        action: tutorialExampleAction('튜토리얼에서 남긴 메모입니다.', () => typeInTutorialField(env, memoBox()?.querySelector('textarea'), '튜토리얼에서 남긴 메모입니다.', '메모를 직접 남기기', { instant: true })),
        leave: () => { ctx.overviewMemoId = freshMemo()?.id || null; } },
      { title: '여백의 메모와 답글', text: () => `방금 단 메모가 ${env.besideOrBelow?.(memoCard()) === '아래' ? '아래 메모 목록' : '문서 옆 여백'}에 있습니다. 메모는 끌어 옮길 수 있고, 답글로 의견을 이어갈 수 있습니다. 메모의 [답글]을 누르세요.`,
        ring: () => pad(rectOf(q('.rc-reply', memoCard())), 4), click: () => q('.rc-reply', memoCard()), reveal: () => q('.rc-reply', memoCard()), open: () => pad(rectOf(memoCard()), 8),
         lost: () => !memoOf() ? 5 : null,
        until: () => replies() > ctx.overviewReplies || !!memoOf() && (!!(memoCard() && q('.memoedit', memoCard())) || s.reply?.memoId === ctx.overviewMemoId) },
      { title: '답글도 남겨 보기', text: () => (filled(replyBox()) ? '[답글 달기]를 누르세요. 보라색 [AI에게 요청]은 실제 AI 작업을 보내는 다른 기능입니다.' : '답글을 직접 적거나 아래 예시를 입력하세요.'),
        ring: () => pad(rectOf(filled(replyBox()) ? replyBox()?.querySelector('button.primary') : replyBox()?.querySelector('textarea')), 4),
        reveal: () => (filled(replyBox()) ? replyBox()?.querySelector('button.primary') : replyBox()?.querySelector('textarea')), open: () => pad(rectOf(replyBox() || memoCard()), 6),
        enter: () => { ctx.overviewReplies ??= replies(); },
        lost: () => !memoOf() ? 5 : null,
        action: tutorialExampleAction('확인했습니다. 이 의견을 참고하겠습니다.', () => typeInTutorialField(env, replyBox()?.querySelector('textarea'), '확인했습니다. 이 의견을 참고하겠습니다.', '답글도 남겨 보기', { instant: true })),
        until: () => replies() > (ctx.overviewReplies ?? 0) },
      { title: 'AI 작업과 메모를 모아 보기', text: () => `${env.besideOrBelow?.(q('.panel')) === '아래' ? '아래' : '오른쪽'} 창의 AI 작업·메모 탭에서 요청과 의견을 모아 볼 수 있습니다. 넓은 화면에서 창을 접었다면 오른쪽 가장자리의 탭으로 다시 펼칩니다.`, ring: top('.panel [role="tablist"], .panel'), enter: () => { s.tab = 'review'; }, next: '확인했어요' },
      { title: '한글 파일로 내려받기', text: () => `${env.saveButton?.() || !q('[data-testid="bar-more-toggle"]') ? '위 [한글로 저장]' : '위 [문서 작업]의 [한글로 저장]'}으로 HWPX 파일을 받을 수 있습니다. 다운로드와 개인 문서함 저장은 구분됩니다. 다음 단계에서 완료하면 연습 문서를 개인 문서함에도 보관합니다.`,
        ring: () => pad(rectOf(env.saveButton?.() || q('[data-testid="bar-more-toggle"]')), 4), open: () => pad(rectOf(env.saveButton?.() || q('[data-testid="bar-more-toggle"]')), 4), next: '완료 단계로' }, finish,
    ];
}
