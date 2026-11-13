/**
 * [hwpx-cowork] 한/글 2022 '차트 디자인' — 차트 종류 변경·차트 구성 추가 대화상자(2026-11-11, 차트 영역).
 *
 * 한/글은 도구 상자 단추(차트 종류 변경 갤러리, 차트 구성 추가 ▸ 축·축 제목·차트 제목·데이터 레이블·눈금선·범례)로 고른다.
 * 편집기는 한 창에 같은 이름·같은 선택지를 모았다. 값 ↔ 엔진 JSON 은 `@/core/h2022-chart-format`(순수 함수),
 * 쓰기는 엔진 `setChartFormatByIndex`(한/글 저장 꼴 — COM 실측)를 편집 라우터 snapshot 으로 보낸다(되돌리기 한 번, 저장·서버 반영 경로).
 */
import { ModalDialog } from './dialog';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';
import type { ChartContainerRefJson, ChartRefJson } from '@/core/chart-data-target';
import {
  CHART_GROUP_NAMES,
  COLOR_CHOICES,
  LAYOUT_CHOICES,
  LEGEND_CHOICES,
  TITLE_CHOICES,
  buildFormatOps,
  formFromState,
  hasFormatOps,
  kindHasAxes,
  type ChartFormatForm,
  type ChartFormatState,
} from '@/core/h2022-chart-format';

export function sameChartAddress(a: ChartRefJson, b: ChartRefJson): boolean {
  const ac = a.container ?? [];
  const bc = b.container ?? [];
  return (
    a.section === b.section &&
    a.paragraph === b.paragraph &&
    a.control === b.control &&
    ac.length === bc.length &&
    ac.every((level: ChartContainerRefJson, i: number) =>
      level.kind === bc[i].kind && level.control === bc[i].control && level.paragraph === bc[i].paragraph && level.cell === bc[i].cell)
  );
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

function select(options: { value: string; label: string }[], value: string): HTMLSelectElement {
  const s = el('select', 'min-width:140px;');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  s.value = value;
  return s;
}

export class ChartFormatDialog extends ModalDialog {
  private wasm: WasmBridge;
  private eventBus: EventBus;
  private services?: CommandServices;
  private chart: ChartRefJson | null = null;
  private state: ChartFormatState | null = null;
  private form: ChartFormatForm | null = null;
  private bodyEl!: HTMLDivElement;
  private errorEl!: HTMLDivElement;

  constructor(wasm: WasmBridge, eventBus: EventBus, services?: CommandServices) {
    super('차트 구성', 460, false);
    this.wasm = wasm;
    this.eventBus = eventBus;
    this.services = services;
  }

  /** 열거 항목으로 연다. 구성을 읽지 못하면 false(호출부가 안내). */
  open(chart: ChartRefJson): boolean {
    let state: ChartFormatState;
    try {
      state = this.wasm.getChartFormatByIndex(chart.index);
    } catch {
      return false;
    }
    if (!state.ok) return false;
    this.chart = chart;
    this.state = state;
    this.form = formFromState(state);
    this.show();
    this.render();
    return true;
  }

  protected createBody(): HTMLElement {
    const body = el('div', 'display:flex;flex-direction:column;gap:8px;padding:6px 4px;');
    this.bodyEl = el('div', 'display:flex;flex-direction:column;gap:10px;');
    this.errorEl = el('div', 'color:#c00;display:none;white-space:pre-wrap;');
    body.appendChild(this.bodyEl);
    body.appendChild(this.errorEl);
    return body;
  }

  private section(title: string): HTMLDivElement {
    const s = el('div', 'display:flex;flex-direction:column;gap:4px;');
    s.appendChild(el('div', 'font-weight:600;', title));
    this.bodyEl.appendChild(s);
    return s;
  }

  private row(parent: HTMLElement, label: string, ...controls: HTMLElement[]): void {
    const r = el('label', 'display:flex;gap:8px;align-items:center;');
    r.appendChild(el('span', 'min-width:84px;', label));
    for (const c of controls) r.appendChild(c);
    parent.appendChild(r);
  }

  private render(): void {
    const s = this.state;
    const f = this.form;
    if (!s || !f) return;
    this.bodyEl.replaceChildren();
    this.errorEl.style.display = 'none';

    // ── 차트 종류 변경 ──
    const kinds = s.kinds ?? [];
    const groups = [...new Set(kinds.map((k) => k.group))];
    const typeSec = this.section('차트 종류 변경');
    const groupSel = select(
      [
        ...(f.group === null ? [{ value: '', label: '(지금 종류 — 바꾸지 않음)' }] : []),
        ...groups.map((g) => ({ value: String(g), label: CHART_GROUP_NAMES[g] ?? String(g) })),
      ],
      f.group === null ? '' : String(f.group),
    );
    const kindSel = select([], '');
    const fillKinds = () => {
      kindSel.replaceChildren();
      const g = groupSel.value === '' ? null : Number(groupSel.value);
      for (const k of kinds.filter((k) => k.group === g)) {
        const o = document.createElement('option');
        o.value = String(k.index);
        o.textContent = k.name;
        kindSel.appendChild(o);
      }
      kindSel.disabled = g === null;
      if (g !== null) kindSel.value = String(g === f.group && f.index !== null ? f.index : kinds.find((k) => k.group === g)?.index ?? 0);
    };
    fillKinds();
    groupSel.addEventListener('change', () => {
      fillKinds();
      f.group = groupSel.value === '' ? null : Number(groupSel.value);
      f.index = f.group === null ? null : Number(kindSel.value);
      this.render();
    });
    kindSel.addEventListener('change', () => {
      f.index = Number(kindSel.value);
    });
    this.row(typeSec, '묶음', groupSel);
    this.row(typeSec, '종류', kindSel);
    if (s.group === null) {
      typeSec.appendChild(el('div', 'color:#666;font-size:12px;', '지금 차트는 이 창에서 고를 수 없는 종류입니다(그대로 둘 수 있습니다).'));
    }

    // ── 차트 계열색 바꾸기·차트 레이아웃(한/글 차트 디자인 도구 상자) ──
    const keep = { value: '', label: '(그대로)' };
    const colorSel = select([keep, ...COLOR_CHOICES.map((c) => ({ value: String(c.value), label: c.label }))], f.colors === null ? '' : String(f.colors));
    colorSel.addEventListener('change', () => {
      f.colors = colorSel.value === '' ? null : Number(colorSel.value);
    });
    this.row(typeSec, '차트 계열색', colorSel);
    const layoutSel = select([keep, ...LAYOUT_CHOICES.map((c) => ({ value: String(c.value), label: c.label }))], f.layout === null ? '' : String(f.layout));
    layoutSel.addEventListener('change', () => {
      f.layout = layoutSel.value === '' ? null : Number(layoutSel.value);
    });
    this.row(typeSec, '차트 레이아웃', layoutSel);

    // ── 차트 구성 추가 ──
    const itemSec = this.section('차트 구성 추가');
    const titleSel = select(TITLE_CHOICES, f.title);
    const titleText = el('input', 'flex:1;min-width:120px;') as HTMLInputElement;
    titleText.type = 'text';
    titleText.placeholder = '차트 제목';
    titleText.value = f.titleText;
    titleText.disabled = f.title === 'none';
    titleSel.addEventListener('change', () => {
      f.title = titleSel.value as ChartFormatForm['title'];
      titleText.disabled = f.title === 'none';
    });
    titleText.addEventListener('input', () => {
      f.titleText = titleText.value;
    });
    this.row(itemSec, '차트 제목', titleSel, titleText);

    const legendSel = select(LEGEND_CHOICES, f.legend);
    legendSel.addEventListener('change', () => {
      f.legend = legendSel.value as ChartFormatForm['legend'];
    });
    this.row(itemSec, '범례', legendSel);

    const labelSel = select([{ value: '0', label: '없음' }, { value: '1', label: '표시' }], f.dataLabels ? '1' : '0');
    labelSel.addEventListener('change', () => {
      f.dataLabels = labelSel.value === '1';
    });
    this.row(itemSec, '데이터 레이블', labelSel);

    const axesNow = f.group !== null && f.group !== s.group ? kindHasAxes(f.group) : s.hasAxes;
    if (!axesNow) {
      itemSec.appendChild(el('div', 'color:#666;font-size:12px;', '원형 차트에는 축·축 제목·눈금선이 없습니다.'));
      return;
    }
    // 원형에서 축 있는 종류로 바꾸면 한/글은 축을 새로 만든다 — 그 기본값(보임, 값 축 눈금선 없음 — 실측)으로 시작
    f.horizontalAxis ??= { visible: true, majorGrid: false, title: false, titleText: '' };
    f.verticalAxis ??= { visible: true, majorGrid: false, title: false, titleText: '' };
    const h = f.horizontalAxis;
    const v = f.verticalAxis;
    const check = (on: boolean, set: (b: boolean) => void, text: string) => {
      const wrap = el('label', 'display:inline-flex;gap:4px;align-items:center;margin-right:10px;');
      const c = el('input') as HTMLInputElement;
      c.type = 'checkbox';
      c.checked = on;
      c.addEventListener('change', () => set(c.checked));
      wrap.appendChild(c);
      wrap.appendChild(document.createTextNode(text));
      return wrap;
    };
    this.row(itemSec, '축', check(h.visible, (b) => (h.visible = b), '기본 가로'), check(v.visible, (b) => (v.visible = b), '기본 세로'));
    const axisTitle = (a: { title: boolean; titleText: string }, label: string) => {
      const t = el('input', 'width:120px;') as HTMLInputElement;
      t.type = 'text';
      t.placeholder = '축 제목';
      t.value = a.titleText;
      t.disabled = !a.title;
      t.addEventListener('input', () => (a.titleText = t.value));
      const c = check(a.title, (b) => {
        a.title = b;
        t.disabled = !b;
      }, label);
      const span = el('span', 'display:inline-flex;gap:4px;align-items:center;margin-right:6px;');
      span.appendChild(c);
      span.appendChild(t);
      return span;
    };
    this.row(itemSec, '축 제목', axisTitle(h, '기본 가로'), axisTitle(v, '기본 세로'));
    // 눈금선 '기본 주 가로' = 가로로 놓인 선(세로 축의 주 눈금선), '기본 주 세로' = 세로로 놓인 선(가로 축의 주 눈금선)
    this.row(
      itemSec,
      '눈금선',
      check(v.majorGrid, (b) => (v.majorGrid = b), '기본 주 가로'),
      check(h.majorGrid, (b) => (h.majorGrid = b), '기본 주 세로'),
    );
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.style.display = '';
  }

  protected onConfirm(): void | boolean {
    const chart = this.chart;
    const state = this.state;
    const form = this.form;
    if (!chart || !state || !form) return;
    const ops = buildFormatOps(state, form);
    if (!hasFormatOps(ops)) return;
    const ih = this.services?.getInputHandler() as any;
    const result: { ok: boolean; message?: string; found: boolean } = { ok: false, found: false };
    const run = (wasm: WasmBridge) => {
      const found = wasm.listCharts().find((c) => sameChartAddress(c, chart));
      if (!found) return false;
      result.found = true;
      const res = wasm.setChartFormatByIndex(found.index, ops);
      result.ok = res.ok;
      if (!res.ok) result.message = (res.invalid ?? []).map((i) => i.message).join('\n');
      return res.ok && res.changed !== false;
    };
    if (!ih) {
      if (run(this.wasm)) this.eventBus.emit('document-changed');
    } else {
      ih.executeOperation({
        kind: 'snapshot',
        operationType: 'objectProps',
        operation: (wasm: WasmBridge) => (run(wasm) ? ih.getCursorPosition() : null),
      });
    }
    if (!result.found) {
      this.showError('차트를 다시 찾지 못했습니다 — 문서가 바뀌었습니다. 창을 닫고 다시 여세요.');
      return false;
    }
    if (!result.ok) {
      this.showError(result.message || '차트 구성을 바꾸지 못했습니다.');
      return false;
    }
  }
}
