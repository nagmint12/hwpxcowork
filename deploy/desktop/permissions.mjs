const allowed = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write']);
export function desktopPermission(owned, contents, permission, origin, details = {}, port) {
  if (!owned || contents !== owned || !allowed.has(permission) || !Number.isInteger(port) || port <= 0) return false;
  const local = value => {
    try { const u = new URL(value); return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)
      && Number(u.port) === port && !u.username && !u.password ? u : null; } catch { return null; }
  };
  const top = local(contents.getURL());
  if (!top || (origin && local(origin)?.origin !== top.origin)) return false;
  const requesting = details.requestingUrl ? local(details.requestingUrl) : details.isMainFrame === false ? null : top;
  if (!requesting || requesting.origin !== top.origin) return false;
  return details.isMainFrame === false
    ? ['/studio/', '/studio/index.html'].includes(requesting.pathname)
    : ['/', '/index.html'].includes(requesting.pathname);
}
