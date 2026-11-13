const { seg, eo, ei, eio, lerp } = kit;
const DEMO_CAM = [{ t: 0, v: [640, 445, 2.3] }, { t: 2.0, from: 0.6, v: [800, 450, 1] }, { t: 3.0, from: 2.2, v: [1010, 470, 1.38] }, { t: 7.7, v: [1000, 474, 1.42] }, { t: 8.9, from: 7.8, v: [640, 465, 2.05] }, { t: 10, v: [645, 462, 2.12] }];
const DEMO_CAPS = [[2.5, 3.55, '연구원의 Claude Code가 고쳐 쓰고'], [3.65, 4.65, '검토자의 ChatGPT가 메모를 남기고'], [4.75, 5.8, '조교의 Codex가 용어를 맞추면'], [5.9, 99, '한 장의 HWPX에, 함께 반영합니다']];
kit.scene('demo', {
  init(kit) {
    this.w = APP.win(kit, ['app-a0.webp', 'app-a1.webp', 'app-a2.webp', 'app-a3.webp', 'app-a4.webp', 'app-a5.webp']);
    kit.stage.append(this.w.el);
    this.cur = APP.cursor(kit);
    kit.stage.append(this.cur.ring, this.cur.el);
    this.caps = DEMO_CAPS.map(([a, b, txt]) => { const e = kit.h('<p class="hand capw">' + txt + '</p>'); kit.stage.append(e); return e.style; });
    const wo = kit.h('<div class="whiteout"></div>');
    kit.stage.append(wo);
    this.wo = wo.style;
  },
  render(t) {
    let v = DEMO_CAM[DEMO_CAM.length - 1].v;
    for (let i = 1; i < DEMO_CAM.length; i++) {
      const a = DEMO_CAM[i - 1], b = DEMO_CAM[i];
      if (t <= b.t) {
        const from = b.from != null ? b.from : a.t;
        if (t < from) { v = a.v; break; }
        const p = eio((t - from) / (b.t - from));
        const fa = APP.fit(a.v[0], a.v[1], a.v[2]), fb = APP.fit(b.v[0], b.v[1], b.v[2]);
        v = [lerp(fa[0], fb[0], p), lerp(fa[1], fb[1], p), Math.exp(lerp(Math.log(fa[2]), Math.log(fb[2]), p))];
        break;
      }
    }
    if (t <= 0) v = DEMO_CAM[0].v;
    const c = APP.cam(this.w.el.style, v);
    APP.states(this.w, t, [['app-a0.webp', 0], ['app-a1.webp', 2.5], ['app-a2.webp', 3.6], ['app-a3.webp', 4.7], ['app-a4.webp', 6.35], ['app-a5.webp', 7.35]]);
    this.wo.opacity = 1 - eo(seg(t, 0.05, 0.75));
    this.caps.forEach((s, i) => {
      const [a, b] = DEMO_CAPS[i];
      const p = eo(seg(t, a, a + 0.35)) * (1 - ei(seg(t, b - 0.2, b)));
      s.opacity = p;
      s.transform = 'translateY(' + lerp(18, 0, eo(seg(t, a, a + 0.35))) + 'px) rotate(-1deg)';
    });
    const s0 = APP.toStage(c, 1200, 560), b1 = APP.toStage(c, 1062, 613), b2 = APP.toStage(c, 1062, 716);
    const m1 = eio(seg(t, 5.55, 6.05)), m2 = eio(seg(t, 6.6, 7.05));
    let p = [lerp(s0[0], b1[0], m1), lerp(s0[1], b1[1], m1) - 26 * Math.sin(Math.PI * m1)];
    p = [lerp(p[0], b2[0], m2), lerp(p[1], b2[1], m2) + 14 * Math.sin(Math.PI * m2)];
    const away = eo(seg(t, 7.45, 7.9));
    p[0] += 60 * away; p[1] += 40 * away;
    APP.drawCursor(this.cur, t, p, [6.25, 7.25], eo(seg(t, 5.35, 5.6)) * (1 - away));
  },
});
