// HWP face names often identify a full face, whereas CSS selects a family/style.
// Resolve an exact full/PostScript name through local(), without font enumeration,
// permissions, file uploads, or registration of a substitute under the original name.
import installed from './installed-local-faces.json';
const normalize = (name: string): string => name.normalize('NFC').replace(/\s/g, '').toLowerCase();
const sources = new Map<string, readonly string[]>();
type LocalVariant = { weight: string; style: string; names: readonly string[] };
const variants = new Map<string, readonly LocalVariant[]>();
for (const prefix of ['KoPubWorld', 'KoPub']) {
  for (const [korean, english] of [['바탕체', 'Batang'], ['돋움체', 'Dotum']]) {
    for (const style of ['Light', 'Medium', 'Bold']) {
      const names = [`${prefix}${english} ${style}`, `${prefix}${english}${style}`, `${prefix}${korean} ${style}`];
      for (const alias of [...names, `${prefix} ${english} ${style}`, `${prefix}-${english}-${style}`]) {
        sources.set(normalize(alias), names);
      }
    }
  }
}
for (const [korean, english, style] of [
  ['나눔바른고딕', 'NanumBarunGothic', ''],
  ['나눔바른고딕 Bold', 'NanumBarunGothicBold', 'Bold'],
  ['나눔바른고딕 Light', 'NanumBarunGothicLight', 'Light'],
]) {
  const names = [english, korean, style ? `NanumBarunGothic ${style}` : 'NanumBarunGothic Regular'];
  for (const name of names) sources.set(normalize(name), names);
}
// These full-face names occur in pasted HWP documents and can be installed
// without passing the generic family-width detector. Load the exact local face
// before declaring them unavailable; never substitute a font under these names.
for (const name of ['HY센스L', '한컴 쿨재즈 L']) {
  sources.set(normalize(name), [name]);
}
// [hwpx-cowork] 2026-11-06 dot audit: DirectWrite can discard HY's style
// suffix in CSS family matching. local(full/PostScript name) binds the actual
// installed face, so a nearby family/default font cannot replace its period.
for (const names of [
  ['HY얕은샘물M', 'HYShortSamul-Medium', 'H2sa1M'],
  ['HY엽서L', 'HYPost-Light', 'H2porL'],
  ['HY엽서M', 'HYPost-Medium', 'H2porM'],
  ['맑은 고딕 Semilight', 'Malgun Gothic Semilight', 'MalgunGothic-Semilight'],
]) {
  for (const name of names) sources.set(normalize(name), names);
}

const exactRequired = new Set(sources.keys());
// [hwpx-cowork] Generated from the same SFNT file/index inventory as the Rust
// metrics. A successful local() load proves availability on this client only;
// the catalog itself does not assert that a user's machine has the file.
for (const entry of installed.faces) {
  const regular = entry.variants.find(v => v.weight === '400' && v.style === 'normal');
  if (!regular) continue;
  for (const name of entry.aliases) {
    const key = normalize(name);
    if (sources.has(key)) continue; // preserve previously calibrated exact faces
    sources.set(key, regular.names);
    variants.set(key, entry.variants);
  }
}

const loaded = new Set<string>();
const pending = new Map<string, Promise<boolean>>();
const quote = (name: string): string => `"${name.replace(/["\\]/g, '\\$&')}"`;
let documentFontNames: string[] = [];

export function setDocumentFontNames(names: readonly string[]): void {
  documentFontNames = [...new Set(names)];
}

export function getDocumentFontNames(): string[] {
  return [...documentFontNames];
}

export function exactLocalFaceNames(name: string): readonly string[] {
  return [...(sources.get(normalize(name)) ?? [])];
}

export function isExactLocalFaceName(name: string): boolean {
  // These calibrated names must never be "confirmed" by width heuristics.
  return exactRequired.has(normalize(name));
}

// [hwpx-cowork] 2026-11-10: rhwp 0.9.0 은 로드가 끝난 local() 프로그램을 registerLoadedLocalFontFace 로 등록해야
// 표시 정책(installedFaceName → hasLoadedLocalFontFamily)이 원본 face 로 인정한다. 0.9 빌드는 그 함수를 registerFace 로 넘긴다.
// 사용자가 감지 결과를 초기화하면(clearLoadedLocalFontFaces) 등록이 풀리므로, 다음 호출에서 다시 등록한다.
const loadedFaces = new Map<string, FontFace[]>();
type RegisterLoadedFace = (face: FontFace) => void;
const faceRegistered = (face: FontFace): boolean =>
  typeof document.fonts.has !== 'function' || document.fonts.has(face);

/** Returns only names backed by a successfully loaded exact local FontFace. */
export async function loadExactLocalFaces(requested: readonly string[], registerFace?: RegisterLoadedFace): Promise<string[]> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return [];
  const add: RegisterLoadedFace = registerFace ?? (face => { document.fonts.add(face); });
  const names = [...new Set(requested)].filter(name => sources.has(normalize(name)));
  const result: string[] = [];
  // At most four local font reads at a time, matching the existing webfont loader.
  for (let offset = 0; offset < names.length; offset += 4) {
    await Promise.all(names.slice(offset, offset + 4).map(async name => {
      if (loaded.has(name)) {
        for (const face of loadedFaces.get(name) ?? []) if (!faceRegistered(face)) add(face);
        result.push(name);
        return;
      }
      let attempt = pending.get(name);
      if (!attempt) {
        attempt = (async () => {
          try {
            const key = normalize(name);
            const entries = variants.get(key) ?? [{ weight: '400', style: 'normal', names: sources.get(key)! }];
            const faces: FontFace[] = [];
            for (let index = 0; index < entries.length; index++) {
              const entry = entries[index];
              const source = entry.names.map(value => `local(${quote(value)})`).join(', ');
              const face = new FontFace(name, source, { weight: entry.weight, style: entry.style });
              try {
                await face.load();
                add(face);
                faces.push(face);
              } catch (error) {
                if (index === 0) throw error; // the requested face must be real
                // Missing style siblings can still use browser synthesis.
              }
            }
            loadedFaces.set(name, faces);
            loaded.add(name);
            return true;
          } catch {
            // Missing/blocked local sources stay unavailable; a later call may retry.
            return false;
          }
        })().finally(() => pending.delete(name));
        pending.set(name, attempt);
      }
      if (await attempt) result.push(name);
    }));
  }
  return result;
}
