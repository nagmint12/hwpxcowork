// 시험 받침: 글상자 문서(tests/helpers/floating-doc.mjs 가 만든 것)의 구역 첫 문단에 쪽 크기 그림을 덧붙인다 — PDF 를 옮긴 문서가 쪽마다 까는
// 쪽 배경(흰 바탕 + 위쪽 띠)과, 내용이 든 쪽 그림(스캔한 쪽 꼴 — 무늬가 많아 압축이 덜 되는 그림)을 지어낸 PNG 로 만든다(실제 문서·그림을 쓰지 않는다).
//   const doc = await floatingDoc({ pages: [...] });
//   addPageBackground(doc, { kind: 'plain' });                       // 모든 구역 첫 문단에 쪽 배경(글 앞, zOrder 0 — 글상자 밑)
//   addPageBackground(doc, { sections: [1], kind: 'content' });      // 1구역에만 내용 그림
// engine/flow.js(개체 → 본문 쪽 배경 처리) 시험(tests/objects_to_body_safety.test.mjs)이 쓴다.
import zlib from 'node:zlib';
import { pictureXml } from '../../engine/picture.js';
import { sectionPaper } from '../../engine/layout.js';

/** PNG 한 장(8비트 RGB): pixel(x, y) → [r, g, b] */
export function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1); raw[row] = 0;   // 거르기 없음
    for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** 쪽 배경 꼴: 흰 바탕에 위쪽 회색 띠(무늬 없는 바탕 — 아주 잘 준다) */
export const plainPng = (w = 420, h = 594) => makePng(w, h, (x, y) => (y < h * 0.06 ? [200, 200, 200] : [255, 255, 255]));
/** 내용 그림 꼴: 흰 바탕에 글줄처럼 촘촘한 검은 점(정해진 씨앗의 의사 난수 — 압축이 덜 된다. 스캔한 글 쪽의 대역) */
export function contentPng(w = 420, h = 594) {
  let s = 12345; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return makePng(w, h, (x, y) => ((y % 14) < 9 && x > 30 && x < w - 30 && rnd() < 0.35 ? [20, 20, 20] : [255, 255, 255]));
}

/**
 * 구역 첫 문단(sections — 기본 모든 구역)에 그림 하나씩을 덧붙인다(그 문단의 첫 도형 앞).
 * opts: kind 'plain'(쪽 배경) | 'content'(내용 그림), wrap(기본 IN_FRONT_OF_TEXT), zOrder(기본 0 — 글상자 밑), rel(기본 PAPER),
 *       w·h(기본 용지 크기 HWPUNIT), x·y(오프셋 기본 0), caption(글 — 있으면 캡션 꼴 subList 를 붙인다), png(그림 바이트를 직접)
 * → 넣은 그림 수
 */
export function addPageBackground(doc, { sections = null, kind = 'plain', wrap = 'IN_FRONT_OF_TEXT', zOrder = 0, rel = 'PAPER', w = null, h = null, x = 0, y = 0, caption = null, png = null } = {}) {
  const bytes = png || (kind === 'content' ? contentPng() : plainPng());
  const binId = doc._addBinary(bytes, { ext: 'png', mime: 'image/png' });
  let n = 0;
  for (const sec of doc.sections) {
    if (sections && !sections.includes(sec.index)) continue;
    const paper = sectionPaper(sec);
    const cw = w ?? paper.w; const ch = h ?? paper.h;
    const id = 900000 + sec.index;
    const attrs = new Map(Object.entries({ textWrap: wrap, textFlow: 'BOTH_SIDES', lock: '0', dropcapstyle: 'None', href: '', groupLevel: '0', reverse: '0' }));
    const pos = `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="${rel}" horzRelTo="${rel}" vertAlign="TOP" horzAlign="LEFT" vertOffset="${y}" horzOffset="${x}"/>`;
    const cap = caption ? `<hp:caption side="BOTTOM" fullSz="0" width="${cw}" gap="850" lastWidth="${cw}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${caption}</hp:t></hp:run></hp:p></hp:subList></hp:caption>` : '';
    const xml = pictureXml({ id, instid: id, zOrder, attrs, binId, org: { w: cw, h: ch }, cur: { w: cw, h: ch }, pos, outMargin: '<hp:outMargin left="0" right="0" top="0" bottom="0"/>', captionXml: cap });
    const p = sec.bodyParas[0];
    const at = sec.xml.indexOf('<hp:rect', p.start);
    const where = at >= 0 && at < p.end ? at : sec.xml.lastIndexOf('<hp:t/></hp:run>', p.end);
    sec.load(sec.xml.slice(0, where) + xml + sec.xml.slice(where));
    n++;
  }
  doc._rewriteSectionFiles?.();
  return n;
}
