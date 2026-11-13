export const TOUCH_MENU_PATCHES = [{
  id: 'context-menu-select-all',
  file: 'src/ui/context-menu.ts',
  why: '본문·표·그림 우클릭 메뉴에 실제 전체 선택 명령을 제공한다',
  anchor: "    const menu = document.createElement('div');\n    menu.className = 'context-menu';",
  replace: anchor => `    if (!items.some(item => item.commandId === 'edit:select-all')) {\n      items = [{ type: 'command', commandId: 'edit:select-all', label: '전체 선택' }, { type: 'separator' }, ...items];\n    }\n${anchor}`,
}];
