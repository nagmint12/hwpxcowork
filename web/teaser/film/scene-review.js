const { seg, eo, ei, eio, lerp } = kit;
const REV_CAM = [{ t: 0, v: [740, 650, 1.5] }, { t: 0.9, from: 0.15, v: [900, 620, 1.5] }, { t: 3.8, from: 2.85, v: [580, 665, 2.2] }, { t: 5, v: [590, 662, 2.26] }];
kit.scene('review', {
  init(kit) {
    this.w = UI.win(kit, ['ui-completed.webp', 'ui-memo.webp', 'ui-applied2.webp'],
      '<div class="rev-mark" style="position:absolute;left:' + (713 * 1.2) + 'px;top:' + (676 * 1.2) + 'px;width:' + (66 * 1.2) + 'px;height:5px;border-radius:3px;background:var(--accent);transform-origin:0 50%"></div>');
    kit.stage.append(this.w.el);
    this.mark = this.w.el.querySelector('.rev-mark').style;
    this.cur = UI.cursor(kit);
    kit.stage.append(this.cur.ring, this.cur.el);
    this.capEl = kit.h('<p class="cap">함께 검토하고 바로 반영합니다</p>');
    kit.stage.append(this.capEl);
    this.cap = this.capEl.style;
  },
  render(t) {
    const c = UI.cam(this.w.el.style, UI.at(REV_CAM, t, eio));
    UI.states(this.w, t, [['ui-completed.webp', 0], ['ui-memo.webp', 0.75], ['ui-applied2.webp', 2.55]]);
    const a = UI.toStage(c, 1260, 600), btn = UI.toStage(c, 1062, 843);
    const m = eio(seg(t, 1.5, 2.2));
    const p = [lerp(a[0], btn[0], m) + 24 * Math.sin(Math.PI * m), lerp(a[1], btn[1], m)];
    const away = eo(seg(t, 2.6, 3.1));
    p[0] += 50 * away; p[1] += 40 * away;
    UI.drawCursor(this.cur, t, p, 2.35, eo(seg(t, 1.3, 1.55)) * (1 - away));
    this.mark.transform = 'scaleX(' + eo(seg(t, 3.75, 4.15)) + ')';
    const k = seg(t, 0.15, 0.6);
    this.cap.opacity = eo(k);
    this.cap.transform = 'translateY(' + lerp(24, 0, eo(k)) + 'px)';
  },
});
