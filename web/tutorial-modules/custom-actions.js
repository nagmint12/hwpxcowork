// 설정에는 동작의 이름과 인수만 저장합니다. 실행 코드는 이 등록부에서 관리합니다.
import { typeInTutorialField, tutorialExampleAction } from './common.js';

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
    click: target };
  if (ref.actionId === 'type-text') return {
    ...base, ring: () => env.pad(targetRect(), 4), open: () => params.scope === 'editor' ? env.frameRect() : targetRect(),
    motion: () => ({ rect: targetRect(), mode: 'typing' }),
    action: tutorialExampleAction(params.value, () => typeInTutorialField(env, target(), params.value, ref.title, { instant: true })),
    until: () => !!target() && String(target().value) === params.value };
  if (ref.actionId === 'select-text') return {
    ...base, ring: () => env.phraseRect(params.text), open: env.frameRect, 
    until: () => {
      const at = env.locate?.(params.text); const selected = env.s?.selection;
      return !!at && !!selected && !selected.collapsed && selected.ref === at.ref
        && (!selected.endRef || selected.endRef === at.ref)
        && selected.start === at.start && selected.end === at.end && selected.text === params.text
        && (!selected.refs || (selected.refs.length === 1 && selected.refs[0] === at.ref));
    } };
  throw new Error(`등록되지 않은 custom 동작입니다: ${ref.actionId}`);
}
