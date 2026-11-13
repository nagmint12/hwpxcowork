const { seg, eo, eio, lerp } = kit;
const HANDS_CAM = [{ t: 0, v: [805, 440, 1.33] }, { t: 1.3, from: 0.1, v: [1000, 560, 0.95] }, { t: 6, v: [1000, 552, 0.97] }];
const HANDS_N = [0.9, 2.1, 3.3];
kit.scene('hands', {
  init(kit) {
    kit.stage.append(kit.h('<div class="ground"></div>'));
    this.w = HW.build(kit);
    const pg = this.w.page;
    const n2 = kit.h('<p class="hand narr" style="left:120px;top:58px">좋은 문장은, 여러 손을 거쳐 옵니다</p>');
    const n3 = kit.h('<p class="hand narr" style="left:120px;top:58px">각자의 AI가, 각자의 기억을 안고</p>');
    pg.append(n2, n3);
    this.n2 = n2.style; this.n3 = n3.style;
    const tg = HW.NOTES.map((n) => HW.rects(this.w, this.w.span(n.tgt)));
    const want = tg.map((r) => (r[r.length - 1].y - 14));
    const order = want.map((y, i) => i).sort((a, b) => want[a] - want[b]);
    const top = want.slice();
    let last = -1e9;
    order.forEach((i) => { top[i] = Math.max(want[i], last + 150); last = top[i]; });
    const svg = kit.h('<svg style="position:absolute;left:0;top:0;width:1320px;height:1560px;overflow:visible"></svg>');
    pg.append(svg);
    this.hl = []; this.lead = []; this.txt = []; this.sign = []; this.note = [];
    HW.NOTES.forEach((n, i) => {
      this.hl.push(HW.marker(kit, this.w, this.w.span(n.tgt)));
      const r = tg[i][tg[i].length - 1];
      const x0 = 918, y0 = top[i] + 30, x1 = r.x + r.w + 8, y1 = r.y + r.h / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'ink');
      path.setAttribute('d', 'M' + x0 + ' ' + y0 + ' C ' + (x0 - 40) + ' ' + y0 + ' ' + (x1 + 40) + ' ' + y1 + ' ' + x1 + ' ' + y1);
      path.setAttribute('pathLength', '1');
      path.setAttribute('stroke-dasharray', '1 1');
      path.style.stroke = n.col; path.style.strokeWidth = '3';
      svg.append(path);
      this.lead.push(path.style);
      const e = kit.h('<div class="note" style="left:930px;top:' + top[i] + 'px;transform:rotate(' + n.rot + 'deg)"><p class="hand" style="color:' + n.col + '">' + n.text + '</p><p class="hand sign" style="color:' + n.col + '">' + n.sign + '</p></div>');
      pg.append(e);
      this.note.push(e.style);
      this.txt.push(e.children[0].style); this.sign.push(e.children[1].style);
    });
  },
  render(t) {
    HW.cam(this.w.ws, HW.at(HANDS_CAM, t, eio));
    HW.write(this.n2, t, -5, 1, 0.2);
    HW.write(this.n3, t, 4.3, 1.4);
    HANDS_N.forEach((N, i) => {
      HW.sweep(this.hl[i], t, N - 0.25, 0.5);
      this.lead[i].strokeDashoffset = 1 - eo(seg(t, N, N + 0.4));
      HW.write(this.txt[i], t, N + 0.25, 1.0);
      HW.write(this.sign[i], t, N + 1.0, 0.7);
      const n = HW.NOTES[i];
      this.note[i].transform = 'rotate(' + (n.rot + 0.4 * Math.sin(2 * Math.PI * (t / 3.4 + i * 0.3))) + 'deg)';
    });
  },
});
