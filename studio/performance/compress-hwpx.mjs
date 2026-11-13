import JSZip from 'jszip';

const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;
const sameBytes = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// JSZip 3 exposes compressed entries through _data. Feature-check this optional
// optimization: an incompatible JSZip build simply takes the normal compressor.
function reusableData(entry) {
  const data = entry?._data;
  return data?.compression?.magic === '\x08\x00'
    && data.compressedContent instanceof Uint8Array
    && typeof data.getCompressedWorker === 'function' ? data : null;
}
function retainData(data) {
  // Detach subarrays from their original ZIP. Otherwise a tiny retained entry
  // could keep a much larger package alive outside the cache's memory budget.
  return Object.assign(Object.create(Object.getPrototypeOf(data)), data, {
    compressedContent: data.compressedContent.slice(),
  });
}
async function readHwpx(snapshot) {
  const source = await JSZip.loadAsync(snapshot, { createFolders: false });
  const mime = source.file('mimetype');
  if (!mime || await mime.async('string') !== 'application/hwp+zip') {
    throw new Error('HWPX mimetype이 올바르지 않습니다');
  }
  return source;
}

/** One document's bounded cache. Equality always checks the complete raw bytes;
 * ZIP CRC/size alone cannot establish that an entry is unchanged. */
export class HwpxCompressionCache {
  constructor({ maxBytes = DEFAULT_CACHE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('잘못된 압축 캐시 크기');
    this.maxBytes = maxBytes;
    this.clear();
  }
  clear() { this.entries = new Map(); this.bytes = 0; this.lastRun = null; }
  get stats() { return { entries: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes }; }
  async prime(snapshot) {
    this.clear();
    const source = await readHwpx(snapshot);
    const entries = new Map(); let bytes = 0;
    for (const [name, entry] of Object.entries(source.files)) {
      const data = reusableData(entry);
      if (entry.dir || !data || data.uncompressedSize + data.compressedSize > this.maxBytes - bytes) continue;
      const raw = await entry.async('uint8array');
      const compressed = retainData(data);
      entries.set(name, { raw, compressed });
      bytes += raw.byteLength + compressed.compressedContent.byteLength;
    }
    this.entries = entries; this.bytes = bytes;
  }
}

// The engine produces the exact same package parts as its regular exporter.
// Only ZIP compression runs here, on the worker thread. Never regenerate XML.
/** @param {Uint8Array} snapshot @param {HwpxCompressionCache | null} cache */
export async function compressHwpx(snapshot, cache = null) {
  const source = await readHwpx(snapshot);
  const zip = new JSZip();
  const date = new Date(1980, 0, 1, 0, 0, 0);
  const candidates = new Map(); let candidateBytes = 0;
  let reusedEntries = 0; let compressedEntries = 0;
  zip.file('mimetype', 'application/hwp+zip', { date, compression: 'STORE', createFolders: false });
  for (const [name, entry] of Object.entries(source.files)) {
    if (name === 'mimetype') continue;
    const raw = await entry.async('uint8array');
    const previous = cache?.entries.get(name);
    const reusable = !entry.dir && previous && sameBytes(previous.raw, raw);
    const data = reusable ? previous.compressed : raw;
    if (!entry.dir) { if (reusable) reusedEntries++; else compressedEntries++; }
    zip.file(name, data, {
      date, dir: entry.dir, createFolders: false, compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    // Prefer unchanged cached arrays; do not retain a second large copy of an
    // image just compared. Reserve raw bytes now and enforce the exact budget
    // with compressed sizes once generation succeeds.
    if (cache && !entry.dir && raw.byteLength <= cache.maxBytes - candidateBytes) {
      candidates.set(name, reusable ? previous : { raw });
      candidateBytes += raw.byteLength;
    }
  }
  const result = await zip.generateAsync({ type: 'uint8array', platform: 'UNIX', streamFiles: false });
  if (cache) {
    const generated = await JSZip.loadAsync(result, { createFolders: false });
    const retained = new Map(); let bytes = 0;
    for (const [name, candidate] of candidates) {
      const data = candidate.compressed || reusableData(generated.files[name]);
      const size = data ? candidate.raw.byteLength + data.compressedContent.byteLength : 0;
      if (!data || size > cache.maxBytes - bytes) continue;
      retained.set(name, candidate.compressed ? candidate : { raw: candidate.raw, compressed: retainData(data) });
      bytes += size;
    }
    cache.entries = retained; cache.bytes = bytes;
    cache.lastRun = { reusedEntries, compressedEntries };
  }
  return result;
}
