// hwpx-cowork 소개 영상(여백의 손글씨 · teaser3) 재생기 — 영상 파일 없이 코드로 그린다.
// 화면의 모든 것은 시각 t(초)의 순수 함수: 장면 모듈(film/scene-*.js)의 render(t) 가 t 만 보고 그린다.
// 그래서 되감기·타임라인 이동·반복이 정확히 같은 그림을 낸다. 소리는 없다(무음).
//
// 주소 옵션: ?autoplay=0(멈춘 채 시작) · ?loop=0(끝에서 멈춤) · ?controls=0(컨트롤 숨김) · ?t=7.5(그 시각부터)
// mount(root, opts) 의 opts 가 주소 옵션을 덮는다. opts.onEnd(끝까지 재생됐을 때) · opts.clickToggle=false(화면 누름으로 멈추지 않음)
// · opts.frame=true(넓은 화면에서 위아래·좌우 여백을 두고 둥근 틀로 띄움 — 좁은 화면은 비율대로 가득) — 첫 접속 소개(index.html ?intro=1)가 쓴다

const BASE = new URL('./', import.meta.url);
const q = new URLSearchParams(location.search);
const OPT = {
  autoplay: q.get('autoplay') !== '0',
  loop: q.get('loop') !== '0',
  controls: q.get('controls') !== '0',
  start: Math.max(0, Number(q.get('t')) || 0),
};

// ── 시간·움직임 도우미(장면 모듈이 kit 에서 꺼내 쓴다) ──
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const eo = (x) => 1 - (1 - clamp01(x)) ** 3;
const ei = (x) => clamp01(x) ** 3;
const eio = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
const eob = (x, s = 1.4) => { x = clamp01(x) - 1; return 1 + (s + 1) * x * x * x + s * x * x; };

// 낱말 단위 등장·퇴장(한 줄 글을 낱말 span 으로 한 번만 나눈다)
function words(el) {
  if (!el._w) {
    const parts = el.textContent.split(/(\s+)/);
    el.textContent = '';
    el._w = [];
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) { el.append(p); continue; }
      const s = document.createElement('span');
      s.textContent = p;
      s.style.display = 'inline-block';
      el.append(s);
      el._w.push(s.style);
    }
  }
  return el._w;
}
const TextFx = {
  fadeFromRight(el, t, t0, { stagger = 0.11, dur = 0.5, dx = 26 } = {}) {
    const w = words(el);
    w.forEach((s, i) => {
      const p = eo(seg(t, t0 + i * stagger, t0 + i * stagger + dur));
      s.opacity = p;
      s.transform = `translateX(${(1 - p) * dx}px)`;
    });
    return t0 + (w.length - 1) * stagger + dur;
  },
  fadeOutLeft(el, t, t0, { stagger = 0.06, dur = 0.3, dx = 26 } = {}) {
    const w = words(el);
    w.forEach((s, i) => {
      const p = ei(seg(t, t0 + i * stagger, t0 + i * stagger + dur));
      s.opacity = 1 - p;
      s.transform = `translateX(${-p * dx}px)`;
    });
    return t0 + (w.length - 1) * stagger + dur;
  },
};

function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ── 재생기 ──
export async function mount(root, opts = {}) {
  const O = { clickToggle: true, ...OPT, ...opts };
  const film = await (await fetch(new URL('film/scenes.json', BASE))).json();
  const W = film.width, H = film.height;
  const T = {}; let acc = 0;
  for (const s of film.scenes) { T[s.id] = acc; acc += s.dur; }
  const DUR = acc;

  // 그림을 미리 풀어 둔다(첫 장면부터 빈칸 없이)
  const urls = Object.fromEntries(film.assets.map((n) => [n, new URL(`assets/${n}`, BASE).href]));
  await Promise.all(Object.values(urls).map((u) => { const im = new Image(); im.src = u; return im.decode().catch(() => {}); }));

  // 글꼴 파일을 먼저 올린다(장면이 init 에서 글자 자리를 재므로 글꼴이 준비된 뒤에 시작)
  await Promise.all((film.fonts || []).map(async (f) => {
    try {
      const face = new FontFace(f.family, `url(${new URL(`assets/${f.file}`, BASE).href})`);
      document.fonts.add(await face.load());
    } catch (e) { console.warn('글꼴을 불러오지 못했습니다:', f.file, e); }
  }));

  const css = await (await fetch(new URL('film/base.css', BASE))).text();
  root.innerHTML = '';
  root.classList.add('tz');
  const viewport = h('<div class="tz-viewport"></div>');
  const stage = h(`<div id="stage" class="tz-stage" style="width:${W}px;height:${H}px;background:${film.background}"></div>`);
  const style = document.createElement('style');
  style.textContent = css;
  stage.append(style);
  viewport.append(stage);
  root.append(viewport);

  // 장면 등록용 kit(전역 오염 없이 모듈마다 함수로 실행)
  const defs = {};
  const helpers = { seg, lerp, clamp01, eo, ei, eio, eob, TextFx, h };
  const filmKit = { ...helpers, W, H, scene(id, def) { defs[id] = def; } };
  for (const m of film.modules) {
    const code = await (await fetch(new URL(`film/${m}`, BASE))).text();
    // shared.js 는 window.UI 를 만든다. 장면 모듈은 kit.scene(...) 을 부른다.
    new Function('kit', `${code}\n//# sourceURL=${BASE.pathname}film/${m}`)(filmKit);
  }

  const scenes = [];
  for (const s of film.scenes) {
    const box = h('<div class="tz-scene" style="position:absolute;inset:0;overflow:hidden"></div>');
    stage.append(box);
    const kit = {
      ...helpers, stage: box, W, H, dur: s.dur, start: T[s.id],
      assets: { url: (n) => urls[n] },
    };
    const def = defs[s.id];
    if (!def) throw new Error(`장면 모듈이 없습니다: ${s.id}`);
    const inst = Object.create(def);
    if (inst.init) await inst.init(kit);
    scenes.push({ ...s, start: T[s.id], box, inst, kit });
  }

  // ── 그리기 ──
  let cur = null;
  function draw(t) {
    t = Math.min(Math.max(t, 0), DUR);
    let sc = scenes[scenes.length - 1];
    for (const s of scenes) if (t < s.start + s.dur) { sc = s; break; }
    if (sc !== cur) { for (const s of scenes) s.box.style.display = s === sc ? '' : 'none'; cur = sc; }
    sc.inst.render(t - sc.start, sc.kit);
  }

  // 무대 크기를 바깥 상자에 맞춘다(16:9 유지). 틀 모드의 넓은 화면(PC)은 가로 8%·세로 10%(최소 32px) 여백을 두고
  // 원래 크기(1920)보다 키우지 않는다. 좁은 화면(모바일, 폭 900px 미만)은 비율대로 가득 채운다.
  const fit = () => {
    const r = viewport.getBoundingClientRect();
    const framed = !!O.frame && r.width >= 900 && r.height >= 500;
    const px = framed ? Math.max(32, r.width * 0.08) : 0;
    const py = framed ? Math.max(32, r.height * 0.1) : 0;
    const k = Math.min((r.width - 2 * px) / W, (r.height - 2 * py) / H, framed ? 1 : Infinity);
    const x = (r.width - W * k) / 2, y = (r.height - H * k) / 2;
    stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    root.classList.toggle('tz-framed', framed);
    // 재생 막대·건너뛰기 단추가 무대 틀 안쪽에 붙도록 틀 위치를 넘긴다
    const ds = document.documentElement.style;
    ds.setProperty('--tz-x', `${x}px`);
    ds.setProperty('--tz-y', `${y}px`);
  };
  new ResizeObserver(fit).observe(viewport);
  fit();

  // ── 컨트롤 ──
  const bar = h(`<div class="tz-bar" ${O.controls ? '' : 'hidden'}>
    <button type="button" class="tz-play" aria-label="재생"></button>
    <input class="tz-seek" type="range" min="0" max="${DUR}" step="0.01" value="0" aria-label="재생 위치">
    <span class="tz-time">0:00 / 0:${String(Math.round(DUR)).padStart(2, '0')}</span>
  </div>`);
  root.append(bar);
  const btn = bar.querySelector('.tz-play');
  const seek = bar.querySelector('.tz-seek');
  const time = bar.querySelector('.tz-time');
  const ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let t = Math.min(O.start, DUR);
  // '동작 줄이기'면 멈춘 채 시작 — 첫 접속 소개(opts.autoplay=true)는 끝나야 다음 화면으로 가므로 그대로 재생한다
  let playing = O.autoplay && (!reduce || opts.autoplay === true);
  let last = 0;
  let dragging = false;

  function ui() {
    btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    btn.setAttribute('aria-label', playing ? '일시정지' : '재생');
    root.classList.toggle('tz-paused', !playing);
    if (!dragging) seek.value = t;
    time.textContent = `${fmt(t)} / ${fmt(DUR)}`;
  }
  function play() { if (t >= DUR) t = 0; playing = true; last = 0; ui(); }
  function pause() { playing = false; ui(); }
  btn.addEventListener('click', () => (playing ? pause() : play()));
  if (O.clickToggle) viewport.addEventListener('click', () => (playing ? pause() : play()));
  seek.addEventListener('input', () => { dragging = true; t = Number(seek.value); draw(t); ui(); });
  seek.addEventListener('change', () => { dragging = false; });
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowLeft') { t = Math.max(0, t - 2); draw(t); ui(); }
    else if (e.key === 'ArrowRight') { t = Math.min(DUR, t + 2); draw(t); ui(); }
  });
  // 탭이 가려지면 멈췄다가 돌아오면 그 자리에서 이어 간다(시간이 튀지 않게)
  document.addEventListener('visibilitychange', () => { last = 0; });

  function frame(now) {
    if (playing && !dragging) {
      if (last) t += Math.min(0.1, (now - last) / 1000);
      last = now;
      if (t >= DUR) {
        if (O.loop) t = 0; else { t = DUR; playing = false; O.onEnd?.(); }
      }
      draw(t);
      ui();
    } else last = 0;
    requestAnimationFrame(frame);
  }
  draw(t); ui();
  requestAnimationFrame(frame);

  // 밖에서 다룰 수 있게(예: 다른 화면에서 멈춤)
  return { play, pause, seek: (s) => { t = Math.min(Math.max(0, s), DUR); draw(t); ui(); }, get time() { return t; }, duration: DUR };
}
