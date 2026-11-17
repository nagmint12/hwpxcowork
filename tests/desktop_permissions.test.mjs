import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopPermission } from '../deploy/desktop/permissions.mjs';
import { createBlockedCloseHandler } from '../deploy/desktop/close-policy.mjs';
const owned = { getURL: () => 'http://localhost:54321/?teaser=0' };

test('own document page and own studio iframe can load fonts; other frames/origins/installations cannot', () => {
  const decide = (origin, details, contents = owned, permission = 'local-fonts', port = 54321) => desktopPermission(owned, contents, permission, origin, details, port);
  assert.equal(decide('http://localhost:54321', { isMainFrame: true, requestingUrl: owned.getURL() }), true);
  assert.equal(decide('http://localhost:54321', { isMainFrame: false, requestingUrl: 'http://localhost:54321/studio/?embed=1' }), true);
  for (const url of ['https://other.example/studio/', 'http://localhost:8787/studio/', 'http://127.0.0.1:54321/studio/', 'file:///studio/', 'http://user:password@localhost:54321/studio/', 'http://localhost:54321/api/raw-document']) {
    assert.equal(decide(url, { isMainFrame: false, requestingUrl: url }), false, url);
  }
  assert.equal(decide('http://localhost:54321', { isMainFrame: false }), false);
  assert.equal(decide('http://localhost:54321', {}, { getURL: owned.getURL }), false);
  assert.equal(decide('http://localhost:54321', {}, owned, 'camera'), false);
  assert.equal(decide('http://localhost:54321', {}, owned, 'local-fonts', 0), false);
});

test('unload keeps cancel as default and resumes the requested close or reload only after discard', () => {
  let discard = false, prompts = 0, resumed = 0;
  const event = { preventDefault: () => { assert.equal(discard, true); resumed++; } };
  const handler = createBlockedCloseHandler({ confirmDiscard: () => { prompts++; handler(event); return discard; } });
  handler(event); assert.equal(prompts, 1); assert.equal(resumed, 0);
  discard = true; handler(event); assert.equal(prompts, 2); assert.equal(resumed, 1);
});
