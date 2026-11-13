/**
 * 표 계산식 대화상자 (ModalDialog 패턴)
 *
 * 한컴 [표-계산식] 대화상자와 동일한 기능:
 * - 계산식 입력 (= 또는 @ 시작)
 * - 함수 목록 드롭다운
 * - 쉬운 범위 (left, right, above, below)
 * - 형식 (기본, 정수, 소수 등)
 * - 세 자리마다 쉼표 구분
 */
import { ModalDialog } from './dialog';
import { makeOption } from './dom-utils';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';

import { t } from '../i18n/index.ts';
interface FormulaContext {
  sec: number;
  ppi: number;
  ci: number;
  cellIndex: number;
}

const FUNCTIONS = [
  { name: 'SUM', desc: '합계' },
  { name: 'AVERAGE', desc: '평균' },
  { name: 'PRODUCT', desc: '곱' },
  { name: 'MIN', desc: '최소값' },
  { name: 'MAX', desc: '최대값' },
  { name: 'COUNT', desc: '개수' },
  { name: 'ABS', desc: '절대값' },
  { name: 'SQRT', desc: '제곱근' },
  { name: 'ROUND', desc: '반올림' },
  { name: 'CEILING', desc: '올림' },
  { name: 'FLOOR', desc: '내림' },
  { name: 'TRUNC', desc: '절삭' },
  { name: 'MOD', desc: '나머지' },
  { name: 'IF', desc: '조건' },
  { name: 'INT', desc: '정수' },
  { name: 'SIGN', desc: '부호' },
  { name: 'EXP', desc: 'e 거듭제곱' },
  { name: 'LN', desc: '자연로그' },
  { name: 'LOG', desc: '상용로그' },
  { name: 'LOG10', desc: '상용로그' },
  { name: 'SIN', desc: '사인' },
  { name: 'COS', desc: '코사인' },
  { name: 'TAN', desc: '탄젠트' },
];

const EASY_RANGES = [
  { value: '', label: t('dialog.formula.label') },
  { value: 'left', label: t('dialog.formula.label.x7d8044') },
  { value: 'right', label: t('dialog.formula.label.xe04b72') },
  { value: 'above', label: t('dialog.formula.label.xf89383') },
  { value: 'below', label: t('dialog.formula.label.x73df79') },
];

const FORMATS = [
  { value: 'default', label: t('dialog.formula.label.xa5b30c') },
  { value: 'integer', label: t('dialog.formula.label.xf1039f') },
  { value: 'decimal1', label: t('dialog.formula.label.xcb1e28') },
  { value: 'decimal2', label: t('dialog.formula.label.xf5b781') },
  // [hwpx-cowork] 한/글 2022 계산식 형식의 소수점 이하 세·네 자리
  { value: 'decimal3', label: '소수점 이하 세 자리' },
  { value: 'decimal4', label: '소수점 이하 네 자리' },
];

/** [hwpx-cowork] 형식 선택 → 한/글 계산식 결과 형식(`%g`·`%.Nf`, 세 자리 쉼표면 끝에 `,`). */
export function formulaResultFormat(format: string, comma: boolean): string {
  const base = format === 'integer' ? '%.0f'
    : format === 'decimal1' ? '%.1f'
    : format === 'decimal2' ? '%.2f'
    : format === 'decimal3' ? '%.3f'
    : format === 'decimal4' ? '%.4f'
    : '%g';
  return comma ? `${base},` : base;
}

/** [hwpx-cowork] 결과 형식 → 형식 선택 값·쉼표(대화상자에 지금 식을 보일 때). */
export function formulaFormatChoice(resultFormat: string): { format: string; comma: boolean } {
  const comma = resultFormat.endsWith(',');
  const base = comma ? resultFormat.slice(0, -1) : resultFormat;
  const m = /^%\.(\d)f$/.exec(base);
  const n = m ? Number(m[1]) : -1;
  const format = n === 0 ? 'integer' : n >= 1 && n <= 4 ? `decimal${n}` : 'default';
  return { format, comma };
}

export class FormulaDialog extends ModalDialog {
  private wasm: any;
  private eventBus: EventBus;
  private ctx: FormulaContext;
  private formulaInput!: HTMLInputElement;
  private funcSelect!: HTMLSelectElement;
  private formatSelect!: HTMLSelectElement;
  private commaCheck!: HTMLInputElement;
  private errorMsg!: HTMLDivElement;

  constructor(wasm: any, eventBus: EventBus, ctx: FormulaContext, private services?: CommandServices) {
    super(t('dialog.formula.title'), 420);
    this.wasm = wasm;
    this.eventBus = eventBus;
    this.ctx = ctx;
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'formula-dialog-body';

    // 계산식 입력
    body.appendChild(this.createRow(t('dialog.formula.createRow.label'), () => {
      this.formulaInput = document.createElement('input');
      this.formulaInput.type = 'text';
      this.formulaInput.className = 'formula-input';
      this.formulaInput.value = '=';
      this.formulaInput.placeholder = '=SUM(A1:A5)';
      return this.formulaInput;
    }));

    // 함수 선택
    body.appendChild(this.createRow(t('dialog.formula.createRow.label.xe97392'), () => {
      this.funcSelect = document.createElement('select');
      this.funcSelect.className = 'formula-select';
      this.funcSelect.appendChild(makeOption('', t('dialog.formula.makeOption.label')));
      FUNCTIONS.forEach(f => this.funcSelect.appendChild(makeOption(f.name, `${f.name} - ${f.desc}`)));
      this.funcSelect.addEventListener('change', () => {
        const func = this.funcSelect.value;
        if (func) {
          const pos = this.formulaInput.selectionStart ?? this.formulaInput.value.length;
          const before = this.formulaInput.value.substring(0, pos);
          const after = this.formulaInput.value.substring(pos);
          this.formulaInput.value = before + func + '()' + after;
          this.formulaInput.focus();
          this.formulaInput.selectionStart = this.formulaInput.selectionEnd = pos + func.length + 1;
          this.funcSelect.value = '';
        }
      });
      return this.funcSelect;
    }));

    // 쉬운 범위
    body.appendChild(this.createRow(t('dialog.formula.createRow.label.x7dcf38'), () => {
      const sel = document.createElement('select');
      sel.className = 'formula-select';
      EASY_RANGES.forEach(r => sel.appendChild(makeOption(r.value, r.label)));
      sel.addEventListener('change', () => {
        if (sel.value) {
          const pos = this.formulaInput.selectionStart ?? this.formulaInput.value.length;
          const before = this.formulaInput.value.substring(0, pos);
          const after = this.formulaInput.value.substring(pos);
          this.formulaInput.value = before + sel.value + after;
          this.formulaInput.focus();
          sel.value = '';
        }
      });
      return sel;
    }));

    // 형식
    body.appendChild(this.createRow(t('dialog.formula.createRow.label.xb85e7a'), () => {
      this.formatSelect = document.createElement('select');
      this.formatSelect.className = 'formula-select';
      FORMATS.forEach(f => this.formatSelect.appendChild(makeOption(f.value, f.label)));
      return this.formatSelect;
    }));

    // 쉼표 구분
    const commaRow = document.createElement('div');
    commaRow.className = 'formula-row';
    const commaLabel = document.createElement('label');
    this.commaCheck = document.createElement('input');
    this.commaCheck.type = 'checkbox';
    // [hwpx-cowork] 한/글 2022 기본 결과 형식(%g)에는 세 자리 쉼표가 없다(COM 실측 쉬운 계산식).
    this.commaCheck.checked = false;
    commaLabel.appendChild(this.commaCheck);
    commaLabel.appendChild(document.createTextNode(t('dialog.formula.createBody.text')));
    commaRow.appendChild(commaLabel);
    body.appendChild(commaRow);

    // 오류 메시지 영역
    this.errorMsg = document.createElement('div');
    this.errorMsg.className = 'formula-error';
    this.errorMsg.style.display = 'none';
    body.appendChild(this.errorMsg);

    return body;
  }

  private createRow(labelText: string, createControl: () => HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'formula-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(createControl());
    return row;
  }

  show(): void {
    super.show();
    // [hwpx-cowork] 계산식 칸이면 지금 식과 형식을 보인다(한/글 계산식 대화상자처럼).
    try {
      const current = this.wasm.getTableCellFormula?.(this.ctx.sec, this.ctx.ppi, this.ctx.ci, this.ctx.cellIndex);
      if (current?.formula) {
        this.formulaInput.value = current.formula;
        const choice = formulaFormatChoice(current.resultFormat ?? '%g');
        this.formatSelect.value = choice.format;
        this.commaCheck.checked = choice.comma;
      }
    } catch { /* 옛 엔진 — 빈 식으로 연다 */ }
    setTimeout(() => this.formulaInput?.focus(), 100);
  }

  protected onConfirm(): boolean {
    const formula = this.formulaInput.value;
    this.clearError();

    if (!formula || formula === '=' || formula === '@') {
      this.showError(t('dialog.formula.showError.label'));
      return false;
    }

    try {
      // [hwpx-cowork] 칸의 실제 격자 자리(병합 칸이 있으면 cellIndex/열 수로 셈하면 틀린다).
      const info = this.wasm.getCellInfo(this.ctx.sec, this.ctx.ppi, this.ctx.ci, this.ctx.cellIndex);
      const row = info.row;
      const col = info.col;

      // 먼저 검증 (write_result=false)
      const validateResult = this.wasm.evaluateTableFormula(
        this.ctx.sec, this.ctx.ppi, this.ctx.ci,
        row, col, formula, false,
      );
      const validated = JSON.parse(validateResult);

      if (!validated.ok) {
        this.showError(validated.error || t('dialog.formula.onConfirm.label'));
        return false;
      }

      // [hwpx-cowork] 한/글처럼 결과를 계산식 필드(식·형식·마지막 결과)로 남긴다 — 셀을 고치면 다시 계산된다.
      // 종전에는 결과 글만 넣어 식이 사라졌다(evaluateTableFormula writeResult + 쉼표 글 교체).
      const resultFormat = formulaResultFormat(this.formatSelect.value, this.commaCheck.checked);
      const commit = () => {
        this.wasm.setTableCellFormula(
          this.ctx.sec, this.ctx.ppi, this.ctx.ci, this.ctx.cellIndex, formula, resultFormat,
        );
      };
      const ih = this.services?.getInputHandler();
      if (ih) {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'tableFormula',
          operation: () => { commit(); return ih.getCursorPosition(); },
        });
      } else {
        commit();
        this.eventBus.emit('document-changed');
      }
      return true; // 성공 → 대화상자 닫기
    } catch (e: any) {
      this.showError(t('dialog.formula.showError.label.xe4e00d') + (e.message || e));
      return false; // 실패 → 대화상자 유지
    }
  }

  private showError(msg: string): void {
    this.errorMsg.textContent = '⚠ ' + msg;
    this.errorMsg.style.display = 'block';
    this.formulaInput.classList.add('formula-input-error');
    this.formulaInput.focus();
  }

  private clearError(): void {
    this.errorMsg.style.display = 'none';
    this.errorMsg.textContent = '';
    this.formulaInput.classList.remove('formula-input-error');
  }
}
