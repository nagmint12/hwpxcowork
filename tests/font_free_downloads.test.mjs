import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import {assertFontDistributionEntry,assertFontDistributionZip,isFontAssetPath,embeddedFontOffset} from '../scripts/font-free-downloads.mjs';
test('downloads reject formerly approved font bytes, including renamed files',()=>{
  const font=fs.readFileSync('studio/dist/fonts/NotoSansSymbols2-Regular.ttf');
  assert.throws(()=>assertFontDistributionEntry('fonts/NotoSansSymbols2-Regular.ttf',font));
  assert.throws(()=>assertFontDistributionEntry('assets/renamed.bin',font),/Actual font binaries/);
  for(const signature of ['OTTO','ttcf','wOFF','wOF2'])assert.throws(()=>assertFontDistributionEntry('renamed.bin',Buffer.from(signature+'fixture')),/Actual font binaries/);
  for(const extension of ['ttf','otf','ttc','otc','woff','woff2','hft','eot','pfb','pfa','fnt','fon'])assert(isFontAssetPath('fonts/test.'+extension));
});
test('WASM data sections and other wrappers cannot embed complete font programs',async()=>{
  for(const file of ['studio/dist/fonts/LatinModernMath-VariableOutline-subset.otf','studio/dist/fonts/NotoSansSymbols2-Regular.ttf','studio/dist/fonts/NotoSansKR-Regular.woff2']){
    const font=fs.readFileSync(file),wrapped=Buffer.concat([Buffer.from('wasm-data:'),font,Buffer.from(':end')]);
    assert.equal(embeddedFontOffset(wrapped),10,file);
    assert.throws(()=>assertFontDistributionEntry('rhwp_bg.wasm',wrapped),/Embedded font binary/);
    const zip=new JSZip();zip.file('rhwp_bg.wasm',wrapped);
    await assert.rejects(assertFontDistributionZip(await zip.generateAsync({type:'nodebuffer'})),/Embedded font binary/);
  }
  assert.equal(embeddedFontOffset(Buffer.from('OTTO numeric matching scale 0.98 widths 400 500')),-1);
});
test('nested downloads reject font assets while allowing numeric matching and correction data',async()=>{
  const inner=new JSZip();inner.file('renamed.bin',Buffer.from('wOF2fixture'));
  const outer=new JSZip();outer.file('nested.hwpx',await inner.generateAsync({type:'nodebuffer'}));
  await assert.rejects(assertFontDistributionZip(await outer.generateAsync({type:'nodebuffer'})),/Actual font binaries/);
  const good=new JSZip();good.file('hft-matching.json',JSON.stringify({family:'HY중고딕',scale:0.98,baseline:0.01,widths:[400,500]}));
  assert.deepEqual(await assertFontDistributionZip(await good.generateAsync({type:'nodebuffer'})),{entries:1});
});
