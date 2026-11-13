// Work가 fileParams로 전달한 파일을 받는다. 토큰 전달·로컬 주소 접근·무제한 다운로드를 허용하지 않는다.
import https from 'node:https';
import { callbackUrl, publicLookup } from './webhook-http.js';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

export function workDownloadUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 16384) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.hash) throw new Error();
    callbackUrl(url.origin); // 긴 CDN 서명 쿼리는 허용하고 출처·주소 검사는 재사용한다.
    return url;
  }
  catch { throw fail('BAD_FILE_URL', '파일 다운로드 주소는 공개 HTTPS 주소여야 합니다'); }
}

export async function downloadWorkFile(value, { maxBytes = 52428800, request = https.request, signal } = {}) {
  const deadline = AbortSignal.timeout(30000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function get(destination, redirects = 0) {
    const url = workDownloadUrl(destination);
    return new Promise((resolve, reject) => {
      const req = request(url, { method: 'GET', agent: false, lookup: publicLookup, signal: abort,
        headers: { Accept: 'application/octet-stream, */*' } }, response => {
        response.on('error', () => reject(fail('FILE_DOWNLOAD_FAILED', '파일 다운로드가 중단되었습니다', 502)));
        response.on('aborted', () => reject(fail('FILE_DOWNLOAD_FAILED', '파일 다운로드가 중단되었습니다', 502)));
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirects >= 3 || !response.headers.location) return reject(fail('FILE_DOWNLOAD_FAILED', '파일 다운로드 경로가 올바르지 않습니다', 502));
          let next;
          try { next = workDownloadUrl(new URL(response.headers.location, url).href); }
          catch (e) { return reject(e); }
          return resolve(get(next.href, redirects + 1));
        }
        if (status !== 200) {
          response.resume();
          return reject(fail('FILE_DOWNLOAD_FAILED', '파일을 내려받지 못했습니다. Work에서 파일을 다시 전달해 주세요', 502));
        }
        if (Number(response.headers['content-length']) > maxBytes) {
          response.destroy();
          return reject(fail('TOO_LARGE', '결과 파일이 첨부 크기 제한을 넘습니다', 413));
        }
        const parts = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(fail('TOO_LARGE', '결과 파일이 첨부 크기 제한을 넘습니다', 413));
            response.destroy(); req.destroy();
          } else parts.push(chunk);
        });
        response.on('end', () => {
          if (!size) return reject(fail('EMPTY', '빈 파일입니다'));
          resolve({ bytes: Buffer.concat(parts), mime: String(response.headers['content-type'] || '').split(';')[0] });
        });
      });
      req.on('error', () => reject(fail('FILE_DOWNLOAD_FAILED', '파일을 내려받지 못했습니다. 주소·만료 시간을 확인해 주세요', 502)));
      req.setTimeout(10000, () => req.destroy());
      req.end();
    });
  }
  return get(value);
}
