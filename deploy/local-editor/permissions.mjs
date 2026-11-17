const supported = new Set(['local-fonts', 'clipboard-read', 'clipboard-sanitized-write']);
export function isLocalEditorUrl(value, documentOnly = false) {
  try {
    const url = new URL(value);
    return url.protocol === 'hwpx-local:' && url.hostname === 'editor' && !url.port && !url.username && !url.password
      && (!documentOnly || url.pathname === '/assets/editor/index.html');
  } catch { return false; }
}
// 외부 사이트나 문서 안의 subframe에는 자동 글꼴 접근 권한을 주지 않는다.
export function localEditorPermission(ownedContents, contents, permission, requestingOrigin, details = {}) {
  return !!ownedContents && contents === ownedContents && supported.has(permission)
    && isLocalEditorUrl(contents.getURL(), true) && details.isMainFrame !== false
    && (!requestingOrigin || isLocalEditorUrl(requestingOrigin))
    && (!details.requestingUrl || isLocalEditorUrl(details.requestingUrl, true));
}
