// [hwpx-cowork] Independent Hancom 2022 PDF controls. No font binary is in
// the fixture; source fractions and PDF hash are recorded in oracle.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const fixture = 'tests/fixtures/fonts/b7-hft-ttf';
const oracle = JSON.parse(fs.readFileSync(`${fixture}/oracle.json`, 'utf8'));
const input = fs.readFileSync(`${fixture}/input.hwpx`);
assert.equal(crypto.createHash('sha256').update(input).digest('hex'), oracle.inputSha256);
const pkg = path.resolve(process.env.RHWP_PKG || 'vendor/rhwp/pkg');
const wasm = fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm'));
const wasmSha256 = crypto.createHash('sha256').update(wasm).digest('hex');
const m = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
m.initSync({ module: wasm });
globalThis.measureTextWidth = () => { throw Error('Host/browser measurement is outside this test'); };

// Hancom's already calibrated 4-HWPUNIT grid; constants come from source
// font widths (.384, 1, 341/1024), not from the engine being tested.
function advanceHu(c) {
  const s = Math.floor(c.sizePt * 100 / 4);
  return 4 * Math.floor(c.expectedEm * s * c.ratio / 100 + (c.ratio === 100 ? .5 : 0) + 1e-7);
}

test('HFT diagnostic neutral slots restart at a line boundary', async () => {
  // A diagnostic counterexample for projected single-glyph runs. The
  // language algorithm is line-based, so dots after this explicit break
  // belong to the following Korean run, not the preceding Latin run.
  const zip = await JSZip.loadAsync(input);
  const xml = await zip.file('Contents/section0.xml').async('string');
  assert.ok(xml.includes(`<hp:t>${oracle.text}</hp:t>`));
  zip.file('Contents/section0.xml', xml.replace(`<hp:t>${oracle.text}</hp:t>`, '<hp:t>A·B<hp:lineBreak/>···가</hp:t>'));
  const d = new m.HwpDocument(await zip.generateAsync({ type: 'uint8array' }));
  try {
    d.convertToEditable();
    const trace = JSON.parse(d.getFontDecisionTrace(0, '{"maxCharacters":4096}'));
    const dots = trace.records.filter(r => r.source.paragraphIndex === 0 && r.source.character === '·');
    assert.deepEqual(dots.map(r => r.document.languageSlot), [1, 0, 0, 0]);
  } finally { d.free(); }
});
function runs(tree) {
  const out = [];
  function visit(v) {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'textRun') out.push(v);
    for (const x of Object.values(v)) if (x && typeof x === 'object') visit(x);
  }
  visit(tree);
  return out;
}

for (const editable of [false, true]) {
  test(`B7 HFT, TTF, explicit substitute: 16 Hancom controls (${editable ? 'editable' : 'stored'})`, () => {
    const d = new m.HwpDocument(input);
    try {
      if (editable) d.convertToEditable();
      assert.equal(d.pageCount(), 1);
      const tree = JSON.parse(d.getPageLayerTreeWithProfile(0, 'screen'));
      const glyphs = runs(tree).flatMap(run => run.clusters.filter(cl => run.text.slice(cl.textRangeUtf16.start, cl.textRangeUtf16.end) === '·')
        .map(cl => ({ para: Number(/\/para:(\d+)\//.exec(run.source.stableSourceKey)[1]), dx: cl.advance.dx })));
      for (const c of oracle.cases) {
        const dots = glyphs.filter(g => g.para === c.paragraphIndex);
        assert.equal(dots.length, 5, c.id);
        for (const dot of dots) assert.ok(Math.abs(dot.dx * 75 - advanceHu(c)) < .001, `${c.id}: ${dot.dx * 75} vs ${advanceHu(c)} HU`);
        for (const dot of c.pdfDots) assert.ok(Math.abs(dot.advanceEm - c.expectedEm) < .000002, `${c.id}: independent PDF width`);
      }
    } finally { d.free(); }
  });
  test(`HFT font decision trace agrees with layout and retains honest provenance (${editable ? 'editable' : 'stored'})`, () => {
    const d = new m.HwpDocument(input);
    try {
      if (editable) d.convertToEditable();
      const trace = JSON.parse(d.getFontDecisionTrace(0, '{"maxCharacters":4096}'));
      assert.equal(trace.status, 'complete');
      const dots = trace.records.filter(r => r.source.character === '·');
      assert.equal(dots.length, 80);
      for (const c of oracle.cases) {
        const row = dots.filter(r => r.source.paragraphIndex === c.paragraphIndex);
        assert.equal(row.length, 5, c.id);
        for (const r of row) assert.ok(Math.abs(r.layoutMetric.finalAdvanceHwpunit - advanceHu(c)) < .001, `${c.id}: trace vs layout`);
        if (c.type === 'HFT') {
          assert.deepEqual(row.map(r => r.document.languageSlot), [0, 1, 1, 1, 1], c.id);
          for (const r of row) {
            // Source FontDB: inherited Korean slot is HGSMJ (no B7),
            // but the explicit punctuation metric slot is ENSMJ, 384/1000.
            assert.equal(r.layoutMetric.requestedFace, 'HFTMETRIC:ENSMJ.HFT:HY신명조:1:0');
            if (r.document.languageSlot === 0) {
              const step = r.layoutMetric.transforms.find(s => s.kind === 'latinPunctuationMetricSlot');
              assert.equal(step.input, 'HFTMETRIC:HGSMJ.HFT:HY신명조:0:0');
              assert.equal(step.output, r.layoutMetric.requestedFace);
            }
            assert.equal(r.layoutMetric.aliasResolvedFace, r.layoutMetric.requestedFace);
            const p = r.provenance.find(p => p.sourceOwner === 'hwpx-cowork-hft-ttf');
            assert.ok(p, c.id);
            assert.equal(p.ruleId ?? null, null);
            assert.equal(p.evidenceStatus ?? null, null);
          }
        }
      }
    } finally { d.free(); }
    console.log(JSON.stringify({ wasmSha256, oraclePdf: oracle.pdfSha256 }));
  });
}
