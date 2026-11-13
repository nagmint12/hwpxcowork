import { navigateLink } from '../core/link-navigation';
import { showLinkDestinationDialog } from '../ui/link-destination-dialog';
/** 링크의 실제 글자 선택 영역 안에서만 hover/열기/우클릭 대상을 찾는다. */
import { hyperlinkTarget, applyHyperlinkFormat } from '@/core/hyperlink';
import type { HyperlinkInfo, HyperlinkTarget } from '@/core/hyperlink';
import type { DocumentPosition } from '@/core/types';
import { showToast } from '@/ui/toast';
import { t } from '../i18n/index.ts';

type LinkHit = { target: HyperlinkTarget; link: HyperlinkInfo; position: DocumentPosition };

/** [hwpx-cowork] 문서 안 링크(한/글 차례 항목 `?#<문단·개체 id>;…`, 책갈피 `?이름;…`)인가 */
export function isInternalLink(uri: string): boolean {
  return /^\?/.test(uri) || /^#/.test(uri);
}

/**
 * 누른 자리의 링크. internal 이 참이면 문서 안 링크(차례 항목)도 — 그 링크는 웹 주소가 아니라 가리킬 뿐이므로
 * 우클릭의 '하이퍼링크 고치기'(웹 주소 대화상자)에는 넘기지 않는다.
 */
export function hyperlinkAtPointer(self: any, e: MouseEvent, internal = false): LinkHit | null {
  if (!self.wasm?.getHyperlinkContext || !self.canEditHyperlink?.() || self.connectorDrawingMode
    || self.polygonDrawingMode || self.imagePlacementMode || self.textboxPlacementMode) return null;
  const content = self.container.querySelector('#scroll-content');
  if (!content) return null;
  try {
    const box = content.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const page = self.virtualScroll.getPageAtPoint(x, y);
    if (page < 0 || page >= self.wasm.pageCount) return null;
    const zoom = self.viewportManager.getZoom();
    const px = (x - self.virtualScroll.getPageLeftResolved(page, content.clientWidth)) / zoom;
    const py = (y - self.virtualScroll.getPageOffset(page)) / zoom;
    const hit = self.wasm.hitTest(page, px, py);
    const target = hyperlinkTarget(hit);
    const context = self.wasm.getHyperlinkContext(target);
    for (const link of context.links as HyperlinkInfo[]) {
      if (!self.wasm.classifyHyperlinkDestination(link.uri)) continue;
      // [hwpx-cowork] 문서 안 연결(책갈피·차례)은 internal(Ctrl+클릭 경로)일 때만 잡는다 — 0.9.0 분류 위에 얹은 우리 규칙.
      if (isInternalLink(link.uri) && !internal) continue;
      // caret hit-test는 글자 오른쪽 절반에서 다음 offset을 반환할 수 있다.
      if (hit.charOffset < link.start || hit.charOffset > link.end) continue;
      const path = target.cellPath;
      const rects = path.length ? self.wasm.getSelectionRectsInCellByPath(target.section, target.para,
        JSON.stringify(path.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex }))),
        path[path.length - 1][2], link.start, path[path.length - 1][2], link.end)
        : self.wasm.getSelectionRects(target.section, target.para, link.start, target.para, link.end);
      if (rects.some((r: any) => r.pageIndex === page && px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height)) {
        return { target, link, position: { ...hit, charOffset: link.start } };
      }
    }
  } catch { /* 미지원 문서 컨텍스트는 일반 글자 편집으로 처리한다. */ }
  return null;
}

export function hoverHyperlink(self: any, e: MouseEvent): boolean {
  if (self.hyperlinkHover) {
    self.container.removeAttribute('title');
    if (self.container.style.cursor === 'pointer') self.container.style.cursor = '';
    self.hyperlinkHover = false;
  }
  const hit = hyperlinkAtPointer(self, e, true);
  if (!hit) return false;
  self.container.title = isInternalLink(hit.link.uri) ? internalLinkTitle(self, hit.link.uri) : hit.link.uri;
  self.container.style.cursor = 'pointer';
  self.hyperlinkHover = true;
  return true;
}

export function rememberHyperlinkClick(self: any, e: MouseEvent): void {
  self.hyperlinkClick = null;
  if (e.button !== 0 || e.shiftKey || e.altKey) return;
  const hit = hyperlinkAtPointer(self, e, true);
  if (hit) self.hyperlinkClick = { hit, x: e.clientX, y: e.clientY, generation: self.wasm.documentGeneration };
}

export function followHyperlinkClick(self: any, e: MouseEvent): void {
  const pending = self.hyperlinkClick;
  self.hyperlinkClick = null;
  if (!pending || e.button !== 0 || Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > 3
    || pending.generation !== self.wasm.documentGeneration || self.cursor.hasSelection()) return;
  const current = hyperlinkAtPointer(self, e, true);
  if (!current || current.link.fieldId !== pending.hit.link.fieldId || current.link.uri !== pending.hit.link.uri
    || JSON.stringify(current.target) !== JSON.stringify(pending.hit.target)) return;
  if (isInternalLink(current.link.uri)) { followInternalLink(self, current.link.uri); return; }
  try {
    const destination = self.wasm.classifyHyperlinkDestination(current.link.uri);
    if (!destination) return;
    const generation = self.wasm.documentGeneration;
    const followed = navigateLink(destination, { fileName: self.wasm.fileName, sourceFormat: self.wasm.getSourceFormat() }, {
      anchor: name => {
        const bookmark = self.wasm.getBookmarks().find((item: any) => item.name === name);
        if (!bookmark || !self.moveCursorTo({ sectionIndex: bookmark.sec, paragraphIndex: bookmark.para, charOffset: bookmark.charPos })) {
          showToast({ message: '연결된 문서 책갈피를 찾거나 이동할 수 없습니다.' }); return false;
        }
        return true;
      },
      web: uri => {
        const url = new URL(uri);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
        const opened = window.open('about:blank', '_blank');
        if (!opened) { showToast({ message: '팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요.' }); return false; }
        opened.opener = null; opened.location.replace(url.href); return true;
      },
      mail: uri => { window.location.assign(uri); return true; },
      browserFallback: showLinkDestinationDialog,
    });
    void Promise.resolve(followed).then(handled => {
      if (!handled || self.wasm.documentGeneration !== generation) return;
    // 한컴의 방문 색과 같이 글자 서식으로 반영한다. 저장·PDF·undo에도 같은 색이 남는다.
    // 읽기 전용/양식 편집에서는 executeOperation의 기존 정책이 변경을 차단한다.
    self.executeOperation({
      kind: 'snapshot', operationType: 'visitHyperlink', selectionBefore: null,
      operation: (wasm: any) => {
        const { target, link } = current;
        const path = JSON.stringify(target.cellPath.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex })));
        const props = target.cellPath.length
          ? wasm.getCellCharPropertiesAtByPath(target.section, target.para, path, link.start)
          : wasm.getCharPropertiesAt(target.section, target.para, link.start);
        if (props.textColor?.toLowerCase() === '#800080') return null;
        applyHyperlinkFormat(wasm, target, link.start, link.end, '#800080');
        return self.cursor.getPosition();
      },
    });
    }).catch(error => { showToast({ message: error instanceof Error ? error.message : String(error) }); });
  } catch (error) {
    showToast({ message: error instanceof Error ? error.message : String(error) });
  }
}

/** [hwpx-cowork] 문서 안 링크가 가리키는 문단의 글(툴팁) */
function internalLinkTitle(self: any, uri: string): string {
  try {
    const target = self.wasm.findHyperlinkTarget?.(uri);
    if (!target) return uri;
    const len = self.wasm.getParagraphLength(target.sec, target.para);
    const text = String(self.wasm.getTextRange(target.sec, target.para, 0, Math.min(len, 40)) ?? '').replace(/\s+/g, ' ').trim();
    return t('editor.link.internalTitle', { text: text || uri });
  } catch {
    return uri;
  }
}

/**
 * [hwpx-cowork] 문서 안 링크(차례 항목)를 누르면 그 문단으로 간다 — 한/글처럼 누르면 바로 이동.
 * 대상이 표·그림이면 그 개체를 품은 문단 머리로. 갈 수 없는 문단(표만 든 문단 등)은 가까운 문단으로.
 */
export function followInternalLink(self: any, uri: string): boolean {
  const target = self.wasm.findHyperlinkTarget?.(uri);
  if (!target) { showToast({ message: t('editor.link.noTarget') }); return false; }
  self.exitFootnoteModeForBodyNavigation?.();
  for (let d = 0; d <= 3; d++) {
    for (const p of d === 0 ? [target.para] : [target.para + d, target.para - d]) {
      if (p < 0) continue;
      if (self.moveCursorTo({ sectionIndex: target.sec, paragraphIndex: p, charOffset: 0 })) return true;
    }
  }
  return false;
}
