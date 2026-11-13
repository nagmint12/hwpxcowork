/**
 * [hwpx-cowork] 한/글 2022 개체 명령(2026-11-11, 개체 영역) — 맨 앞으로·앞으로·맨 뒤로·뒤로(모든 개체), 글 앞으로·글 뒤로,
 * 개체 보호하기·모든 보호 개체 해제하기, 개체 모양 복사·붙이기, 그림 바꾸기·삽입 그림 저장하기.
 *
 * 한/글 2022 동작은 COM 실측(`artifacts/h2022-object/com_probe.py`)과 메뉴 자료(`data/hangul2022_menu.json`)를 따른다.
 * 근거·남은 차이: `research/hangul2022-features-20261111/impl/ledger_object.md`.
 * 문서를 바꾸는 것은 모두 편집 라우터의 snapshot 으로 보낸다 — 되돌리기 한 번, 저장·서버 반영 경로(HWPX 내보내기)를 지난다.
 */
import type { CommandDef, CommandServices } from '../types';
import type { WasmBridge } from '@/core/wasm-bridge';
import { showToast } from '@/ui/toast';
import {
  cellPathJson, changeObjectZOrder, changePicture, getPictureEffects, setPictureEffects, copyObjectFormat, hasObjectApi, isBodyObject, objectFormatClip, objectInfo,
  pasteObjectFormat, setObjectLock, setObjectWrap, unlockAllObjects, alignObjects, type AlignMode, type ObjectAddrLike, type ZOrderOp,
} from '@/engine/object-h2022';
import { CopyObjectFormatDialog, PictureEffectsDialog, objectFormatState } from '@/ui/h2022-object-dialogs';

type Ref = ObjectAddrLike & { type: 'image' | 'shape' | 'equation' | 'group' | 'line' | 'ole' };

function selected(services: CommandServices): { ih: any; ref: Ref } | null {
  const ih = services.getInputHandler() as any;
  if (!ih) return null;
  const ref = ih.getSelectedPictureRef?.() as Ref | null;
  if (!isBodyObject(ref)) {
    if (ref) showToast({ message: '머리말·꼬리말·각주 안 개체에서는 아직 쓸 수 없습니다.', durationMs: 4000 });
    return null;
  }
  if (!hasObjectApi(services.wasm)) {
    showToast({ message: '엔진이 옛 판이라 이 기능을 쓸 수 없습니다.', durationMs: 4000 });
    return null;
  }
  return { ih, ref };
}

/**
 * 문서를 바꾸는 개체 조작 — snapshot 라우팅. mutate 가 false 를 돌려주면 바뀐 것이 없으므로 기록하지 않는다.
 * 캐럿 기록 자리는 insert.ts recordObjectMutation 과 같다(개체 밖 앵커 자리, #3351).
 */
function mutateObject(ih: any, operationType: string, mutate: (wasm: WasmBridge) => boolean): boolean {
  const pos = ih.getPositionOutsideSelectedPicture?.() ?? ih.getCursorPosition();
  let changed = false;
  ih.executeOperation({
    kind: 'snapshot',
    operationType,
    operation: (wasm: WasmBridge) => {
      changed = mutate(wasm);
      return changed ? pos : null;
    },
    meta: { refresh: 'none' },
  });
  return changed;
}

/** 조작 뒤 선택을 다시 그린다 — 한/글은 순서·배치·모양을 바꾼 뒤에도 개체를 고른 채로 둔다(COM: CurSelectedCtrl 그대로) */
function reselect(ih: any, ref: Ref): void {
  ih.exitPictureObjectSelectionAndAfterEdit?.();
  if (!cellPathJson(ref)) ih.selectPictureObject?.(ref.sec, ref.ppi, ref.ci, ref.type);
}

function orderCommand(id: string, label: string, op: ZOrderOp, shortcutLabel?: string): CommandDef {
  return {
    id,
    label,
    shortcutLabel,
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      mutateObject(s.ih, 'changeZOrder', (wasm) => changeObjectZOrder(wasm, s.ref, op).moves.length > 0);
      reselect(s.ih, s.ref);
    },
  };
}

function wrapCommand(id: string, label: string, wrap: 'InFrontOfText' | 'BehindText', shortcutLabel: string): CommandDef {
  return {
    id,
    label,
    shortcutLabel,
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      // 한/글: 글자처럼 취급한 개체·이미 그 배치인 개체는 실패(아무 일 없음)
      mutateObject(s.ih, 'setObjectWrap', (wasm) => setObjectWrap(wasm, s.ref, wrap).changed);
      reselect(s.ih, s.ref);
    },
  };
}

/** 그림 파일을 골라 바이트·원래 크기를 읽는다 */
function pickImage(onPicked: (data: Uint8Array, w: number, h: number, ext: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/bmp,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => (img.naturalWidth > 0 && img.naturalHeight > 0 ? resolve() : reject(new Error('이미지 크기를 확인할 수 없습니다.')));
        img.onerror = () => reject(new Error('브라우저가 이 이미지 파일을 읽지 못했습니다.'));
        img.src = url;
      });
      onPicked(data, img.naturalWidth, img.naturalHeight, file.name.split('.').pop()?.toLowerCase() || 'png');
    } catch (err) {
      showToast({ message: `그림을 바꿀 수 없습니다.\n${err instanceof Error ? err.message : String(err)}`, durationMs: 6000 });
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  input.click();
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp',
  'image/tiff': 'tif', 'image/svg+xml': 'svg', 'image/x-wmf': 'wmf', 'image/x-emf': 'emf',
};

/**
 * 여러 개체 맞춤(한/글 도구 상자 '맞춤'·'너비/높이를 같게') — Shift+클릭으로 고른 개체들, 기준 = 맨 마지막에 고른 개체.
 * 맞춤 2개 이상, 간격 같게 3개 이상(한/글 도움말). 글자처럼 취급·칸 안 개체는 엔진이 뺀다.
 */
function alignCommand(id: string, label: string, mode: AlignMode): CommandDef {
  return {
    id,
    label,
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const ih = services.getInputHandler() as any;
      if (!ih || !hasObjectApi(services.wasm)) return;
      const refs = (ih.getSelectedPictureRefs?.() ?? []) as ObjectAddrLike[];
      const need = mode === 'hspace' || mode === 'vspace' ? 3 : 2;
      if (refs.length < need) {
        showToast({ message: `개체를 ${need}개 이상 고르세요(Shift+클릭). 마지막에 고른 개체가 기준입니다.`, durationMs: 4000 });
        return;
      }
      let err = '';
      mutateObject(ih, 'alignObjects', (wasm) => {
        try { return alignObjects(wasm, refs, mode).moved > 0; } catch (e) { err = e instanceof Error ? e.message : String(e); return false; }
      });
      if (err) showToast({ message: err, durationMs: 4000 });
      ih.exitPictureObjectSelectionAndAfterEdit?.();
    },
  };
}

export const h2022ObjectCommands: CommandDef[] = [
  alignCommand('object:align-left', '왼쪽 맞춤', 'left'),
  alignCommand('object:align-center', '가운데 맞춤', 'center'),
  alignCommand('object:align-right', '오른쪽 맞춤', 'right'),
  alignCommand('object:align-top', '위쪽 맞춤', 'top'),
  alignCommand('object:align-middle', '중간 맞춤', 'middle'),
  alignCommand('object:align-bottom', '아래쪽 맞춤', 'bottom'),
  alignCommand('object:space-horz', '가로 간격을 동일하게', 'hspace'),
  alignCommand('object:space-vert', '세로 간격을 동일하게', 'vspace'),
  alignCommand('object:same-width', '너비를 같게', 'width'),
  alignCommand('object:same-height', '높이를 같게', 'height'),
  alignCommand('object:same-size', '너비 및 높이를 같게', 'size'),
  orderCommand('object:order-first', '맨 앞으로', 'front', 'Shift+PgUp'),
  orderCommand('object:order-front', '앞으로', 'forward'),
  orderCommand('object:order-last', '맨 뒤로', 'back', 'Shift+PgDn'),
  orderCommand('object:order-back', '뒤로', 'backward'),
  wrapCommand('object:in-front-of-text', '글 앞으로', 'InFrontOfText', 'Shift+Home'),
  wrapCommand('object:behind-text', '글 뒤로', 'BehindText', 'Shift+End'),
  {
    id: 'object:lock',
    label: '개체 보호하기',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      mutateObject(s.ih, 'lockObject', (wasm) => !setObjectLock(wasm, s.ref, true).before);
      // 한/글: 보호하면 선택이 풀리고, 보호한 개체는 마우스로 다시 고를 수 없다
      s.ih.exitPictureObjectSelectionAndAfterEdit?.();
    },
  },
  {
    id: 'object:unlock-all',
    label: '모든 보호 개체 해제하기',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      const ih = services.getInputHandler() as any;
      if (!ih || !hasObjectApi(services.wasm)) return;
      let count = 0;
      mutateObject(ih, 'unlockAllObjects', (wasm) => { count = unlockAllObjects(wasm).count; return count > 0; });
      if (count === 0) showToast({ message: '보호된 개체가 없습니다.', durationMs: 3000 }); // 한/글 IDS_SO_UNLOCK_WARNING
      else services.eventBus.emit('document-changed');
    },
  },
  {
    id: 'object:copy-format',
    label: '개체 모양 복사',
    shortcutLabel: 'Alt+Shift+C',
    opensDialog: true,
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      new CopyObjectFormatDialog(() => {
        try {
          copyObjectFormat(services.wasm, s.ref);
          return true;
        } catch (err) {
          showToast({ message: `개체 모양을 복사할 수 없습니다.\n${err instanceof Error ? err.message : String(err)}`, durationMs: 5000 });
          return false;
        }
      }).show();
    },
  },
  {
    id: 'object:paste-format',
    label: '개체 모양 붙이기',
    shortcutLabel: 'Alt+Shift+V',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      if (!objectFormatClip(services.wasm)?.has) {
        showToast({ message: '먼저 개체 모양을 복사하세요(Alt+Shift+C).', durationMs: 3000 });
        return;
      }
      const flags = objectFormatState.flags;
      mutateObject(s.ih, 'pasteObjectFormat', (wasm) => pasteObjectFormat(wasm, s.ref, flags).applied.length > 0);
      reselect(s.ih, s.ref);
    },
  },
  {
    id: 'object:picture-change',
    label: '그림 바꾸기',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      if (s.ref.type !== 'image') { showToast({ message: '그림을 고른 뒤 쓰세요.', durationMs: 3000 }); return; }
      pickImage((data, w, h, ext) => {
        mutateObject(s.ih, 'changePicture', (wasm) => { changePicture(wasm, s.ref, data, w, h, ext); return true; });
        reselect(s.ih, s.ref);
      });
    },
  },
  {
    id: 'object:picture-effects',
    label: '그림 효과',
    opensDialog: true,
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      if (s.ref.type !== 'image') { showToast({ message: '그림을 고른 뒤 쓰세요.', durationMs: 3000 }); return; }
      const before = getPictureEffects(services.wasm, s.ref);
      new PictureEffectsDialog(before, (v) => {
        mutateObject(s.ih, 'pictureEffects', (wasm) => { setPictureEffects(wasm, s.ref, v); return JSON.stringify(v) !== JSON.stringify(before); });
        reselect(s.ih, s.ref);
        return true;
      }).show();
    },
  },
  {
    id: 'object:picture-save',
    label: '삽입 그림 저장하기',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const s = selected(services);
      if (!s) return;
      try {
        const doc = (services.wasm as any).doc;
        const path = cellPathJson(s.ref);
        const bytes: Uint8Array = doc.getControlImageData(s.ref.sec, s.ref.ppi, path, s.ref.ci);
        const mime: string = doc.getControlImageMime(s.ref.sec, s.ref.ppi, path, s.ref.ci) || 'application/octet-stream';
        if (!bytes || bytes.length === 0) throw new Error('그림 자료가 없습니다(연결 그림이거나 빠진 그림).');
        const blob = new Blob([bytes.slice().buffer], { type: mime });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `그림.${MIME_EXT[mime] ?? 'bin'}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      } catch (err) {
        showToast({ message: `그림을 저장할 수 없습니다.\n${err instanceof Error ? err.message : String(err)}`, durationMs: 5000 });
      }
    },
  },
];

/** 개체 속성 대화상자의 '개체 보호하기' 칸이 쓰는 읽기·쓰기(라우터 밖에서 부르지 않는다 — 대화상자 적용 경로에서) */
export function readObjectLocked(wasm: unknown, ref: ObjectAddrLike): boolean | null {
  return objectInfo(wasm, ref)?.locked ?? null;
}
