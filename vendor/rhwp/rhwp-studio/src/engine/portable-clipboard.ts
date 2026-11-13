// [hwpx-cowork] A document fragment travels with the clipboard itself, so
// different tabs/documents do not depend on another editor's in-memory ids.
const MAX_BYTES = 32 * 1024 * 1024;
export function clipboardBase64(bytes: Uint8Array): string {
  if (bytes.length > MAX_BYTES) throw new Error('복사 데이터가 너무 큽니다');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}
export function clipboardBytes(base64: string): Uint8Array {
  if (base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('복사 원본이 올바르지 않습니다');
  }
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
export function portableClipboardHtml(html: string, token: string, bytes: Uint8Array): string {
  const metadata = `<!--rhwp-studio-clipboard:${token}--><!--rhwp-fragment-v1:${clipboardBase64(bytes)}-->`;
  const clean = html.replace(/<!--\s*rhwp-studio-clipboard:[A-Za-z0-9._:-]+\s*-->/g, '')
    .replace(/<!--rhwp-fragment-v1:[A-Za-z0-9+/=]+-->/g, '');
  if (clean.includes('<!--StartFragment-->')) return clean.replace('<!--StartFragment-->', `<!--StartFragment-->${metadata}`);
  if (/<body\b[^>]*>/i.test(clean)) return clean.replace(/<body\b[^>]*>/i, body => body + metadata);
  return metadata + clean;
}
// [hwpx-cowork] 한글은 HTML 안의 hwpjson 보드(<div id='hwpEditorBoardContent'>)로 표·그림·조판 부호를 되살린다.
// 브라우저가 Windows CF_HTML 로 옮길 때 이 문자열 전체가 조각 범위 안에 들어가도록 조각 끝에 붙인다.
export function appendHancomBoard(html: string, board: string): string {
  if (!board) return html;
  if (html.includes('<!--EndFragment-->')) return html.replace('<!--EndFragment-->', `${board}<!--EndFragment-->`);
  const body = html.search(/<\/body>/i);
  return body >= 0 ? html.slice(0, body) + board + html.slice(body) : html + board;
}
export function readPortableClipboard(html: string): Uint8Array | null {
  const match = /<!--rhwp-fragment-v1:([A-Za-z0-9+/=]+)-->/i.exec(html);
  return match ? clipboardBytes(match[1]) : null;
}
