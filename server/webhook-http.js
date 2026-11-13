// Webhook 전용 HTTPS 클라이언트: 매 연결 시 DNS 전체를 검사하고 검증한 IP에만 연결한다.
import https from 'node:https';
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address) {
  try {
    const ip = ipaddr.parse(address);
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv4') return !ip.match(ipaddr.parse('198.18.0.0'), 15);
    return ip.match(ipaddr.parse('2000::'), 3) && !ip.match(ipaddr.parse('2001::'), 23) && !ip.match(ipaddr.parse('3fff::'), 20);
  } catch { return false; }
}

export function callbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('Invalid callback URL'), { reason: 'invalid_url' }); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.hash || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || (ipaddr.isValid(hostname) && !isPublicAddress(hostname))) {
    throw Object.assign(new Error('Callback must use a public HTTPS destination'), { reason: 'unsafe_destination' });
  }
  return url;
}

export function publicLookup(hostname, options, callback, lookup = dns.lookup) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses?.length || addresses.some(item => !isPublicAddress(item.address))) return callback(Object.assign(new Error('Non-public webhook destination'), { reason: 'unsafe_destination' }));
    const family = typeof options === 'number' ? options : options?.family;
    const candidates = family ? addresses.filter(item => item.family === family) : addresses;
    if (!candidates.length) return callback(new Error('No matching webhook address'));
    if (options?.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  });
}

export async function webhookFetch(destination, { headers, body, signal } = {}) {
  const url = callbackUrl(destination);
  return new Promise((resolve, reject) => {
    // URL의 호스트를 바꾸지 않아 원래 호스트의 SNI·인증서 검증을 유지한다. Agent/DNS는 재사용하지 않는다.
    const req = https.request(url, { method: 'POST', agent: false, lookup: publicLookup, signal,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body || '', 'utf8') } }, response => {
      let size = 0; const parts = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) req.destroy(Object.assign(new Error('Webhook response too large'), { reason: 'response_too_large' }));
        else parts.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(Object.assign(new Error('Webhook timeout'), { reason: 'timeout' })));
    req.end(body);
  });
}
