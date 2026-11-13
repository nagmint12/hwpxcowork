// 실제 화면(1600×900 화면을 2배로 찍은 그림)을 1920×1080 무대에 깔고, 카메라·커서를 1600 좌표로 다룬다
window.UI = {
  S: 1.2,
  // 그림 여러 장을 겹친 창. names: ['ui-body.webp', …] → { el, imgs: {name: style} }
  win(kit, names, extra) {
    const el = kit.h('<div class="ui-win">' + names.map((n) => '<img class="ui-img" alt="" src="' + kit.assets.url(n) + '">').join('') + (extra || '') + '</div>');
    const imgs = {};
    [...el.querySelectorAll('.ui-img')].forEach((im, i) => { imgs[names[i]] = im.style; });
    return { el, imgs };
  },
  // 두 그림 사이 상태 바뀜: 순서대로 [이름, 바뀜 시각] — 앞 그림 위로 다음 그림이 0.16초에 걸쳐 뜬다
  states(w, t, seq) {
    seq.forEach(([n, at], i) => { w.imgs[n].opacity = i === 0 ? 1 : Math.min(1, Math.max(0, (t - at) / 0.16)); });
  },
  // 카메라: (cx, cy) = 1600 좌표의 점을 무대 가운데로, z 배율. 화면 밖이 보이지 않게 맞춘다
  fit(cx, cy, z) {
    const hw = 800 / z, hh = 450 / z;
    return [Math.min(1600 - hw, Math.max(hw, cx)), Math.min(900 - hh, Math.max(hh, cy)), z];
  },
  cam(style, v) {
    const [cx, cy, z] = UI.fit(v[0], v[1], v[2]);
    style.transform = 'translate(' + (960 - cx * 1.2 * z) + 'px,' + (540 - cy * 1.2 * z) + 'px) scale(' + z + ')';
    return [cx, cy, z];
  },
  // 카메라 키 [{t, v:[cx,cy,z]}] 사이를 eio 로 (z 는 로그 공간)
  at(keys, t, eio) {
    if (t <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      const from = b.from != null ? b.from : a.t;
      if (t <= b.t) {
        if (t < from) return a.v;
        const p = eio((t - from) / (b.t - from));
        const fa = UI.fit(a.v[0], a.v[1], a.v[2]), fb = UI.fit(b.v[0], b.v[1], b.v[2]);
        return [fa[0] + (fb[0] - fa[0]) * p, fa[1] + (fb[1] - fa[1]) * p, Math.exp(Math.log(fa[2]) + (Math.log(fb[2]) - Math.log(fa[2])) * p)];
      }
    }
    return keys[keys.length - 1].v;
  },
  // 1600 좌표 → 무대 좌표(카메라 반영)
  toStage(c, x, y) { return [960 + (x - c[0]) * 1.2 * c[2], 540 + (y - c[1]) * 1.2 * c[2]]; },
  // 커서(화살표)와 누름 고리
  cursor(kit) {
    const el = kit.h('<div class="cur"><svg viewBox="0 0 24 24"><path d="M4 2.5 L4 19.5 L8.6 15.4 L11.7 22 L14.6 20.7 L11.6 14.3 L17.8 14.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>');
    const ring = kit.h('<div class="ring"></div>');
    return { el, ring, s: el.style, r: ring.style };
  },
  // 커서 그리기: p = [무대 x, y], click = 누른 시각(없으면 null)
  drawCursor(cur, t, p, click, op) {
    const dip = click != null && t >= click && t < click + 0.16 ? 0.86 : 1;
    cur.s.opacity = op;
    cur.s.transform = 'translate(' + (p[0] - 6) + 'px,' + (p[1] - 4) + 'px) scale(' + dip + ')';
    const k = click == null ? -1 : (t - click) / 0.45;
    cur.r.opacity = k >= 0 && k <= 1 ? (1 - k) * op : 0;
    cur.r.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px) scale(' + (0.4 + 0.9 * Math.max(0, k)) + ')';
  },
};
