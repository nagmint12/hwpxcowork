// PC는 대상 주변의 빈 공간, 소개·완료는 화면 중앙에 배치한다.
// 좁은 화면은 편집기 아래쪽을 기본으로 쓰되 입력창을 피한다.
export function tutorialDock(viewport, editor, large = false, { height = null, avoid = null, target = avoid, center = false } = {}) {
  const { x = 0, y = 0, w, h } = viewport;
  const desktop = w > 900;
  const width = Math.min(large ? 640 : 440, Math.max(160, w - 24));
  const top = Math.max(y, !desktop && !center && editor?.h ? editor.y : y);
  const bottom = Math.min(y + h, !desktop && !center && editor?.h ? editor.y + editor.h : y + h);
  const available = bottom - top;
  // 예시 그림·입력 칸이 있는 안내(large)는 화면 높이의 70%까지 쓴다 — 380px에서 금빛 예시 위치가 접혀 안 보였다
  const max = Math.min(large ? Math.max(380, Math.floor(h * .7)) : 260, Math.max(140, Math.floor(h * (large ? .7 : .4))), Math.max(80, available - 24));
  const tall = Math.min(max, height > 0 ? height : max);
  const middle = { x: x + (w - width) / 2, y: y + (h - tall) / 2, w: width, h: tall };
  if (center || (desktop && !target && !avoid)) return { ...middle, max };
  if (desktop) {
    const anchor = target || avoid;
    const blocked = avoid || anchor;
    const gap = 16;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const spot = (sx, sy) => ({ x: clamp(sx, x + 12, x + w - width - 12), y: clamp(sy, y + 12, y + h - tall - 12), w: width, h: tall });
    const cx = anchor.x + anchor.w / 2; const cy = anchor.y + anchor.h / 2;
    const spots = [
      spot(cx - width / 2, blocked.y + blocked.h + gap),
      spot(cx - width / 2, blocked.y - tall - gap),
      spot(blocked.x + blocked.w + gap, cy - tall / 2),
      spot(blocked.x - width - gap, cy - tall / 2),
      middle,
    ];
    const overlap = s => Math.max(0, Math.min(s.x + s.w, blocked.x + blocked.w) - Math.max(s.x, blocked.x)) * Math.max(0, Math.min(s.y + s.h, blocked.y + blocked.h) - Math.max(s.y, blocked.y));
    const distance = s => Math.hypot(Math.max(s.x - cx, 0, cx - s.x - s.w), Math.max(s.y - cy, 0, cy - s.y - s.h));
    spots.sort((a, b) => overlap(a) - overlap(b) || distance(a) - distance(b));
    return { ...spots[0], max };
  }
  const left = Math.max(x + 12, Math.min(x + w - width - 12, (editor?.x || x) + 12));
  const spots = [bottom - tall - 12, top + 12, y + h - tall - 12, y + 12].map(spotY => ({ x: left, y: spotY, w: width, h: tall }));
  const covers = s => !!avoid && s.x < avoid.x + avoid.w && avoid.x < s.x + s.w && s.y < avoid.y + avoid.h && avoid.y < s.y + s.h;
  return { ...(spots.find(s => !covers(s)) || spots[0]), max };
}

export function clippedRect(rect, viewport) {
  if (!rect) return null;
  const x = Math.max(rect.x, viewport.x); const y = Math.max(rect.y, viewport.y);
  const right = Math.min(rect.x + rect.w, viewport.x + viewport.w); const bottom = Math.min(rect.y + rect.h, viewport.y + viewport.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}
