// 기능별 튜토리얼 단계. 실행기와 코스 구성은 이 파일 밖에서 관리합니다.
import { stepHelpers, el, length, image, practice, external, commandExample, typeInTutorialField } from './common.js';

// 우발적인 문단 재배치·삭제·다른 글 수정을 감지하는 작은 서명입니다(인증용 해시 아님).
// 본문 전체를 진행 ctx에 넣으면 서버의 32KB 진행 저장 상한을 넘을 수 있습니다.
const paragraphSignature = paragraphs => {
  const value = JSON.stringify(paragraphs.map(p => [p.ref, String(p.text || '')]));
  let first = 2166136261; let second = 5381;
  for (const ch of value) { const code = ch.codePointAt(0); first = Math.imul(first ^ code, 16777619); second = Math.imul(second, 33) ^ code; }
  return `${value.length}:${first >>> 0}:${second >>> 0}`;
};

export function buildEditorBasics(env) {
  const { d, s, ctx, config, focusIn, rectOf, pad, q, fdoc, inFrame, frameRect, selectFor, locate, phraseRect, cw } = env;
  const { finish, intro, paragraph, focus, frameButton, frameDialog, closeFrameDialog, openShape, reveal, top, fill } = stepHelpers(env);
    // 실제 입력·선택·메모·답글을 사용자가 직접 하고, 안내 단추는 막혔을 때의 대안으로만 둔다(2026-11-01)
    const PRACTICE = '이 문단의 아무 글이나 고쳐 보세요';
    // 문단 번호는 삽입·삭제 뒤 바뀝니다. 최초 본문 순서와 다른 문단의 내용이 모두
    // 유지될 때만 연습 문단을 식별합니다. 구조가 달라지면 checkpoint 복구로 돌립니다.
    const anchoredPractice = () => {
      const baseline = ctx.overviewAnchor; if (!baseline) return null;
      const now = s.paragraphs || []; if (now.length !== baseline.count) return null;
      const index = baseline.index;
      if (!now[index] || now[index].ref !== baseline.ref || paragraphSignature(now.filter((_, k) => k !== index)) !== baseline.others) return null;
      return now[index];
    };
    const practiceRef = () => anchoredPractice()?.ref || null;
    const requirePractice = () => { const p = anchoredPractice(); if (!p) throw new Error('연습 문단의 위치가 바뀌었습니다. [이 단계 다시하기]로 문서를 복구해 주세요.'); return p; };
    const editorText = () => { try { const ref = practiceRef(); return ref ? cw()?.debug?.text?.(ref) ?? null : null; } catch { return null; } };
    const edited = () => editorText() != null && ctx.overviewOriginal != null && editorText() !== ctx.overviewOriginal;
    const saved = () => !s.draft?.dirty && !s.draft?.saving;
    const practiceRing = () => phraseRect(['이 문단의 아무 글이나', '글을 고치는 연습을 했습니다', '이 문단'].find(t => locate(t)) || '이 문단');
    const memoPicked = () => env.toolbarShown?.() && env.selHas?.('아무 글');
    const filled = box => String(box?.querySelector('textarea')?.value || '').trim();
    const memoBox = () => q('.popover .memoedit');
    const replyBox = () => (memoCard() && q('.memoedit', memoCard())) || (s.reply?.memoId === ctx.overviewMemoId ? q('.quickreply .memoedit') : null);
    const memoOf = () => (s.memos || []).find(m => m.id === ctx.overviewMemoId);
    const memoCard = () => { const m = memoOf(); return m ? q(`.rcard[data-kind="memo"][data-id="${m.id}"]`) : null; };
    const memoTarget = target => { const at = locate('이 문단의 아무 글이나'); return !!at && !!target && target.ref === at.ref && (!target.endRef || target.endRef === at.ref) && target.start === at.start && target.end === at.end; };
    const freshMemo = () => (s.memos || []).find(m => !(ctx.overviewMemoIds || []).includes(m.id) && !m.link && memoTarget(m));
    const replies = () => (memoOf()?.thread?.replies || []).length;
    return [
      intro('처음 쓰기 — 화면부터 익혀 봅니다', '임시 문서에서 글 고치기·저장 상태·메모·답글·작업 창·한글 저장을 직접 해 봅니다. 막히면 안내창의 노란 단추가 대신 해 줍니다.'),
      { title: '제목과 저장 상태', text: '위쪽은 문서 제목과 저장 상태입니다. 지금은 본인만 쓰는 임시 연습 문서입니다. ‘실시간 · 저장됨’이 되면 편집 내용이 연습 문서에 저장된 것입니다.', ring: top('[data-testid="doc-title"]'), open: () => rectOf(q('.v3bar')), next: '확인했어요' },
      { title: '문장을 직접 고쳐 보기', text: () => (edited() ? '잘했습니다. 위쪽 저장 상태가 ‘저장됨’이 되면 다음으로 넘어갑니다.' : `금빛 테두리 안 연습 문장을 ${env.touch ? '눌러' : '클릭해'} 커서를 놓고, 글자를 지우거나 덧붙여 보세요. 입력하면 위쪽 저장 상태가 ‘저장 중’을 거쳐 ‘저장됨’으로 바뀝니다.`),
        enter: () => { const p = focus('이 문단의 아무 글이나'); if (p && ctx.overviewOriginal == null) { ctx.overviewEditRef = p.ref; ctx.overviewOriginal = p.text; } if (p && !ctx.overviewAnchor && p.text === ctx.overviewOriginal) { const paragraphs = s.paragraphs || []; const index = paragraphs.indexOf(p); ctx.overviewAnchor = { count: paragraphs.length, index, ref: p.ref, others: paragraphSignature(paragraphs.filter((_, k) => k !== index)) }; } }, ring: practiceRing, open: frameRect,
        action: { label: '연습 문장 고치기', show: () => !edited(), run: async () => { const p = requirePractice(); const at = locate(PRACTICE); if (!at || at.ref !== p.ref) throw new Error('연습 문장을 찾지 못했습니다. [이 단계 다시하기]로 복구해 주세요.'); const ticket = env.stepIdentity?.(); const result = await d.editor.applyText({ ...at, find: PRACTICE, replace: '이 문단에서 글을 고치는 연습을 했습니다' }); if (env.stepIdentity && env.stepIdentity() !== ticket) return; if (!result?.ok) throw new Error('문장을 고치지 못했습니다. 편집기가 준비된 뒤 다시 눌러 주세요.'); await d.saveDraftNow(); if (env.stepIdentity && env.stepIdentity() !== ticket) return; await d.refresh(['paragraphs','info']); } },
        until: () => edited() && saved() },
      { title: '고친 글 되돌리기', text: () => (env.touch ? '이번에는 고친 문장을 원래대로 돌려 놓습니다. 아래 [원래 문장으로]를 누르세요. 키보드가 있으면 Ctrl+Z로도 되돌립니다.' : '이번에는 고친 문장을 원래대로 돌려 놓습니다. 원래 문장이 될 때까지 Ctrl+Z를 눌러 보세요. 아래 [원래 문장으로]도 같은 결과입니다.'),
        ring: practiceRing, open: frameRect,
        action: { label: '원래 문장으로', run: async () => { const p = requirePractice(); const cur = editorText(); if (cur == null || ctx.overviewOriginal == null) throw new Error('연습 문장을 찾지 못했습니다. [이 단계 다시하기]로 복구해 주세요.'); if (cur !== ctx.overviewOriginal) { const ticket = env.stepIdentity?.(); const result = await d.editor.applyText({ ref: p.ref, find: cur, replace: ctx.overviewOriginal }); if (env.stepIdentity && env.stepIdentity() !== ticket) return; if (!result?.ok) throw new Error('원문으로 되돌리지 못했습니다'); await d.saveDraftNow(); if (env.stepIdentity && env.stepIdentity() !== ticket) return; await d.refresh(['paragraphs','info']); } } },
        until: () => editorText() != null && editorText() === ctx.overviewOriginal && saved() },
      { title: '의견을 남길 글 선택', text: () => (memoPicked() ? '도구 막대의 [메모]를 누르세요.' : `‘이 문단의 아무 글이나’를 ${env.dragHow || '끌어'} 고르세요. 손을 떼면 글 위에 작은 도구 막대가 나옵니다.`),
        ring: () => (memoPicked() ? pad(inFrame(env.toolbarBtn('memo')), 4) : phraseRect('이 문단의 아무 글이나')), open: frameRect,
        action: { label: '글을 고르고 메모 열기', run: async () => { const ticket = env.stepIdentity?.(); const p = focus('이 문단의 아무 글이나'); if (!p) throw new Error('연습 문장을 찾지 못했습니다'); const t = await selectFor('이 문단의 아무 글이나'); if (env.stepIdentity && env.stepIdentity() !== ticket) return; if (!t) throw new Error('연습 글을 다시 선택해 주세요.'); d.openPopover('memo', t, null); } }, until: () => s.popover?.kind === 'memo' && memoTarget(s.popover.target) },
      { title: '메모를 직접 남기기', text: () => (filled(memoBox()) ? '[메모 달기]를 누르세요. 이 의견은 완료한 HWPX와 한/글에서도 메모로 보입니다.' : '메모 칸에 의견을 적으세요. 예: 「튜토리얼에서 남긴 메모입니다.」'),
        ring: () => pad(rectOf(filled(memoBox()) ? q('.popover .memoedit button.primary') : q('.popover .memoedit textarea')), 4), open: () => rectOf(q('.popover')),
        enter: () => { ctx.overviewMemos ??= (s.memos || []).length; ctx.overviewMemoIds ||= (s.memos || []).map(m => m.id); },
        action: { label: '예시 메모 넣기', show: () => !filled(memoBox()), run: () => fill('.popover .memoedit textarea', '튜토리얼에서 남긴 메모입니다. 이 문장을 함께 확인해 주세요.') },
        until: () => !!freshMemo(), lost: () => (!s.popover && !freshMemo() ? 4 : null),
        leave: () => { ctx.overviewMemoId = freshMemo()?.id || null; } },
      { title: '여백의 메모와 답글', text: () => `방금 단 메모가 ${env.besideOrBelow?.(memoCard()) === '아래' ? '아래 메모 목록' : '문서 옆 여백'}에 있습니다. 메모는 끌어 옮길 수 있고, 답글로 의견을 이어갈 수 있습니다. 메모의 [답글]을 누르세요.`,
        ring: () => pad(rectOf(q('.rc-reply', memoCard())), 4), click: () => q('.rc-reply', memoCard()), reveal: () => q('.rc-reply', memoCard()), open: () => pad(rectOf(memoCard()), 8),
        action: { label: '메모 답글 열기', run: () => { const m = memoOf(); if (!m) throw new Error('방금 단 메모를 찾지 못했습니다'); s.active = { kind: 'memo', id: m.id }; d.openReply({ key: Date.now(), kind: 'memo', memoId: m.id, ref: m.ref, quote: m.text || m.body || '', anchor: null }); } }, until: () => !!memoOf() && (!!(memoCard() && q('.memoedit', memoCard())) || s.reply?.memoId === ctx.overviewMemoId) },
      { title: '답글도 남겨 보기', text: () => (filled(replyBox()) ? '[답글 달기]를 누르세요. 보라색 [AI에게 요청]은 실제 AI 작업을 보내는 다른 기능입니다.' : '답글 칸에 의견을 적으세요. 예: 「확인했습니다. 이 의견을 참고하겠습니다.」'),
        ring: () => pad(rectOf(filled(replyBox()) ? replyBox()?.querySelector('button.primary') : replyBox()?.querySelector('textarea')), 4),
        reveal: () => (filled(replyBox()) ? replyBox()?.querySelector('button.primary') : replyBox()?.querySelector('textarea')), open: () => pad(rectOf(replyBox() || memoCard()), 6),
        enter: () => { ctx.overviewReplies ??= replies(); },
        action: { label: '예시 답글 넣기', show: () => !filled(replyBox()), run: () => typeInTutorialField(env, replyBox()?.querySelector('textarea'), '확인했습니다. 이 의견을 참고하겠습니다.', '답글도 남겨 보기') },
        until: () => replies() > (ctx.overviewReplies ?? 0) },
      { title: 'AI 작업과 메모를 모아 보기', text: () => `${env.besideOrBelow?.(q('.panel')) === '아래' ? '아래' : '오른쪽'} 창의 AI 작업·메모 탭에서 요청과 의견을 모아 볼 수 있습니다. 넓은 화면에서 창을 접었다면 오른쪽 가장자리의 탭으로 다시 펼칩니다.`, ring: top('.panel [role="tablist"], .panel'), enter: () => { s.tab = 'review'; }, next: '확인했어요' },
      { title: '한글 파일로 내려받기', text: () => `${env.saveButton?.() || !q('[data-testid="bar-more-toggle"]') ? '위 [한글로 저장]' : '위 [⋯] 메뉴의 [한글로 저장]'}으로 HWPX 파일을 받을 수 있습니다. 다운로드와 개인 문서함 저장은 구분됩니다. 다음 단계에서 완료하면 연습 문서를 개인 문서함에도 보관합니다.`,
        ring: () => pad(rectOf(env.saveButton?.() || q('[data-testid="bar-more-toggle"]')), 4), open: () => pad(rectOf(env.saveButton?.() || q('[data-testid="bar-more-toggle"]')), 4), next: '완료 단계로' }, finish,
    ];
}
