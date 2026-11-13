const { seg, eo, eio, lerp } = kit;
const PAGE_CAM = [{ t: 0, v: [800, 450, 1.24] }, { t: 4.5, v: [805, 440, 1.33] }];
kit.scene('page', {
  init(kit) {
    kit.stage.append(kit.h('<div class="ground"></div>'));
    this.w = HW.build(kit);
    const n1 = kit.h('<p class="hand narr" style="left:120px;top:58px">보고서 한 장이 있습니다</p>');
    const n2 = kit.h('<p class="hand narr" style="left:120px;top:58px">좋은 문장은, 여러 손을 거쳐 옵니다</p>');
    this.w.page.append(n1, n2);
    this.n1 = n1.style; this.n2 = n2.style;
    this.body = this.w.page.querySelector('.hw-body').style;
  },
  render(t) {
    HW.cam(this.w.ws, HW.at(PAGE_CAM, t, eio));
    this.body.opacity = eo(seg(t, -0.9, -0.2));
    HW.write(this.n1, t, -1.2, 1.6, 2.2);
    HW.write(this.n2, t, 2.6, 1.5);
  },
});
