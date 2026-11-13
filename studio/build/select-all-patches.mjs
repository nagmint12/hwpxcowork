// 개체(그림·선·도형·표)를 고른 채 모두 선택(Ctrl+A) = 문서 전체 — 한/글 2022 실측(2026-11-04).
// 숨은 한/글에서 선 개체를 FindCtrl 로 고르면 CurSelectedCtrl=gso·SelectionMode 4, 이때 복사는 그 개체만(보드 8,009B·글 0자).
// 여기서 SelectAll 을 하면 CurSelectedCtrl 없음·SelectionMode 1 이 되고 복사는 문서 전체(보드 537,149B·글 3,450자 — 개체를 고르지
// 않은 모두 선택 537,293B 와 같은 범위). 표를 개체로 고른 경우도 같다(표만 50,603B → 모두 선택 뒤 968,132B = 그냥 모두 선택).
// 편집기는 개체 선택을 그대로 둔 채 범위만 바꿔, 이어지는 Ctrl+C 가 고른 개체만 복사했다(npm run test:clipboard:hancom 튜토리얼
// 문서: 표지 첫 문단의 선을 누른 뒤 Ctrl+A·C → 한/글에 선 하나만 붙음). 표는 키 처리 폴스루가 표 선택을 먼저 풀어 캐럿이 칸 안에
// 남아 칸 내용만 골랐다.
const KEYBOARD = 'src/engine/input-handler-keyboard.ts';

export const SELECT_ALL_PATCHES = [
  {
    id: 'select-all-releases-object-selection',
    file: KEYBOARD,
    why: '개체 선택 중 모두 선택은 개체 선택을 풀고 문서 전체를 고른다(한/글 2022 실측) — 개체만 복사되던 결함',
    anchor: 'export function handleSelectAll(this: any): void {\n',
    replace: (a) => `${a}  // [hwpx-cowork] 2026-11-04 개체(그림·도형·표) 선택 중 모두 선택 = 개체 선택을 풀고 문서 전체(한/글 2022 실측, studio/build/select-all-patches.mjs).
  // 개체 밖으로 캐럿을 옮겨(본문 개체면 본문) 아래 셀 안 규칙이 개체가 든 칸을 고르지 않게 한다.
  if (this.cursor.isInPictureObjectSelection?.()) {
    this.cursor.moveOutOfSelectedPicture();
    this.pictureObjectRenderer?.clear();
    this.eventBus.emit('picture-object-selection-changed', false);
  }
  if (this.cursor.isInTableObjectSelection?.()) {
    this.cursor.moveOutOfSelectedTable();
    this.eventBus.emit('table-object-selection-changed', false);
  }
`,
  },
  {
    id: 'select-all-from-table-object-selection',
    file: KEYBOARD,
    why: '표 개체 선택 중 Ctrl+A 는 표 선택을 푸는 폴스루보다 먼저 모두 선택으로 보낸다(그래야 위 패치가 표 밖에서 문서 전체를 고른다)',
    anchor: '    // 그 외 키 → 표 객체 선택 해제 후 기본 키 처리\n    this.cursor.exitTableObjectSelection();\n',
    replace: (a) => `    // [hwpx-cowork] 2026-11-04 표 개체 선택 중 Ctrl+A = 문서 전체(한/글 2022 실측) — 폴스루는 캐럿을 칸 안에 두어 칸 내용만 골랐다
    if (matchShortcut(e, defaultShortcuts) === 'edit:select-all') {
      e.preventDefault();
      this.dispatcher?.dispatch('edit:select-all');
      return;
    }
${a}`,
  },
];
