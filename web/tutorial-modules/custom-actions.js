// 설정에는 동작의 이름과 인수만 저장합니다. 실행 코드는 이 등록부에서 관리합니다.
import { typeTutorialInput } from '../tutorial-motion.js';

export function buildCustomAction(ref, env) {
  const params = ref.params || {};
  const target = () => {
    try { return params.scope === 'editor' ? env.fdoc()?.querySelector(params.selector) : env.q(params.selector); }
    catch { return null; }
  };
  const targetRect = () => params.scope === 'editor' ? env.inFrame(target()) : env.rectOf(target());
  const base = { title: ref.title, text: ref.text };
  if (ref.actionId === 'notice') return { ...base, center: true, next: '다음 단계' };
  if (ref.actionId === 'click-target') return {
    ...base, ring: () => env.pad(targetRect(), 4), open: () => params.scope === 'editor' ? env.frameRect() : targetRect(),
    click: target, frameClick: params.scope === 'editor', advanceOnClick: true,
  };
  if (ref.actionId === 'type-text') return {
    ...base, ring: () => env.pad(targetRect(), 4), open: () => params.scope === 'editor' ? env.frameRect() : targetRect(),
    motion: () => ({ rect: targetRect(), mode: 'typing' }),
    action: { label: '예시 입력하기', run: async () => {
      const input = target();
      if (!input || !/^(INPUT|TEXTAREA)$/.test(input.tagName) || input.readOnly || input.disabled) throw new Error('입력할 수 있는 칸을 찾지 못했습니다. 대상 창을 연 뒤 다시 시도하세요.');
      input.focus();
      await typeTutorialInput({ input, text: params.value, current: () => target() === input && env.isCurrentStep?.(ref.title) !== false, reduced: env.motionReduced });
    } },
    until: () => !!target() && String(target().value) === params.value,
  };
  if (ref.actionId === 'select-text') return {
    ...base, ring: () => env.phraseRect(params.text), open: env.frameRect,
    action: { label: '연습 글 선택하기', run: async () => {
      if (!await env.selectFor(params.text)) throw new Error('연습 문서에서 선택할 글을 찾지 못했습니다.');
    } },
    until: () => !!env.selHas?.(params.text),
  };
  throw new Error(`등록되지 않은 custom 동작입니다: ${ref.actionId}`);
}
