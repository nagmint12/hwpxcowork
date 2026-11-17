import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import {assertFontDistributionEntry,assertFontDistributionZip} from '../scripts/rhwp-original-font-policy.mjs';
test('original rhwp font and embedded equation subset are allowed; modified font is blocked',()=>{
  const name='vendor/rhwp/assets/fonts/LatinModernMath-VariableOutline-subset.otf',font=fs.readFileSync(name);
  assert.doesNotThrow(()=>assertFontDistributionEntry(name,font));
  assert.doesNotThrow(()=>assertFontDistributionEntry('rhwp_bg.wasm',Buffer.concat([Buffer.from('wasm:'),font])));
  const changed=Buffer.from(font);changed[changed.length-1]^=1;
  assert.throws(()=>assertFontDistributionEntry('renamed.otf',changed),/Font asset has no approved distribution fingerprint/);
  assert.throws(()=>assertFontDistributionEntry('rhwp_bg.wasm',Buffer.concat([Buffer.from('wasm:'),changed])),/Embedded font differs/);
});
test('an approved later font cannot hide an earlier modified font of a different format',()=>{
  const otf=fs.readFileSync('vendor/rhwp/assets/fonts/LatinModernMath-VariableOutline-subset.otf');
  const ttf=fs.readFileSync('vendor/rhwp/assets/fonts/NotoSansSymbols2-Regular.ttf');
  const changed=Buffer.from(otf);changed[changed.length-1]^=1;
  assert.throws(()=>assertFontDistributionEntry('rhwp_bg.wasm',Buffer.concat([Buffer.from('wasm:'),changed,ttf])),/Embedded font differs/);
  assert.doesNotThrow(()=>assertFontDistributionEntry('rhwp_bg.wasm',Buffer.concat([Buffer.from('wasm:'),otf,ttf])));
});
test('nested downloads keep original fonts and reject additions',async()=>{
  const font=fs.readFileSync('vendor/rhwp/assets/fonts/NotoSansKR-Regular.woff2'),inner=new JSZip();inner.file('fonts/renamed.woff2',font);
  const outer=new JSZip();outer.file('nested.zip',await inner.generateAsync({type:'nodebuffer'}));
  assert.equal((await assertFontDistributionZip(await outer.generateAsync({type:'nodebuffer'}))).entries,2);
  inner.file('fonts/additional.woff2',Buffer.from('not an original font'));
  outer.file('nested.zip',await inner.generateAsync({type:'nodebuffer'}));
  await assert.rejects(assertFontDistributionZip(await outer.generateAsync({type:'nodebuffer'})));
});
test('official Electron embedded fonts remain scoped to its framework, not new font assets',()=>{
  const data=JSON.parse(fs.readFileSync('scripts/rhwp-approved-runtime-fonts.json','utf8'));
  assert(data.embeddedFonts.every(f=>f.component==='electron'));
  assert(data.officialExecutables.every(e=>e.component==='claude-code'&&e.file==='claude.exe'));
  const font=fs.readFileSync('vendor/rhwp/assets/fonts/LatinModernMath-VariableOutline-subset.otf');
  const bad=Buffer.from(font);bad[bad.length-1]^=1;
  assert.throws(()=>assertFontDistributionEntry('app/Contents/Frameworks/Electron Framework',bad));
});
