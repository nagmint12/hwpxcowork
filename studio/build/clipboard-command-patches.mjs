// 도구 막대의 단추도 단축키·우클릭과 같은 편집 명령을 실행한다.
export const CLIPBOARD_COMMAND_PATCHES = [
  ...[['cut', '오려두기'], ['copy', '복사하기']].map(([command, title]) => ({
    id: `wire-toolbar-${command}`,
    file: 'index.html',
    why: `${title} 단추의 누락된 data-cmd를 연결해 실제 클립보드 명령을 실행한다`,
    anchor: `<button class="tb-btn" title="${title} (Ctrl+${command === 'cut' ? 'X' : 'C'})"`,
    replace: anchor => anchor.replace('class="tb-btn"', `class="tb-btn" data-cmd="edit:${command}"`),
  })),
];
