/**
 * [hwpx-cowork] 한/글 2022 개체 대화상자(2026-11-11) — 개체 모양 복사(CopyShapeFormatDlg, Alt+Shift+C).
 *
 * 한/글 파라미터셋 ShapeObjectCopyPaste 의 다섯 항목(선 모양·채우기·크기·그림자·그림 효과)을 고른다. 고른 것은
 * 기억해 두었다가 개체 모양 붙이기(Alt+Shift+V)에 그대로 쓴다(한/글 COM 실측: 붙이기 플래그로 고른 것만 바뀐다).
 * 대화상자의 처음 체크 상태는 한/글에서 재지 못했다(COM GetDefault 는 모두 0 — 원장 ledger_object.md '미실측').
 */
import { ModalDialog } from './dialog';
import type { FormatFlags, PictureEffectsValue } from '@/engine/object-h2022';

export const FORMAT_FLAG_LABELS: Array<[keyof FormatFlags, string]> = [
  ['line', '선 모양'],
  ['fill', '채우기'],
  ['size', '크기'],
  ['shadow', '그림자'],
  ['picEffect', '그림 효과'],
];

/** 마지막으로 고른 개체 모양 항목(붙이기가 쓴다) */
export const objectFormatState: { flags: FormatFlags } = {
  flags: { line: true, fill: true, size: false, shadow: true, picEffect: true },
};

export class CopyObjectFormatDialog extends ModalDialog {
  private boxes: Partial<Record<keyof FormatFlags, HTMLInputElement>> = {};
  constructor(private onOk: (flags: FormatFlags) => boolean) { super('개체 모양 복사', 300); }
  protected createBody(): HTMLElement {
    const b = document.createElement('div');
    b.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 4px;';
    const cap = document.createElement('div');
    cap.textContent = '복사할 모양';
    b.appendChild(cap);
    for (const [k, label] of FORMAT_FLAG_LABELS) {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;gap:6px;align-items:center;';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = objectFormatState.flags[k];
      this.boxes[k] = c;
      l.append(c, document.createTextNode(label));
      b.appendChild(l);
    }
    return b;
  }
  protected onConfirm(): boolean {
    const flags = { ...objectFormatState.flags };
    for (const [k] of FORMAT_FLAG_LABELS) flags[k] = this.boxes[k]?.checked === true;
    objectFormatState.flags = flags;
    return this.onOk(flags);
  }
}

// ───────── 그림 효과(그림자·네온·옅은 테두리·반사) — 2026-11-12 ─────────

/** 대화상자 칸 값(사람 단위: 길이 pt, 투명도 %, 각도 도) */
export interface PictureEffectsForm {
  shadowOn: boolean; shadowColor: string; shadowTransparency: number; shadowBlurPt: number; shadowAngle: number; shadowDistancePt: number;
  glowOn: boolean; glowColor: string; glowTransparency: number; glowSizePt: number;
  softOn: boolean; softSizePt: number;
  reflOn: boolean; reflTransparency: number; reflSizePercent: number; reflDistancePt: number;
}

/**
 * 효과가 없을 때 처음 값. 그림자는 한/글이 저장한 견본(samples aift.hwpx — 투명도 80%, 흐리게 4pt, 45도, 거리 10pt, 검정)을 따른다.
 * 네온(빨강 50%, 10pt), 옅은 테두리(5pt), 반사(투명도 50%, 크기 90%, 거리 0)는 한/글 대화상자 처음 값을 재지 못해
 * effect_probe 실측 변형 값을 쓴다(미실측).
 */
export const PICTURE_EFFECT_DEFAULTS: PictureEffectsForm = {
  shadowOn: false, shadowColor: '#000000', shadowTransparency: 80, shadowBlurPt: 4, shadowAngle: 45, shadowDistancePt: 10,
  glowOn: false, glowColor: '#FF0000', glowTransparency: 50, glowSizePt: 10,
  softOn: false, softSizePt: 5,
  reflOn: false, reflTransparency: 50, reflSizePercent: 90, reflDistancePt: 0,
};

/** 엔진 값 → 칸 값 (1pt = 100 HWPUNIT) */
export function effectsToForm(v: PictureEffectsValue | null): PictureEffectsForm {
  const f = { ...PICTURE_EFFECT_DEFAULTS };
  if (!v) return f;
  if (v.shadow) Object.assign(f, { shadowOn: true, shadowColor: v.shadow.color, shadowTransparency: Math.round(v.shadow.alpha * 100), shadowBlurPt: v.shadow.radius / 100, shadowAngle: v.shadow.direction, shadowDistancePt: v.shadow.distance / 100 });
  if (v.glow) Object.assign(f, { glowOn: true, glowColor: v.glow.color, glowTransparency: Math.round(v.glow.alpha * 100), glowSizePt: v.glow.radius / 100 });
  if (v.softEdge) Object.assign(f, { softOn: true, softSizePt: v.softEdge.radius / 100 });
  if (v.reflection) Object.assign(f, { reflOn: true, reflTransparency: Math.round(v.reflection.alphaStart * 100), reflSizePercent: Math.round(v.reflection.posEnd * 100), reflDistancePt: v.reflection.distance / 100 });
  return f;
}

/** 칸 값 → 엔진 값(네 가지를 모두 보낸다 — 끄면 null) */
export function formToEffects(f: PictureEffectsForm, before: PictureEffectsValue | null): PictureEffectsValue {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
  return {
    shadow: f.shadowOn ? { style: before?.shadow?.style ?? 'OUTSIDE', alpha: clamp(f.shadowTransparency, 0, 100) / 100, radius: Math.round(clamp(f.shadowBlurPt, 0, 100) * 100), direction: clamp(f.shadowAngle, 0, 359), distance: Math.round(clamp(f.shadowDistancePt, 0, 200) * 100), color: f.shadowColor } : null,
    glow: f.glowOn ? { alpha: clamp(f.glowTransparency, 0, 100) / 100, radius: Math.round(clamp(f.glowSizePt, 0, 150) * 100), color: f.glowColor } : null,
    softEdge: f.softOn ? { radius: Math.round(clamp(f.softSizePt, 0, 100) * 100) } : null,
    reflection: f.reflOn ? { radius: before?.reflection?.radius ?? 0, distance: Math.round(clamp(f.reflDistancePt, 0, 100) * 100), alphaStart: clamp(f.reflTransparency, 0, 100) / 100, alphaEnd: before?.reflection?.alphaEnd ?? 1, posStart: before?.reflection?.posStart ?? 0, posEnd: clamp(f.reflSizePercent, 1, 100) / 100 } : null,
  };
}

/** 그림 효과 대화상자 — 한/글 2022 그림 효과(그림자, 반사, 네온, 옅은 테두리) 칸. 그리기는 그림자와 네온만(원장) */
export class PictureEffectsDialog extends ModalDialog {
  private inputs: Record<string, HTMLInputElement> = {};
  constructor(private value: PictureEffectsValue | null, private onOk: (v: PictureEffectsValue) => boolean) { super('그림 효과', 360); }
  private field(box: HTMLElement, key: keyof PictureEffectsForm, label: string, type: string, val: unknown, unit = ''): void {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:2px 0;';
    const i = document.createElement('input');
    i.type = type;
    if (type === 'checkbox') i.checked = Boolean(val); else { i.value = String(val); i.style.width = type === 'color' ? '40px' : '64px'; }
    this.inputs[key] = i;
    row.append(document.createTextNode(label), i, document.createTextNode(unit));
    box.appendChild(row);
  }
  protected createBody(): HTMLElement {
    const f = effectsToForm(this.value);
    const b = document.createElement('div');
    b.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:6px 2px;';
    const group = (title: string) => { const fs = document.createElement('fieldset'); const lg = document.createElement('legend'); lg.textContent = title; fs.appendChild(lg); b.appendChild(fs); return fs; };
    let g = group('그림자');
    this.field(g, 'shadowOn', '그림자', 'checkbox', f.shadowOn);
    this.field(g, 'shadowColor', '색', 'color', f.shadowColor);
    this.field(g, 'shadowTransparency', '투명도', 'number', f.shadowTransparency, '%');
    this.field(g, 'shadowBlurPt', '흐리게', 'number', f.shadowBlurPt, 'pt');
    this.field(g, 'shadowAngle', '각도', 'number', f.shadowAngle, '도');
    this.field(g, 'shadowDistancePt', '거리', 'number', f.shadowDistancePt, 'pt');
    g = group('네온');
    this.field(g, 'glowOn', '네온', 'checkbox', f.glowOn);
    this.field(g, 'glowColor', '색', 'color', f.glowColor);
    this.field(g, 'glowTransparency', '투명도', 'number', f.glowTransparency, '%');
    this.field(g, 'glowSizePt', '크기', 'number', f.glowSizePt, 'pt');
    g = group('옅은 테두리(저장만, 화면에는 아직 그리지 않음)');
    this.field(g, 'softOn', '옅은 테두리', 'checkbox', f.softOn);
    this.field(g, 'softSizePt', '크기', 'number', f.softSizePt, 'pt');
    g = group('반사(저장만, 화면에는 아직 그리지 않음)');
    this.field(g, 'reflOn', '반사', 'checkbox', f.reflOn);
    this.field(g, 'reflTransparency', '투명도', 'number', f.reflTransparency, '%');
    this.field(g, 'reflSizePercent', '크기', 'number', f.reflSizePercent, '%');
    this.field(g, 'reflDistancePt', '거리', 'number', f.reflDistancePt, 'pt');
    return b;
  }
  protected onConfirm(): boolean {
    const f = { ...PICTURE_EFFECT_DEFAULTS } as PictureEffectsForm;
    for (const [k, i] of Object.entries(this.inputs)) {
      (f as unknown as Record<string, unknown>)[k] = i.type === 'checkbox' ? i.checked : i.type === 'color' ? i.value.toUpperCase() : Number(i.value);
    }
    return this.onOk(formToEffects(f, this.value));
  }
}
