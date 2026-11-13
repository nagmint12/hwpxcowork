// node --test tests/mcp_size_admin.test.mjs — AI 에 보내는 응답 크기와 관리자 설정:
// get_request 서식은 번호 + 관련 header 만(formattingCatalog 없음), get_formatting(전체·부분·번호·문단), 응답 한도(관리자 설정 → 바로 적용, 넘치면 줄임),
// 사용자 관리(추가·역할·새 토큰·삭제, 마지막 관리자·자기 계정 보호, 설정 파일 저장).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SAMPLE = path.join(here, 'samples', '2025년_전체종합보고서.hwpx');   // 표·서식이 많은 실제 보고서
const hasSample = fs.existsSync(SAMPLE);
const size = (o) => JSON.stringify(o, null, 1).length;

async function mcp(srv, name, args) {
  const r = await fetch(`${srv.base}/mcp?agent=SizeTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.admin}`, 'X-Hwpx-Agent-Session': 'sizeA', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  const text = res.content[0].text;
  return res.isError ? { error: text } : (/^[[{]/.test(text) ? JSON.parse(text) : { text });
}

test('get_request·get_formatting: 서식은 번호 + 관련 header 만, 응답 한도를 관리자가 바꾸면 바로 줄인다', { skip: !hasSample && '2025 표본 없음', timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.admin, SAMPLE);
    const A = srv.api('admin'); const D = `/api/docs/${doc.id}`;
    const table = (await A(`${D}/tables`))[0];
    const cell = table.cells.find((c) => c.refs?.length && c.text)?.refs[0];
    const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '이 칸의 서식을 다른 표와 맞춰줘', route: 'queue', target: { ref: cell } } })).request;
    // 기본(4만 자): 문단은 번호만, 관련 header 만, 전체 목록 없음
    const full = await mcp(srv, 'get_request', { doc_id: doc.id, request_id: req.rid });
    assert.ok(!('formattingCatalog' in full) && full.formattingHeader && !full.truncated);
    assert.ok(size(full) <= 40000, `${size(full)}자`);
    const used = new Set(full.contextItems.flatMap((c) => (c.runs || []).map((r) => r.charPrId)));
    assert.deepEqual(new Set(full.formattingHeader.charPr.map((c) => c.id)).isSupersetOf(used), true, '쓰인 글자모양 번호는 모두 header 에 있다');
    assert.ok(full.contextItems.every((c) => c.ref === '…' || (c.styleId != null && Array.isArray(c.runs) && !('formatting' in c))));
    assert.match(full.howTo, /formattingHeader/);
    // 서식이 필요 없는 요청(서식 낱말 없음): 서식 번호·값 없이 스타일 이름만, 필요한 문단은 get_formatting
    const plainReq = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '시각화해줘', route: 'queue', target: { ref: cell } } })).request;
    const plain = await mcp(srv, 'get_request', { doc_id: doc.id, request_id: plainReq.rid });
    assert.deepEqual(Object.keys(plain.formattingHeader).sort(), ['lean', 'note']); assert.match(plain.formattingHeader.note, /get_formatting/);
    assert.ok(plain.contextItems.every((c) => c.ref === '…' || (!('runs' in c) && !('paraPrId' in c) && (c.styleId == null || typeof c.style === 'string'))), JSON.stringify(plain.contextItems.slice(0, 2)));
    assert.ok(plain.howTo.includes('get_formatting(refs)로 그 문단만'), plain.howTo); assert.ok(size(plain) < size(full) * 0.7, `${size(plain)} < ${size(full)}`);
    // 전체 서식: 기본 한도면 한 번에, 번호·문단으로 골라 받기
    const all = await mcp(srv, 'get_formatting', { doc_id: doc.id });
    assert.ok(all.styles.length > 10 && all.charPr.length >= all.counts.charPr && all.fonts.length, Object.keys(all).join(','));
    const pick = await mcp(srv, 'get_formatting', { doc_id: doc.id, ids: { charPr: [all.charPr[0].id] } });
    assert.deepEqual([pick.charPr.length, pick.styles.length, pick.paraPr.length, 'fonts' in pick], [1, 0, 0, false]);
    const para = await mcp(srv, 'get_formatting', { doc_id: doc.id, refs: [cell] });
    assert.equal(para.paragraphs[0].ref, cell); assert.ok(para.header.charPr.some((c) => c.id === para.paragraphs[0].runs[0].charPrId));
    // 관리자가 한도를 5천 자로 → 다음 호출부터 줄인다(대상 문단은 남김)
    const L = await A('/api/admin/limits');
    assert.deepEqual([L.limits.mcpResponseChars, L.defaults.mcpResponseChars], [40000, 40000]); assert.ok(L.guide.client);
    const bad = await A.res('/api/admin/limits', { method: 'PATCH', body: { limits: { mcpResponseChars: 4000 }, revision: L.revision } });
    assert.deepEqual([bad.status, bad.data.error], [400, 'INVALID_LIMITS']);
    const saved = await A('/api/admin/limits', { method: 'PATCH', body: { limits: { mcpResponseChars: 5000 }, revision: L.revision } });
    assert.equal(saved.limits.mcpResponseChars, 5000);
    assert.equal(JSON.parse(fs.readFileSync(srv.configPath, 'utf8')).limits.mcpResponseChars, 5000, '설정 파일에도 저장');
    const stale = await A.res('/api/admin/limits', { method: 'PATCH', body: { limits: { mcpResponseChars: 6000 }, revision: L.revision } });
    assert.deepEqual([stale.status, stale.data.error], [409, 'CONFIG_CHANGED']);
    const small = await mcp(srv, 'get_request', { doc_id: doc.id, request_id: req.rid });
    assert.ok(small.truncated && small.truncated.limit === 5000 && small.truncated.contextItemsDropped > 0, JSON.stringify(small.truncated));
    assert.ok(small.contextItems.some((c) => c.isTarget && c.ref === cell), '대상 문단은 남긴다');
    assert.ok(size(small) < size(full));
    const parted = await mcp(srv, 'get_formatting', { doc_id: doc.id });
    assert.equal(parted.truncated, true);
    const page = await mcp(srv, 'get_formatting', { doc_id: doc.id, part: 'charPr' });
    assert.ok(page.items.length && page.nextFrom > 0 && size(page) <= 5000, `${size(page)}`);
    const next = await mcp(srv, 'get_formatting', { doc_id: doc.id, part: 'charPr', from: page.nextFrom });
    assert.equal(next.items[0].id, all.charPr[page.nextFrom].id);
    const read = await mcp(srv, 'read_document', { doc_id: doc.id });
    assert.ok(read.text.length <= 5600, `read_document ${read.text.length}자`);
  } finally { await srv.stop(); }
});

test('관리자 사용자 관리: 추가(토큰 한 번)·역할·새 토큰·삭제가 바로 적용, 마지막 관리자·자기 계정 보호, 관리자만', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('admin');
    const me = async (token) => (await fetch(`${srv.base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status;
    const list = await A('/api/admin/users');
    assert.deepEqual(list.users.map((u) => [u.name, u.role, u.me]), [['관리자', 'admin', true], ['홍길동', 'editor', false], ['김검토', 'editor', false]]);
    assert.ok(list.users.every((u) => /^….{4}$/.test(u.tokenHint)) && !JSON.stringify(list).includes(srv.tokens.a), '목록에 토큰 전체를 싣지 않는다');
    assert.equal((await srv.api('a').res('/api/admin/users')).status, 403);
    // 추가 → 토큰으로 바로 접속
    const add = await A('/api/admin/users', { method: 'POST', body: { user: { name: ' 새 사용자 ', role: 'viewer' }, revision: list.revision } });
    assert.deepEqual([add.created.name, add.created.role], ['새 사용자', 'viewer']);
    assert.equal(await me(add.created.token), 200);
    assert.equal((await A.res('/api/admin/users', { method: 'POST', body: { user: { name: '새 사용자' }, revision: add.revision } })).data.error, 'NAME_TAKEN');
    assert.equal((await A.res('/api/admin/users', { method: 'POST', body: { user: { name: 'x', role: 'owner' }, revision: add.revision } })).data.error, 'BAD_ROLE');
    // 역할·새 토큰
    const promoted = await A(`/api/admin/users/${encodeURIComponent('새 사용자')}`, { method: 'PATCH', body: { user: { role: 'editor' }, revision: add.revision } });
    assert.equal(promoted.users.find((u) => u.name === '새 사용자').role, 'editor');
    const re = await A(`/api/admin/users/${encodeURIComponent('새 사용자')}/token`, { method: 'POST', body: { revision: promoted.revision } });
    assert.deepEqual([await me(add.created.token), await me(re.issued.token)], [401, 200]);
    // 보호: 자기 계정 삭제·마지막 관리자 강등
    assert.equal((await A.res(`/api/admin/users/${encodeURIComponent('관리자')}`, { method: 'DELETE', body: { revision: re.revision } })).data.error, 'SELF_DELETE');
    assert.equal((await A.res(`/api/admin/users/${encodeURIComponent('관리자')}`, { method: 'PATCH', body: { user: { role: 'editor' }, revision: re.revision } })).data.error, 'LAST_ADMIN');
    // 삭제 → 바로 401, 설정 파일에서도 빠짐(다른 항목 유지)
    const del = await A(`/api/admin/users/${encodeURIComponent('새 사용자')}`, { method: 'DELETE', body: { revision: re.revision } });
    assert.ok(!del.users.some((u) => u.name === '새 사용자'));
    assert.equal(await me(re.issued.token), 401);
    const file = JSON.parse(fs.readFileSync(srv.configPath, 'utf8'));
    assert.deepEqual(file.users.map((u) => u.name), ['관리자', '홍길동', '김검토']);
    assert.ok(file.dataDir || file.port !== undefined || Object.keys(file).length > 1, '다른 설정 항목은 그대로');
    assert.equal((await A.res('/api/admin/users', { method: 'POST', body: { user: { name: 'y' }, revision: list.revision } })).data.error, 'CONFIG_CHANGED');
  } finally { await srv.stop(); }
});

test('관리자가 토큰을 직접 정한다(비우면 무작위): 형식·중복 거절, 바꾼 토큰으로 바로 접속', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('admin');
    const me = async (token) => (await fetch(`${srv.base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status;
    const list = await A('/api/admin/users');
    const add = await A('/api/admin/users', { method: 'POST', body: { user: { name: '시험', role: 'editor', token: 'test1234' }, revision: list.revision } });
    assert.equal(add.created.token, 'test1234');
    assert.equal(await me('test1234'), 200);
    for (const bad of ['abc', 'has space', '한글토큰', 'a/b', 'x'.repeat(201)]) {
      assert.equal((await A.res('/api/admin/users', { method: 'POST', body: { user: { name: `b${bad.length}`, token: bad }, revision: add.revision } })).data.error, 'BAD_TOKEN', bad);
    }
    assert.equal((await A.res('/api/admin/users', { method: 'POST', body: { user: { name: '중복', token: srv.tokens.a }, revision: add.revision } })).data.error, 'TOKEN_TAKEN');
    const re = await A(`/api/admin/users/${encodeURIComponent('시험')}/token`, { method: 'POST', body: { revision: add.revision, token: 'demo-2026' } });
    assert.equal(re.issued.token, 'demo-2026');
    assert.deepEqual([await me('test1234'), await me('demo-2026')], [401, 200]);
    assert.equal((await A.res(`/api/admin/users/${encodeURIComponent('시험')}/token`, { method: 'POST', body: { revision: re.revision, token: srv.tokens.a } })).data.error, 'TOKEN_TAKEN');
    const same = await A(`/api/admin/users/${encodeURIComponent('시험')}/token`, { method: 'POST', body: { revision: re.revision, token: 'demo-2026' } });
    assert.equal(same.issued.token, 'demo-2026', '자기 토큰을 그대로 다시 정하는 것은 허용');
    const auto = await A(`/api/admin/users/${encodeURIComponent('시험')}/token`, { method: 'POST', body: { revision: same.revision } });
    assert.ok(auto.issued.token.length >= 32, '비우면 무작위(옵션)');
  } finally { await srv.stop(); }
});
