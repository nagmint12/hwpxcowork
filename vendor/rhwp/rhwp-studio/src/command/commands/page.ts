import type { CommandDef } from '../types';
import type { CodeControlInfo, DocumentPosition } from '@/core/types';
import { PageSetupDialog } from '@/ui/page-setup-dialog';
import { PageBorderDialog } from '@/ui/page-border-dialog';
import { SectionSettingsDialog } from '@/ui/section-settings-dialog';
import { ColumnSettingsDialog } from '@/ui/column-settings-dialog';
import { NewNumberDialog } from '@/ui/new-number-dialog';
// [hwpx-cowork] 한/글 2022 서식·쪽(2026-11-11): 쪽 번호 매기기·감추기 창, 구역 나누기·다단 설정 나누기, 현재 다단
import { PageNumberingDialog } from '@/ui/h2022-format-pagenum-dialog';
import { MasterTextDialog } from '@/ui/master-text-dialog';
import { PageHideDialog } from '@/ui/h2022-format-hide-dialog';
import { EndnoteShapeDialog } from '@/ui/endnote-shape-dialog';
import { hasH2022Format } from '@/ui/h2022-format-api';
import { columnDialogToEngine, columnPreset } from '@/ui/h2022-format-model';
import { InsertFieldInHeaderFooterCommand } from '@/engine/command';
import { emitHeaderFooterModeChanged } from '@/engine/header-footer-mode';

import { t } from '../../i18n/index.ts';
function stub(id: string, label: string, icon?: string, shortcut?: string): CommandDef {
  return {
    id,
    label,
    icon,
    shortcutLabel: shortcut,
    canExecute: () => false,
    execute() { /* TODO */ },
  };
}

/**
 * 대상 좌표에 머리말/꼬리말이 없으면 만든다 (Task #3206).
 *
 * 존재 확인은 **생성 네이티브가 중복을 거부하는 조건과 같은 범위**(구역·종류·applyTo)로 해야
 * 한다 — `getHeaderFooter` 와 `createHeaderFooter` 는 같은 `find_header_footer_control` 을
 * 쓰므로 두 판단이 어긋날 수 없다. 대상 좌표를 정하는 일은 호출측(`getHeaderFooterEditTarget`)
 * 몫이고, 여기서는 그 좌표를 그대로 쓴다.
 *
 * `navigateHeaderFooterByPage` 로 존재를 확인하면 안 된다. 이 함수는 `current_page + direction`
 * 부터 훑는 쪽 이동용이라 현재 쪽을 건너뛴다 — 1쪽 문서에서는 어느 방향으로도 대상이 없어,
 * 이미 있는 머리말을 없다고 판단하고 생성으로 넘어가 중복 생성 오류가 났다.
 *
 * [Task #3207] 생성은 문서 구조를 바꾸므로 snapshot 으로 기록한다(이미 있으면 커서 이동뿐이라
 * 기록 대상이 아니다).
 */
function ensureHeaderFooter(
  services: Parameters<CommandDef['execute']>[0],
  ih: NonNullable<ReturnType<Parameters<CommandDef['execute']>[0]['getInputHandler']>>,
  bodyPos: DocumentPosition,
  target: { sectionIndex: number; applyTo: number },
  isHeader: boolean,
): void {
  const { sectionIndex, applyTo } = target;
  const hf = JSON.parse(services.wasm.getHeaderFooter(sectionIndex, isHeader, applyTo));
  if (hf.exists) return;

  ih.executeOperation({
    kind: 'snapshot',
    operationType: 'createHeaderFooter',
    operation: (wasm) => {
      wasm.createHeaderFooter(sectionIndex, isHeader, applyTo);
      return bodyPos;
    },
  });
}

/** 머리말/꼬리말 생성 + 편집 모드 진입 공통 함수 */
function enterHeaderFooterEditing(
  services: Parameters<CommandDef['execute']>[0],
  isHeader: boolean,
): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const cursor = (ih as any).cursor;
  if (!cursor) return;

  // 편집 대상은 이 쪽에 **실제로 렌더되는** 컨트롤이다 — 어느 것이 렌더되는지는 쪽 홀짝이
  // 정하고(홀수/짝수가 양 쪽을 이긴다) 구역에 자기 머리말이 없으면 앞 구역에서 상속된다.
  // `양 쪽` 으로 고정하면 캐럿이 찍힌 머리말과 다른 컨트롤을 편집하게 된다 (Task #3206).
  // 더블클릭 진입(input-handler-mouse)이 히트테스트로 얻는 것과 같은 답이다.
  const currentPage = cursor.rect?.pageIndex ?? 0;
  const target = services.wasm.getHeaderFooterEditTarget(currentPage, isHeader);

  const bodyPos = cursor.getPosition();
  ensureHeaderFooter(services, ih, bodyPos, target, isHeader);
  cursor.enterHeaderFooterMode(isHeader, target.sectionIndex, target.applyTo, currentPage);

  emitHeaderFooterModeChanged(services.eventBus, cursor);
  (ih as any).updateCaret?.();
  (ih as any).textarea?.focus();
}

/** 머리말/꼬리말 편집 중 필드 마커를 삽입하는 공통 함수 */
function insertHfField(
  services: Parameters<CommandDef['execute']>[0],
  fieldType: number,
): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const cursor = (ih as any).cursor;
  if (!cursor || !cursor.isInHeaderFooter()) return;
  const isHeader = cursor.headerFooterMode === 'header';
  const target = {
    sectionIdx: cursor.hfSectionIdx,
    isHeader,
    applyTo: cursor.hfApplyTo,
    previewPage: cursor.hfPreviewPage,
  };
  const paraIdx = cursor.hfParaIdx;
  const charOffset = cursor.hfCharOffset;
  try {
    const result = services.wasm.insertFieldInHf(
      target.sectionIdx, isHeader, target.applyTo, paraIdx, charOffset, fieldType,
    );
    if (
      result.ok
      && Number.isSafeInteger(result.charOffset)
      && Number.isSafeInteger(result.insertedAt)
      && Number.isSafeInteger(result.insertedLength)
      && result.insertedLength > 0
    ) {
      cursor.setHfCursorPosition(paraIdx, result.charOffset);
      // [Task #3212] 이미 적용된 삽입을 역연산 명령으로 기록한다(#2337 HF 커맨드와 동형).
      // cursor 좌표와 실제 텍스트 삽입 위치는 inline control 뒤에서 다를 수 있다.
      // 따라서 역연산은 native가 준 실제 marker 범위를 사용한다.
      ih.executeOperation({
        kind: 'record',
        command: new InsertFieldInHeaderFooterCommand(
          target, paraIdx, charOffset, result.insertedAt, fieldType,
          result.insertedLength, result.charOffset,
        ),
      });
    }
    (ih as any).afterEdit?.();
    (ih as any).updateCaret?.();
  } catch (e) {
    console.warn('[page] 필드 삽입 실패:', e);
  }
}

/** 페이지 단위로 이전/다음 머리말·꼬리말로 이동하는 공통 함수 */
function navigateHeaderFooter(
  services: Parameters<CommandDef['execute']>[0],
  direction: -1 | 1,
): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const cursor = (ih as any).cursor;
  if (!cursor || !cursor.isInHeaderFooter()) return;

  const currentPage = cursor.rect?.pageIndex ?? 0;
  const isHeader = cursor.headerFooterMode === 'header';

  const result = services.wasm.navigateHeaderFooterByPage(currentPage, isHeader, direction);
  if (!result.ok) return; // 더 이상 이동할 페이지 없음 → 현재 위치 유지

  // 대상 페이지의 머리말/꼬리말로 전환
  cursor.switchHeaderFooterTarget(
    result.isHeader!,
    result.sectionIdx!,
    result.applyTo!,
    result.pageIndex!,
  );
  emitHeaderFooterModeChanged(services.eventBus, cursor);
  (ih as any).updateCaret?.();
  (ih as any).textarea?.focus();
}

/** 머리말/꼬리말 마당 템플릿 적용 공통 함수 */
function applyHfTemplate(
  services: Parameters<CommandDef['execute']>[0],
  isHeader: boolean,
  applyTo: number,
  templateId: number,
): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const cursor = (ih as any).cursor;
  // 현재 편집 중이면 종료
  let sectionIdx: number;
  if (cursor?.isInHeaderFooter()) {
    sectionIdx = cursor.hfSectionIdx;
    cursor.exitHeaderFooterMode();
  } else {
    sectionIdx = cursor?.getPosition()?.sectionIndex ?? 0;
  }

  try {
    // [Task #3207] 마당 적용은 HF 내용을 통째로 교체하므로 snapshot 으로 기록한다.
    // 모드 탈출/재진입은 커서 상태라 기록 밖에 둔다(undo 는 본문 분기로 모드를 빠져나온다).
    // 위에서 이미 HF 모드를 종료했으므로 여기서 읽는 위치는 본문 위치다.
    const bodyPos = ih.getPosition();
    let applied = false;
    ih.executeOperation({
      kind: 'snapshot',
      operationType: 'applyHfTemplate',
      operation: (wasm) => {
        // [Task #2370] 의미상 실패(ok:false)는 문서 무변경이므로 null 로 기록을 취소한다.
        // 종전에는 같은 목적으로 throw 했으나(정상 흐름을 예외로 처리) 공용 no-op 신호로 통일.
        applied = wasm.applyHfTemplate(sectionIdx, isHeader, applyTo, templateId).ok;
        return applied ? bodyPos : null;
      },
    });
    if (!applied) {
      // 적용되지 않았으면 HF 가 생겼다는 보장이 없다 → 편집 모드로 들어가지 않는다.
      console.warn('[page] 마당 적용 실패: applyHfTemplate 가 ok:false 를 반환');
      (ih as any).afterEdit?.();
    } else {
      // 템플릿 적용 후 편집 모드로 진입. 마당 적용은 기존 HF 를 지우고 다시 만들므로
      // (`apply_hf_template_native` 1~2단계) 적용 대상 좌표에 HF 가 있음이 보장된다 —
      // 존재 확인이 필요 없다 (Task #3206).
      cursor.enterHeaderFooterMode(isHeader, sectionIdx, applyTo, cursor?.rect?.pageIndex ?? 0);
      emitHeaderFooterModeChanged(services.eventBus, cursor);
    }
  } catch (e) {
    console.warn('[page] 마당 적용 실패:', e);
    // 실패 경로 리프레시 — 성공 경로는 executeOperation 이 이미 afterEdit 로 갱신했으므로
    // 여기서 다시 부르지 않는다(성공 경로 이중 afterEdit 제거).
    (ih as any).afterEdit?.();
  }
  (ih as any).updateCaret?.();
  // 메뉴 닫기 후 포커스가 유실될 수 있으므로 지연 포커스
  const textarea = (ih as any).textarea;
  textarea?.focus();
  setTimeout(() => textarea?.focus(), 50);
}

/** [hwpx-cowork] 본문 캐럿 자리(표 칸 안이면 표를 둔 본문 문단) */
function bodyCaret(services: Parameters<CommandDef['execute']>[0]): { sec: number; para: number; offset: number; inCell: boolean } | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  const pos = ih.getPosition();
  const cur = ih.getCursorPosition();
  const inCell = cur.parentParaIndex !== undefined;
  return { sec: pos.sectionIndex, para: inCell ? cur.parentParaIndex! : pos.paragraphIndex, offset: pos.charOffset, inCell };
}

/** [hwpx-cowork] 단 하나·둘·셋·왼쪽·오른쪽 — 캐럿 문단에 적용되는 다단('현재 다단')을 바꾼다(한/글 ColDef ApplyTo=2 실측) */
function applyColumnPreset(
  services: Parameters<CommandDef['execute']>[0],
  id: string,
  preset: { cols: number } | { side: 'left' | 'right' },
): void {
  const ih = services.getInputHandler();
  const at = bodyCaret(services);
  if (!ih || !at) return;
  const pos = ih.getPosition();
  // 옛 엔진(getColumnDefAt 없음)은 부르는 쪽이 종전 경로(구역 첫 단 정의)를 쓴다
  ih.executeOperation({
    kind: 'snapshot',
    operationType: 'columnPreset',
    operation: (wasm) => {
      const def = wasm.getColumnDefAt(at.sec, at.para);
      const body = Number(def.bodyWidth) || 0;
      const keep = {
        separatorType: Number(def.separatorType) || 0,
        separatorWidth: Number(def.separatorWidth) || 0,
        separatorColor: String(def.separatorColor || '#000000'),
      };
      const spacingMm = 2268 / (7200 / 25.4);
      if ('cols' in preset) {
        wasm.setColumnDefAt(at.sec, at.para, {
          columnCount: preset.cols, columnType: 0, sameWidth: true, spacing: 2268, ...keep,
        });
      } else {
        const v = columnPreset(preset.side, body, spacingMm);
        wasm.setColumnDefAt(at.sec, at.para, {
          ...columnDialogToEngine({ ...v, lineType: keep.separatorType, lineWidth: keep.separatorWidth, lineColor: keep.separatorColor }),
        });
      }
      return pos;
    },
    meta: { actionId: id, domain: 'page', refresh: 'full', dirtyScope: 'document' },
  });
}

export const pageCommands: CommandDef[] = [
  {
    id: 'page:setup',
    opensDialog: true,
    label: t('command.page.setup.label'),
    icon: 'icon-page-setup',
    shortcutLabel: 'F7',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      const cursor = ih ? (ih as any).cursor : null;
      const sectionIdx = cursor?.getPosition()?.sectionIndex ?? 0;
      const dialog = new PageSetupDialog(services.wasm, services.eventBus, sectionIdx, services);
      dialog.show();
    },
  },
  {
    id: 'page:page-border',
    opensDialog: true,
    label: t('command.page.pageBorder.label'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      const cursor = ih ? (ih as any).cursor : null;
      const sectionIdx = cursor?.getPosition()?.sectionIndex ?? 0;
      const dialog = new PageBorderDialog(services.wasm, services.eventBus, sectionIdx, services);
      dialog.show();
    },
  },
  // ─── 머리말 ──────────────────────────────────
  {
    id: 'page:header-create',
    label: t('command.page.headerCreate.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      enterHeaderFooterEditing(services, true);
    },
  },
  // ─── 꼬리말 ──────────────────────────────────
  {
    id: 'page:footer-create',
    label: t('command.page.footerCreate.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      enterHeaderFooterEditing(services, false);
    },
  },
  // ─── 머리말/꼬리말 닫기 ────────────────────────
  {
    id: 'page:headerfooter-close',
    label: t('command.page.headerfooterClose.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const cursor = (ih as any).cursor;
      if (!cursor || !cursor.isInHeaderFooter()) return;
      // 현재 보고 있는 페이지 기억
      const hfPage = cursor.rect?.pageIndex ?? 0;
      cursor.exitHeaderFooterMode();
      emitHeaderFooterModeChanged(services.eventBus, cursor);
      // 해당 페이지의 본문 첫 문단 시작점으로 커서 이동
      try {
        const pageInfo = services.wasm.getPageInfo(hfPage);
        const bodyX = pageInfo.marginLeft + 1;
        const bodyY = pageInfo.marginTop + pageInfo.marginHeader + 1;
        const hit = services.wasm.hitTest(hfPage, bodyX, bodyY);
        if (hit.paragraphIndex < 0xFFFFFF00) {
          cursor.moveTo(hit);
        }
      } catch { /* hitTest 실패 시 기존 위치 유지 */ }
      (ih as any).afterEdit?.();
      (ih as any).textarea?.focus();
    },
  },
  // ─── 머리말/꼬리말 지우기 ──────────────────────
  {
    id: 'page:headerfooter-delete',
    label: t('command.page.headerfooterDelete.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const cursor = (ih as any).cursor;
      if (!cursor || !cursor.isInHeaderFooter()) return;
      const sectionIdx = cursor.hfSectionIdx;
      const isHeader = cursor.headerFooterMode === 'header';
      const applyTo = cursor.hfApplyTo;
      // 편집 모드 탈출
      cursor.exitHeaderFooterMode();
      emitHeaderFooterModeChanged(services.eventBus, cursor);
      // 컨트롤 삭제 — [Task #3207] snapshot 으로 기록해 undo 로 되살릴 수 있게 한다.
      // 모드 탈출은 위에서 이미 끝났으므로 여기 커서는 본문이다.
      const bodyPos = ih.getPosition();
      ih.executeOperation({
        kind: 'snapshot',
        operationType: 'deleteHeaderFooter',
        operation: (wasm) => {
          wasm.deleteHeaderFooter(sectionIdx, isHeader, applyTo);
          return bodyPos;
        },
      });
      // executeOperation 이 이미 afterEdit 로 리프레시하므로 별도 afterEdit 를 부르지 않는다.
      (ih as any).textarea?.focus();
    },
  },
  // ─── 머리말/꼬리말 이전/다음 이동 ─────────────────
  {
    id: 'page:headerfooter-prev',
    label: t('command.page.headerfooterPrev.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      navigateHeaderFooter(services, -1);
    },
  },
  {
    id: 'page:headerfooter-next',
    label: t('command.page.headerfooterNext.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      navigateHeaderFooter(services, 1);
    },
  },
  {
    id: 'page:new-page-num',
    opensDialog: true,
    label: t('command.page.newPageNum.label'),
    canExecute: (ctx) => ctx.hasDocument && !ctx.inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const cursor = (ih as any).cursor;
      if (!cursor) return;
      const pos = cursor.getPosition();
      const wasm = services.wasm;
      const eventBus = services.eventBus;
      if (!wasm || !eventBus) return;
      // [hwpx-cowork] 캐럿 자리에 새 번호 부호가 있으면 그것을 고친다(뒤 → 앞 차례로 찾는다)
      let existing: CodeControlInfo | null = null;
      try {
        const target = { sec: pos.sectionIndex, para: pos.paragraphIndex };
        for (const dir of ['forward', 'backward'] as const) {
          const hit = typeof wasm.getCodeControlAt === 'function' ? wasm.getCodeControlAt(target, pos.charOffset, dir) : null;
          if (hit?.kind === 'newNum') { existing = hit; break; }
        }
      } catch { existing = null; }
      const dlg = new NewNumberDialog(wasm, eventBus, {
        sec: pos.sectionIndex, para: pos.paragraphIndex, offset: pos.charOffset,
      }, services, existing);
      dlg.show();
    },
  },
  // ─── 머리말/꼬리말 현재 쪽 감추기 ──────────────
  {
    id: 'page:hide-headerfooter',
    label: t('command.page.hideHeaderfooter.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const cursor = (ih as any).cursor;
      if (!cursor || !cursor.isInHeaderFooter()) return;
      const isHeader = cursor.headerFooterMode === 'header';
      const pageIndex = cursor.rect?.pageIndex ?? 0;
      // [Task #3207] 감추기는 히스토리에 기록하지 않는다 — toggle_hide_header_footer_native 는
      // 세션 집합(hidden_header_footer)과 렌더 캐시만 바꾸고 document 는 건드리지 않는데
      // (레포 가드가 Exempt::SessionState/직렬화 비대상으로 분류), 스냅샷은 document 만 담고
      // 복원도 세션 집합을 되돌리지 않는다. 라우팅하면 되돌아가는 것 없이 redo 스택이 버려지고
      // 스냅샷 예산만 소모돼 사용자의 진짜 undo 이력이 축출된다.
      try {
        const result = services.wasm.toggleHideHeaderFooter(pageIndex, isHeader);
        console.log(`[page] ${isHeader ? '머리말' : '꼬리말'} 쪽 ${pageIndex} 감추기: ${result.hidden}`);
      } catch (e) {
        console.warn('[page] 감추기 토글 실패:', e);
      }
      (ih as any).afterEdit?.();
      (ih as any).updateCaret?.();
    },
  },
  {
    id: 'page:edit-master-text',
    label: '바탕쪽 글 편집',
    opensDialog: true,
    canExecute: ctx => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih || !services.wasm.supportsPageSourceEdits?.()) return;
      const page = ih.getCursorPageIndex();
      new MasterTextDialog(services, services.wasm.getPageMasterText(page)).show();
    },
  },
  {
    id: 'page:hide-current',
    opensDialog: true,
    label: t('command.page.hideCurrent.label'),
    shortcutLabel: 'Ctrl+M,S',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const cursor = (ih as any).cursor;
      if (!cursor) return;
      // [hwpx-cowork] 한/글 2022 쪽 > 감추기(PageHiding): 캐럿 문단에 저장되는 감추기 컨트롤을 여섯 칸 창으로 고친다.
      // 종전 '현재 쪽만 감추기'(세션 상태, 저장 안 됨)는 머리말/꼬리말 편집 중의 page:hide-headerfooter 로만 남긴다.
      const at = bodyCaret(services);
      if (at && !cursor.isInHeaderFooter?.() && !cursor.isInFootnote?.()) {
        new PageHideDialog(services.wasm, services.eventBus, { sec: at.sec, para: at.para }, services).show();
        return;
      }
      const pageIndex = cursor.rect?.pageIndex ?? 0;
      // [Task #3207] 감추기는 세션 상태라 히스토리에 기록하지 않는다(위 page:hide-headerfooter
      // 주석 참조). 스냅샷이 담는 내용이 없어 원자화도 실효가 없으므로 종전 호출을 유지하고,
      // dirty 마킹 경로인 emit 도 그대로 둔다.
      try {
        const headerResult = services.wasm.toggleHideHeaderFooter(pageIndex, true);
        const footerResult = services.wasm.toggleHideHeaderFooter(pageIndex, false);
        if (headerResult.hidden !== footerResult.hidden) {
          services.wasm.toggleHideHeaderFooter(pageIndex, false);
        }
        services.eventBus.emit('document-changed');
      } catch (err) {
        console.warn('[page:hide-current] 현재 쪽 감추기 실패:', err);
      }
    },
  },
  // ─── 머리말/꼬리말 필드 삽입 ────────────────────
  {
    id: 'page:insert-field-pagenum',
    label: t('command.page.insertFieldPagenum.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) { insertHfField(services, 1); },
  },
  {
    id: 'page:insert-field-totalpage',
    label: t('command.page.insertFieldTotalpage.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) { insertHfField(services, 2); },
  },
  {
    id: 'page:insert-field-filename',
    label: t('command.page.insertFieldFilename.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) { insertHfField(services, 3); },
  },
  // ─── 머리말/꼬리말 마당 (템플릿) ─────────────────────
  {
    id: 'page:apply-hf-template',
    label: t('command.page.applyHfTemplate.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services, params) {
      const isHeader = params?.isHeader === 'true';
      const applyTo = parseInt(params?.applyTo as string ?? '0', 10);
      const templateId = parseInt(params?.templateId as string ?? '0', 10);
      applyHfTemplate(services, isHeader, applyTo, templateId);
    },
  },
  {
    id: 'page:break',
    label: t('command.page.break.label'),
    shortcutLabel: 'Ctrl+Enter',
    // [hwpx-cowork] 표 칸·글상자 위치의 paragraphIndex 는 칸 안 문단 번호다. 그대로 본문 문단으로 쓰면
    // 표와 상관없는 본문 문단을 쪼갠다 — 표 안에서는 쪽 나누기를 하지 않는다(표 안 Ctrl+Enter = 줄 추가).
    canExecute: (ctx) => ctx.hasDocument && !ctx.inTable && !ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      if (ih.getCursorPosition().parentParaIndex !== undefined) return; // [hwpx-cowork]
      try {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'pageBreak',
          ownsPriorTextPagination: true, // [hwpx-cowork] 기존 키의 타이머가 새 입력의 뒤쪽까지 즉시 계산하지 않게 한다.
          // [hwpx-cowork] 쪽 삽입에 필요한 원래 문단·줄 좌표만 히스토리에 잡는다.
          captureBefore: (wasm) => wasm.savePageBreakUndo(pos.sectionIndex, pos.paragraphIndex, pos.charOffset),
          operation: (wasm) => {
            const result = JSON.parse(wasm.insertPageBreak(pos.sectionIndex, pos.paragraphIndex, pos.charOffset));
            if (result.ok) {
              return {
                sectionIndex: pos.sectionIndex,
                paragraphIndex: result.paraIdx ?? pos.paragraphIndex,
                charOffset: result.charOffset ?? 0,
              };
            }
            return null;
          },
          meta: { actionId: 'page:break', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) {
        console.warn('[page:break] 쪽 나누기 실패:', err);
      }
    },
  },
  {
    id: 'page:hide',
    label: t('command.page.hide.registryLabel'),
    shortcutLabel: 'Ctrl+M,S',
    // [hwpx-cowork] 2026-11-12 통합: 새 엔진에서는 감추기 창을 연다(tests/dialog-policy-ledger 계약)
    opensDialog: true,
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      // [hwpx-cowork] 한/글 Ctrl+N,S = 감추기 창(HidePageDlg). 새 엔진이면 창을 연다.
      const at = bodyCaret(services);
      if (at && hasH2022Format(services.wasm)) {
        new PageHideDialog(services.wasm, services.eventBus, { sec: at.sec, para: at.para }, services).show();
        return;
      }
      const pos = ih.getPosition();
      try {
        // 현재 문단의 감추기 상태 조회(읽기) 후 토글값 결정.
        const cur = JSON.parse((services.wasm as any).doc.getPageHide(pos.sectionIndex, pos.paragraphIndex));
        // exists → 제거(false), 없음 → 쪽 번호 감추기 적용(true). 나머지 5플래그는 양쪽 모두 false.
        const applyPageNumHide = !cur.exists;
        // [page-hide 이관] 문단 감추기 변경을 snapshot 으로 라우팅(기존 emit-only → undo 불가였음).
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'pageHide',
          operation: (wasm) => {
            (wasm as any).doc.setPageHide(
              pos.sectionIndex, pos.paragraphIndex,
              false, false, false, false, false, applyPageNumHide,
            );
            return pos;
          },
          meta: { actionId: 'page:hide', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) {
        console.warn('[page:hide] 감추기 실패:', err);
      }
    },
  },
  {
    id: 'page:column-break',
    label: t('command.page.columnBreak.label'),
    shortcutLabel: 'Ctrl+Shift+Enter',
    // [hwpx-cowork] 쪽 나누기와 같은 까닭으로 표 안에서는 단 나누기를 하지 않는다.
    canExecute: (ctx) => ctx.hasDocument && !ctx.inTable && !ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      if (ih.getCursorPosition().parentParaIndex !== undefined) return; // [hwpx-cowork]
      try {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'columnBreak',
          operation: (wasm) => {
            const result = JSON.parse(wasm.insertColumnBreak(pos.sectionIndex, pos.paragraphIndex, pos.charOffset));
            if (result.ok) {
              return {
                sectionIndex: pos.sectionIndex,
                paragraphIndex: result.paraIdx ?? pos.paragraphIndex,
                charOffset: result.charOffset ?? 0,
              };
            }
            return pos;
          },
          meta: { actionId: 'page:column-break', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) {
        console.warn('[page:column-break] 단 나누기 실패:', err);
      }
    },
  },
  // 다단 프리셋 — ColumnDef 컨트롤 수정 (SectionDef와 독립)
  ...[
    { id: 'page:col-1', label: t('command.page.col1.registryLabel'), cols: 1 },
    { id: 'page:col-2', label: t('command.page.col2.registryLabel'), cols: 2 },
    { id: 'page:col-3', label: t('command.page.col3.registryLabel'), cols: 3 },
  ].map((def): CommandDef => ({
    id: def.id,
    label: def.label,
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      // [hwpx-cowork] 새 엔진이면 캐럿 문단의 다단('현재 다단')을 바꾸고 구분선은 그대로 둔다
      if (hasH2022Format(services.wasm)) {
        try { applyColumnPreset(services, def.id, { cols: def.cols }); } catch (err) { console.warn(`[${def.id}]`, err); }
        return;
      }
      try {
        // 일반 다단(0), 같은 너비(1), 간격 8mm=2268HU. snapshot 으로 라우팅해 undo 가능.
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'setColumnDef',
          operation: (wasm) => {
            wasm.setColumnDef(pos.sectionIndex, def.cols, 0, 1, 2268);
            return pos;
          },
          meta: { actionId: def.id, domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) {
        console.warn(`[${def.id}] 다단 설정 실패:`, err);
      }
    },
  })),
  {
    id: 'page:col-left',
    label: t('command.page.colLeft.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      // [hwpx-cowork] 종전에는 왼쪽·오른쪽이 같은 호출(같은 너비 아님만 지정)이라 결과가 같았다 — 단별 너비를 준다
      if (hasH2022Format(services.wasm)) {
        try { applyColumnPreset(services, 'page:col-left', { side: 'left' }); } catch (err) { console.warn('[page:col-left]', err); }
        return;
      }
      try {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'setColumnDef',
          operation: (wasm) => {
            wasm.setColumnDef(pos.sectionIndex, 2, 0, 0, 2268);
            return pos;
          },
          meta: { actionId: 'page:col-left', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) { console.warn('[page:col-left]', err); }
    },
  },
  {
    id: 'page:col-right',
    label: t('command.page.colRight.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      // [hwpx-cowork] 종전에는 왼쪽·오른쪽이 같은 호출(같은 너비 아님만 지정)이라 결과가 같았다 — 단별 너비를 준다
      if (hasH2022Format(services.wasm)) {
        try { applyColumnPreset(services, 'page:col-right', { side: 'right' }); } catch (err) { console.warn('[page:col-right]', err); }
        return;
      }
      try {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'setColumnDef',
          operation: (wasm) => {
            wasm.setColumnDef(pos.sectionIndex, 2, 0, 0, 2268);
            return pos;
          },
          meta: { actionId: 'page:col-right', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) { console.warn('[page:col-right]', err); }
    },
  },
  {
    id: 'page:col-settings',
    opensDialog: true,
    label: t('command.page.colSettings.label'),
    // [hwpx-cowork] Ctrl+Alt+Enter 는 한/글처럼 다단 설정 나누기(page:coldef-break)
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      // [hwpx-cowork] 캐럿 자리를 넘겨 '현재 다단'·'새 다단으로'·구분선·단별 너비를 쓴다
      const at = bodyCaret(services);
      const caret = at && !at.inCell ? { para: at.para, offset: at.offset } : at ? { para: at.para, offset: 0 } : undefined;
      const dlg = new ColumnSettingsDialog(services.wasm, services.eventBus, pos.sectionIndex, services, caret);
      dlg.show();
    },
  },
  // ─── [hwpx-cowork] 다단 설정 나누기 (한/글 InsertColDefBreak/BreakColDef, Ctrl+Alt+Enter) ───
  {
    id: 'page:coldef-break',
    label: '다단 설정 나누기',
    shortcutLabel: 'Ctrl+Alt+Enter',
    canExecute: (ctx) => ctx.hasDocument && !ctx.inTable && !ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih || !hasH2022Format(services.wasm)) return;
      const pos = ih.getPosition();
      if (ih.getCursorPosition().parentParaIndex !== undefined) return;
      const cursor = (ih as any).cursor;
      if (cursor?.isInHeaderFooter?.() || cursor?.isInFootnote?.()) return;
      try {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'columnDefBreak',
          operation: (wasm) => {
            const r = wasm.insertColumnDefBreak(pos.sectionIndex, pos.paragraphIndex, pos.charOffset);
            return { sectionIndex: pos.sectionIndex, paragraphIndex: r.para, charOffset: r.charOffset };
          },
          meta: { actionId: 'page:coldef-break', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) {
        console.warn('[page:coldef-break] 다단 설정 나누기 실패:', err);
      }
    },
  },
  // ─── [hwpx-cowork] 구역 나누기 (한/글 BreakSection, Shift+Alt+Enter) ───
  {
    id: 'page:section-break',
    label: '구역 나누기',
    shortcutLabel: 'Alt+Shift+Enter',
    canExecute: (ctx) => ctx.hasDocument && !ctx.inTable && !ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getPosition();
      if (ih.getCursorPosition().parentParaIndex !== undefined) return;
      const cursor = (ih as any).cursor;
      if (cursor?.isInHeaderFooter?.() || cursor?.isInFootnote?.()) return;
      try {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'sectionBreak',
          operation: (wasm) => {
            // 엔진 splitSection = 한/글 12.30·2022 실측 규칙(문단 가운데는 가름, 새 구역은 새 쪽, 캐럿은 새 구역 처음)
            const r = wasm.splitSection(pos.sectionIndex, pos.paragraphIndex, pos.charOffset);
            return { sectionIndex: r.section, paragraphIndex: r.para ?? 0, charOffset: r.charOffset ?? 0 };
          },
          meta: { actionId: 'page:section-break', domain: 'page', refresh: 'full', dirtyScope: 'document' },
        });
      } catch (err) {
        console.warn('[page:section-break] 구역 나누기 실패:', err);
      }
    },
  },
  // ─── [hwpx-cowork] 쪽 번호 매기기 (한/글 PageNumPos, Ctrl+N,P → Ctrl+M,P) ───
  {
    id: 'page:pagenum-pos',
    opensDialog: true,
    label: '쪽 번호 매기기',
    shortcutLabel: 'Ctrl+M,P',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const at = bodyCaret(services);
      if (!at || !hasH2022Format(services.wasm)) return;
      new PageNumberingDialog(services.wasm, services.eventBus, at.sec, services).show();
    },
  },
  // ─── [hwpx-cowork] 각주 모양 (한/글 주석 모양 창의 각주 탭, FootnoteOption) ───
  {
    id: 'page:footnote-shape',
    opensDialog: true,
    label: '각주 모양',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const at = bodyCaret(services);
      if (!at || !hasH2022Format(services.wasm)) return;
      new EndnoteShapeDialog(services.wasm, services.eventBus, at.sec, services, 'footnote').show();
    },
  },
  // ─── 구역 설정 ──────────────────────────────────
  {
    id: 'page:section-settings',
    opensDialog: true,
    label: t('command.page.sectionSettings.label'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const cursor = (ih as any).cursor;
      const sectionIdx = cursor?.getPosition()?.sectionIndex ?? 0;
      const dialog = new SectionSettingsDialog(services.wasm, services.eventBus, sectionIdx, services);
      dialog.show();
    },
  },
];
