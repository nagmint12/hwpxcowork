// HWPX 컨테이너(zip) 읽기/쓰기. mimetype 을 맨 앞에 무압축으로 두고 나머지는 deflate.
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

const dec = new TextDecoder('utf-8');
const enc = new TextEncoder();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const zipDate = () => new Date(1980, 0, 1);

// JSZip은 읽은 ZipObject를 다시 생성할 때 압축 방식이 같으면 압축 데이터를 재사용한다.
// files는 공개 Map이고 getBytes도 가변 배열을 반환하므로 참조/수정 횟수만 비교하면 안 된다.
const compression = (name, bytes) => !bytes.length || name === 'mimetype' || name === 'version.xml' ? 'STORE' : 'DEFLATE';

export class HwpxContainer {
  /** @param {Map<string, Uint8Array>} files @param {string[]} order */
  constructor(files, order) { this.files = files; this.order = order; this.revision = 0; this._savedEntries = new Map(); }

  static async load(buffer) {
    // JSZip의 압축 데이터는 입력 버퍼를 참조할 수 있다. 호출자가 원본을 수정해도 안전하게 보관한다.
    const input = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice()
      : buffer instanceof ArrayBuffer ? buffer.slice(0) : Array.isArray(buffer) ? buffer.slice() : buffer;
    const zip = await JSZip.loadAsync(input);
    const files = new Map(); const order = [];
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    for (const name of names) { files.set(name, await zip.files[name].async('uint8array')); order.push(name); }
    const container = new HwpxContainer(files, order);
    for (const name of names) container._savedEntries.set(name, { hash: digest(files.get(name)), entry: zip.files[name] });
    return container;
  }

  has(name) { return this.files.has(name); }
  getBytes(name) { return this.files.get(name); }
  getText(name) { const b = this.files.get(name); return b == null ? null : dec.decode(b); }
  setText(name, text) { if (!this.files.has(name)) this.order.push(name); this.files.set(name, enc.encode(text)); this.revision++; }
  setBytes(name, bytes) { if (!this.files.has(name)) this.order.push(name); this.files.set(name, bytes); this.revision++; }
  remove(name) { if (this.files.delete(name)) this.revision++; this.order = this.order.filter((n) => n !== name); }

  /** content.hpf(매니페스트) 순서를 따르는 구역 파일 목록. 없으면 이름순. */
  sectionNames() {
    const hpf = this.getText('Contents/content.hpf');
    const names = [];
    if (hpf) {
      const re = /<opf:item\b[^>]*href="([^"]+)"[^>]*>/g; let m;
      while ((m = re.exec(hpf))) if (/^Contents\/section\d+\.xml$/.test(m[1])) names.push(m[1]);
    }
    if (!names.length) {
      for (const n of this.order) if (/^Contents\/section\d+\.xml$/.test(n)) names.push(n);
      names.sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    }
    return names;
  }

  async save() {
    const zip = new JSZip();
    const hashes = new Map();
    // 직접 files.set()으로 추가된 파일도 빠뜨리지 않으며 기존 파일 순서는 유지한다.
    const names = [...new Set(['mimetype', 'version.xml', ...this.order, ...this.files.keys()])];
    for (const name of names) {
      const bytes = this.files.get(name); if (bytes == null) continue;
      const hash = digest(bytes); hashes.set(name, hash);
      const saved = this._savedEntries.get(name);
      const reuse = saved?.hash === hash;
      // 새로 압축하는 배열은 스냅샷으로 분리한다. generateAsync 도중 원본이 바뀌어도
      // 저장 결과와 다음 저장의 비교 해시가 서로 어긋나지 않는다.
      zip.file(name, reuse ? new Uint8Array(0) : Uint8Array.from(bytes), { compression: compression(name, bytes), date: zipDate() });
      if (reuse) {
        // ZipObject를 유지해야 JSZip이 원래 압축 스트림/CRC를 재사용한다.
        // file()은 빈 자리와 상위 폴더를 먼저 만들고, 공개 files에서 entry를 교체한다.
        saved.entry.date = zipDate();
        saved.entry.options.compression = compression(name, bytes);
        zip.files[name] = saved.entry;
      }
    }
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    // 변경 파일도 이후 저장에서는 재압축하지 않는다. 여기서는 ZIP 목록만 읽고 압축을 풀지 않는다.
    const savedZip = await JSZip.loadAsync(Uint8Array.from(output));
    const savedEntries = new Map();
    for (const [name, hash] of hashes) savedEntries.set(name, { hash, entry: savedZip.files[name] });
    this._savedEntries = savedEntries;
    return output;
  }
}
