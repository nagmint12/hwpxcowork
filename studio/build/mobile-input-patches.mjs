// InputHandler 자체에서 설치하므로 cowork 플러그인 없이 연 편집기에도 적용된다.
const INPUT = 'src/engine/input-handler.ts';
export const MOBILE_INPUT_PATCHES = [
  {
    id: 'engine-mobile-hold-input-import', file: INPUT,
    why: '편집기 엔진의 모든 IME 포커스 경로에 모바일 길게 누르기 정책을 연결한다',
    anchor: "import * as _mouse from './input-handler-mouse';",
    replace: a => `${a}\nimport { installHoldToEdit } from '@cowork/web/hold-to-edit.js';`,
  },
  {
    id: 'engine-mobile-hold-input-state', file: INPUT,
    why: '문서 입력기 수명과 모바일 포커스 정책의 수명을 맞춘다',
    anchor: '  private textarea: HTMLTextAreaElement;',
    replace: a => `${a}\n  private disposeHoldToEdit: (() => void) | null = null;`,
  },
  {
    id: 'engine-mobile-hold-input-install', file: INPUT,
    why: 'textarea와 iOS contenteditable 모두 짧은 터치·자동 포커스로 키보드를 열지 않는다',
    anchor: '    this.onClickBound = this.onClick.bind(this);',
    replace: a => `    this.disposeHoldToEdit = installHoldToEdit(this.textarea, { surface: this.container });\n\n${a}`,
  },
  {
    id: 'engine-mobile-hold-input-dispose', file: INPUT,
    why: '입력기 종료 때 길게 누르기 타이머·문서 이벤트를 제거한다',
    anchor: '    this.textarea.remove();',
    replace: a => `    this.disposeHoldToEdit?.();\n    this.disposeHoldToEdit = null;\n${a}`,
  },
];
