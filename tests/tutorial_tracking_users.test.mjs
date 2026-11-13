import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

test('selected tutorial user gets tracking without changing other users', async t => {
  const srv = await startServer({ config: { tutorial: { trackChangesUsers: ['홍길동'] } } });
  t.after(() => srv.stop());
  for (const [who, expected] of [['a', true], ['b', false]]) {
    const api = srv.api(who);
    const { docId } = await api('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'overview' } });
    const info = await api(`/api/docs/${docId}`);
    const doc = await HwpxDoc.load(await api(`/api/docs/${docId}/file?kind=tracked`));
    assert.equal(doc.header.trackingEnabled(), expected);
    assert.equal(info.settings.track === 'tracked', expected);
  }
});
