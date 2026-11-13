// 플러그인 스타일 — <style id="cowork-style"> 하나를 iframe 문서 head 에 넣는다(docs/V3_SPEC.md §1.3 '스타일').
// 색 변수: --cw-memo, --cw-ai, --cw-prop, --cw-ins, --cw-del(+ 내 수정 --cw-mine). 사람 색은 요소마다 --cw-person 으로 받는다.
// 우클릭 메뉴는 studio 의 .md-item / .md-sep / .md-sub 모양을 그대로 쓰고, 머리글·하위 메뉴 패널·키보드 강조만 더한다.

const CSS = `
#scroll-container { touch-action: pan-x pan-y; }
@media (max-width: 767px) {
  :root:not(.cw-mobile-ruler) #editor-area {
    grid-template-columns: 0 minmax(0, 1fr);
    grid-template-rows: 0 minmax(0, 1fr);
  }
  :root:not(.cw-mobile-ruler) #ruler-corner,
  :root:not(.cw-mobile-ruler) #h-ruler,
  :root:not(.cw-mobile-ruler) #v-ruler { visibility: hidden; pointer-events: none; }
}
:root {
  --cw-memo: #f5c518; --cw-ai: #7c5cff; --cw-prop: #f08c00; --cw-ins: #2b8a3e; --cw-del: #e03131; --cw-mine: #1c7ed6;
  --cw-ai-text: #5a3fc0; --cw-ai-icon: #7c5cff; --cw-ai-soft: #f1edfb;
}
/* 어두운 화면(studio 보기 → 어둡게 — data-theme-effective): 메뉴·목록 바탕이 어두우므로 바로 보냄 보라를 밝은 연보라로.
   문서 위 강조·표식(--cw-ai)은 흰 종이 위라 그대로 둔다 */
:root[data-theme-effective="dark"] { --cw-ai-text: #d0bfff; --cw-ai-icon: #b197fc; --cw-ai-soft: rgba(151, 117, 250, 0.22); }
#scroll-content > .cowork-layer, #scroll-content > .cowork-marks {
  position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;
}
#scroll-content > .cowork-layer { z-index: 4; }
#scroll-content > .cowork-marks { z-index: 8; }
.cowork-layer > div, .cowork-marks > div { position: absolute; box-sizing: border-box; }
.cowork-layer > div { pointer-events: none; }
.cowork-marks > div { pointer-events: auto; }
.cowork-marks > div.cw-etag { cursor: default; } /* '● 이름' 입력 중 표는 알림만 — 누르기는 없고 마우스를 올리면 '이름 님이 입력 중' */

/* 강조 */
.cw-box.cw-memo, .cw-box.cw-comment, .cw-box.cw-review {
  background: rgba(245, 197, 24, 0.30); mix-blend-mode: multiply;
  border-bottom: 2px solid var(--cw-person, var(--cw-memo));
}
.cw-box.cw-request { background: rgba(124, 92, 255, 0.20); mix-blend-mode: multiply; border-bottom: 2px solid var(--cw-ai); }
.cw-box.cw-proposal { background: rgba(240, 140, 0, 0.07); border-bottom: 2px dashed var(--cw-prop); }
.cw-box.cw-proposal-after { border-bottom: 2px dashed var(--cw-prop); }
.cw-box.cw-ins { border-bottom: 2px solid var(--cw-ins); }
.cw-box.cw-resolved { opacity: 0.35; }
.cw-box.cw-active { outline: 2px solid rgba(28, 126, 214, 0.55); outline-offset: 1px; }
.cw-box.cw-memo.cw-active, .cw-box.cw-comment.cw-active, .cw-box.cw-review.cw-active { background: rgba(245, 197, 24, 0.55); }
.cw-box.cw-request.cw-active { background: rgba(124, 92, 255, 0.38); }
/* AI 작업 진행 단계(호스트 requestPhase — docs/UI_TERMS.md §6): 응답 대기 = 은은한 붉은 톤 · 처리 중 = 보라가 숨쉬듯 · 내 차례(확인 필요) = 테두리 · 실패 = 붉은 밑줄 */
.cw-box.cw-request.cw-ph-wait { background: rgba(214, 72, 86, 0.10); border-bottom: 2px dashed rgba(181, 71, 79, 0.65); }
.cw-box.cw-request.cw-ph-wait.cw-active { background: rgba(214, 72, 86, 0.20); }
.cw-box.cw-request.cw-ph-run { animation: cw-run 1.3s ease-in-out infinite alternate; }
@keyframes cw-run { from { background-color: rgba(124, 92, 255, 0.10); } to { background-color: rgba(124, 92, 255, 0.32); } }
.cw-box.cw-request.cw-ph-act { box-shadow: 0 0 0 1.5px rgba(31, 95, 191, 0.75); border-radius: 2px; }
.cw-box.cw-request.cw-ph-fail { background: rgba(224, 49, 49, 0.08); border-bottom-color: var(--cw-del); }
/* AI 처리 중 강조는 호스트의 상태 표시와 함께 '동작 줄이기' 설정에서도 재생한다. */
.cw-box.cw-flash { background: rgba(255, 196, 0, 0.55); mix-blend-mode: multiply; animation: cw-flash 0.4s ease-in-out 4 alternate; }
@keyframes cw-flash { from { opacity: 1; } to { opacity: 0.12; } }
/* 남이 바꾼 자리(V4 §2.4-5 — flash): 그 사람 색 밑줄이 1.5초 동안 깜빡인다(배경 없음 — 글을 가리지 않게) */
.cw-box.cw-rflash { border-bottom: 2px solid var(--cw-person, #1c7ed6); animation: cw-rflash 0.375s ease-in-out 4 alternate; }
@keyframes cw-rflash { from { opacity: 1; } to { opacity: 0.2; } }

/* 삭제 쐐기(변경 추적) */
.cw-wedge { width: 0 !important; height: 0 !important; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 7px solid var(--cw-del); cursor: help; }

/* 남의 수정 중: 왼쪽 여백 막대·이름표 / 내 수정: 얇은 막대·지운 자리 삼각형 */
.cw-dbar { background: var(--cw-person, #495057); border-radius: 2px; cursor: pointer; }
.cw-dbar.cw-active { box-shadow: 0 0 0 2px rgba(28, 126, 214, 0.45); }
.cw-dtag, .cw-etag {
  height: 16px; font: 600 11px/16px system-ui, 'Malgun Gothic', sans-serif; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; text-align: right; color: var(--cw-person, #495057); cursor: pointer;
}
.cw-dtag::before { content: ''; }
.cw-etag { font-weight: 500; opacity: 0.9; }
.cw-mine-bar { border-radius: 1px; }
.cw-mine-changed { background: var(--cw-mine); }
.cw-mine-inserted { background: var(--cw-ins); }
.cw-mine-del { width: 0 !important; height: 0 !important; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 7px solid var(--cw-del); }

/* 오른쪽 여백 원형 표식 */
.cw-mark {
  border-radius: 50%; font: 700 9px/16px system-ui, sans-serif; color: #fff; text-align: center; cursor: pointer;
  box-shadow: 0 0 0 1.5px #fff, 0 1px 3px rgba(0, 0, 0, 0.35); user-select: none;
}
.cw-mark-memo { background: var(--cw-memo); color: #5c4400; }
.cw-mark-ai { background: var(--cw-ai); }
.cw-mark-prop { background: var(--cw-prop); }
.cw-mark-draft { background: var(--cw-person, #495057); }
.cw-mark-mixed { background: conic-gradient(var(--cw-memo) 0 33%, var(--cw-ai) 0 66%, var(--cw-prop) 0); }
.cw-mark.cw-active { box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(28, 126, 214, 0.65); }

.cw-tip {
  position: fixed; z-index: 30000; max-width: 360px; padding: 6px 8px; border-radius: 6px; pointer-events: none;
  background: rgba(33, 37, 41, 0.94); color: #fff; font: 12px/1.45 system-ui, 'Malgun Gothic', sans-serif; white-space: pre-wrap; display: none;
}

/* 우클릭 '검토' 구역 */
.context-menu.cw-has-review { max-height: calc(100vh - 8px); overflow-y: auto; }
.cw-menu-head {
  display: flex; align-items: center; gap: 8px; padding: 4px 12px 3px 12px; cursor: default; user-select: none;
  font-size: var(--font-size-sm, 11px); font-weight: 700; color: var(--color-text-hint, #868e96);
}
.cw-menu-head::after { content: ''; flex: 1; border-top: 1px solid var(--ui-border-subtle, #dee2e6); }
.context-menu .cw-ico {
  position: absolute; left: 9px; top: 50%; margin-top: -8px; width: 16px; height: 16px; line-height: 16px;
  text-align: center; font-size: 12px; color: var(--color-text-hint, #868e96);
}
.context-menu .cw-row .md-shortcut { padding-left: 20px; }
.context-menu .cw-kb, .context-menu .cw-sub.cw-open { background: var(--ui-selected, #e7f1ff); color: var(--color-primary-dark, #1c4f8c); }
.cw-sub-panel {
  display: none; position: fixed; min-width: 168px; padding: 4px 0; z-index: 20001;
  background: var(--color-surface, #fff); border: 1px solid var(--ui-border, #ced4da); box-shadow: var(--shadow-dropdown, 0 4px 12px rgba(0,0,0,.15));
  font-size: var(--font-size-base, 13px);
}
.cw-sub.cw-open > .cw-sub-panel { display: block; }
.cw-sub-panel .md-item { color: var(--color-text, #212529); }
/* 바로 AI 에게 보내는 항목(docs/UI_TERMS.md §4): 보라 아이콘·글자, 하위 메뉴 머리글 = 보낼 곳('Claude Code로 보내기') */
.context-menu .cw-row.cw-send .cw-ico, .cw-sub-panel .md-item.cw-send .cw-ico { color: var(--cw-ai-icon); }
.context-menu .cw-row.cw-send .md-label, .cw-sub-panel .md-item.cw-send .md-label { color: var(--cw-ai-text); }
.cw-sub-panel .cw-menu-head { color: var(--cw-ai-text); font-weight: 600; }

/* 미니 도구 막대 */
.cw-mini {
  position: fixed; z-index: 19000; display: flex; align-items: center; gap: 2px; padding: 3px;
  background: var(--color-surface, #fff); border: 1px solid var(--ui-border, #ced4da); border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16); font: 12px/1 system-ui, 'Malgun Gothic', sans-serif; user-select: none;
}
.cw-mini button {
  border: 0; background: transparent; color: var(--color-text, #212529); padding: 5px 8px; border-radius: 4px; cursor: pointer;
  font: inherit; white-space: nowrap;
}
.cw-mini button:hover, .cw-mini button.cw-on { background: var(--ui-selected, #e7f1ff); color: var(--color-primary-dark, #1c4f8c); }
.cw-mini .cw-mini-sep { width: 1px; align-self: stretch; margin: 2px 1px; background: var(--ui-border-subtle, #dee2e6); }
.cw-mini-drop {
  position: fixed; z-index: 19001; min-width: 140px; padding: 4px 0; background: var(--color-surface, #fff);
  border: 1px solid var(--ui-border, #ced4da); border-radius: 6px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  font: 12px/1 system-ui, 'Malgun Gothic', sans-serif;
}
.cw-mini-drop button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 7px 12px; cursor: pointer; font: inherit; color: var(--color-text, #212529); }
.cw-mini-drop button:hover { background: var(--ui-selected, #e7f1ff); }
.cw-mini-drop .cw-mini-head { padding: 5px 12px 4px; font-size: 11px; font-weight: 600; color: var(--cw-ai-text); cursor: default; }
.cw-mini-drop .cw-mini-line { margin: 3px 0; border-top: 1px solid var(--ui-border-subtle, #dee2e6); }
.cw-mini-drop button.cw-send { color: var(--cw-ai-text); }
.cw-mini-drop button.cw-send::before { content: '✦'; display: inline-block; width: 14px; font-size: 10px; color: var(--cw-ai-icon); }
.cw-mini-drop button.cw-send:hover { background: var(--cw-ai-soft); }
`;

export function injectStyle(): void {
  if (document.getElementById('cowork-style')) return;
  const el = document.createElement('style');
  el.id = 'cowork-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function removeStyle(): void {
  document.getElementById('cowork-style')?.remove();
}
