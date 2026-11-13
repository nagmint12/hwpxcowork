const { seg, eo, eio, eob, lerp } = kit;
kit.scene('end', {
  init(kit) {
    kit.stage.append(kit.h('<div class="ground"></div>'));
    this.w = APP.win(kit, ['app-a5.webp']);
    const frame = kit.h('<div style="position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden;transform-origin:0 0;box-shadow:0 4px 10px rgba(0,0,0,.12), 0 40px 90px rgba(0,26,112,.22)"></div>');
    frame.append(this.w.el);
    kit.stage.append(frame);
    this.frame = frame.style;
    const card = kit.h('<div style="position:absolute;inset:0">' +
      '<div class="words" style="left:910px;top:350px;width:960px;gap:0"><h1 class="name end-name">hwpx-cowork</h1>' +
      '<p class="hand end-hand" style="font-size:58px;margin-top:56px">각자의 AI와, 한 장의 문서에서</p>' +
      '<p class="tagline end-tag" style="margin-top:24px">HWPX 공동 검토 · 나의 AI를 MCP로 연결</p></div>' +
      '<svg viewBox="0 0 1920 1080" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><path class="ink end-sw" pathLength="1" stroke-dasharray="1 1" style="stroke:var(--accent);stroke-width:10" d="M914 504 C 1040 490 1200 494 1370 486"/></svg></div>');
    kit.stage.append(card);
    const q = (s) => card.querySelector(s).style;
    this.name = q('.end-name'); this.hand = q('.end-hand'); this.tag = q('.end-tag'); this.sw = q('.end-sw');
  },
  render(t) {
    const z = APP.cam(this.w.el.style, [lerp(645, 800, eio(seg(t, 0, 0.9))), lerp(462, 450, eio(seg(t, 0, 0.9))), Math.exp(lerp(Math.log(2.12), 0, eio(seg(t, 0, 0.9))))]);
    const p = eio(seg(t, 1.0, 1.8));
    const s = lerp(1, 0.36, p);
    this.frame.transform = 'translate(' + lerp(0, 150, p) + 'px,' + lerp(0, 346, p) + 'px) scale(' + s + ') rotate(' + lerp(0, -2, eob(seg(t, 1.2, 2.0), 1.6)) + 'deg)';
    this.frame.borderRadius = lerp(0, 14, p) / s + 'px';
    const n = seg(t, 1.55, 2.1);
    this.name.opacity = eo(n);
    this.name.transform = 'translateX(' + (lerp(40, 0, eo(n)) - 2 * Math.max(0, t - 2.1)) + 'px)';
    this.sw.strokeDashoffset = 1 - eo(seg(t, 2.1, 2.55));
    HW.write(this.hand, t, 2.35, 1.3);
    const g = seg(t, 3.4, 3.85);
    this.tag.opacity = eo(g);
    this.tag.transform = 'translateX(' + lerp(24, 0, eo(g)) + 'px)';
  },
});
