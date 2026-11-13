import type { CommandDef, CommandServices } from '../types';
import { OptionsDialog } from '../../ui/options-dialog';
import { TocDialog, askTocExists, rememberedTocOptions } from '../../ui/toc-dialog';
import { showToast } from '../../ui/toast';
import type { DocumentPosition, TocOptions, TocRegionInfo } from '@/core/types';

import { t } from '../../i18n/index.ts';

// ─── [hwpx-cowork] 차례/색인(한/글 '도구 > 차례/색인') ───

/** 캐럿의 본문 문단(표 칸 안이면 그 표를 품은 본문 문단) */
function caretBodyPara(services: CommandServices): { sec: number; para: number; inCell: boolean } | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  // 머리말·꼬리말·각주 편집 중에는 본문 캐럿이 아니다(차례는 본문에만)
  const cursor = (ih as unknown as { cursor?: { isInHeaderFooter?: () => boolean; isInFootnote?: () => boolean } }).cursor;
  if (cursor?.isInHeaderFooter?.() || cursor?.isInFootnote?.()) {
    showToast({ message: t('command.tool.toc.bodyOnly') });
    return null;
  }
  const pos = ih.getCursorPosition() as DocumentPosition;
  const inCell = pos.parentParaIndex != null || !!pos.cellPath?.length;
  return { sec: pos.sectionIndex, para: inCell ? (pos.parentParaIndex ?? pos.paragraphIndex) : pos.paragraphIndex, inCell };
}

const canEditToc = (ctx: Parameters<NonNullable<CommandDef['canExecute']>>[0]) =>
  ctx.hasDocument && ctx.isEditable && !ctx.isFormMode && !ctx.inCellSelectionMode && !ctx.inPictureObjectSelection && !ctx.inTableObjectSelection;

/** 차례 뒤 첫 문단(없으면 차례 마지막 문단) 앞 — 차례를 만든 뒤 캐럿 자리 */
function afterRegion(services: CommandServices, r: TocRegionInfo): DocumentPosition {
  const count = services.wasm.getParagraphCount(r.sec);
  return { sectionIndex: r.sec, paragraphIndex: Math.min(r.end + 1, count - 1), charOffset: 0 };
}

function noEngine(services: CommandServices): boolean {
  if (services.wasm.hasTableOfContents()) return false;
  showToast({ message: t('command.tool.toc.noEngine') });
  return true;
}

function paragraphStyleNames(services: CommandServices): string[] {
  try {
    return services.wasm.getStyleList().filter((s) => s.type === 0).map((s) => s.name);
  } catch {
    return [];
  }
}

/** 차례 만들기(이미 차례 필드가 있으면 한/글처럼 고침·필드 추가를 묻는다) — dialog 는 대화상자를 만든다(문단 스타일 이름, 처음 값) */
async function makeToc(services: CommandServices, edit: TocRegionInfo | null, dialog: (styles: string[], initial: TocOptions) => TocDialog): Promise<void> {
  const ih = services.getInputHandler();
  if (!ih || noEngine(services)) return;
  const at = caretBodyPara(services);
  if (!at) return;
  const wasm = services.wasm;
  const initial: TocOptions = edit?.options ? { ...rememberedTocOptions(), ...edit.options } : rememberedTocOptions();
  const opts = await dialog(paragraphStyleNames(services), initial).ask();
  if (!opts) return;
  let target = edit;
  if (!target && opts.field) {
    const existing = wasm.getTableOfContentsAt(at.sec, at.para) ?? wasm.listTablesOfContents()[0] ?? null;
    if (existing) {
      const c = await askTocExists();
      if (!c) return;
      if (c === 'edit') target = existing;
    }
  }
  const generation = wasm.documentGeneration;
  if (services.getInputHandler() !== ih || wasm.documentGeneration !== generation) return;
  try {
    ih.executeOperation({
      kind: 'snapshot',
      operationType: target ? 'updateTableOfContents' : 'makeTableOfContents',
      selectionBefore: null,
      operation: (wasm) => {
        if (target) {
          const r = wasm.updateTableOfContents(target.sec, target.start, { ...opts, field: true });
          return { sectionIndex: r.sec, paragraphIndex: r.start, charOffset: 0 };
        }
        const r = wasm.makeTableOfContents(at.sec, at.para, opts);
        return afterRegion(services, r);
      },
    });
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e) });
  }
}

/** 차례 새로 고침(all = 모든 차례) — 캐럿이 차례 밖이면 첫 차례 */
function updateToc(services: CommandServices, all: boolean): void {
  const ih = services.getInputHandler();
  if (!ih || noEngine(services)) return;
  const wasm = services.wasm;
  const list = wasm.listTablesOfContents();
  if (!list.length) { showToast({ message: t('command.tool.toc.none') }); return; }
  const at = caretBodyPara(services);
  const here = at ? wasm.getTableOfContentsAt(at.sec, at.para) : null;
  const target = here ?? list[0];
  const before = ih.getCursorPosition() as DocumentPosition;
  try {
    ih.executeOperation({
      kind: 'snapshot',
      operationType: all ? 'updateAllTablesOfContents' : 'updateTableOfContents',
      selectionBefore: null,
      operation: (wasm) => {
        if (all) {
          wasm.updateAllTablesOfContents();
        } else {
          wasm.updateTableOfContents(target.sec, target.start);
        }
        // 차례 안에 있던 캐럿은 차례 첫 문단으로, 밖이면 그대로(문단 수가 바뀌면 차례 뒤 문단 번호가 밀린다)
        if (here) return { sectionIndex: here.sec, paragraphIndex: here.start, charOffset: 0 };
        const count = wasm.getParagraphCount(before.sectionIndex);
        return { sectionIndex: before.sectionIndex, paragraphIndex: Math.min(before.paragraphIndex, count - 1), charOffset: 0 };
      },
    });
    showToast({ message: all ? t('command.tool.toc.updatedAll', { n: list.length }) : t('command.tool.toc.updated') });
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e) });
  }
}

/** 제목 차례 표시·차례 숨기기(켜고 끄기) */
function toggleTitleMark(services: CommandServices, kind: 'title' | 'hide'): void {
  const ih = services.getInputHandler();
  if (!ih || noEngine(services)) return;
  const at = caretBodyPara(services);
  if (!at) return;
  if (at.inCell) { showToast({ message: t('command.tool.toc.bodyOnly') }); return; }
  const pos = ih.getCursorPosition() as DocumentPosition;
  let state = 'none';
  try {
    ih.executeOperation({
      kind: 'snapshot',
      operationType: 'setTitleMark',
      selectionBefore: null,
      operation: (wasm) => {
        state = wasm.setTitleMark(at.sec, at.para, kind).state;
        return pos;
      },
    });
    showToast({ message: t(`command.tool.toc.mark.${state}`) });
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e) });
  }
}

export const toolCommands: CommandDef[] = [
  {
    id: 'tool:options',
    opensDialog: true,
    label: t('command.tool.options.label'),
    execute(services) {
      const dlg = new OptionsDialog(services.eventBus, () => {
        if (!services.wasm.pageCount) return [];
        return services.wasm.getDocumentFontCandidates();
      });
      dlg.show();
    },
  },
  {
    id: 'tool:toc-make',
    opensDialog: true,
    label: t('command.tool.tocMake.label'),
    canExecute: canEditToc,
    execute(services) { void makeToc(services, null, (styles, initial) => new TocDialog(styles, initial)); },
  },
  {
    id: 'tool:toc-edit',
    opensDialog: true,
    label: t('command.tool.tocEdit.label'),
    canExecute: canEditToc,
    execute(services) {
      const at = caretBodyPara(services);
      const here = at ? services.wasm.getTableOfContentsAt(at.sec, at.para) : null;
      const edit = here ?? services.wasm.listTablesOfContents()[0] ?? null;
      void makeToc(services, edit, (styles, initial) => new TocDialog(styles, initial, edit ? t('dialog.toc.editTitle') : undefined, edit ? t('dialog.toc.editBtn') : undefined));
    },
  },
  {
    id: 'tool:toc-update',
    label: t('command.tool.tocUpdate.label'),
    canExecute: canEditToc,
    execute(services) { updateToc(services, false); },
  },
  {
    id: 'tool:toc-update-all',
    label: t('command.tool.tocUpdateAll.label'),
    canExecute: canEditToc,
    execute(services) { updateToc(services, true); },
  },
  {
    id: 'tool:toc-mark-title',
    label: t('command.tool.tocMarkTitle.label'),
    canExecute: canEditToc,
    execute(services) { toggleTitleMark(services, 'title'); },
  },
  {
    id: 'tool:toc-hide-title',
    label: t('command.tool.tocHideTitle.label'),
    canExecute: canEditToc,
    execute(services) { toggleTitleMark(services, 'hide'); },
  },
];
