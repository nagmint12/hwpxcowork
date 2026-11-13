// 기존 기능 시험을 동일 입력으로 고정한 후보 WASM에 실행한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
const engine = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
globalThis.measureTextWidth ??= (_font, text) => String(text).length * 10;
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) {
  engine.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });
  globalThis.__rhwpEngineReady.add(pkgDir);
}
export const { HwpDocument, hwpxToHwpJson } = engine;
export default engine;
