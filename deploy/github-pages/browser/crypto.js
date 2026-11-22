import { Buffer } from 'buffer/';
import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
export function createHash(algorithm) {
  const hash = { sha1, sha256, sha512 }[algorithm]?.create();
  if (!hash) throw new Error('Unsupported digest ' + algorithm);
  return {
    update(value, encoding) { hash.update(typeof value === 'string' ? Buffer.from(value, encoding) : value); return this; },
    digest(encoding) { const bytes = Buffer.from(hash.digest()); return encoding ? bytes.toString(encoding) : bytes; },
  };
}
export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = length => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(length)));
export default { createHash, randomBytes, randomUUID };
