import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {desktopCliPackages,desktopAiSupport} from '../deploy/desktop/cli-versions.mjs';
import {machoTargets,auditMacBinaries} from '../scripts/macos-binary-audit.mjs';
test('Monterey does not expose CLI versions lacking required isolation flags',()=>{
  for(const release of ['21.2.0','21.6.0','']){
    assert.equal(desktopAiSupport('darwin',release).available,false);
    assert.equal(desktopAiSupport('darwin',release).minimumMacos,'13.0');
  }
  assert.equal(desktopAiSupport('darwin','22.1.0').available,true);
  assert.equal(desktopAiSupport('win32','21.2.0').available,true);
  assert.deepEqual(desktopCliPackages(),{codex:'@openai/codex@0.169.0','claude-code':'@anthropic-ai/claude-code@2.1.323'});
});
test('Mac binary gate checks actual load command rather than app label',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-macos-gate-'));
  const macho=min=>{const b=Buffer.alloc(56);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(0x100000c,4);b.writeUInt32LE(1,16);b.writeUInt32LE(24,20);b.writeUInt32LE(0x32,32);b.writeUInt32LE(24,36);b.writeUInt32LE(1,40);b.writeUInt32LE(min,44);return b;};
  try{
    assert.deepEqual(machoTargets(macho(0x0c0000)),[{arch:'arm64',minimumMacos:'12.0.0'}]);
    fs.writeFileSync(path.join(directory,'app'),macho(0x0c0100));
    assert.equal(auditMacBinaries(directory,{arch:'arm64'}).binaries.length,1);
    fs.writeFileSync(path.join(directory,'nested.dylib'),macho(0x0d0000));
    assert.throws(()=>auditMacBinaries(directory,{arch:'arm64'}),/requires 13\.0\.0/);
    assert.throws(()=>auditMacBinaries(directory,{arch:'x64'}),/Missing target architecture/);
  }finally{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});
