import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLabRuntime } from '../runtime.mjs';
import { createLocalFileTools } from '../local-files.mjs';

const value = result => JSON.parse(result.content[0].text);
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
async function setup() {
  const runtime = createLabRuntime(), user = runtime.users.owner, session = 'lab-file-test';
  const doc = await runtime.service.createBlankDocument({ title: 'Local file roundtrip', user, location: { space: 'private' } });
  const bytes = Buffer.from('가상 원본\nA,10\nB,20\n', 'utf8');
  const attachment = await runtime.service.addAttachment(doc.id, { name: 'input.csv', bytes }, user);
  const created = await runtime.service.createRequest(doc.id, { kind: 'instruct', route: 'queue', instruction: '첨부 파일을 처리합니다.', target: { scope: 'document' }, attachments: [attachment.aid] }, user);
  const args = { doc_id: doc.id, request_id: created.request.rid, expected_attempt: 1 };
  await runtime.service.startRequest(doc.id, created.request.rid, { ...user, agentSession: session, agentAttempt: 1 }, 'MCP Lab', { session });
  const module = createLocalFileTools({ runtime, user, session });
  return { runtime, user, session, doc, bytes, attachment, args, module,
    download: a => module.tools[0].handler({ ...args, attachment_id: attachment.aid, ...a }),
    upload: a => module.tools[1].handler({ ...args, ...a }),
  };
}

test('actual local bytes download/upload roundtrip, content-hash dedup, and no direct document overwrite', async t => {
  const h = await setup(); t.after(async () => { h.module.close(); await h.runtime.close(); });
  const before = h.runtime.service.store.currentBytes(h.doc.id);
  const download = value(await h.download());
  assert.deepEqual(fs.readFileSync(download.path), h.bytes);
  assert.ok(download.path.startsWith(h.module.directory));
  assert.ok(!JSON.stringify(download).includes(h.bytes.toString('utf8')));
  const resultBytes = Buffer.from('가상 결과\n합계,30\n', 'utf8');
  const output = path.join(download.out_dir, 'result.csv'); fs.writeFileSync(output, resultBytes);
  const saved = value(await h.upload({ path: output }));
  assert.ok(saved.aid); assert.equal(saved.duplicate, false);
  assert.deepEqual((await h.runtime.service.getAttachment(h.doc.id, saved.aid)).bytes, resultBytes);
  const again = value(await h.upload({ path: 'out/result.csv' }));
  assert.equal(again.aid, saved.aid); assert.equal(again.duplicate, true);
  assert.deepEqual(h.runtime.service.store.currentBytes(h.doc.id), before);
  const resultDownload = value(await h.download({ attachment_id: saved.aid }));
  assert.deepEqual(fs.readFileSync(resultDownload.path), resultBytes);
});

test('other users, out-of-root paths, traversal, hard links and executable extensions are rejected', async t => {
  const h = await setup(); t.after(async () => { h.module.close(); await h.runtime.close(); });
  const download = value(await h.download());
  const other = createLocalFileTools({ runtime: h.runtime, user: h.runtime.users.other, session: 'other' });
  await assert.rejects(other.tools[0].handler({ ...h.args, attachment_id: h.attachment.aid }));
  other.close();
  const outside = path.join(h.runtime.tempDir, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  await rejects(h.upload({ path: outside }), 'OUTSIDE');
  await rejects(h.upload({ path: '../outside.txt' }), 'OUTSIDE');
  const executable = path.join(download.out_dir, 'run.exe'); fs.writeFileSync(executable, 'not executable but forbidden extension');
  await rejects(h.upload({ path: executable }), 'FILE_TYPE_NOT_ALLOWED');
  const hard = path.join(download.out_dir, 'linked.txt'); fs.linkSync(outside, hard);
  await rejects(h.upload({ path: hard }), 'NOT_FILE');
  const plain = path.join(download.out_dir, 'plain.txt'); fs.writeFileSync(plain, 'text');
  await rejects(h.upload({ path: plain, file_name: 'renamed.csv' }), 'FILE_TYPE_MISMATCH');
  const junction = path.join(download.out_dir, 'junction');
  fs.symlinkSync(h.runtime.tempDir, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await rejects(h.upload({ path: path.join(junction, 'outside.txt') }), 'OUTSIDE');
});

test('stale attempts, unrelated attachments, another claim and cancellation cannot save bytes', async t => {
  const h = await setup(); t.after(async () => { h.module.close(); await h.runtime.close(); });
  const download = value(await h.download());
  const output = path.join(download.out_dir, 'result.txt'); fs.writeFileSync(output, 'result');
  await rejects(h.download({ expected_attempt: 2 }), 'ATTEMPT_CHANGED');
  await rejects(h.upload({ path: output, expected_attempt: 2 }), 'ATTEMPT_CHANGED');
  const unlinked = await h.runtime.service.addAttachment(h.doc.id, { name: 'unlinked.txt', bytes: Buffer.from('not linked') }, h.user);
  await rejects(h.download({ attachment_id: unlinked.aid }), 'NOT_REQUEST_ATTACHMENT');
  const differentSession = createLocalFileTools({ runtime: h.runtime, user: h.user, session: 'wrong-session' });
  await assert.rejects(differentSession.tools[1].handler({ ...h.args, path: output }), error => ['CLAIMED', 'CLAIM_REQUIRED'].includes(error.code));
  differentSession.close();
  const beforeCount = h.runtime.service._meta(h.doc.id).attachments.length;
  await h.runtime.service.cancelRequest(h.doc.id, h.args.request_id, h.user);
  await rejects(h.download(), 'REQUEST_CLOSED');
  await rejects(h.upload({ path: output }), 'REQUEST_CLOSED');
  assert.equal(h.runtime.service._meta(h.doc.id).attachments.length, beforeCount);
});

test('size limits and closed bridges are enforced before result storage', async t => {
  const h = await setup(); t.after(async () => { h.module.close(); await h.runtime.close(); });
  const download = value(await h.download());
  h.runtime.config.attachments.maxBytes = 4;
  const small = createLocalFileTools({ runtime: h.runtime, user: h.user, session: h.session });
  const output = path.join(download.out_dir, 'large.txt'); fs.writeFileSync(output, 'five!');
  await rejects(small.tools[1].handler({ ...h.args, path: output }), 'TOO_LARGE');
  await rejects(small.tools[0].handler({ ...h.args, attachment_id: h.attachment.aid }), 'TOO_LARGE');
  small.close(); await rejects(small.tools[0].handler({ ...h.args, attachment_id: h.attachment.aid }), 'FILES_CLOSED');
});
