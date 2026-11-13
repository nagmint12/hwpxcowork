/**
 * [hwpx-cowork] 개체 속성 '번호 종류'(없음·그림·표·수식) 고르기.
 *
 * 한/글 2022 실측(2026-11-03): 번호 종류가 그림·표·수식인 개체는 캡션이 없어도 그 셈의 번호 하나를 차지하고,
 * 캡션의 번호는 종류와 상관없이 제 개체 번호를 보인다(번호 종류 없음이면 1). 새 번호로 시작은 그 종류 셈을 다시 시작한다.
 * 번호는 엔진이 문서 처음부터 다시 센다 — 이 창은 종류만 바꾼다.
 */
import { t } from '../i18n/index.ts';
import type { ObjectNumberingType } from '@/core/types';

const OPTIONS: Array<[ObjectNumberingType, string]> = [
  ['NONE', 'dialog.objectNumbering.none'],
  ['PICTURE', 'dialog.objectNumbering.picture'],
  ['TABLE', 'dialog.objectNumbering.table'],
  ['EQUATION', 'dialog.objectNumbering.equation'],
];

export function createNumberingSelect(): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'dialog-select';
  for (const [value, key] of OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = t(key);
    sel.appendChild(opt);
  }
  return sel;
}

/** 엔진 값을 고르기에 — 모르는 값·옛 엔진(값 없음)이면 fallback */
export function setNumberingSelect(sel: HTMLSelectElement, value: string | undefined, fallback: ObjectNumberingType): void {
  sel.value = OPTIONS.some(([v]) => v === value) ? (value as ObjectNumberingType) : fallback;
  sel.dataset.initial = sel.value;
}

/** 처음 값에서 바뀌었을 때만 봉지에 넣을 값 */
export function changedNumbering(sel: HTMLSelectElement): ObjectNumberingType | undefined {
  return sel.value !== sel.dataset.initial ? (sel.value as ObjectNumberingType) : undefined;
}
