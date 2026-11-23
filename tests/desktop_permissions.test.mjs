import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopPermission } from '../deploy/desktop/permissions.mjs';
import { createBlockedCloseHandler } from '../deploy/desktop/close-policy.mjs';
const owned = { getURL: () => 'http://localhost:54321/?teaser=0' };

test('the document tab can load installed fonts on its own port and in stdio mode', () => {
  for (const portless of [false, true]) {
    const base = portless ? 'http://localhost' : 'http://localhost:54321';
    const host = { getURL: () => base + '/?teaser=0' };
    const allowed = path => desktopPermission(host, host, 'local-fonts', base,
      { isMainFrame: false, requestingUrl: new URL(path, base).href }, 54321, portless);
    assert.equal(allowed('/studio/cowork-embed.html?renderer=canvas2d'), true);
    assert.equal(allowed('/uploads/cowork-embed.html'), false);
    assert.equal(allowed('https://example.org/studio/cowork-embed.html'), false);
  }
});

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
