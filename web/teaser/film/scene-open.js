const { seg, eo, ei, eio, lerp, TextFx } = kit;
kit.scene('open', {
  init(kit) {
    this.w = UI.win(kit, ['ui-body.webp']);
    const root = kit.h('<div class="ground"><div class="bar"></div>' +
      '<div class="words open-words" style="left:150px;top:330px;width:700px"><h1 class="line open-line">한글 문서를 함께 고쳐 쓰다</h1>' +
      '<p class="sub open-sub">hwpx-cowork · HWPX 공동 검토·편집 도구</p></div>' +
      '<div class="open-frame" style="position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden;transform-origin:0 0;box-shadow:0 4px 10px rgba(0,0,0,.12), 0 40px 90px rgba(0,26,112,.22)"></div></div>');
    root.querySelector('.open-frame').append(this.w.el);
    kit.stage.append(root);
    this.frame = root.querySelector('.open-frame').style;
    this.words = root.querySelector('.open-words').style;
    this.line = root.querySelector('.open-line');
    this.sub = root.querySelector('.open-sub').style;
    UI.cam(this.w.el.style, [800, 450, 1]);
  },
  render(t) {
    TextFx.fadeFromRight(this.line, t, -0.9);
    this.sub.opacity = eo(seg(t, 0.3, 0.8));
    this.sub.transform = 'translateX(' + lerp(26, 0, eo(seg(t, 0.3, 0.8))) + 'px)';
    const out = ei(seg(t, 1.7, 2.2));
    this.words.opacity = 1 - out;
    this.words.transform = 'translateX(' + lerp(0, -60, out) + 'px)';
    const inn = eo(seg(t, -0.6, 0.4));
    const p = eio(seg(t, 1.9, 2.8));
    const s = lerp(0.52, 1, p) * (1 + 0.012 * eio(seg(t, 0.4, 1.9)) * (1 - p));
    const x = lerp(880, 0, p), y = lerp(250, 0, p) + lerp(70, 0, inn);
    this.frame.opacity = inn;
    this.frame.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
    this.frame.borderRadius = lerp(14, 0, p) / s + 'px';
    UI.states(this.w, t, [['ui-body.webp', 0]]);
  },
});
