import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {startServer,uploadDoc} from './helpers/server.mjs';import {HwpxDoc} from '../engine/doc.js';
import {initSync,HwpDocument} from '../vendor/rhwp/pkg/rhwp.js';
import {pasteWithParagraphFormat} from '../studio/build/native-paste.mjs';
initSync({module:fs.readFileSync('vendor/rhwp/pkg/rhwp_bg.wasm')});

test('HFT 대체 글꼴의 빈 binary 참조를 가진 WASM 붙여넣기가 실시간 저장·재전송된다',async()=>{
 const blank=fs.readFileSync('server/templates/blank.hwpx'),source=await HwpxDoc.load(blank);
 source.insertTracked('s0/p0',0,'복사한 글자 ·․•',{author:'시험'});source.acceptAll();
 source.formatRange('s0/p0',{start:0,end:Array.from(source.text('s0/p0')).length,char:{font:'한양견고딕',shadeColor:'#FF8000'}});
 source.header.xml=source.header.xml.replace(/<hh:font\b[^>]*face="한양견고딕"[^>]*>[\s\S]*?<\/hh:font>/g,xml=>xml.replace('type="TTF"','type="HFT"').replace('</hh:font>','<hh:substFont face="한컴바탕" type="TTF" isEmbedded="0"/></hh:font>'));
 const s=await startServer();
 try{
  for(const occupied of [false,true]){
   const w=new HwpDocument(blank);
   try{
    if(occupied)w.insertText(0,0,0,'기존 ');
    const meta=await uploadDoc(s.base,s.tokens.a,w.exportHwpx(),'paste.hwpx');
    assert.equal(JSON.parse(pasteWithParagraphFormat(w,HwpDocument,0,0,'[]',occupied?3:0,new Uint8Array(await source.save()))).ok,true);
    const bytes=w.exportHwpx(),head=await HwpxDoc.load(bytes);
    assert.match(head.header.xml,/<hh:substFont\b[^>]*isEmbedded="0"[^>]*binaryItemIDRef=""/);
    const headers={Authorization:'Bearer '+s.tokens.a,'Content-Type':'application/octet-stream'};
    let version;
    for(const seq of [351001,351002]){
     const r=await fetch(`${s.base}/api/docs/${meta.id}/live?base=1&loaded=1&seq=${seq}`,{method:'PUT',headers,body:bytes}),out=await r.json();
     assert.equal(r.status,200,JSON.stringify(out));assert.equal(out.clean,true);
     if(version)assert.equal(out.version,version);version=out.version;
    }
    const r=await fetch(`${s.base}/api/docs/${meta.id}/file?kind=working`,{headers}),saved=await HwpxDoc.load(new Uint8Array(await r.arrayBuffer()));
    assert.equal(saved.text('s0/p0'),(occupied?'기존 ':'')+source.text('s0/p0'));
    assert.equal(saved.formattingFingerprint('s0/p0'),head.formattingFingerprint('s0/p0'));
   }finally{w.free();}
  }
 }finally{await s.stop();}
});

test('실제 포함 글꼴·대체 글꼴의 자원 참조는 빈 참조와 구별해 계속 거절한다',async()=>{
 for(const substitute of ['isEmbedded="1" binaryItemIDRef=""','isEmbedded="0" binaryItemIDRef="font-real"','isEmbedded="true" binaryItemIDRef=""']){
  const source=await HwpxDoc.load(fs.readFileSync('server/templates/blank.hwpx'));
  source.header.xml=source.header.xml.replace(/<hh:font\b([^>]*)>[\s\S]*?<\/hh:font>/g,(all,a)=>`<hh:font${a}><hh:substFont face="포함 대체" type="TTF" ${substitute}/></hh:font>`);
  source.header.addItem('styles','style','<hh:style id="0" type="CHAR" name="포함 글꼴 시험" engName="EmbeddedGuard" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>');
  const target=await HwpxDoc.load(fs.readFileSync('server/templates/blank.hwpx')),before=target.header.xml;
  await assert.rejects(target.copyStyleDefinitionsFrom(source),e=>e.code==='FORMAT_UNSUPPORTED');assert.equal(target.header.xml,before);
 }
});
test('실시간 저장은 본문에서 참조하지 않은 새 스타일도 저장하고 재전송을 중복 반영하지 않는다',async()=>{
 const s=await startServer();
 try{
  const bytes=fs.readFileSync('server/templates/blank.hwpx'),doc=await uploadDoc(s.base,s.tokens.a,bytes,'styles.hwpx'),head=await HwpxDoc.load(bytes);
  head.header.addItem('styles','style','<hh:style id="0" type="CHAR" name="본문 미사용 복사 스타일" engName="UnusedClipboardStyle" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>');
  const body=await head.save(),headers={Authorization:'Bearer '+s.tokens.a,'Content-Type':'application/octet-stream'};
  const first=await fetch(s.base+'/api/docs/'+doc.id+'/live?base=1&seq=1',{method:'PUT',headers,body});assert.equal(first.status,200);const result=await first.json();assert.equal(result.version,2);assert.equal(result.formatVersion,2);
  const file=await fetch(s.base+'/api/docs/'+doc.id+'/file?kind=working',{headers}),saved=await HwpxDoc.load(new Uint8Array(await file.arrayBuffer()));
  assert.ok(saved.formattingCatalog().styles.some(s=>s.name==='본문 미사용 복사 스타일'));
  const second=await fetch(s.base+'/api/docs/'+doc.id+'/live?base=1&seq=2',{method:'PUT',headers,body});assert.equal(second.status,200);assert.equal((await second.json()).version,2);
 }finally{await s.stop();}
});

test('변경 요청 반영도 복사한 문자 스타일 정의를 본문과 함께 보존한다',async()=>{
 const s=await startServer();
 try{
  const bytes=fs.readFileSync('server/templates/blank.hwpx'),doc=await uploadDoc(s.base,s.tokens.a,bytes,'draft-styles.hwpx'),head=await HwpxDoc.load(bytes);
  head.insertTracked('s0/p0',0,'복사한 본문',{author:'붙여넣기 시험'});head.acceptAll();
  head.header.addItem('styles','style','<hh:style id="0" type="CHAR" name="수정본 전용 문자 스타일" engName="DraftOnlyStyle" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>');
  const headers={Authorization:'Bearer '+s.tokens.a,'Content-Type':'application/octet-stream'};
  const response=await fetch(s.base+'/api/docs/'+doc.id+'/drafts/mine?base=1',{method:'PUT',headers,body:await head.save()});assert.equal(response.status,200);const saved=await response.json();assert.ok(saved.cr?.cid);
  const merged=await fetch(s.base+'/api/docs/'+doc.id+'/change-requests/'+saved.cr.cid+'/merge',{method:'POST',headers});assert.equal(merged.status,200);
  const file=await fetch(s.base+'/api/docs/'+doc.id+'/file?kind=working',{headers}),result=await HwpxDoc.load(new Uint8Array(await file.arrayBuffer()));
  assert.ok(result.formattingCatalog().styles.some(s=>s.name==='수정본 전용 문자 스타일'));assert.equal(result.text('s0/p0','final'),'복사한 본문');
 }finally{await s.stop();}
});
