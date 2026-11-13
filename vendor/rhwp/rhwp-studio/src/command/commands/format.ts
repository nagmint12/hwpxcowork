import type { CommandDef } from '../types';
import { CharShapeDialog } from '@/ui/char-shape-dialog';
import { ParaShapeDialog } from '@/ui/para-shape-dialog';
import { NumberingDialog } from '@/ui/numbering-dialog';
import { StyleDialog } from '@/ui/style-dialog';
import { StyleEditDialog } from '@/ui/style-edit-dialog';
import { PicturePropsDialog } from '@/ui/picture-props-dialog';
import { EquationPropertiesDialog } from '@/ui/equation-props-dialog';
import { TableCellPropsDialog } from '@/ui/table-cell-props-dialog';
import { hasH2022Format } from '@/ui/h2022-format-api';
import { numberingRowsToEngine } from '@/ui/h2022-format-model';
import { applyMarkpenSelection, pickMarkpenRange } from '@/engine/input-handler-markpen';

import { t } from '../../i18n/index.ts';
import { STYLE_SHORTCUT_COUNT, styleShortcutCommandId } from '../shortcut-map';

/** [hwpx-cowork] Ctrl+1~9·Ctrl+0 — 한컴처럼 스타일 목록 순서의 n번째 스타일을 적용한다 */
const styleShortcutCommands: CommandDef[] = Array.from({ length: STYLE_SHORTCUT_COUNT }, (_, i) => ({
  id: styleShortcutCommandId(i + 1),
  label: t('command.format.styleShortcut.label', { p1: i + 1 }),
  shortcutLabel: `Ctrl+${(i + 1) % 10}`,
  canExecute: (ctx) => ctx.hasDocument,
  execute(services) {
    const style = services.wasm.getStyleList()[i];
    if (style) services.getInputHandler()?.applyStyle(style.id);
  },
}));

/**
 * [hwpx-cowork] 한 수준 증가(−1)·감소(+1) — 한/글 2022 IncreaseLevel/DecreaseLevel(Ctrl+Num −/+), 2026-11-11.
 * '개요 N' 스타일 문단은 종전대로 스타일을 바꾸고, 그 밖의 번호·개요 머리 문단은 문단 수준(paraLevel)을 한 단계 바꾼다
 * (한/글 COM ParaNumberBulletLevelDown 실측: 번호 문단 수준 0→1→2, 0 에서 위로는 그대로, 글머리표는 바뀌지 않음).
 */
function changeLevel(services: Parameters<CommandDef['execute']>[0], delta: number): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const pos = ih.getPosition();
  const cur = ih.getCursorPosition();
  let outlineStyle = false;
  try {
    const style = cur.parentParaIndex !== undefined
      ? null
      : services.wasm.getStyleAt(pos.sectionIndex, pos.paragraphIndex);
    outlineStyle = !!style && /^개요\s*\d$/.test(style.name);
  } catch { outlineStyle = false; }
  if (outlineStyle || cur.parentParaIndex !== undefined || !hasH2022Format(services.wasm)) {
    ih.changeOutlineLevel(delta);
    return;
  }
  try {
    ih.executeOperation({
      kind: 'snapshot',
      operationType: 'paraNumberLevel',
      operation: (wasm) => {
        const r = wasm.changeParaNumberLevel(pos.sectionIndex, pos.paragraphIndex, delta);
        return r.changed ? pos : null;
      },
      meta: { actionId: delta < 0 ? 'format:level-increase' : 'format:level-decrease', domain: 'paraFormat', refresh: 'full', dirtyScope: 'document' },
    });
  } catch (err) {
    console.warn('[format:level] 수준 바꾸기 실패:', err);
  }
}

/**
 * [hwpx-cowork] 형광펜 이동(한/글 MarkPenNext/Prev, 실측 artifacts/h2022-format/com/result_nav.json, 2026-11-12):
 * 다음/이전 형광펜 범위를 블록으로 고르고 캐럿은 그 끝, 끝에 닿으면 처음(마지막)으로 돌아간다. 본문만(한/글 실측 범위).
 */
function moveToMarkpen(services: Parameters<CommandDef['execute']>[0], dir: 1 | -1): void {
  const ih = services.getInputHandler();
  if (!ih || !hasH2022Format(services.wasm)) return;
  const cursor = (ih as any).cursor;
  if (cursor?.isInHeaderFooter?.() || cursor?.isInFootnote?.()) return;
  const sel = cursor?.getSelectionOrdered?.();
  const cur = sel ? sel.start : ih.getCursorPosition();
  const at = { sec: cur.sectionIndex, para: cur.parentParaIndex ?? cur.paragraphIndex, offset: cur.parentParaIndex !== undefined ? 0 : cur.charOffset };
  const ranges: Array<{ sec: number; para: number; start: number; end: number }> = [];
  for (let s = 0; s < services.wasm.getSectionCount(); s++) {
    for (const r of services.wasm.getMarkpenRanges(s).ranges) ranges.push({ sec: s, para: r.para, start: r.start, end: r.end });
  }
  const r = pickMarkpenRange(ranges, at, dir);
  if (!r) return;
  const start = { sectionIndex: r.sec, paragraphIndex: r.para, charOffset: r.start };
  cursor?.clearSelection?.();
  ih.moveCursorTo(start);
  cursor?.setAnchor?.();
  cursor?.moveTo?.({ ...start, charOffset: r.end });
  (ih as any).updateCaret?.();
}

export const formatCommands: CommandDef[] = [
  {
    id: 'format:bold',
    label: t('command.format.bold.registryLabel'),
    shortcutLabel: 'Ctrl+B',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('bold');
    },
  },
  {
    id: 'format:italic',
    label: t('command.format.italic.label'),
    shortcutLabel: 'Ctrl+I',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('italic');
    },
  },
  {
    id: 'format:underline',
    label: t('command.format.underline.label'),
    shortcutLabel: 'Ctrl+U',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('underline');
    },
  },
  {
    id: 'format:strikethrough',
    label: t('command.format.strikethrough.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('strikethrough');
    },
  },
  // 양각/음각/외곽선/위첨자/아래첨자
  {
    id: 'format:emboss',
    label: t('command.format.emboss.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('emboss');
    },
  },
  {
    id: 'format:engrave',
    label: t('command.format.engrave.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('engrave');
    },
  },
  {
    id: 'format:outline',
    label: t('command.format.outline.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('outline');
    },
  },
  {
    id: 'format:superscript',
    label: t('command.format.superscript.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('superscript');
    },
  },
  {
    id: 'format:subscript',
    label: t('command.format.subscript.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleFormat('subscript');
    },
  },
  // 줄 간격
  {
    id: 'format:line-spacing',
    label: t('command.format.lineSpacing.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services, params) {
      const value = params?.value as number | undefined;
      if (value === undefined) return;
      services.getInputHandler()?.setLineSpacing(value);
    },
  },
  // 줄 간격 줄이기 (Alt+Shift+A)
  {
    id: 'format:line-spacing-decrease',
    label: t('command.format.lineSpacingDecrease.registryLabel'),
    shortcutLabel: 'Alt+Shift+A',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const props = ih.getParaProperties();
      const current = props?.lineSpacing ?? 160;
      // toolbar.ts ▼ 버튼과 동일하게 5%로 하한 clamp (issue #3009)
      const newValue = Math.max(5, current - 10);
      ih.setLineSpacing(newValue);
    },
  },
  // 줄 간격 늘리기 (Alt+Shift+Z)
  {
    id: 'format:line-spacing-increase',
    label: t('command.format.lineSpacingIncrease.registryLabel'),
    shortcutLabel: 'Alt+Shift+Z',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const props = ih.getParaProperties();
      const current = props?.lineSpacing ?? 160;
      const newValue = Math.min(500, current + 10);
      ih.setLineSpacing(newValue);
    },
  },
  // 글꼴 크기 크게 (Alt+Shift+E)
  {
    id: 'format:font-size-increase',
    label: t('command.format.fontSizeIncrease.registryLabel'),
    shortcutLabel: 'Alt+Shift+E',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.adjustFontSize(100); // +1pt
    },
  },
  // 글꼴 크기 작게 (Alt+Shift+R)
  {
    id: 'format:font-size-decrease',
    label: t('command.format.fontSizeDecrease.registryLabel'),
    shortcutLabel: 'Alt+Shift+R',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.adjustFontSize(-100); // -1pt
    },
  },
  // 장평 줄이기 (Shift+Alt+J)
  {
    id: 'format:char-ratio-decrease',
    label: t('command.format.charRatioDecrease.registryLabel'),
    shortcutLabel: 'Shift+Alt+J',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.adjustCharRatio(-1);
    },
  },
  // 장평 늘리기 (Shift+Alt+K)
  {
    id: 'format:char-ratio-increase',
    label: t('command.format.charRatioIncrease.registryLabel'),
    shortcutLabel: 'Shift+Alt+K',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.adjustCharRatio(1);
    },
  },
  // 자간 줄이기 (Shift+Alt+N)
  {
    id: 'format:char-spacing-decrease',
    label: t('command.format.charSpacingDecrease.registryLabel'),
    shortcutLabel: 'Shift+Alt+N',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.adjustCharSpacing(-1);
    },
  },
  // 자간 늘리기 (Shift+Alt+W)
  {
    id: 'format:char-spacing-increase',
    label: t('command.format.charSpacingIncrease.registryLabel'),
    shortcutLabel: 'Shift+Alt+W',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.adjustCharSpacing(1);
    },
  },
  // 문단 정렬
  {
    id: 'format:align-left',
    label: t('command.format.alignLeft.label'),
    shortcutLabel: 'Ctrl+Shift+L',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.applyParaAlign('left');
    },
  },
  {
    id: 'format:align-center',
    label: t('command.format.alignCenter.label'),
    shortcutLabel: 'Alt+Shift+C',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.applyParaAlign('center');
    },
  },
  {
    id: 'format:align-right',
    label: t('command.format.alignRight.label'),
    shortcutLabel: 'Alt+Shift+H',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.applyParaAlign('right');
    },
  },
  {
    id: 'format:align-justify',
    label: t('command.format.alignJustify.label'),
    shortcutLabel: 'Ctrl+Shift+M',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.applyParaAlign('justify');
    },
  },
  {
    id: 'format:align-distribute',
    label: t('command.format.alignDistribute.label'),
    shortcutLabel: 'Alt+Shift+D',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.applyParaAlign('distribute');
    },
  },
  {
    id: 'format:align-split',
    label: t('command.format.alignSplit.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.applyParaAlign('split');
    },
  },
  // 글자 모양 대화상자
  {
    id: 'format:char-shape',
    opensDialog: true,
    label: t('command.format.charShape.label'),
    icon: 'icon-char-shape',
    shortcutLabel: 'Alt+L',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const charProps = ih.getCharProperties();
      // [hwpx-cowork] 셀 블록(F5·마우스 끌기)에서는 글자 모양을 블록 칸 전부에 적용한다(한컴 셀 블록 Alt+L).
      const inCellBlock = ih.isInCellSelectionMode();
      // 대화상자 열기 전 선택 범위를 저장 (대화상자 조작 중 선택이 풀릴 수 있음)
      const savedSel = ih.getSelection();
      if (!savedSel && !inCellBlock) return;
      const dialog = new CharShapeDialog(services.wasm, services.eventBus);
      dialog.onApply = (mods) => {
        // fontName → fontId 변환 (WASM parse_char_shape_mods는 fontId만 인식)
        if (mods.fontName) {
          const fontId = services.wasm.findOrCreateFontId(mods.fontName);
          if (fontId >= 0) mods.fontId = fontId;
          delete mods.fontName;
        }
        if (inCellBlock || !savedSel) {
          ih.applyCharPropsToCurrentTarget(mods);
          return;
        }
        ih.applyCharPropsToRange(savedSel.start, savedSel.end, mods);
      };
      dialog.onClose = () => ih.focus();
      dialog.show(charProps);
    },
  },
  {
    id: 'format:para-shape',
    opensDialog: true,
    label: t('command.format.paraShape.label'),
    icon: 'icon-para-shape',
    shortcutLabel: 'Alt+T',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const paraProps = ih.getParaProperties();
      const sel = ih.getSelection();
      const curPos = ih.getCursorPosition();
      const range = sel ?? { start: curPos, end: curPos };
      const dialog = new ParaShapeDialog(services.wasm, services.eventBus);
      // [hwpx-cowork] 셀 블록이면 블록 칸 전부의 문단에 적용한다(applyParaFormat 은 셀 블록을 먼저 본다).
      const inCellBlock = ih.isInCellSelectionMode();
      dialog.onApply = (mods) => {
        if (inCellBlock && ih.isInCellSelectionMode()) {
          ih.applyParaPropsAtCursor(mods);
          return;
        }
        ih.applyParaPropsToRange(range.start, range.end, mods);
      };
      dialog.onClose = () => ih.focus();
      dialog.show(paraProps);
    },
  },
  {
    id: 'format:apply-style',
    label: t('command.format.applyStyle.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services, params) {
      const styleId = params?.styleId as number | undefined;
      if (styleId === undefined) return;
      services.getInputHandler()?.applyStyle(styleId);
    },
  },
  ...styleShortcutCommands,
  {
    id: 'format:toggle-numbering',
    label: t('command.format.toggleNumbering.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.getInputHandler()?.toggleNumbering();
    },
  },
  {
    id: 'format:toggle-bullet',
    label: t('command.format.toggleBullet.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services, params) {
      const bulletChar = params?.bulletChar as string | undefined;
      services.getInputHandler()?.toggleBullet(bulletChar);
    },
  },
  {
    id: 'format:apply-bullet',
    label: t('command.format.applyBullet.registryLabel'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services, params) {
      const bulletChar = params?.bulletChar as string | undefined;
      if (!bulletChar) return;
      services.getInputHandler()?.applyBullet(bulletChar);
    },
  },
  {
    id: 'format:para-num-shape',
    opensDialog: true,
    label: t('command.format.paraNumShape.label'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      // 현재 문단의 번호 정보 전달
      const props = ih.getParaProperties();
      const dialog = new NumberingDialog(services.wasm, services.eventBus);
      dialog.currentHeadType = props.headType ?? 'None';
      dialog.currentNumberingId = props.numberingId ?? 0;
      dialog.currentRestartMode = (props as any).numberingRestartMode ?? 0;
      // Bullet일 때 현재 bullet 문자 전달
      if (props.headType === 'Bullet' && props.numberingId && props.numberingId > 0) {
        try {
          const bullets = services.wasm.getBulletList();
          const b = bullets.find((item: any) => item.id === props.numberingId);
          if (b) {
            // rawCode(PUA 원본)로 프리셋 매칭, 없으면 mapped char 사용
            const rawChar = b.rawCode ? String.fromCodePoint(b.rawCode) : b.char;
            dialog.currentBulletChar = rawChar;
          }
        } catch { /* ignore */ }
      }
      dialog.onApply = (nid, restartMode, startNum) => {
        if (nid === 0) {
          // "(없음)": 번호 해제
          ih.applyParaPropsAtCursor({ headType: 'None', numberingId: 0 });
        } else if (restartMode === 0) {
          // "앞 번호 이어": 이전 번호 문단의 numbering_id를 찾아서 적용
          const prevNid = (props as any).numberingId ?? nid;
          ih.applyNumbering(prevNid > 0 ? prevNid : nid);
        } else if (restartMode === 2) {
          // "새 번호 시작": 새 Numbering 정의 적용 (다른 numbering_id)
          ih.applyNumbering(nid);
        } else {
          // "이전 번호 이어": 현재 numbering_id 유지
          ih.applyNumbering(nid);
        }
      };
      dialog.onApplyBullet = (bulletChar) => {
        ih.applyBullet(bulletChar);
      };
      // [hwpx-cowork] 문단 번호 사용자 정의(h2022-format): 새 번호 정의를 snapshot 으로 만들고(되돌리기에 남는다) 그 번호를 적용한다
      if (hasH2022Format(services.wasm)) {
        dialog.onCustom = (rows) => {
          let id = 0;
          ih.executeOperation({
            kind: 'snapshot',
            operationType: 'createNumbering',
            operation: (wasm) => {
              id = wasm.createNumberingEx(numberingRowsToEngine(rows)).id;
              return ih.getCursorPosition();
            },
            meta: { actionId: 'format:para-num-shape', domain: 'paraFormat', refresh: 'full', dirtyScope: 'document' },
          });
          if (id > 0) ih.applyNumbering(id);
        };
      }
      dialog.onClose = () => ih.focus();
      dialog.show();
    },
  },
  {
    id: 'format:bullet-shape',
    label: t('command.format.bulletShape.label'),
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      // 글머리표 버튼의 팝업을 프로그래밍적으로 열기
      const btn = document.getElementById('tb-bullet');
      if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    },
  },
  // [hwpx-cowork] 형광펜 지우기(한/글 MarkPenDelete 실측: 블록 범위만 지우고 블록이 없으면 아무것도 안 한다)·이동(MarkPenNext/Prev).
  // 한/글 2022 메뉴·도구 상자·단축키 자료에는 이 셋이 없다(액션만 — data/hangul2022_menu.json·official_actions) — 서식 메뉴에만 둔다.
  {
    id: 'format:markpen-delete',
    label: '형광펜 지우기',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih || !hasH2022Format(services.wasm)) return;
      applyMarkpenSelection(ih as never, '');
    },
  },
  {
    id: 'format:markpen-next',
    label: '다음 형광펜',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) { moveToMarkpen(services, 1); },
  },
  {
    id: 'format:markpen-prev',
    label: '이전 형광펜',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) { moveToMarkpen(services, -1); },
  },
  // [hwpx-cowork] 개요 적용/해제(한/글 ToggleOutlineNumber, Ctrl+Insert) — 한/글 COM PutOutlineNumber 실측(2026-11-11):
  // 한 번 = '개요 1' 스타일, 개요 문단에서 다시 = '바탕글'. 표 칸에서도 같은 스타일 적용 경로(applyStyle)를 쓴다.
  {
    id: 'format:outline-toggle',
    label: '개요 적용/해제',
    shortcutLabel: 'Ctrl+Insert',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      try {
        const pos = ih.getCursorPosition();
        const style = pos.parentParaIndex !== undefined
          ? services.wasm.getCellStyleAt(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!, pos.cellParaIndex!)
          : services.wasm.getStyleAt(pos.sectionIndex, pos.paragraphIndex);
        const styles = services.wasm.getStyleList();
        const isOutline = /^개요\s*\d$/.test(style.name);
        const target = isOutline
          ? styles.find((s: { id: number; name: string }) => s.name === '바탕글') ?? styles[0]
          : styles.find((s: { id: number; name: string }) => /^개요\s*1$/.test(s.name));
        if (target) ih.applyStyle(target.id);
      } catch (err) {
        console.warn('[format:outline-toggle] 개요 적용/해제 실패:', err);
      }
    },
  },
  {
    id: 'format:level-increase',
    label: t('command.format.levelIncrease.label'),
    shortcutLabel: 'Ctrl+Num -',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      changeLevel(services, -1);
    },
  },
  {
    id: 'format:level-decrease',
    label: t('command.format.levelDecrease.label'),
    shortcutLabel: 'Ctrl+Num +',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      changeLevel(services, 1);
    },
  },
  // 스타일 대화상자
  {
    id: 'format:style-dialog',
    opensDialog: true,
    label: t('command.format.styleDialog.label'),
    shortcutLabel: 'F6',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const dialog = new StyleDialog(services.wasm, services.eventBus, services);

      // 편집 요청
      dialog.onEditRequest = (styleId: number) => {
        const styles = services.wasm.getStyleList();
        const style = styles.find((s: { id: number }) => s.id === styleId);
        if (!style) return;
        const editDlg = new StyleEditDialog(services.wasm, services.eventBus, 'edit', {
          id: style.id, name: style.name, englishName: style.englishName,
          type: style.type, nextStyleId: style.nextStyleId,
        }, undefined, services);
        editDlg.onSave = () => dialog.refresh();
        editDlg.show();
      };

      // 추가 요청
      dialog.onAddRequest = () => {
        let baseInfo = {};
        try {
          baseInfo = {
            charProps: ih.getCharProperties(),
            paraProps: ih.getParaProperties(),
          };
        } catch {
          baseInfo = {};
        }
        const addDlg = new StyleEditDialog(services.wasm, services.eventBus, 'add', undefined, baseInfo, services);
        addDlg.onSave = () => dialog.refresh();
        addDlg.show();
      };

      // 설정(적용)
      dialog.onApply = (styleId: number) => {
        ih.applyStyle(styleId);
      };
      dialog.onClose = () => ih.focus();

      const curStyleId = ih.getCurrentStyleId();
      dialog.show();
      dialog.setCurrentStyleId(curStyleId);
    },
  },
  {
    id: 'format:object-properties',
    opensDialog: true,
    label: t('command.format.objectProperties.label'),
    icon: 'icon-obj-props',
    shortcutLabel: 'P',
    canExecute: (ctx) => ctx.inPictureObjectSelection || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;

      // 그림/도형 선택 시
      if (ih.isInPictureObjectSelection()) {
        const ref = ih.getSelectedPictureRef();
        if (!ref) return;
        if (ref.type === 'equation') {
          const dialog = new EquationPropertiesDialog(services.wasm, services.eventBus, services);
          dialog.open(ref.sec, ref.ppi, ref.ci, ref.cellIdx, ref.cellParaIdx, ref.noteRef);
          return;
        }
        const dialog = new PicturePropsDialog(services.wasm, services.eventBus, services);
        dialog.open(ref.sec, ref.ppi, ref.ci, ref.type);
        return;
      }

      // 표 선택 시
      if (ih.isInTableObjectSelection()) {
        // [hwpx-cowork] 표 테두리를 눌러 고른 표는 캐럿이 표 밖이다 — 캐럿 칸 대신 선택한 표를 쓴다
        // (table:cell-props 와 같은 기준). 종전에는 이 경우 대화상자가 조용히 열리지 않았다.
        const ref = ih.getSelectedTableRef();
        if (!ref) return;
        const tableCtx = { sec: ref.sec, ppi: ref.ppi, ci: ref.ci };
        const dialog = new TableCellPropsDialog(services.wasm, services.eventBus, tableCtx, 0, 'table', services);
        dialog.show();
      }
    },
  },
];
