// 차트 그리기: 차트 명세(자료만 — 종류·항목·계열 값) → 보고서 꼴 PNG. 그림 제안(propose_figure 의 chart)에 쓴다.
// 그리기는 서버 PC 의 Python·matplotlib(server/chart.py)이 한다 — 한글은 SVG 그림을 그리지 않아 PNG 가 필요하다.
// Python 경로: HWPX_COWORK_PYTHON(없으면 Windows 'python', 그 밖 'python3'). 없거나 matplotlib 이 없으면 CHART_UNAVAILABLE.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chart.py');
export const CHART_TYPES = ['bar', 'hbar', 'line', 'stacked_hbar'];

export class ChartError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const clean = (s, max) => [...String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('');
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

/**
 * 차트 명세 검사·정리 → { type, categories, series:[{name, values}], y_label, unit, y_min, y_max, value_labels, decimals }.
 * type: bar(세로 묶음 막대)·hbar(가로 묶음 막대)·line(꺾은선)·stacked_hbar(가로 100% 누적 — 응답분포). 값의 빈 자리는 null.
 */
export function normChart(c) {
  if (!c || typeof c !== 'object') throw new ChartError('BAD_CHART', '차트 명세(chart)가 필요합니다');
  const type = String(c.type || '');
  if (!CHART_TYPES.includes(type)) throw new ChartError('BAD_CHART', `차트 종류는 ${CHART_TYPES.join('·')} 중 하나입니다: ${type || '(없음)'}`);
  const categories = Array.isArray(c.categories) ? c.categories.map((x) => clean(x, 40)) : [];
  if (!categories.length || categories.length > 60) throw new ChartError('BAD_CHART', '항목(categories)은 1~60개입니다');
  const series = Array.isArray(c.series) ? c.series : [];
  if (!series.length || series.length > 12) throw new ChartError('BAD_CHART', '계열(series)은 1~12개입니다');
  const out = series.map((s, i) => {
    const values = Array.isArray(s?.values) ? s.values.map(num) : [];
    if (values.length !== categories.length) throw new ChartError('BAD_CHART', `계열 ${i + 1}의 값 수(${values.length})가 항목 수(${categories.length})와 다릅니다`);
    if (values.some((v) => Number.isNaN(v))) throw new ChartError('BAD_CHART', `계열 ${i + 1}에 숫자가 아닌 값이 있습니다(빈 자리는 null)`);
    return { name: clean(s.name, 30) || `계열 ${i + 1}`, values };
  });
  if (!out.some((s) => s.values.some((v) => v != null))) throw new ChartError('BAD_CHART', '그릴 값이 없습니다');
  const spec = { type, categories, series: out, y_label: clean(c.y_label ?? c.yLabel, 40) || null, unit: clean(c.unit, 8) || null };
  for (const k of ['y_min', 'y_max']) { const v = num(c[k] ?? c[k.replace('_m', 'M')]); if (Number.isNaN(v)) throw new ChartError('BAD_CHART', `${k} 는 숫자입니다`); spec[k] = v; }
  if (spec.y_min != null && spec.y_max != null && spec.y_min >= spec.y_max) throw new ChartError('BAD_CHART', 'y_min 은 y_max 보다 작아야 합니다');
  const vl = c.value_labels ?? c.valueLabels;
  spec.value_labels = ['all', 'last', 'none'].includes(vl) ? vl : null;
  const d = num(c.decimals);
  spec.decimals = d != null && Number.isInteger(d) && d >= 0 && d <= 4 ? d : null;
  return spec;
}

/** 차트 명세(normChart 결과) → PNG Buffer(폭 2000px) */
export function renderChart(spec, { python = process.env.HWPX_COWORK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(python, ['-B', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) {
      reject(new ChartError('CHART_UNAVAILABLE', `서버에서 차트를 그릴 수 없습니다(Python 실행 실패: ${e.message}) — 그림 파일(image_base64)로 보내세요`)); return;
    }
    const out = []; let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝남 */ } }, timeoutMs);
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => { err = (err + b.toString('utf8')).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(new ChartError('CHART_UNAVAILABLE', `서버에서 차트를 그릴 수 없습니다(Python 이 없음: ${e.code || e.message}) — 그림 파일(image_base64)로 보내세요`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const png = Buffer.concat(out);
      if (code === 0 && png.length > 8 && png[0] === 0x89 && png[1] === 0x50) { resolve(png); return; }
      const why = /No module named ['"]?matplotlib/.test(err) ? 'matplotlib 이 설치되어 있지 않습니다' : (err.trim().split('\n').pop() || `종료 코드 ${code}`);
      reject(new ChartError(/matplotlib/.test(why) ? 'CHART_UNAVAILABLE' : 'CHART_FAILED', `차트를 그리지 못했습니다: ${why}`));
    });
    child.stdin.on('error', () => { /* 일찍 끝난 프로세스 — close 가 알린다 */ });
    child.stdin.end(Buffer.from(JSON.stringify(spec), 'utf8'));
  });
}
