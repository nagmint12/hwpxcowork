import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { PROGRESSIVE_OPEN_PATCHES } from '../studio/build/progressive-open-patches.mjs';
import { patchesForStudio } from '../studio/build/patches.mjs';

// [hwpx-cowork] 2026-11-10: 실제 빌드와 같이 원본의 판(Cargo.toml)으로 0.9 덮어쓰기 여부를 정한다
// (전에는 RHWP_STUDIO_SRC 를 줄 때만 0.9 로 보아, vendor 가 0.9.0 이 된 뒤 0.8.7 기준 글을 찾았다).
const studioSource = path.resolve(process.env.RHWP_STUDIO_SRC || fileURLToPath(new URL('../vendor/rhwp/rhwp-studio', import.meta.url)));
let source=fs.readFileSync(path.join(studioSource,'src/core/wasm-bridge.ts'),'utf8').replace(/\r\n/g,'\n');
const patches = patchesForStudio(studioSource, PROGRESSIVE_OPEN_PATCHES);
for(const patch of patches.filter(p=>p.file==='src/core/wasm-bridge.ts')) {
  assert.equal(source.split(patch.anchor).length-1,1,patch.id);
  source=source.replace(patch.anchor,()=>patch.replace(patch.anchor));
}
const names=['loadDocumentAtomically','loadDocument','loadDocumentProgressively','progressiveOpenState','stepProgressiveOpen',
  'flushProgressiveOpen','commitProgressiveOpen','rollbackProgressiveOpen','getDocumentInfo','releaseDocument',
  'createNewDocument','ensureParagraphStableIds','documentGeneration','pageCount'];
const methods=names.map(name=>{
  const match=new RegExp('\\n  (?:(?:private|async|get) )*'+name+'\\(').exec(source);
  assert.ok(match,name);
  const end=source.indexOf('\n  }',match.index)+5;
  assert.ok(end>match.index,name);
  return source.slice(match.index,end);
}).join('\n');
// Exercise the actual patched ownership methods with small deterministic WASM
// handles. Font measuring and stable-ID setup are outside this ownership contract.
const scaffold=`const HwpDocument=globalThis.__progressiveFakeDocument;
const blake3=bytes=>bytes;const bytesToHex=bytes=>Array.from(bytes).join('');
const userSettings={getPdfImportLayout:()=>undefined};
const createDocumentForBytes=(Constructor,bytes)=>new Constructor(bytes);
export class Bridge {
doc=null;_documentGeneration=0;coworkProgressivePrevious=null;_fileName='document.hwp';
_currentFileHandle=null;_requiresPasswordForSave=false;_documentDigest=null;releases=0;
_recoveryCipher=null;_pdfImport=null;
clearLayerResourceCache(){}setRecoveryCipher(value){this._recoveryCipher?.dispose();this._recoveryCipher=value;}
releaseCanvasFontResources(){this.releases++;}ensureParagraphStableIdsFor(doc){doc.stable=true;}
populateExternalImagesFromDevServer(){return Promise.resolve();}
${methods}
}`;
const compiled=stripTypeScriptTypes(scaffold,{mode:'transform'});

class Handle {
  static mode=null;
  static created=[];
  constructor(bytes) {this.id=bytes[0];this.freed=0;this.pending=false;this.pages=3;Handle.created.push(this);}
  static openProgressive(bytes) {const doc=new Handle(bytes);doc.pending=!['complete','fallback'].includes(Handle.mode);doc.pages=doc.pending?2:3;return doc;}
  convertToEditable() {if(Handle.mode==='convert')throw Error('conversion failed');}
  setFileName(name) {this.name=name;}
  pageCount() {if(this.pending&&Handle.mode==='count')throw Error('page count failed');return this.pages;}
  getDocumentInfo() {return JSON.stringify({pageCount:this.pageCount()});}
  progressiveOpenState() {return JSON.stringify({state:this.pending?'pending':'complete',pageCount:this.pages,processedParagraphs:2,totalParagraphs:20});}
  stepProgressiveOpen() {this.pending=false;this.pages=10;return this.progressiveOpenState();}
  flushProgressiveOpen() {return this.stepProgressiveOpen();}
  free() {assert.equal(this.freed,0,'handle must be freed exactly once');this.freed++;}
  createBlankDocument() {this.pending=false;this.pages=1;return JSON.stringify({pageCount:1});}
  exportHwp() {return new Uint8Array([this.id]);}
}
let serial=0;
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-progressive-bridge-'));
test.after(()=>{
  assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('hwpx-progressive-bridge-'));
  fs.rmSync(temporary,{recursive:true,force:true});
});
async function ready() {
  Handle.mode=null;Handle.created=[];globalThis.__progressiveFakeDocument=Handle;
  const generated=path.join(temporary,`bridge-${++serial}.mjs`);fs.writeFileSync(generated,compiled);
  const {Bridge}=await import(pathToFileURL(generated).href);
  delete globalThis.__progressiveFakeDocument;
  const bridge=new Bridge();bridge.loadDocument(new Uint8Array([1]),'original.hwpx');
  bridge._currentFileHandle={fixture:'original-handle'};bridge._requiresPasswordForSave=true;
  return bridge;
}

test('progressive open holds the old document until commit and commits exactly once',async()=>{
  const b=await ready(),old=b.doc;
  b.loadDocumentProgressively(new Uint8Array([2]),'next.hwpx');const next=b.doc;
  assert.equal(old.freed,0);assert.equal(next.freed,0);assert.notEqual(old,next);
  b.stepProgressiveOpen();assert.equal(b.commitProgressiveOpen(b.documentGeneration),true);
  assert.equal(old.freed,1);assert.equal(next.freed,0);assert.equal(b.coworkProgressivePrevious,null);
  assert.equal(b.commitProgressiveOpen(b.documentGeneration),false);
});

test('rollback restores the exact old handle and file metadata, with a fresh lease generation',async()=>{
  const b=await ready(),old=b.doc,handle=b._currentFileHandle,digest=b._documentDigest;
  b.loadDocumentProgressively(new Uint8Array([2]),'next.hwpx');const next=b.doc,generation=b.documentGeneration;
  assert.equal(b.rollbackProgressiveOpen(generation),true);
  assert.equal(b.doc,old);assert.equal(old.freed,0);assert.equal(next.freed,1);
  assert.equal(b._fileName,'original.hwpx');assert.equal(b._currentFileHandle,handle);
  assert.equal(b._requiresPasswordForSave,true);assert.equal(b._documentDigest,digest);
  assert.ok(b.documentGeneration>generation);
});

test('a newer open first drops the uneditable old preview and stale rollback cannot replace the newest document',async()=>{
  const b=await ready(),old=b.doc;
  b.loadDocumentProgressively(new Uint8Array([2]),'abandoned.hwpx');const partial=b.doc,generation=b.documentGeneration;
  b.loadDocument(new Uint8Array([3]),'newest.hwpx');const newest=b.doc;
  assert.equal(partial.freed,1);assert.equal(old.freed,1);assert.equal(newest.freed,0);
  assert.equal(b.rollbackProgressiveOpen(generation),false);assert.equal(b.doc,newest);
});

test('conversion failure and post-swap failure preserve the previous document without double-free',async()=>{
  for(const mode of ['convert','count']) {
    const b=await ready(),old=b.doc;
    Handle.mode=mode;
    assert.throws(()=>b.loadDocumentProgressively(new Uint8Array([2]),'invalid.hwpx'),/failed/);
    assert.equal(b.doc,old);assert.equal(old.freed,0);
    assert.equal(Handle.created.at(-1).freed,1);
    assert.equal(b._fileName,'original.hwpx');assert.equal(b.coworkProgressivePrevious,null);
  }
});

test('release and create-new clean up the held prior document',async()=>{
  const b=await ready(),old=b.doc;
  b.loadDocumentProgressively(new Uint8Array([2]),'pending.hwpx');const partial=b.doc;
  b.releaseDocument();assert.equal(old.freed,1);assert.equal(partial.freed,1);assert.equal(b.doc,null);
  const c=await ready(),old2=c.doc;
  c.loadDocumentProgressively(new Uint8Array([3]),'pending-new.hwpx');const partial2=c.doc;
  c.createNewDocument();assert.equal(old2.freed,1);assert.equal(partial2.freed,0);
  assert.equal(c.pageCount,1);assert.equal(c.coworkProgressivePrevious,null);
});

test('already complete short/multisection fallback opens commit the old document before later edits and opens',async()=>{
  const helperSource=fs.readFileSync(new URL('../studio/performance/progressive-open.ts',import.meta.url),'utf8');
  const helper=stripTypeScriptTypes(helperSource,{mode:'transform'});
  const helperFile=path.join(temporary,'coordinator.mjs');fs.writeFileSync(helperFile,helper);
  const {loadDocumentProgressively}=await import(pathToFileURL(helperFile).href);
  for(const mode of ['complete','fallback']) {
    const b=await ready(),old=b.doc;Handle.mode=mode;
    await loadDocumentProgressively(b,new Uint8Array([2]),'completed.hwpx',{
      preview:async()=>assert.fail('completed document has no preview phase'),progress:()=>assert.fail('completed document has no pending progress'),
    });
    assert.equal(old.freed,1);assert.equal(b.coworkProgressivePrevious,null);
    const edited=b.doc;edited.pages=12;
    b.loadDocument(new Uint8Array([3]),'later.hwpx');
    assert.equal(edited.freed,1);assert.equal(b.doc.id,3);assert.equal(old.freed,1);
  }
});
