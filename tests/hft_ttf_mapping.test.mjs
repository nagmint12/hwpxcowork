// User's 2026-11-07 contract: placement metadata may ship; extracted outlines may not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const data=JSON.parse(fs.readFileSync('vendor/rhwp/src/renderer/hft_ttf_data.json','utf8'));
test('HFT source slots map to natural TTF families and a separate metric identity',()=>{
  const row=data.bindings.find(b=>b.lang===5&&b.names.includes('한양중고딕'));
  assert.equal(row.ttf,'HY중고딕');assert(row.programs[0].startsWith('HFTMETRIC:SPJGT.HFT:'));
  assert(data.bindings.find(b=>b.lang===5&&b.names.includes('한양신명조')).ttf.includes('신명조'));
  assert(!data.bindings.some(b=>b.ttf.startsWith('Cowork HFT')));
});
test('middle-dot correspondence is limited to explicit HFT source programs',()=>{
  const targets=data.programs.flatMap(p=>p.differences.filter(r=>r[2]===0xb7).map(r=>({p,r})));
  assert(targets.length>0);
  for(const {p,r} of targets){assert.equal(r[0],0x2024);assert.equal(p.lang,5);}
  assert(!data.bindings.some(b=>b.names.includes('HY중고딕')),'ordinary TTF must not acquire an HFT-only rewrite');
});
test('only differing metric values ship; no outlines or font loading code',()=>{
  for(const p of data.programs)for(const r of p.differences)assert(r.slice(1).some(v=>v!==null&&v!==0));
  assert(!/path_native|curveTo|charStrings|data:font|fonts\/hft\//.test(JSON.stringify(data)));
  const patches=fs.readFileSync('studio/build/font-patches.mjs','utf8');
  assert(!/NATIVE_HFT_FONTS|nativeHftTargets|nativeHftCanvasKitPlan|native-hft\.ts/.test(patches));
  assert(!fs.existsSync('vendor/rhwp/assets/fonts/hft'));
});
test('audited source upward double-stroke arrow selects upward TTF scalar',()=>{
  const p=data.programs.find(p=>p.file==='SPMJ.HFT'&&p.lang===5);
  assert(p);assert.equal(p.differences.find(r=>r[0]===0x21df)[2],0x21de);
});
