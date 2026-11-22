export const docOf = route => /^#\/doc\/([\w-]+)(?:[/?]|$)/.exec(route || '')?.[1] || null;
export const routeOf = id => id ? '#/doc/' + id : '#/';
export const tabId = id => 'office-tab-' + id;
export const panelId = id => 'office-document-' + id;
export const overlayId = id => 'office-overlays-' + id;

export function createTabs() {
  return {
    items: [],
    visits: [],
    openSequence: 0,
    find(id) { return this.items.find(tab => tab.id === id); },
    fromSource(source) { return source && this.items.find(tab => tab.source === source); },
    add({ id, title, source }) {
      if (this.find(id)) return;
      this.items.push({ id, title: title || '문서', source, serial: ++this.openSequence, visited: false, dirty: false, saving: false, closing: false, failed: false });
    },
    visit(id) {
      this.add({ id });
      this.find(id).visited = true;
      this.visits = [id, ...this.visits.filter(visited => visited !== id)];
    },
    remove(id) {
      const index = this.items.findIndex(tab => tab.id === id);
      if (index < 0) return null;
      this.items.splice(index, 1);
      this.visits = this.visits.filter(visited => visited !== id);
      return this.visits[0] || this.items[index]?.id || this.items[index - 1]?.id || null;
    },
    cycle(id, step) {
      if (!this.items.length) return null;
      const index = this.items.findIndex(tab => tab.id === id);
      return this.items[index < 0 ? (step > 0 ? 0 : this.items.length - 1) : (index + step + this.items.length) % this.items.length].id;
    },
  };
}

function sharedStart(a, b) {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length++;
  return length;
}

// 같은 앞부분이 긴 제목은 서로 다른 부분부터 표시한다. 동일 제목에는 처음 열 때 받은 번호만 덧붙인다.
export function officeTabNames(items) {
  const labels = items.map(tab => {
    const title = tab.title.normalize('NFC');
    return { tab, title, chars: Array.from(title) };
  });
  const names = new Map();
  for (const { tab, title, chars } of labels) {
    let shared = 0;
    let duplicate = false;
    for (const other of labels) {
      if (other.tab.id === tab.id) continue;
      if (title === other.title) duplicate = true;
      else shared = Math.max(shared, sharedStart(chars, other.chars));
    }
    const start = shared < 8 ? 0 : shared === chars.length ? Math.max(0, shared - 4) : shared;
    names.set(tab.id, {
      prefix: chars.slice(0, start).join(''), suffix: chars.slice(start).join(''), duplicate: duplicate ? tab.serial : null,
    });
  }
  return names;
}

// 헤더에는 파일명만 보낸다. 윈도 경로 구분자·예약 이름·제어 문자에 의존하지 않는다.
export function officeFileName(value, allowHwp = false) {
  const name = String(value || '').split(/[\\/]/).pop().normalize('NFC');
  const extension = allowHwp && /\.hwp$/i.test(name) ? '.hwp' : '.hwpx';
  if (!name.toLowerCase().endsWith(extension)) throw new Error(allowHwp ? 'HWP 또는 HWPX 파일을 선택하세요.' : 'HWPX 파일을 선택하세요.');
  const base = Array.from(name.slice(0, -extension.length).replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '')).slice(0, 120).join('').replace(/[. ]+$/g, '');
  const safe = base || '문서';
  return (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(safe) ? '_' : '') + safe + extension;
}

export function officeFileBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return file.bytes;
}

export function uploadHeaders(location) {
  if (location.folderId) return { 'x-folder-id': location.folderId };
  const headers = { 'x-space': location.space };
  if (location.space === 'private') headers['x-space-owner'] = encodeURIComponent(location.owner);
  return headers;
}
