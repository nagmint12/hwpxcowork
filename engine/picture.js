// 그림(hp:pic) 읽기와 새 그림 XML 만들기.
// 읽기: 구역의 그림마다 주인 문단·캡션 문단·그림 파일 id(binaryItemIDRef)를 모은다.
// 만들기: 한글이 저장한 그림과 같은 요소 차례(offset … imgDim, hc:img, effects, sz, pos, outMargin, caption) — 문단 조립은 doc.js insertPictureAfter.
import { escapeAttr } from './xmlscan.js';

/** 그림 픽셀 → HWPUNIT(96dpi: 1px = 75) — 표준서식 생성기(skill/hwpx-standard-report)와 같은 환산 */
export const PX = 75;
/** 1mm = 7200/25.4 HWPUNIT */
export const MM = 7200 / 25.4;

/**
 * 그림 파일 종류·픽셀 크기(파일 머리만 읽는다). PNG·JPEG·GIF·BMP 만 — 한글이 넣을 수 있는 흔한 꼴.
 * @returns {{ ext: string, mime: string, width: number, height: number } | null} mime 은 한글 매니페스트 꼴(jpg 는 image/jpg)
 */
export function imageInfo(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const be16 = (i) => (u[i] << 8) | u[i + 1];
  const be32 = (i) => ((u[i] << 24) >>> 0) + (u[i + 1] << 16) + (u[i + 2] << 8) + u[i + 3];
  const le16 = (i) => u[i] | (u[i + 1] << 8);
  const le32 = (i) => (u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24));
  const ok = (r) => (r.width > 0 && r.height > 0 && r.width <= 30000 && r.height <= 30000 ? r : null);
  if (u.length > 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return ok({ ext: 'png', mime: 'image/png', width: be32(16), height: be32(20) });
  if (u.length > 4 && u[0] === 0xff && u[1] === 0xd8) {
    // 표지(marker)를 따라가 SOFn(크기)을 찾는다 — DHT(C4)·JPG(C8)·DAC(CC)는 SOF 가 아니다
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] !== 0xff) { i++; continue; }
      const mk = u[i + 1];
      if (mk === 0xff) { i++; continue; }
      if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd8)) { i += 2; continue; }
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return ok({ ext: 'jpg', mime: 'image/jpg', width: be16(i + 7), height: be16(i + 5) });
      i += 2 + be16(i + 2);
    }
    return null;
  }
  if (u.length > 10 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return ok({ ext: 'gif', mime: 'image/gif', width: le16(6), height: le16(8) });
  if (u.length > 26 && u[0] === 0x42 && u[1] === 0x4d) return ok({ ext: 'bmp', mime: 'image/bmp', width: le32(18), height: Math.abs(le32(22)) });
  return null;
}

/**
 * 구역의 그림 목록(문서 순서). 주인 = 그림을 품은 가장 안쪽 문단, body = 주인이 본문 문단인가, cap = 캡션 문단(그림 안 첫 문단) | null
 * @returns {{ start, end, owner, body: boolean, cap, binId: string|null, open: string, head: string }[]} head = 캡션 앞까지의 그림 XML
 */
export function scanPictures(sec) {
  const out = [];
  const bodySet = new Set(sec.bodyParas);
  for (const m of sec.xml.matchAll(/<hp:pic\b[^>]*>/g)) {
    const start = m.index; const close = sec.xml.indexOf('</hp:pic>', start);
    if (close < 0) continue;
    const end = close + '</hp:pic>'.length;
    let owner = null; let cap = null;
    for (const p of sec.paras) {
      if (p.start < start && end <= p.end && (!owner || p.start > owner.start)) owner = p;
      if (!cap && p.start > start && p.end < end) cap = p;
    }
    const xml = sec.xml.slice(start, end);
    const capAt = xml.indexOf('<hp:caption');
    out.push({
      start, end, owner, body: !!owner && bodySet.has(owner), cap, open: m[0],
      binId: (/\bbinaryItemIDRef="([^"]*)"/.exec(xml) || [])[1] ?? null, head: capAt < 0 ? xml : xml.slice(0, capAt),
    });
  }
  return out;
}

/**
 * 새 그림 XML(hp:pic 하나).
 * @param {object} o { id, instid, zOrder, attrs(Map — 여는 태그 속성), binId, org {w,h}(원본 HWPUNIT), cur {w,h}(보이는 크기), pos, outMargin, captionXml, numbering('PICTURE'|'NONE') }
 */
export function pictureXml({ id, instid, zOrder, attrs, binId, org, cur, pos, outMargin, captionXml = '', numbering = 'NONE' }) {
  const a = new Map(attrs);
  a.set('id', String(id)); a.set('zOrder', String(zOrder)); a.set('numberingType', numbering); a.set('instid', String(instid));
  const attrStr = [...a].map(([k, v]) => `${k}="${escapeAttr(String(v))}"`).join(' ');
  const s = (n) => String(Number(n.toFixed(5)));
  return `<hp:pic ${attrStr}><hp:offset x="0" y="0"/><hp:orgSz width="${org.w}" height="${org.h}"/><hp:curSz width="${cur.w}" height="${cur.h}"/>`
    + '<hp:flip horizontal="0" vertical="0"/>'
    + `<hp:rotationInfo angle="0" centerX="${Math.floor(cur.w / 2)}" centerY="${Math.floor(cur.h / 2)}" rotateimage="1"/>`
    + '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
    + `<hc:scaMatrix e1="${s(cur.w / org.w)}" e2="0" e3="0" e4="0" e5="${s(cur.h / org.h)}" e6="0"/>`
    + '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
    + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${org.w}" y="0"/><hc:pt2 x="${org.w}" y="${org.h}"/><hc:pt3 x="0" y="${org.h}"/></hp:imgRect>`
    + `<hp:imgClip left="0" right="${org.w}" top="0" bottom="${org.h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:imgDim dimwidth="${org.w}" dimheight="${org.h}"/><hc:img binaryItemIDRef="${escapeAttr(binId)}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>`
    + `<hp:sz width="${cur.w}" widthRelTo="ABSOLUTE" height="${cur.h}" heightRelTo="ABSOLUTE" protect="0"/>${pos}${outMargin}${captionXml}</hp:pic>`;
}
