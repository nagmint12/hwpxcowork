// 옆 칸 폭 조절 경계선(2026-11-18 사용자 요청): 문서함 나무 | 문서 목록, 드라이브 폴더 | 파일 목록.
// 경계선을 끌거나(마우스·터치·펜) 화살표 키(Shift = 크게)로 폭을 바꾸고, 두 번 누르기·Home 은 기본 폭으로 돌린다.
// 폭은 이 브라우저에 기억한다(localStorage — 못 쓰는 환경이면 이번 화면에서만). 폭 null = 기본(CSS 가 정함 — 드라이브는 좁은 칸에서 기본 폭이 달라진다).
// 좁은 화면에서 옆 칸이 위로 올라가거나 숨으면 경계선도 CSS 가 숨긴다(library.css · drive.css).
import { ref, nextTick, onMounted } from '/vendor/vue.esm-browser.prod.js';

/** 정할 폭 → 실제로 쓸 폭: [min, max] 안, 오른쪽 목록이 mainMin 보다 좁아지지 않게(room = 지금 옆 칸 + 목록 폭 − mainMin) */
export function clampSideWidth(w, { min, max, room = Infinity }) {
  const hi = Math.max(min, Math.min(max, room));
  return Math.round(Math.min(hi, Math.max(min, Number(w) || 0)));
}

/** 기억해 둔 폭 → 숫자(px) 또는 null(기본 폭). 숫자가 아니거나 범위 밖이면 null */
export function parseSideWidth(raw, { min, max }) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

/** 폭 상태 + 저장(경계선의 commit 에서 부른다) */
export function useSideWidth(key, limits) {
  const read = () => { try { return parseSideWidth(localStorage.getItem(key), limits); } catch { return null; } };
  const width = ref(read());
  function save() {
    try { if (width.value == null) localStorage.removeItem(key); else localStorage.setItem(key, String(width.value)); } catch { /* 저장 못 함 — 이번 화면에서만 */ }
  }
  return { width, save };
}

/**
 * 경계선. target='prev': 바로 앞 형제가 옆 칸, 바로 뒤 형제가 목록(문서함 — 격자 칸 사이).
 * target='parent': 부모가 옆 칸, 부모의 다음 형제가 목록(드라이브 — 옆 칸 오른쪽 테두리 위에 겹쳐 둔다).
 * v-model = 폭(px | null), commit = 끌기·키·되돌리기가 끝남(저장할 때).
 */
export const SideSplitter = {
  props: {
    modelValue: { type: Number, default: null },
    min: { type: Number, default: 160 },
    max: { type: Number, default: 520 },
    mainMin: { type: Number, default: 320 },
    target: { type: String, default: 'prev' },
    label: { type: String, default: '옆 칸 폭 조절' },
  },
  emits: ['update:modelValue', 'commit'],
  template: `<div ref="el" class="side-splitter" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="label"
    :aria-valuenow="now" :aria-valuemin="min" :aria-valuemax="max" title="끌어서 폭 조절 · 두 번 누르면 기본 폭"
    @pointerdown="start" @dblclick="reset" @keydown="key"></div>`,
  setup(props, { emit }) {
    const el = ref(null);
    const now = ref(props.modelValue ?? undefined);
    function parts() {
      const s = el.value;
      const side = props.target === 'parent' ? s?.parentElement : s?.previousElementSibling;
      const main = props.target === 'parent' ? side?.nextElementSibling : s?.nextElementSibling;
      return { side, main };
    }
    function measure() {
      const { side, main } = parts();
      const sw = side ? side.getBoundingClientRect().width : 0;
      const mw = main ? main.getBoundingClientRect().width : 0;
      return { sw, opts: { min: props.min, max: props.max, room: main ? sw + mw - props.mainMin : Infinity } };
    }
    const sync = () => { const { sw } = measure(); if (sw) now.value = Math.round(sw); };
    onMounted(sync);
    function set(w) { now.value = w; emit('update:modelValue', w); }
    function start(e) {
      if (e.button !== 0) return;
      const s = e.currentTarget; const { sw, opts } = measure();
      if (!sw) return;
      e.preventDefault();
      try { s.setPointerCapture(e.pointerId); } catch { /* 잡지 못해도 끌기는 된다 */ }
      const x0 = e.clientX; let x = x0; let moved = false; let raf = 0;
      const apply = () => { raf = 0; set(clampSideWidth(sw + x - x0, opts)); };
      const move = (ev) => {
        x = ev.clientX;
        if (!moved && Math.abs(x - x0) < 3) return;
        if (!moved) { moved = true; s.classList.add('dragging'); document.documentElement.classList.add('side-resizing'); }
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const up = () => {
        s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); s.removeEventListener('pointercancel', up);
        if (raf) { cancelAnimationFrame(raf); apply(); }
        s.classList.remove('dragging'); document.documentElement.classList.remove('side-resizing');
        if (moved) emit('commit');
      };
      s.addEventListener('pointermove', move); s.addEventListener('pointerup', up); s.addEventListener('pointercancel', up);
    }
    function reset() { emit('update:modelValue', null); emit('commit'); nextTick(sync); }
    function key(e) {
      if (e.key === 'Home') { e.preventDefault(); reset(); return; }
      const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const { sw, opts } = measure();
      if (!sw) return;
      set(clampSideWidth(sw + dir * (e.shiftKey ? 64 : 16), opts));
      emit('commit');
    }
    return { el, now, start, reset, key };
  },
};
