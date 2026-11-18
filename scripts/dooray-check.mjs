#!/usr/bin/env node
// 두레이 개인 API 토큰 점검(읽기만) — cowork 에 등록하기 전에 토큰·사이트 주소·개인 드라이브를 확인한다.
//   PowerShell:  $env:DOORAY_API_TOKEN='<토큰>'; npm run dooray:check -- --site https://회사.dooray.com
//   bash:        DOORAY_API_TOKEN='<토큰>' npm run dooray:check -- --site https://회사.dooray.com
// 토큰은 명령 인자로 받지 않는다(명령 기록에 남지 않게). 결과에 토큰을 찍지 않는다. 쓰기 요청을 보내지 않는다.
import { createDoorayClient, doorayEndpoint, normalizeDoorayToken } from '../server/dooray-api.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const site = arg('--site') || process.env.DOORAY_SITE;
const say = (ok, text) => console.log(`${ok ? '확인' : '실패'}  ${text}`);
try {
  if (!site) throw new Error('--site https://회사.dooray.com 을 주세요.');
  if (!process.env.DOORAY_API_TOKEN) throw new Error('환경 변수 DOORAY_API_TOKEN 에 토큰을 넣어 주세요.');
  const endpoint = doorayEndpoint(site);
  const token = normalizeDoorayToken(process.env.DOORAY_API_TOKEN);
  say(true, `사이트 ${endpoint.site} → ${endpoint.cloudLabel} API ${endpoint.apiBase}`);
  const client = createDoorayClient({ apiBase: endpoint.apiBase, domain: endpoint.domain, token, timeoutMs: 20000 });
  const me = (await client.me()).result;
  say(true, `토큰 계정: ${me?.name || '(이름 없음)'}${me?.userCode ? ` (${me.userCode})` : ''}`);
  const drives = ((await client.drives({ type: 'private' })).result || []).filter((d) => d?.type === 'private');
  if (drives.length !== 1) throw new Error(`개인 드라이브를 ${drives.length}개 찾았습니다(1개여야 합니다).`);
  say(true, '개인 드라이브 찾음');
  const roots = ((await client.files(String(drives[0].id), { type: 'folder', subTypes: 'root' })).result || []).filter((f) => f?.subType === 'root');
  if (roots.length !== 1) throw new Error('개인 드라이브의 최상위 폴더를 찾지 못했습니다.');
  const top = await client.files(String(drives[0].id), { parentId: String(roots[0].id), page: 0, size: 20 });
  const items = top.result || [];
  say(true, `최상위 폴더 읽기: ${top.totalCount ?? items.length}개 항목(폴더 ${items.filter((f) => f.type === 'folder').length} · 파일 ${items.filter((f) => f.type !== 'folder').length}, 첫 쪽 기준)`);
  console.log('\n이 토큰과 주소를 cowork [드라이브 → 연결 설정]에 등록하면 됩니다.');
} catch (e) {
  say(false, e.message);
  if (e.code === 'DOORAY_AUTH') console.log('  → 토큰을 다시 복사했는지, 두레이에서 토큰이 삭제되지 않았는지 확인하세요.');
  if (e.code === 'DOORAY_FORBIDDEN') console.log('  → 기관에 접속 위치 제한(IP ACL)이 있으면 이 PC·서버 주소의 허용을 관리자에게 요청하세요.');
  process.exitCode = 1;
}
