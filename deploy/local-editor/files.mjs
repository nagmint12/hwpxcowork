// 사용자가 고른 파일의 권한만 보관한다. 서버·문서함·운영 설정을 만들지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const LIMIT = 256 * 1024 * 1024;
const supported = file => /\.(hwp|hwpx|hml)$/i.test(file);
const stamp = stat => stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : null;
async function stat(file) { try { return await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export class LocalFiles {
  constructor() { this.handles = new Map(); }
  async grant(file, { creating = false } = {}) {
    if (!supported(file)) throw new Error('HWP·HWPX·HML 문서를 선택해 주세요.');
    const current = await stat(file);
    if (!creating && !current?.isFile()) throw new Error('문서 파일을 찾지 못했습니다.');
    if (current && (!current.isFile() || current.size > LIMIT)) throw new Error('256MB 이하의 문서 파일을 선택해 주세요.');
    const target = current ? await fs.realpath(file) : path.join(await fs.realpath(path.dirname(file)), path.basename(file));
    const id = crypto.randomUUID(); this.handles.set(id, { file: target, stamp: stamp(await stat(target)), busy: false });
    return { id, name: path.basename(file) };
  }
  record(id) { const handle = this.handles.get(id); if (!handle) throw new Error('파일을 다시 열어 주세요.'); return handle; }
  async read(id) { const h = this.record(id); const current = await stat(h.file); if (!current || current.size > LIMIT) throw new Error('문서 파일을 읽을 수 없습니다.'); return new Uint8Array(await fs.readFile(h.file)); }
  async same(a, b) { return this.record(a).file === this.record(b).file; }
  async write(id, value) {
    const h = this.record(id);
    if (h.busy) throw new Error('이 파일을 저장하고 있습니다.');
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > LIMIT) throw new Error('저장할 문서 데이터를 확인해 주세요.');
    h.busy = true; let temporary;
    try {
      const previous = await stat(h.file);
      if (stamp(previous) !== h.stamp) throw new Error('다른 프로그램에서 파일이 바뀌었습니다. 다시 열거나 다른 이름으로 저장해 주세요.');
      if (previous && !(previous.mode & 0o222)) throw new Error('읽기 전용 파일입니다. 다른 이름으로 저장해 주세요.');
      temporary = path.join(path.dirname(h.file), `.${path.basename(h.file)}.${crypto.randomUUID()}.tmp`);
      const output = await fs.open(temporary, 'wx', previous ? previous.mode & 0o777 : 0o600);
      try { await output.writeFile(value); await output.sync(); } finally { await output.close(); }
      if (stamp(await stat(h.file)) !== h.stamp) throw new Error('저장 중 원본이 바뀌었습니다. 다른 이름으로 저장해 주세요.');
      await fs.rename(temporary, h.file); temporary = null;
      h.stamp = stamp(await stat(h.file));
      return { name: path.basename(h.file), bytes: value.byteLength };
    } finally { h.busy = false; if (temporary) await fs.unlink(temporary).catch(() => {}); }
  }
}

export function assetPath(root, input) {
  const url = new URL(input);
  if (url.protocol !== 'hwpx-local:' || url.hostname !== 'editor') throw new Error('잘못된 앱 주소입니다.');
  const rel = decodeURIComponent(url.pathname).replace(/^\/assets\/editor\//, '');
  if (rel === url.pathname || rel.includes('\\') || rel.includes('\0')) throw new Error('잘못된 파일 경로입니다.');
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('잘못된 파일 경로입니다.');
  return file;
}
