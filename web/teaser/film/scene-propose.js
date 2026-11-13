const { seg, eo, ei, eio, lerp, TextFx } = kit;
const PROP_TXT = '추정 표현을 단정형으로 고쳐 주세요';
const PROP_X = (() => { const w = [...PROP_TXT].map((c) => (c === ' ' ? 4.2 : 12.3)); const tot = w.reduce((a, b) => a + b, 0); let s = 0; return [0, ...w.map((v) => (s += v * 197 / tot))]; })();
const PROP_T0 = 1.35, PROP_T1 = 2.35;
const PROP_CAM = [{ t: 0, v: [800, 450, 1] }, { t: 1.3, from: 0.45, v: [1420, 250, 2.1] }, { t: 4.3, from: 3.4, v: [760, 640, 1.45] }, { t: 6, v: [740, 650, 1.5] }];
kit.scene('propose', {
  init(kit) {
    this.w = UI.win(kit, ['ui-body.webp', 'ui-typed.webp', 'ui-sent.webp', 'ui-completed.webp'],
      '<div class="ui-mask prop-mask" style="top:' + (198 * 1.2) + 'px;height:' + (26 * 1.2) + 'px"></div>' +
      '<div class="prop-caret" style="position:absolute;top:' + (200 * 1.2) + 'px;width:2px;height:' + (21 * 1.2) + 'px;background:#1f2933"></div>');
    kit.stage.append(this.w.el);
    this.mask = this.w.el.querySelector('.prop-mask').style;
    this.caret = this.w.el.querySelector('.prop-caret').style;
    this.cur = UI.cursor(kit);
    kit.stage.append(this.cur.ring, this.cur.el);
    this.capEl = kit.h('<p class="cap">AI가 고칠 곳을 제안합니다</p>');
    kit.stage.append(this.capEl);
    this.cap = this.capEl.style;
  },
  render(t) {
    const c = UI.cam(this.w.el.style, UI.at(PROP_CAM, t, eio));
    UI.states(this.w, t, [['ui-body.webp', 0], ['ui-typed.webp', 1.25], ['ui-sent.webp', 2.85], ['ui-completed.webp', 3.55]]);
    const n = Math.max(0, Math.min(PROP_TXT.length, Math.floor((t - PROP_T0) / (PROP_T1 - PROP_T0) * PROP_TXT.length) + (t >= PROP_T0 ? 1 : 0)));
    const x = 1274 + PROP_X[n];
    const typing = t >= 1.25 && t < 2.85;
    this.mask.opacity = typing ? 1 : 0;
    this.mask.left = x * 1.2 + 'px';
    this.mask.width = Math.max(0, 1480 - x) * 1.2 + 'px';
    this.caret.left = (x + 1) * 1.2 + 'px';
    this.caret.opacity = typing && (t < PROP_T1 + 0.05 || Math.floor(t / 0.53) % 2 === 0) ? 1 : 0;
    const a = UI.toStage(c, 1450, 300), btn = UI.toStage(c, 1542, 358);
    const m = eio(seg(t, 2.2, 2.6));
    const p = [lerp(a[0], btn[0], m), lerp(a[1], btn[1], m) - 30 * Math.sin(Math.PI * m)];
    const away = eo(seg(t, 2.85, 3.3));
    p[0] += 40 * away; p[1] += 50 * away;
    UI.drawCursor(this.cur, t, p, 2.68, eo(seg(t, 2.0, 2.25)) * (1 - away));
    const k = seg(t, 3.9, 4.35);
    this.cap.opacity = eo(k);
    this.cap.transform = 'translateY(' + lerp(24, 0, eo(k)) + 'px)';
  },
});
