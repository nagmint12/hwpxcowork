// Implements the response operations used by the shared document routes inside a service worker.
import { Buffer } from 'buffer/';
import files from './files.js';
export function createRouter(user) {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    app[method] = (pattern, ...handlers) => {
      const parts = pattern.split('/');
      routes.push({ method: method.toUpperCase(), parts, handlers: handlers.filter(Boolean) });
    };
  }
  async function dispatch(request, pathname) {
    const url = new URL(request.url);
    const parts = pathname.split('/');
    const req = { method: request.method, user, path: pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers) };
    // In one local workspace, keep the outgoing tab's save alive through its durable response.
    // The editor already understands a completed write in place of a background-save receipt.
    if (request.method === 'PUT' && /\/(?:live|drafts\/mine)$/.test(pathname)) delete req.query.departure;
    req.get = name => request.headers.get(name);
    req.header = req.get;
    if (!['GET', 'HEAD'].includes(request.method)) {
      req.body = request.headers.get('content-type')?.includes('application/json') ? await request.json() : Buffer.from(await request.arrayBuffer());
    }
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    let status = 200;
    let result;
    const res = {
      setHeader(key, value) { headers.set(key, value); return res; },
      set(key, value) { return res.setHeader(key, value); },
      type(value) { return res.setHeader('Content-Type', value); },
      status(code) { status = code; return res; },
      json(value) { res.type('application/json; charset=utf-8'); return res.send(JSON.stringify(value)); },
      send(value) { result = new Response(value, { status, headers }); return res; },
      sendFile(file) { return res.send(files.readFileSync(file)); },
      end() { return res.send(null); },
    };
    for (const route of routes) {
      if (route.method !== request.method || route.parts.length !== parts.length) continue;
      const params = {};
      if (!route.parts.every((part, index) => {
        if (!part.startsWith(':')) return part === parts[index];
        params[part.slice(1)] = decodeURIComponent(parts[index]); return true;
      })) continue;
      req.params = params;
      for (const handler of route.handlers) {
        let next = false;
        await handler(req, res, error => { if (error) throw error; next = true; });
        if (result) return result;
        if (!next) break;
      }
    }
    return Response.json({ error: 'PAGES_UNAVAILABLE', message: '개인 실행기에서 제공하는 기능입니다.' }, { status: 404 });
  }
  return { app, dispatch };
}
