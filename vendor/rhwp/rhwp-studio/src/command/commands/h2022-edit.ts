/**
 * [hwpx-cowork] 한/글 2022 편집·입력 명령(2026-11-11) — 덧말 넣기, 글자 겹치기, 글자 바꾸기(대/소문자·전각/반각),
 * 날짜/시간 문자열·형식. 근거·남은 차이는 `research/hangul2022-features-20261111/impl/ledger_edit.md`.
 */
import type { CommandDef, CommandServices } from '../types';
import { showToast } from '@/ui/toast';
import { InsertTextCommand } from '@/engine/command';
import {
  ComposeDialog, ConvertCaseDialog, ConvertFullHalfDialog, ConvertJapaneseDialog, DateFormatDialog, DutmalDialog,
  composeTargetAt, dateFormatState, existingCompose,
} from '@/ui/h2022-edit-dialogs';
import { DATE_FORMATS, formatDate } from '@/ui/h2022-edit-convert';
import { hasApi, insertDateCode } from '@/ui/h2022-edit-engine';
import { applyThroughRouter } from '@/ui/dialog-apply';
import { loadHanjaTable } from '@/ui/h2022-hanja';
import { CrossRefDialog } from '@/ui/h2022-edit-xref-dialog';
import { pageMoveTarget, type PageMove } from '@/engine/h2022-navigation';
import { ConvertKoreanDialog, HanjaDialog, hanjaTargets } from '@/ui/h2022-edit-hanja-dialog';

function notSupportedHere(): void {
  showToast({ message: '이 자리(머리말·꼬리말·각주 안)에서는 아직 쓸 수 없습니다.', durationMs: 4000 });
}

/** 캐럿 자리에 글 넣기(선택이 있으면 InsertTextCommand 가 하는 대로 — 입력과 같은 경로) */
function insertAtCaret(services: CommandServices, text: string): void {
  const ih = services.getInputHandler();
  if (!ih || !text) return;
  ih.executeOperation({ kind: 'command', command: new InsertTextCommand(ih.getCursorPosition(), text) });
  services.eventBus.emit('document-changed');
  ih.focus?.();
}

/**
 * 날짜/시간 코드(한/글 InsertFieldDateTime) — 캐럿 자리에 DATE 필드 + 오늘 날짜 글. 한/글 기본 형식(YYYY년 M월 D일)만
 * (다른 형식의 한/글 Command 부호는 실측하지 않았다). 본문 문단에서만 — 표 셀·머리말·각주 안은 알린다.
 */
function insertDateCodeAtCaret(services: CommandServices): void {
  const ih = services.getInputHandler() as any;
  const cursor = ih?.cursor;
  if (!ih || !cursor) return;
  if (!hasApi(services.wasm, 'insertDateCode')) { showToast({ message: '이 편집기 엔진은 날짜/시간 코드를 넣지 못합니다.', durationMs: 4000 }); return; }
  const pos = ih.getCursorPosition();
  if (cursor.isInHeaderFooter?.() || cursor.isInFootnote?.() || cursor.isInCell?.()) {
    showToast({ message: '날짜/시간 코드는 아직 본문 문단에만 넣습니다. 문자열(Ctrl+K,D)로 넣으세요.', durationMs: 5000 });
    return;
  }
  cursor.clearSelection?.();
  const text = formatDate(new Date(), DATE_FORMATS[0]);
  applyThroughRouter({
    services, label: 'insertDateCode', operationType: 'insertDateCode',
    operation: () => {
      const r = insertDateCode(services.wasm, pos.sectionIndex, pos.paragraphIndex, pos.charOffset, text);
      return r?.ok ? { ...pos, charOffset: r.charOffset + r.length, codeGap: undefined } : pos;
    },
    fallback: () => { insertDateCode(services.wasm, pos.sectionIndex, pos.paragraphIndex, pos.charOffset, text); services.eventBus.emit('document-changed'); },
  });
}

/** 한/글 MovePageBegin/End·MoveSectionUp/Down — 단축키 없는 액션이라 명령(명령 찾기)으로만 둔다 */
function pageMoveCommand(id: string, label: string, move: PageMove): CommandDef {
  return {
    id, label,
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler() as any;
      const cursor = ih?.cursor;
      if (!ih || !cursor || cursor.isInHeaderFooter?.() || cursor.isInFootnote?.()) return;
      const target = pageMoveTarget(services.wasm as any, ih.getCursorPosition(), move);
      if (!target) return;
      cursor.clearSelection?.();
      if (!ih.moveCursorTo(target)) cursor.moveTo(target);
      ih.updateCaret?.();
      ih.focus?.();
    },
  };
}

const editable = (ctx: { hasDocument: boolean; isFormMode: boolean }) => ctx.hasDocument && !ctx.isFormMode;

export const h2022EditCommands: CommandDef[] = [
  {
    id: 'insert:dutmal',
    label: '덧말 넣기',
    opensDialog: true,
    canExecute: editable,
    execute(services) {
      const at = composeTargetAt(services);
      if (!at) { notSupportedHere(); return; }
      new DutmalDialog(services, at, existingCompose(services, at.target, 'ruby')).show();
    },
  },
  {
    id: 'insert:compose-chars',
    label: '글자 겹치기',
    opensDialog: true,
    canExecute: editable,
    execute(services) {
      const at = composeTargetAt(services);
      if (!at) { notSupportedHere(); return; }
      new ComposeDialog(services, at, existingCompose(services, at.target, 'overlap')).show();
    },
  },
  {
    id: 'edit:convert-case',
    label: '대문자/소문자 바꾸기',
    opensDialog: true,
    canExecute: (ctx) => editable(ctx) && ctx.hasSelection,
    execute(services) { new ConvertCaseDialog(services).show(); },
  },
  {
    id: 'edit:convert-full-half',
    label: '전각/반각 바꾸기',
    opensDialog: true,
    canExecute: (ctx) => editable(ctx) && ctx.hasSelection,
    execute(services) { new ConvertFullHalfDialog(services).show(); },
  },
  {
    id: 'edit:convert-japanese',
    label: '일어 바꾸기',
    opensDialog: true,
    canExecute: (ctx) => editable(ctx) && ctx.hasSelection,
    execute(services) { new ConvertJapaneseDialog(services).show(); },
  },
  {
    // 한/글 ConvertHanjaDlg(F9) — 글자 단위(한자 표는 처음 쓸 때 불러온다)
    id: 'edit:convert-hanja',
    label: '한자로 바꾸기',
    shortcutLabel: 'F9',
    opensDialog: true,
    canExecute: editable,
    async execute(services) {
      const table = await loadHanjaTable();
      const at = hanjaTargets(services, table);
      if (!at) { showToast({ message: '이 자리(머리말·꼬리말·각주 안, 여러 문단 선택)에서는 아직 쓸 수 없습니다.', durationMs: 4000 }); return; }
      if (!at.spots.length) { showToast({ message: '한자로 바꿀 한글이 없습니다.', durationMs: 3000 }); return; }
      new HanjaDialog(services, table, at.host, at.spots).show();
    },
  },
  {
    // 한/글 ConvertKoreanDlg(Alt+F9) — 漢字를 한글로 / 漢字를 漢字(한글)로
    id: 'edit:convert-to-hangul',
    label: '한글로 바꾸기',
    shortcutLabel: 'Alt+F9',
    opensDialog: true,
    canExecute: (ctx) => editable(ctx) && ctx.hasSelection,
    async execute(services) {
      const table = await loadHanjaTable();
      new ConvertKoreanDialog(services, table).show();
    },
  },
  pageMoveCommand('edit:move-page-begin', '현재 쪽의 처음으로', 'pageBegin'),
  pageMoveCommand('edit:move-page-end', '현재 쪽의 끝으로', 'pageEnd'),
  pageMoveCommand('edit:move-page-prev', '앞 쪽의 시작으로', 'pagePrev'),
  pageMoveCommand('edit:move-page-next', '뒤 쪽의 시작으로', 'pageNext'),
  pageMoveCommand('edit:move-section-prev', '앞 구역으로', 'sectionPrev'),
  pageMoveCommand('edit:move-section-next', '뒤 구역으로', 'sectionNext'),
  {
    // 한/글 InsertCrossReferenceDlg(Ctrl+K,R) — 표·책갈피만
    id: 'insert:cross-reference',
    label: '상호 참조',
    shortcutLabel: 'Ctrl+K,R',
    opensDialog: true,
    canExecute: editable,
    execute(services) {
      if (!hasApi(services.wasm, 'insertCrossReference')) { showToast({ message: '이 편집기 엔진은 상호 참조를 넣지 못합니다.', durationMs: 4000 }); return; }
      new CrossRefDialog(services).show();
    },
  },
  {
    id: 'insert:date-string',
    label: '날짜/시간 문자열',
    shortcutLabel: 'Ctrl+K,D',
    canExecute: editable,
    execute(services) { insertAtCaret(services, formatDate(new Date(), dateFormatState.format)); },
  },
  {
    id: 'insert:date-code',
    label: '날짜/시간 코드',
    shortcutLabel: 'Ctrl+K,C',
    canExecute: editable,
    execute(services) { insertDateCodeAtCaret(services); },
  },
  {
    id: 'insert:date-format',
    label: '날짜/시간 형식',
    shortcutLabel: 'Ctrl+K,F',
    opensDialog: true,
    canExecute: editable,
    execute(services) { new DateFormatDialog((text) => insertAtCaret(services, text)).show(); },
  },
];

/** 엔진에 새 찾기 API 가 있는가(찾기 대화상자가 옵션 칸을 켤지) */
export function hasFindOptions(services: CommandServices): boolean {
  return hasApi(services.wasm, 'searchTextEx') && hasApi(services.wasm, 'replaceAllEx');
}
