import { Volume, createFsFromVolume } from 'memfs';
import path from 'path-browserify';

export const files = createFsFromVolume(new Volume());
export default files;
export const appendFileSync = (...args) => files.appendFileSync(...args);
const home = '/personal';
const dirty = new Set();
const removed = new Set();
const personal = name => typeof name === 'string' && (name === home || name.startsWith(home + '/'));
function recordTree(name) {
  dirty.add(name);
  if (files.statSync(name).isDirectory()) for (const child of files.readdirSync(name)) recordTree(path.join(name, child));
}
let recording = false;
let db;

for (const method of ['mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'copyFileSync']) {
  if (!files[method]) continue;
  const original = files[method].bind(files);
  files[method] = (...args) => {
    const result = original(...args);
    if (recording) {
      const names = method === 'renameSync' ? args.slice(0, 2) : [args[method === 'copyFileSync' ? 1 : 0]];
      for (const name of names) if (personal(name)) dirty.add(name);
      if (['unlinkSync', 'rmSync', 'rmdirSync', 'renameSync'].includes(method) && personal(args[0])) removed.add(args[0]);
      if (method === 'renameSync' && personal(args[1])) recordTree(args[1]);
    }
    return result;
  };
}

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(tx.error || new Error('브라우저 저장소에 쓰지 못했습니다.'));
});
export function putFile(name, bytes) {
  files.mkdirSync(path.dirname(name), { recursive: true });
  files.writeFileSync(name, bytes);
}
export async function restore(scope) {
  recording = false;
  dirty.clear();
  removed.clear();
  if (!db) db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('hwpx-cowork-personal:' + scope, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  if (files.existsSync(home)) files.rmSync(home, { recursive: true, force: true });
  files.mkdirSync(home, { recursive: true });
  const tx = db.transaction('files', 'readonly');
  const cursor = tx.objectStore('files').openCursor();
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (!item) return;
    if (item.value === null) files.mkdirSync(item.key, { recursive: true });
    else putFile(item.key, item.value);
    item.continue();
  };
  await done(tx);
  recording = true;
}
export async function persist() {
  if (!dirty.size) return;
  const tx = db.transaction('files', 'readwrite');
  const completion = done(tx);
  const records = tx.objectStore('files');
  try {
    for (const name of removed) {
      records.delete(name);
      records.delete(IDBKeyRange.bound(name + '/', name + '/\uffff'));
    }
    for (const name of dirty) {
      if (!files.existsSync(name)) {
        records.delete(name);
        records.delete(IDBKeyRange.bound(name + '/', name + '/\uffff'));
      } else if (files.statSync(name).isDirectory()) records.put(null, name);
      else records.put(new Uint8Array(files.readFileSync(name)), name);
    }
    await completion;
    dirty.clear();
    removed.clear();
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await completion.catch(() => {});
    throw error;
  }
}
