const MAIN='src/main.ts',OPTIONS='src/ui/options-dialog.ts';
export const MOBILE_VIEW_PATCHES=[
  {id:'mobile-editor-shared-ui',file:MAIN,why:'웹·기본 편집기·APK가 같은 도구 접기와 문서 배율 핀치를 쓴다',
    anchor:'const initPromise = initialize();',replace:a=>`import { installMobileEditorUI } from '@cowork/web/mobile-editor.js';\n${a}\ninitPromise.then(() => installMobileEditorUI({\n  getZoom: () => canvasView!.getViewportManager().getZoom(),\n  setZoom: (zoom: number, anchor: {x:number;y:number}) => canvasView!.getViewportManager().setZoom(zoom,anchor),\n}));`},
  {id:'mobile-options-import',file:OPTIONS,why:'환경 설정의 모바일 전용 터치 민감도 탭',
    anchor:"import { ModalDialog } from './dialog';",replace:a=>`${a}\nimport { createMobileSettingsPanel, saveMobileSettingsPanel } from '@cowork/web/mobile-settings.js';`},
  {id:'mobile-options-state',file:OPTIONS,why:'설정 창 취소 시 저장하지 않도록 입력 패널을 보관한다',
    anchor:'  private showRecentCheck!: HTMLInputElement;',replace:a=>`  private mobileHoldPanel: HTMLElement | null = null;\n${a}`},
  {id:'mobile-options-tab',file:OPTIONS,why:'모바일에서만 0.1~2초 설정을 표시한다',
    anchor:'    // 탭 클릭 이벤트 (향후 탭 추가 대비)',replace:a=>`    this.mobileHoldPanel = createMobileSettingsPanel(document);\n    if (this.mobileHoldPanel) {\n      const mobileTab = document.createElement('button');\n      mobileTab.className = 'dialog-tab active'; mobileTab.textContent = '모바일'; mobileTab.dataset.tab = 'mobile';\n      tabs.querySelectorAll('.dialog-tab').forEach(t => t.classList.remove('active'));\n      body.querySelectorAll('.dialog-tab-panel').forEach(p => p.classList.remove('active'));\n      this.mobileHoldPanel.className = 'dialog-tab-panel opt-tab-panel active'; this.mobileHoldPanel.dataset.tab = 'mobile';\n      tabs.appendChild(mobileTab); body.appendChild(this.mobileHoldPanel);\n    }\n\n${a}`},
  {id:'mobile-options-save',file:OPTIONS,why:'확인을 누를 때만 기기에 민감도를 저장한다',
    anchor:'  protected onConfirm(): void {',replace:a=>`${a}\n    saveMobileSettingsPanel(this.mobileHoldPanel);`},
];
