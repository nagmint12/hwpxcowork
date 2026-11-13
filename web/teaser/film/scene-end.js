const { seg, eo, ei, eio, eob, lerp } = kit;
const END_CAM = [{ t: 0, v: [590, 662, 2.26] }, { t: 0.95, from: 0.05, v: [800, 450, 1] }];
kit.scene('end', {
  init(kit) {
    this.w = UI.win(kit, ['ui-applied2.webp', 'ui-export0.webp']);
    const root = kit.h('<div class="ground"><div class="bar"></div>' +
      '<div class="words end-words" style="left:910px;top:372px;width:960px;gap:58px"><h1 class="line end-name" style="font-size:140px;line-height:1;letter-spacing:-0.035em">hwpx-cowork</h1>' +
      '<p class="sub end-sub" style="font-size:36px">한글 문서를 위한 공동 검토 · AI 제안 · 변경 추적</p></div>' +
      '<div class="uline end-u" style="left:914px;top:532px;width:250px;right:auto;bottom:auto;height:10px;border-radius:5px"></div>' +
      '<div class="end-frame" style="position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden;transform-origin:0 0;box-shadow:0 4px 10px rgba(0,0,0,.12), 0 40px 90px rgba(0,26,112,.22)"></div>' +
      '<div class="end-chip" style="position:absolute;left:0;top:0;display:flex;align-items:center;gap:14px;padding:16px 26px;border-radius:10px;background:#fff;border:1px solid #dde1e6;box-shadow:0 12px 32px rgba(16,24,40,.18);font-size:30px;font-weight:600;color:#1f2933;white-space:nowrap">' +
      '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#1f5fbf" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span>결과보고서.hwpx</span></div></div>');
    root.querySelector('.end-frame').append(this.w.el);
    kit.stage.append(root);
    this.cur = UI.cursor(kit);
    kit.stage.append(this.cur.ring, this.cur.el);
    const q = (s) => root.querySelector(s);
    this.frame = q('.end-frame').style;
    this.name = q('.end-name').style;
    this.sub = q('.end-sub').style;
    this.u = q('.end-u').style;
    this.chip = q('.end-chip').style;
  },
  render(t) {
    const c = UI.cam(this.w.el.style, UI.at(END_CAM, t, eio));
    UI.states(this.w, t, [['ui-applied2.webp', 0], ['ui-export0.webp', 1.45]]);
    const a = UI.toStage(c, 1080, 230), btn = UI.toStage(c, 1200, 23);
    const m = eio(seg(t, 0.9, 1.35));
    const p = [lerp(a[0], btn[0], m), lerp(a[1], btn[1], m) + 20 * Math.sin(Math.PI * m)];
    const fade = ei(seg(t, 1.9, 2.2));
    UI.drawCursor(this.cur, t, p, 1.45, eo(seg(t, 0.75, 0.95)) * (1 - fade));
    const s1 = UI.toStage(c, 1200, 58);
    const ch = seg(t, 1.6, 1.85);
    this.chip.opacity = eo(ch) * (1 - ei(seg(t, 2.1, 2.35)));
    this.chip.transform = 'translate(' + (s1[0] - 170) + 'px,' + (s1[1] + 14 + lerp(-12, 0, eo(ch))) + 'px)';
    const p2 = eio(seg(t, 2.15, 3.0));
    const s = lerp(1, 0.36, p2);
    this.frame.transform = 'translate(' + lerp(0, 150, p2) + 'px,' + lerp(0, 346, p2) + 'px) scale(' + s + ')';
    this.frame.borderRadius = lerp(0, 14, p2) / s + 'px';
    const n = seg(t, 2.75, 3.3);
    this.name.opacity = eo(n);
    this.name.transform = 'translateX(' + (lerp(40, 0, eo(n)) - 2 * Math.max(0, t - 3.3)) + 'px)';
    this.u.transform = 'scaleX(' + eo(seg(t, 3.3, 3.7)) + ')';
    const sb = seg(t, 3.55, 4.0);
    this.sub.opacity = eo(sb);
    this.sub.transform = 'translateX(' + lerp(26, 0, eo(sb)) + 'px)';
  },
});
