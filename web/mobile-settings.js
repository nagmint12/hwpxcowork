export const MOBILE_HOLD_KEY = 'hwpx.mobile-hold-ms';
export const DEFAULT_MOBILE_HOLD_MS = 400;
const sessionValues = new WeakMap();

export function isMobileDevice(view) {
  return !!view.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/.test(view.navigator?.userAgent || '')
    || (view.navigator?.platform === 'MacIntel' && view.navigator.maxTouchPoints > 1);
}

export function normalizeMobileHoldMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== '' ? Math.min(2000, Math.max(100, Math.round(n / 100) * 100)) : DEFAULT_MOBILE_HOLD_MS;
}

export function readMobileHoldMs(view = window) {
  try { return normalizeMobileHoldMs(view.localStorage.getItem(MOBILE_HOLD_KEY) ?? sessionValues.get(view)); }
  catch { return sessionValues.get(view) ?? DEFAULT_MOBILE_HOLD_MS; }
}

export function writeMobileHoldMs(value, view = window) {
  const ms = normalizeMobileHoldMs(value);
  sessionValues.set(view, ms);
  try { view.localStorage.setItem(MOBILE_HOLD_KEY, String(ms)); } catch { /* 세션 내 입력 값은 계속 쓴다 */ }
  return ms;
}

export function createMobileSettingsPanel(doc) {
  if (!isMobileDevice(doc.defaultView)) return null;
  const panel = doc.createElement('div');
  panel.innerHTML = '<div class="dialog-section"><div class="dialog-section-title">모바일 터치 민감도</div><p>키보드 입력과 글 선택을 시작할 때 길게 누르는 시간을 설정합니다. 짧을수록 빠르게 반응합니다.</p><label for="mobile-hold-seconds">길게 누르기 시간 (초)</label><div style="display:flex;align-items:center;gap:12px;margin-top:10px"><input id="mobile-hold-seconds" data-mobile-hold type="number" min="0.1" max="2" step="0.1" inputmode="decimal" style="width:80px"><input data-mobile-hold-range aria-label="길게 누르기 시간 조절" type="range" min="0.1" max="2" step="0.1" style="flex:1;min-width:0"></div><p>0.1~2.0초 · 기본 0.4초 · 이 기기에 저장</p></div>';
  const number = panel.querySelector('[data-mobile-hold]');
  const range = panel.querySelector('[data-mobile-hold-range]');
  number.value = range.value = (readMobileHoldMs(doc.defaultView) / 1000).toFixed(1);
  range.addEventListener('input', () => { number.value = range.value; });
  number.addEventListener('input', () => { range.value = number.value; });
  return panel;
}

export function saveMobileSettingsPanel(panel) {
  const input = panel?.querySelector('[data-mobile-hold]');
  if (input) writeMobileHoldMs(input.value === '' ? DEFAULT_MOBILE_HOLD_MS : Number(input.value) * 1000, panel.ownerDocument.defaultView);
}
