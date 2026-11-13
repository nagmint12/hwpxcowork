import test from'node:test';import assert from'node:assert/strict';import crypto from'node:crypto';import fs from'node:fs';
import {createFontDistributionGuard,assertFontDistributionZip,assertFontDistributionBundle,assertFontDistributionTree}from'../scripts/font-distribution-policy.mjs';
import os from'node:os';import path from'node:path';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('source files are blocked by path, renamed fingerprint, and embedded/base64 bytes',()=>{
 const source=Buffer.from('synthetic offline font database fixture'),check=createFontDistributionGuard({excluded:[{bytes:source.length,sha256:hash(source)}],sourceBytes:[source]});
 for(const name of ['FontDB/fontinfo.dat','renamed.bin'])assert.throws(()=>check(name,source));
 for(const body of [Buffer.concat([Buffer.from('header'),source]),Buffer.from(source.toString('base64'))])assert.throws(()=>check('assets/embedded.js',body));
 assert.doesNotThrow(()=>check('assets/routing.json',Buffer.from('{"format":"cowork.font-routing","schema":2}')));
});
test('font bytes require an approved fingerprint regardless of extension/name reuse',()=>{
 const approved=Buffer.from('synthetic permitted font'),check=createFontDistributionGuard({approved:[{sha256:hash(approved)}]});
 assert.doesNotThrow(()=>check('fonts/allowed.woff2',approved));
 assert.throws(()=>check('fonts/allowed.woff2',Buffer.from('unreviewed replacement')));
 assert.throws(()=>check('fonts/hft/allowed.woff2',approved));
});
test('unused source-catalogue rows cannot be reintroduced inside a WASM or ZIP',async()=>{
 const {default:JSZip}=await import('jszip'),bad=Buffer.from('wasm...{"schema":1,"primary":{"version":2022,"defaults":[]}}');
 const check=createFontDistributionGuard();assert.throws(()=>check('assets/rhwp_bg.wasm',bad));
 const zip=new JSZip();zip.file('assets/rhwp_bg.wasm',bad);await assert.rejects(assertFontDistributionZip(await zip.generateAsync({type:'nodebuffer'})));
 const nested=new JSZip();nested.file('payload.zip',await zip.generateAsync({type:'nodebuffer'}));await assert.rejects(assertFontDistributionZip(await nested.generateAsync({type:'nodebuffer'})));
 const packed=await nested.generateAsync({type:'nodebuffer'});await assert.rejects(assertFontDistributionBundle('renamed.bin',packed));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'font-distribution-'));try{fs.writeFileSync(path.join(dir,'renamed.bin'),packed);await assert.rejects(assertFontDistributionTree(dir));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('source container members are independently fingerprinted',()=>{
 const policy=JSON.parse(fs.readFileSync('scripts/font-distribution-policy.json','utf8'));
 assert.equal(policy.excludedFingerprints.filter(r=>r.source?.startsWith('FontDB/FslFonts.dat!')).length,482);
});
test('current generated routing contains only consumed fields and HFT uses font-level metrics',()=>{
 const d=JSON.parse(fs.readFileSync('vendor/rhwp/src/renderer/hancom_fontdb_data.json','utf8'));
 assert.equal(d.format,'cowork.font-routing');assert.equal(d.schema,2);
 assert.deepEqual(Object.keys(d.primaryRouting).sort(),['defaultChains','hftSlotNames','missingGlyphRoutes'].sort());
 for(const row of d.primaryRouting.hftSlotNames)assert.deepEqual(Object.keys(row).sort(),['names','slot']);
 assert(!/"(?:line|fields|private|representatives|sources|localNames|fileSha256)":/.test(JSON.stringify(d)));
 const h=JSON.parse(fs.readFileSync('vendor/rhwp/src/renderer/hft_ttf_data.json','utf8'));assert.equal(h.schema,2);
 for(const p of h.programs){for(const r of p.differences)assert.equal(r.length,3);assert(!p.inkBounds&&!p.boldGeometry);if(p.metrics)assert.equal(p.metrics.length,2);}
});
