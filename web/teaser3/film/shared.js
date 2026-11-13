// 한 장의 보고서(세계 좌표 1920×1080 안의 종이)와 손글씨 도우미 — 장면 page·hands·meet·end 가 함께 쓴다
window.HW = {
  P1: '본 사업은 교육과정 개선을 통해 <span class="hw-sat">학생 만족도</span> 향상에 <span class="hw-del">일정 부분 기여한 것으로 보인다</span>.',
  P1F: '본 사업은 교육과정 개선을 통해 학생 만족도 향상에 기여하였다([표 1]).',
  P2: '참여 교원의 수업 자료가 <span class="hw-room">학과 공동 자료실</span>에 정리되어 다음 학기에도 활용할 수 있게 되었다.',
  P2F: '참여 교원의 수업 자료가 학과 교육자료실에 정리되어 다음 학기에도 활용할 수 있게 되었다.',
  NOTES: [
    { tgt: 'del', text: '‘보인다’ 말고, 적절한 표현으로', sign: '— 연구원 · Claude Code와', col: 'var(--main)', rot: -2 },
    { tgt: 'sat', text: '근거로 [표 1]을 함께', sign: '— 검토자 · ChatGPT와', col: 'var(--sky)', rot: 1.6 },
    { tgt: 'room', text: '학과 공식 명칭으로', sign: '— 조교 · Codex와', col: 'var(--gold)', rot: -1.2 },
  ],
  // final: 고쳐진 문장을 같은 자리에 겹쳐 둔다(처음엔 안 보임)
  build(kit) {
    const world = kit.h('<div class="hw-world"><div class="hw-page"><div class="hw-hls"></div>' +
      '<div class="hw-body"><p class="hw-h">2) 주요 성과</p>' +
      '<div style="position:relative"><p class="hw-p1">' + HW.P1 + '</p><p class="hw-p1f" style="position:absolute;left:0;top:0;opacity:0">' + HW.P1F + '</p></div>' +
      '<div style="position:relative"><p class="hw-p2">' + HW.P2 + '</p><p class="hw-p2f" style="position:absolute;left:0;top:0;opacity:0">' + HW.P2F + '</p></div>' +
      '</div></div></div>');
    kit.stage.append(world);
    const page = world.querySelector('.hw-page');
    const q = (s) => world.querySelector(s);
    return { world, ws: world.style, page, hls: q('.hw-hls'), p1: q('.hw-p1').style, p1f: q('.hw-p1f').style, p2: q('.hw-p2').style, p2f: q('.hw-p2f').style, span: (k) => q('.hw-' + k) };
  },
  // 글 조각의 줄별 상자(종이 좌표)
  rects(w, el) {
    const pr = w.page.getBoundingClientRect();
    const k = pr.width / w.page.offsetWidth || 1;
    return [...el.getClientRects()].map((r) => ({ x: (r.left - pr.left) / k, y: (r.top - pr.top) / k, w: r.width / k, h: r.height / k }));
  },
  cam(ws, v) { ws.transform = 'translate(' + (960 - v[0] * v[2]) + 'px,' + (540 - v[1] * v[2]) + 'px) scale(' + v[2] + ')'; },
  at(keys, t, eio) {
    if (t <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i], from = b.from != null ? b.from : a.t;
      if (t <= b.t) {
        if (t < from) return a.v;
        const p = eio((t - from) / (b.t - from));
        return [a.v[0] + (b.v[0] - a.v[0]) * p, a.v[1] + (b.v[1] - a.v[1]) * p, Math.exp(Math.log(a.v[2]) + (Math.log(b.v[2]) - Math.log(a.v[2])) * p)];
      }
    }
    return keys[keys.length - 1].v;
  },
  // 손글씨처럼 왼쪽부터 드러나기(천천히 시작해 받침에서 머물듯)
  write(s, t, t0, dur, out) {
    const p = Math.min(1, Math.max(0, (t - t0) / dur));
    const q = p < 1 ? p * p * (3 - 2 * p) * 0.35 + p * 0.65 : 1;
    s.clipPath = 'inset(-30px ' + ((1 - q) * 100).toFixed(2) + '% -30px -30px)';
    s.opacity = out == null ? 1 : 1 - Math.min(1, Math.max(0, (t - out) / 0.45));
  },
  // 형광펜 칠(줄별 상자 뒤에 깔림)
  marker(kit, w, el) {
    return HW.rects(w, el).map((r) => {
      const e = kit.h('<div class="hw-hl" style="left:' + (r.x - 4) + 'px;top:' + (r.y + r.h * 0.18) + 'px;width:' + (r.w + 8) + 'px;height:' + (r.h * 0.7) + 'px"></div>');
      w.hls.append(e); return e.style;
    });
  },
  sweep(list, t, t0, dur) {
    const n = list.length;
    list.forEach((s, i) => { s.transform = 'scaleX(' + kit.eo(kit.seg(t, t0 + (i * dur) / n, t0 + ((i + 1) * dur) / n)) + ')'; });
  },
};

// 실제 앱 화면(1600×900 화면을 2배로 찍은 그림)을 1920×1080 무대에 깔고 카메라·커서를 1600 좌표로 다룬다
window.APP = {
  win(kit, names) {
    const el = kit.h('<div class="ui-win">' + names.map((n) => '<img class="ui-img" alt="" src="' + kit.assets.url(n) + '">').join('') + '</div>');
    const imgs = {};
    [...el.querySelectorAll('.ui-img')].forEach((im, i) => { imgs[names[i]] = im.style; });
    return { el, imgs };
  },
  states(w, t, seq) { seq.forEach(([n, at], i) => { w.imgs[n].opacity = i === 0 ? 1 : Math.min(1, Math.max(0, (t - at) / 0.18)); }); },
  fit(cx, cy, z) { const hw = 800 / z, hh = 450 / z; return [Math.min(1600 - hw, Math.max(hw, cx)), Math.min(900 - hh, Math.max(hh, cy)), z]; },
  cam(style, v) { const [cx, cy, z] = APP.fit(v[0], v[1], v[2]); style.transform = 'translate(' + (960 - cx * 1.2 * z) + 'px,' + (540 - cy * 1.2 * z) + 'px) scale(' + z + ')'; return [cx, cy, z]; },
  toStage(c, x, y) { return [960 + (x - c[0]) * 1.2 * c[2], 540 + (y - c[1]) * 1.2 * c[2]]; },
  cursor(kit) {
    const el = kit.h('<div class="cur"><svg viewBox="0 0 24 24"><path d="M4 2.5 L4 19.5 L8.6 15.4 L11.7 22 L14.6 20.7 L11.6 14.3 L17.8 14.3 Z" fill="var(--second)" stroke="var(--ground)" stroke-width="1.6" stroke-linejoin="round"/></svg></div>');
    const ring = kit.h('<div class="ring"></div>');
    return { el, ring, s: el.style, r: ring.style };
  },
  drawCursor(cur, t, p, clicks, op) {
    const c = clicks.filter((x) => t >= x).pop();
    const dip = c != null && t < c + 0.16 ? 0.86 : 1;
    cur.s.opacity = op;
    cur.s.transform = 'translate(' + (p[0] - 6) + 'px,' + (p[1] - 4) + 'px) scale(' + dip + ')';
    const k = c == null ? -1 : (t - c) / 0.45;
    cur.r.opacity = k >= 0 && k <= 1 ? (1 - k) * op : 0;
    cur.r.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px) scale(' + (0.4 + 0.9 * Math.max(0, k)) + ')';
  },
};
