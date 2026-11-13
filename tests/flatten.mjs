import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
const [inp, out] = process.argv.slice(2);
const d = await HwpxDoc.load(fs.readFileSync(inp));
const f = await d.flattened();
fs.writeFileSync(out, await f.save());
console.log('flattened →', out, 'changes', f.changes().length, 'memos', f.memos().length);
