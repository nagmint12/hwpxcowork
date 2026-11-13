// 가벼운 XML 토큰 스캐너 — HWPX(OWPML) XML 을 "원문 보존" 방식으로 다루기 위한 도구.
// DOM 으로 다시 직렬화하지 않고, 바이트(문자) 위치를 기억해 필요한 곳만 문자열로 잘라 붙인다.
// 지원: 시작/끝/빈 태그, 텍스트, 주석, CDATA, 처리 명령, 속성(따옴표 안의 > 포함).

const NAME_START = /[A-Za-z_:]/;

/** @typedef {{type:'open'|'close'|'selfclose'|'text'|'other', name?:string, start:number, end:number, attrStart?:number, attrEnd?:number}} Token */

/** XML 문자열을 토큰 배열로 만든다. 각 토큰은 원문의 [start, end) 범위를 가리킨다. */
export function scan(xml) {
  const tokens = [];
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { if (i < n) tokens.push({ type: 'text', start: i, end: n }); break; }
    if (lt > i) tokens.push({ type: 'text', start: i, end: lt });
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4); const end = e < 0 ? n : e + 3;
      tokens.push({ type: 'other', start: lt, end }); i = end; continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9); const end = e < 0 ? n : e + 3;
      tokens.push({ type: 'text', start: lt, end, cdata: true }); i = end; continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt); const end = e < 0 ? n : e + 1;
      tokens.push({ type: 'other', start: lt, end }); i = end; continue;
    }
    // 일반 태그: 따옴표 안의 '>' 를 건너뛰며 끝을 찾는다.
    let j = lt + 1; let quote = null;
    while (j < n) {
      const c = xml[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const end = Math.min(n, j + 1);
    const isClose = xml[lt + 1] === '/';
    let k = isClose ? lt + 2 : lt + 1;
    const nameStart = k;
    while (k < end && /[A-Za-z0-9_:.\-]/.test(xml[k])) k++;
    const name = xml.slice(nameStart, k);
    const selfclose = !isClose && xml[end - 2] === '/';
    tokens.push({
      type: isClose ? 'close' : (selfclose ? 'selfclose' : 'open'),
      name, start: lt, end,
      attrStart: k, attrEnd: selfclose ? end - 2 : end - 1,
    });
    i = end;
  }
  return tokens;
}

/** 태그 토큰의 속성을 객체로 읽는다 (순서 유지: Map). */
export function attrs(xml, tok) {
  const map = new Map();
  if (tok.attrStart == null) return map;
  const s = xml.slice(tok.attrStart, tok.attrEnd);
  const re = /([A-Za-z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) map.set(m[1], decodeEntities(m[2] != null ? m[2] : m[3]));
  return map;
}

export function attr(xml, tok, name) {
  if (tok.attrStart == null) return undefined;
  const s = xml.slice(tok.attrStart, tok.attrEnd);
  const re = new RegExp('(?:^|\\s)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
  const m = re.exec(s);
  return m ? decodeEntities(m[1] != null ? m[1] : m[2]) : undefined;
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] != null ? ENT[e] : all;
  });
}

// XML 1.0 에 쓸 수 없는 글자(Char 규칙 밖): C0 제어 문자(탭·줄바꿈·CR 은 됨)·U+FFFE·U+FFFF·짝 없는 대리 문자
// (u 플래그 — 짝이 맞는 대리 쌍은 한 글자라 걸리지 않는다). 한글 등 엄격한 읽기 프로그램은 이런 글자가 든 XML 을 열지 못한다.
const XML_FORBIDDEN = /[\u0000-\u0008\u000E-\u001F\u{FFFE}\u{FFFF}]|[\uD800-\uDFFF]/gu;
// U+000B(세로 탭 — 워드에서 붙여 넣은 줄바꿈)·U+000C(쪽 나눔)는 줄바꿈으로 바꾸고 나머지 금지 글자는 지운다(server/memotext.js xmlSafe 와 같은 규칙).
// 메모·문단 글·작성자 이름 등 XML 로 나가는 글은 모두 아래 두 함수를 거치므로 여기서 한 번에 막는다.
const xmlChars = (s) => String(s).replace(/[\u000B\u000C]/g, '\n').replace(XML_FORBIDDEN, '');

/** 텍스트 노드용 이스케이프(XML 1.0 금지 글자는 뺀다 — 위 xmlChars). */
export function escapeText(s) {
  return xmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 속성값용 이스케이프(XML 1.0 금지 글자는 뺀다 — 위 xmlChars). */
export function escapeAttr(s) {
  return xmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 텍스트 노드 원문(엔티티 포함)을 글자 단위로 풀어 각 글자의 원문 위치를 돌려준다.
 * 반환: { text, raw: [[rawStart, rawEnd], ...] } — raw[i] 는 text 의 i번째 코드포인트의 원문 범위.
 */
export function decodeWithMap(xml, start, end) {
  const chars = []; const raw = [];
  let i = start;
  while (i < end) {
    const c = xml[i];
    if (c === '&') {
      const semi = xml.indexOf(';', i);
      if (semi > 0 && semi < end && semi - i <= 10) {
        const ent = xml.slice(i + 1, semi);
        let out = null;
        if (ent[0] === '#') { const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10); if (!Number.isNaN(cp)) out = String.fromCodePoint(cp); }
        else if (ENT[ent] != null) out = ENT[ent];
        if (out != null) { chars.push(out); raw.push([i, semi + 1]); i = semi + 1; continue; }
      }
    }
    const cp = xml.codePointAt(i); const len = cp > 0xffff ? 2 : 1;
    chars.push(String.fromCodePoint(cp)); raw.push([i, i + len]); i += len;
  }
  return { text: chars.join(''), chars, raw };
}
