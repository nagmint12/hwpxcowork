import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {HwpxDoc} from '../engine/doc.js';
import {scan,attrs} from '../engine/xmlscan.js';
import {startServer,uploadDoc} from './helpers/server.mjs';

const blank=fs.readFileSync('server/templates/blank.hwpx');
const plain=doc=>doc.sections[0].bodyParas.map(p=>doc.text(p.ref,'final'));
const add=(doc,at,text)=>{const ref=doc.insertParagraphAfter(0,at,text,{author:'fixture'});doc.acceptAll();return ref;};
const put=async(s,id,body,base=1,seq=1)=>{
 const r=await fetch(`${s.base}/api/docs/${id}/live?base=${base}&seq=${seq}`,{method:'PUT',headers:{Authorization:`Bearer ${s.tokens.a}`,'Content-Type':'application/octet-stream'},body});
 assert.equal(r.status,200,await r.clone().text());return r.json();
};
const saved=async(s,id)=>HwpxDoc.load(await s.api('a')(`/api/docs/${id}/file?kind=working`));
const tableGeometry=(doc,key)=>{
 const {sec,t}=doc._tableTarget(key);const xml=sec.xml.slice(t.start,t.end);
 const geometry=new Set(['hp:tbl','hp:tr','hp:tc','hp:sz','hp:pos','hp:outMargin','hp:inMargin','hp:caption','hp:cellAddr','hp:cellSpan','hp:cellSz','hp:cellMargin','hp:cellzone','hp:subList']);
 const identity=new Set(['id','instid','linkListIDRef','linkListNextIDRef']);
 return scan(xml).filter(token=>geometry.has(token.name)&&['open','selfclose'].includes(token.type)).map(token=>[
  token.name,[...attrs(xml,token)].filter(([name])=>!identity.has(name)).map(([name,value])=>{
   if(name==='borderFillIDRef'){
    const definition=doc.header.block('borderFill',value);assert.ok(definition,`테두리·배경 정의 ${value}`);
    return [name,definition.replace(/\sid="[^"]*"/,'')];
   }
   return [name,value];
  }).sort(([a],[b])=>a.localeCompare(b)),
 ]);
};

test('최종본 같은 틈 200문단은 순서·인라인 문자·뒤 문단을 보존하고 구역을 한 번만 해석한다',async()=>{
 const doc=await HwpxDoc.load(blank);add(doc,0,'끝 문단');
 const seq=doc.sections[0].loadSeq;const header=doc.header.xml;
 const texts=Array.from({length:200},(_,i)=>i===3?'한글\t탭\n다음 줄 & < > 😀':`문단 ${i}`);
 const refs=doc.insertFinalParagraphsAfter(0,0,texts);
 assert.equal(doc.sections[0].loadSeq,seq+1);
 assert.deepEqual(plain(doc),['',...texts,'끝 문단']);
 assert.deepEqual(refs,texts.map((_,i)=>`s0/p${i+1}`));
 assert.equal(doc.changes().length,0);assert.equal(doc.header.xml,header);
 const round=await HwpxDoc.load(await doc.save());assert.deepEqual(plain(round),plain(doc));
 const xml=doc.sections[0].xml;
 assert.throws(()=>doc.insertFinalParagraphsAfter(0,-1,['불가']));
 assert.equal(doc.sections[0].xml,xml);
});

test('같은 틈에 글·표·그림 문단을 섞어 붙여넣어도 본문·서식·개체가 보존되고 재전송이 중복되지 않는다',async()=>{
 const s=await startServer();
 try{
  const doc=await uploadDoc(s.base,s.tokens.a,blank,'bulk-mixed.hwpx');
  const head=await HwpxDoc.load(blank);add(head,0,'앞 문장');
  head.insertTableAfter(0,1,{rows:[['머리','수치'],['첫째','17.5%'],['둘째','한국어']],headerRows:1,caption:'검증 표'},{author:'fixture'});head.acceptAll();
  add(head,2,'표 뒤 문장');add(head,3,'마지막 문장');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8e8AAAAASUVORK5CYII=','base64');
  head.insertPictureAfter(0,3,{data:png,caption:'검증 그림'},{author:'fixture'});head.acceptAll();
  head.formatRange('s0/p1',{start:0,end:Array.from(head.text('s0/p1')).length,char:{bold:true,sizePt:14},paragraph:{align:'CENTER'}});
  const body=await head.save();const first=await put(s,doc.id,body);
  const actual=await saved(s,doc.id);
  assert.deepEqual(plain(actual),plain(head));
  const expectedParagraphs=head.paragraphs({nested:true,view:'final'});
  const actualParagraphs=actual.paragraphs({nested:true,view:'final'});
  assert.deepEqual(actualParagraphs.map(p=>[p.ref,p.text]),expectedParagraphs.map(p=>[p.ref,p.text]),'본문·표 칸·캡션의 모든 글');
  const tableOwners=new Set(head.tables().map(table=>table.ref));
  for(const paragraph of expectedParagraphs){
   assert.equal(actual.formattingFingerprint(paragraph.ref),head.formattingFingerprint(paragraph.ref),`${paragraph.ref} 글자·문단 서식`);
   if(!tableOwners.has(paragraph.ref))assert.equal(actual.objectPrint(paragraph.ref),head.objectPrint(paragraph.ref),`${paragraph.ref} 그림·조판 부호`);
  }
  assert.deepEqual(actual.tables(),head.tables(),'표 칸 주소·합침·머리행·캡션');
  // 기존 import도 borderFill 번호를 다시 매긴다. objectPrint의 원시 번호 대신 정의 내용을 비교한다.
  // 실제 63쪽 원본의 빈 문단 두 곳에서 발생하던 서식 clean=false와는 별개의 기존 현상이다.
  for(const table of head.tables())assert.deepEqual(tableGeometry(actual,table.key),tableGeometry(head,table.key),'표 크기·배치·여백·칸 크기·테두리·배경');
  const tracked=await HwpxDoc.load(await s.api('a')(`/api/docs/${doc.id}/file?kind=tracked`));
  assert.equal(tracked.header.trackingEnabled(),true,'기존 삽입→수락 경로의 추적 설정 유지');
  assert.equal(tracked.header.authors().filter(author=>author.name===s.users.a.name&&author.mark===1).length,1,'삽입 작성자 유지');
  assert.equal(actual.tables().length,1);assert.equal(actual.changes().length,0);
  assert.equal(actual.figures().length,1);
  const pic=actual.figures()[0];
  assert.deepEqual(Buffer.from(actual.binaryItem(pic.binId).bytes),png);
  const second=await put(s,doc.id,body,1,2);assert.equal(second.version,first.version);assert.equal(second.applied.inserted.length,0);
 }finally{await s.stop();}
});

test('두 삽입 틈의 문단 순서를 유지하고 기존 뒤 문단의 메모 주소를 옮긴다',async()=>{
 const s=await startServer();
 try{
  const base=await HwpxDoc.load(blank);add(base,0,'중간 기준');add(base,1,'끝 기준');
  const uploaded=await uploadDoc(s.base,s.tokens.a,await base.save(),'bulk-gaps.hwpx');const api=s.api('a');
  await api(`/api/docs/${uploaded.id}/memos`,{method:'POST',body:{ref:'s0/p2',text:'기존 메모'}});
  const info=await api(`/api/docs/${uploaded.id}`);const head=await saved(s,uploaded.id);
  add(head,1,'중간 뒤 첫째');add(head,2,'중간 뒤 둘째');
  add(head,0,'맨 앞 뒤 첫째');add(head,1,'맨 앞 뒤 둘째');
  await put(s,uploaded.id,await head.save(),info.version);
  const actual=await saved(s,uploaded.id);
  assert.deepEqual(plain(actual),['','맨 앞 뒤 첫째','맨 앞 뒤 둘째','중간 기준','중간 뒤 첫째','중간 뒤 둘째','끝 기준']);
  assert.equal(actual.memos().filter(m=>m.text==='기존 메모').length,1);
  assert.equal(actual.memos().find(m=>m.text==='기존 메모').ref,'s0/p6');
 }finally{await s.stop();}
});

test('변경 추적 문서의 복수 문단 삽입은 추적 경로를 유지한다',async()=>{
 const s=await startServer();
 try{
  const uploaded=await uploadDoc(s.base,s.tokens.a,blank,'bulk-tracked.hwpx');
  await s.api('a')(`/api/docs/${uploaded.id}/settings`,{method:'PATCH',body:{track:'tracked'}});
  const head=await HwpxDoc.load(blank);add(head,0,'새 문단 하나');add(head,1,'새 문단 둘');
  await put(s,uploaded.id,await head.save());
  const actual=await HwpxDoc.load(await s.api('a')(`/api/docs/${uploaded.id}/file?kind=tracked`));
  assert.deepEqual(plain(actual),plain(head));assert.ok(actual.changes().some(c=>c.type==='Insert'));
 }finally{await s.stop();}
});

test('삽입 묶음 앞뒤 삭제가 섞여도 남긴 문단의 메모·대기 제안 주소를 보존한다',async()=>{
 const s=await startServer();
 try{
  const base=await HwpxDoc.load(blank);
  for(const text of ['앞에서 지울 문단','삽입 기준','뒤에서 지울 문단','보존할 마지막 문단']) add(base,base.sections[0].bodyParas.length-1,text);
  const uploaded=await uploadDoc(s.base,s.tokens.a,await base.save(),'bulk-remove.hwpx');
  const api=s.api('a'),url=`/api/docs/${uploaded.id}`;
  await api(`${url}/memos`,{method:'POST',body:{ref:'s0/p4',text:'남겨야 할 메모'}});
  const proposal=await api(`${url}/proposals`,{method:'POST',body:{ref:'s0/p4',find:'보존할',replace:'유지할',reason:'문단 주소 확인'}});
  const info=await api(url),head=await saved(s,uploaded.id);
  head.removeBodyParagraph(0,3);head.removeBodyParagraph(0,1);
  add(head,1,'삽입 하나');add(head,2,'삽입 둘');add(head,3,'삽입 셋');
  await put(s,uploaded.id,await head.save(),info.version);
  const actual=await saved(s,uploaded.id);
  assert.deepEqual(plain(actual),['','삽입 기준','삽입 하나','삽입 둘','삽입 셋','보존할 마지막 문단']);
  assert.equal(actual.memos().find(m=>m.text==='남겨야 할 메모').ref,'s0/p5');
  const proposals=await api(`${url}/proposals`);
  const kept=proposals.find(p=>p.pid===proposal.pid);
  assert.equal(kept.ref,'s0/p5');assert.equal(kept.status,'pending');assert.ok(!kept.lost);
 }finally{await s.stop();}
});
