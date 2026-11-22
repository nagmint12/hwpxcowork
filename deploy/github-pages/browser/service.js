import JSZip from 'jszip';
import files, { putFile, restore, persist } from './files.js';
import { createRouter } from './router.js';
import { TutorialStore as Store } from '../../../server/tutorial-store.js';
import { editorEngine } from '../../../server/toc-engine.js';
import { Service } from '../../../server/service.js';
import { loadConfig } from '../../../server/config.js';
import { createTutorial } from '../../../server/tutorial.js';
import { installTutorialRoutes } from '../../../server/routes/tutorial.js';
import { installLibraryRoutes } from '../../../server/routes/library.js';
import { installCollabRoutes } from '../../../server/routes/collab.js';
import { installDocumentRoutes } from '../../../server/routes/documents.js';
import { KINDS, PRESETS } from '../../../server/memotext.js';

const scope = new URL(self.registration.scope);
const user = { name: '내 문서', role: 'admin' };
const seedRoot = '/project';
const storageName = scope.pathname;
let opening;
let tail = Promise.resolve();
let resources;
let wasm;
let messages = [];

async function staticBytes(relative) {
  const response = await fetch(new URL(relative, scope));
  if (!response.ok) throw Error('편집기 자료를 읽지 못했습니다 (' + relative + ', ' + response.status + ')');
  return new Uint8Array(await response.arrayBuffer());
}
async function seeds() {
  const zip = await JSZip.loadAsync(await staticBytes('personal-seed.zip'));
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) putFile(seedRoot + '/' + entry.name, await entry.async('uint8array'));
  }
}
async function prepareEngine() {
  if (!wasm) wasm = staticBytes('studio/rhwp_bg.wasm').then(bytes => putFile(seedRoot + '/vendor/rhwp/pkg/rhwp_bg.wasm', bytes))
    .catch(error => { wasm = null; throw error; });
  await wasm;
}
async function create() {
  resources ||= seeds().catch(error => { resources = null; throw error; });
  await resources;
  await restore(storageName);
  const settings = { dataDir: '/personal', users: [user], ai: { enabled: false }, tutorial: { enabled: true, everyone: true, examples: true, introOnLogin: false }, changeRequests: { allowDirectApply: true } };
  putFile(seedRoot + '/config.json', JSON.stringify(settings));
  const config = loadConfig(seedRoot);
  const store = new Store(config.dataDir);
  const hub = { broadcast(doc, event) { messages.push({ doc, event }); } };
  const service = new Service({ store, hub, config, ai: { enabled: false } });
  const tutorial = createTutorial({ service, config });
  const { app, dispatch } = createRouter(user);
  const ctx = { app, service, config, store, hub, tutorial, root: seedRoot, auth: null, raw: null, rawAttachment: null,
    wrap: handler => handler, bodyBytes: req => req.body, safeDecode: (value, fallback) => { try { return decodeURIComponent(value); } catch { return fallback; } },
    trackOperation: fn => fn() };
  const inactive = { configured: false, active: false };
  app.post('/api/docs', async (req, _res, next) => {
    if (/\.hwp$/i.test(ctx.safeDecode(req.headers['x-file-name'] || '', ''))) {
      const document = new (editorEngine().HwpDocument)(req.body);
      try { req.body = Buffer.from(document.exportHwpx()); } finally { document.free(); }
      req.headers['x-file-name'] += 'x';
    }
    next();
  });
  app.get('/api/config', (_req, res) => res.json({ name: 'HWPX Cowork', browserPersonal: true, studio: { mode: 'local', available: true, plugin: true }, studioUrl: new URL('studio/', scope).href,
    publicUrl: scope.href, aiEnabled: false, allowDirectApply: true, attachments: config.attachments, kinds: KINDS, presets: PRESETS, features: {}, local: false }));
  app.get('/api/me', (_req, res) => res.json({ ...user, browserPersonal: true, tutorial: true, tutorialIntroRequired: false, serverAi: false, personalAi: inactive }));
  app.get('/api/agent/status', (_req, res) => res.json({ sessions: [], me: { online: false, sessions: [] }, agents: {} }));
  app.get('/api/automation/status', (_req, res) => res.json({ connected: false, personalAi: inactive }));
  app.get('/api/me/ai', (_req, res) => res.json(inactive));
  app.get('/api/clipboard/status', (_req, res) => res.json({ enabled: false, available: false }));
  installTutorialRoutes(ctx);
  installLibraryRoutes(ctx);
  ctx.collab = installCollabRoutes(ctx);
  installDocumentRoutes(ctx);
  // Only rehearsal documents can dispatch a prepared answer. An ordinary file has no AI provider or queue.
  return async (request, pathname) => {
    const target = /^\/api\/docs\/([\w-]+)\/(?:requests(?:\/\d+\/(?:retry|recover))?|memos\/[^/]+\/ask-ai)$/.exec(pathname);
    if (request.method === 'POST' && target && !service._meta(target[1]).tutorialSession) {
      return Response.json({ error: 'PAGES_AI_OFF', message: '준비된 예시 답변은 튜토리얼 문서에서 사용할 수 있습니다.' }, { status: 422 });
    }
    if (/^\/api\/(?:docs(?:\/|$)|tutorial\/(?:start|entry)|library\/docs)/.test(pathname)) await prepareEngine();
    return dispatch(request, pathname);
  };
}
async function handle(request, pathname) {
  let response;
  try {
    opening ||= create().catch(error => { opening = null; throw error; });
    const dispatch = await opening;
    try { response = await dispatch(request, pathname); }
    catch (error) {
      console.error('[pages]', pathname, error);
      response = Response.json({ error: error.code || 'PAGES_ERROR', message: error.message }, { status: error.status || 500 });
    }
    try { await persist(); }
    catch (error) { opening = null; messages = []; throw error; }
    if (messages.length) {
      const events = messages; messages = [];
      for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'hwpx-document-events', events });
    }
    return response;
  } catch (error) {
    console.error('[pages] storage', error);
    return Response.json({ error: 'PAGES_STORAGE', message: '브라우저 문서함을 열거나 저장하지 못했습니다. ' + error.message }, { status: 503 });
  }
}
// Let open editors finish their transactions on the current worker before activating an update.
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + 'api/')) return;
  const origin = event.request.headers.get('origin');
  if (event.request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== scope.origin)) {
    event.respondWith(new Response(null, { status: 403 }));
    return;
  }
  const pathname = url.pathname.slice(scope.pathname.length - 1);
  const task = tail.then(() => handle(event.request, pathname));
  tail = task.then(() => {}, () => {});
  event.respondWith(task);
});
