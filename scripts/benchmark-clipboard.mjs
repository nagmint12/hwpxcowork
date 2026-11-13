// [hwpx-cowork] Reproducible local WASM clipboard measurements; no user data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { initSync, HwpDocument } from '../vendor/rhwp/pkg/rhwp.js';
import { portableClipboardHtml } from '../vendor/rhwp/rhwp-studio/src/engine/portable-clipboard.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fs.readFileSync(new URL('../testdata/매크로테스트용_저장.hwpx', import.meta.url));
const wasmBytes = fs.readFileSync(new URL('../vendor/rhwp/pkg/rhwp_bg.wasm', import.meta.url));
const out = path.join(root, 'artifacts', 'format-brush-2026-10-28');
const round = n => Math.round(n * 100) / 100;
const stats = samples => {
  const sorted = [...samples].sort((a,b) => a-b);
  return { medianMs: round(sorted[Math.floor(sorted.length / 2)]), maxMs: round(sorted.at(-1)) };
};
const chosen = process.argv.indexOf('--case');
if (chosen >= 0) {
  const name = process.argv[chosen + 1];
  const t = performance.now();
  const engine = initSync({ module: wasmBytes });
  const initMs = performance.now() - t;
  const source = new HwpDocument(fixture);
  const base = { linearMemoryMiB: engine.memory.buffer.byteLength / 1048576, rssMiB: process.memoryUsage().rss / 1048576 };
  const copy = [], html = [], paste = [];
  let payload, peakLinear = base.linearMemoryMiB, peakRss = base.rssMiB;
  let htmlBytes;
  for (let i = 0; i < 7; i++) {
    const d = new HwpDocument(fixture);
    let t = performance.now();
    if (name === 'format') payload = source.exportFormatBrush(0,0,'[]',1);
    else {
      if (name === 'text') source.copySelection(0,0,0,0,33);
      if (name === 'table') source.copyControl(0,5,'',0);
      if (name === 'picture') source.copyControl(0,7,'',0);
      if (name === 'document') {
        const last = source.getParagraphCount(0)-1;
        source.copySelection(0,0,0,last,source.getParagraphLength(0,last));
      }
      payload = source.exportClipboardHwpx();
    }
    copy.push(performance.now()-t);
    t = performance.now();
    const content = portableClipboardHtml('<p>benchmark</p>','bench',payload);
    htmlBytes = Buffer.byteLength(content);
    html.push(performance.now()-t);
    t = performance.now();
    if (name === 'format') d.applyFormatBrush(JSON.stringify([{sec:0,para:3,path:[],start:0,end:3}]),payload,'both');
    else d.pasteDocumentFragment(0,3,'[]',0,payload);
    paste.push(performance.now()-t);
    peakLinear = Math.max(peakLinear,engine.memory.buffer.byteLength/1048576);
    peakRss = Math.max(peakRss,process.memoryUsage().rss/1048576);
    d.free();
  }
  source.free();
  console.log(JSON.stringify({ name, samples:7, wasmInitMs:round(initMs), payloadBytes:payload.length,
    htmlBytes, copy:stats(copy), htmlEncoding:stats(html), paste:stats(paste),
    wasmLinearBaseMiB:round(base.linearMemoryMiB), wasmLinearPeakMiB:round(peakLinear),
    rssBaseMiB:round(base.rssMiB), rssPeakMiB:round(peakRss),
    note:'Node engine-only process. Memory includes 2 loaded documents, WASM, JS and repeated runs; not a browser tab total.' }));
} else {
  fs.mkdirSync(out,{recursive:true});
  const cases = ['text','table','picture','document','format'].map(name => {
    const r = spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--case',name],{cwd:root,encoding:'utf8'});
    if(r.status!==0) throw new Error(r.stderr || r.stdout);
    return JSON.parse(r.stdout.trim());
  });
  const result = { measuredAt:new Date().toISOString(), node:process.version, cpu:os.cpus()[0].model,
    logicalCpus:os.cpus().length, physicalMemoryGiB:round(os.totalmem()/1073741824), fixtureBytes:fixture.length,
    wasmBytes:wasmBytes.length, wasmGzipBytes:gzipSync(wasmBytes).length,cases };
  fs.writeFileSync(path.join(out,'benchmark.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
