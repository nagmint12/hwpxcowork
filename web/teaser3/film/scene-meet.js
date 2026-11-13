const { seg, eo, ei, eio, lerp } = kit;
const MEET_CAM = [{ t: 0, v: [1000, 552, 0.97] }, { t: 1.3, from: 0.15, v: [770, 445, 1.36] }, { t: 5, v: [775, 440, 1.4] }];
function meetWave(r, seed) {
  const y = r.y + r.h * 0.56, n = Math.max(3, Math.round(r.w / 46));
  let d = 'M' + (r.x - 4) + ' ' + y;
  for (let k = 1; k <= n; k++) { const x = r.x - 4 + (r.w + 8) * k / n; d += ' Q ' + (x - (r.w + 8) / n / 2) + ' ' + (y + ((k + seed) % 2 ? -7 : 7)) + ' ' + x + ' ' + y; }
  return d;
}
kit.scene('meet', {
  init(kit) {
    kit.stage.append(kit.h('<div class="ground"></div>'));
    this.w = HW.build(kit);
    const pg = this.w.page;
    const tg = HW.NOTES.map((n) => HW.rects(this.w, this.w.span(n.tgt)));
    const want = tg.map((r) => (r[r.length - 1].y - 14));
    const order = want.map((y, i) => i).sort((a, b) => want[a] - want[b]);
    const top = want.slice(); let last = -1e9;
    order.forEach((i) => { top[i] = Math.max(want[i], last + 150); last = top[i]; });
    this.hl = HW.NOTES.map((n) => HW.marker(kit, this.w, this.w.span(n.tgt)));
    this.notes = HW.NOTES.map((n, i) => {
      const e = kit.h('<div class="note" style="left:930px;top:' + top[i] + 'px;transform:rotate(' + n.rot + 'deg)"><p class="hand" style="color:' + n.col + '">' + n.text + '</p><p class="hand sign" style="color:' + n.col + '">' + n.sign + '</p></div>');
      pg.append(e); return e.style;
    });
    const del = tg[0], sat = tg[1], room = tg[2];
    let paths = '';
    del.forEach((r, k) => { paths += '<path class="ink meet-sd" pathLength="1" stroke-dasharray="1 1" style="stroke:var(--main)" d="' + meetWave(r, k) + '"/>'; });
    room.forEach((r, k) => { paths += '<path class="ink meet-sr" pathLength="1" stroke-dasharray="1 1" style="stroke:var(--gold)" d="' + meetWave(r, k + 1) + '"/>'; });
    const d0 = del[0];
    paths += '<path class="ink meet-caret" pathLength="1" stroke-dasharray="1 1" style="stroke:var(--main)" d="M' + (d0.x - 16) + ' ' + (d0.y + 6) + ' L' + (d0.x - 4) + ' ' + (d0.y + 26) + ' L' + (d0.x + 8) + ' ' + (d0.y + 6) + '"/>';
    const svg = kit.h('<svg style="position:absolute;left:0;top:0;width:1320px;height:1560px;overflow:visible">' + paths + '</svg>');
    pg.append(svg);
    const dl = del[del.length - 1], r0 = room[0];
    const ins = kit.h('<p class="hand" style="position:absolute;left:' + (d0.x + 4) + 'px;top:' + (d0.y - 44) + 'px;font-size:44px;transform:rotate(-2deg)">기여하였다</p>');
    const ref = kit.h('<p class="hand" style="position:absolute;left:' + (dl.x + dl.w + 10) + 'px;top:' + (dl.y - 38) + 'px;font-size:38px;color:var(--sky);transform:rotate(2deg)">([표 1])</p>');
    const rn = kit.h('<p class="hand" style="position:absolute;left:' + (r0.x + 6) + 'px;top:' + (r0.y - 42) + 'px;font-size:40px;color:var(--gold);transform:rotate(-1.5deg)">이러닝시스템</p>');
    const n3 = kit.h('<p class="hand narr" style="left:120px;top:58px">각자의 AI가, 각자의 기억을 안고</p>');
    const n4 = kit.h('<p class="hand narr" style="left:120px;top:58px">이제, 실제 화면에서</p>');
    pg.append(ins, ref, rn, n3, n4);
    this.ins = ins.style; this.ref = ref.style; this.rn = rn.style; this.n3 = n3.style; this.n4 = n4.style;
    this.sd = [...svg.querySelectorAll('.meet-sd')].map((e) => e.style);
    this.sr = [...svg.querySelectorAll('.meet-sr')].map((e) => e.style);
    this.caret = svg.querySelector('.meet-caret').style;
    this.svg = svg.style;
    const wo = kit.h('<div class="whiteout" style="opacity:0"></div>');
    kit.stage.append(wo);
    this.wo = wo.style;
  },
  render(t) {
    HW.cam(this.w.ws, HW.at(MEET_CAM, t, eio));
    HW.write(this.n3, t, -5, 1, 0.15);
    HW.write(this.n4, t, 2.3, 1.1);
    this.wo.opacity = eio(seg(t, 3.35, 4.0));
    const settle = 0;
    this.hl.forEach((l) => l.forEach((s) => { s.transform = 'scaleX(1)'; s.opacity = 1 - settle; }));
    this.notes.forEach((s, i) => { s.opacity = 1; });
    const nd = this.sd.length;
    this.sd.forEach((s, k) => { s.strokeDashoffset = 1 - eo(seg(t, 0.9 + k * 0.6 / nd, 0.9 + (k + 1) * 0.6 / nd)); });
    const nr = this.sr.length;
    this.sr.forEach((s, k) => { s.strokeDashoffset = 1 - eo(seg(t, 2.3 + k * 0.45 / nr, 2.3 + (k + 1) * 0.45 / nr)); });
    this.caret.strokeDashoffset = 1 - eo(seg(t, 1.45, 1.7));
    this.svg.opacity = 1 - settle;
    HW.write(this.ins, t, 1.6, 0.8);
    HW.write(this.ref, t, 2.05, 0.55);
    HW.write(this.rn, t, 2.75, 0.75);
    this.w.p1.opacity = 1 - settle; this.w.p1f.opacity = settle;
    this.w.p2.opacity = 1 - settle; this.w.p2f.opacity = settle;
  },
});
