// 화면 오류 기록(server/client-log.js) — 관리자만 받고 runtime/client-log.jsonl 에 한 줄씩 쌓는다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

test('관리자 기록은 쌓고, 편집자는 403', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const send = (who, body) => srv.api(who).res('/api/client-log', { method: 'POST', body });
  const entries = [{ at: '2026-11-03T00:00:00Z', level: 'error', src: 'studio', msg: 'x'.repeat(10000) }, { level: 'state', src: 'editor', msg: '{"phase":"setBase"}' }];
  const ok = await send('admin', { session: 's1', page: '#/doc/abc', env: { ua: 'phone', dpr: 3 }, entries });
  assert.equal(ok.status, 204);
  assert.equal((await send('a', { entries })).status, 403);
  assert.equal((await send('admin', { entries: [] })).status, 204);
  const lines = fs.readFileSync(path.join(srv.dataDir, 'runtime', 'client-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].user, srv.users.admin.name);
  assert.equal(lines[0].page, '#/doc/abc');
  assert.equal(lines[0].env.dpr, 3);
  assert.equal(lines[0].msg.length, 4000);
  assert.equal(lines[1].msg, '{"phase":"setBase"}');
});
