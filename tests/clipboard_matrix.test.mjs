import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import {HwpDocument} from './helpers/rhwp.mjs';
import {HwpxDoc} from '../engine/doc.js';
const blank=fs.readFileSync(new URL('../vendor/rhwp/saved/blank2010.hwp',import.meta.url));
const fixture=n=>fs.readFileSync(new URL('./fixtures/'+n,import.meta.url));
const xml=async bytes=>{
 const z=await JSZip.loadAsync(bytes);
 return (await Promise.all(Object.keys(z.files).filter(n=>/^Contents\/section\d+\.xml$/.test(n))
  .sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).map(n=>z.file(n).async('string')))).join('\n');
};
// The fork's legacy spelling and 0.9's canonical spelling denote one control.
const count=(s,tag)=>(s.match(new RegExp(`<hp:${['hypen','hyphen'].includes(tag)?'(?:hypen|hyphen)':tag}\\b`,'g'))||[]).length;
function copy(doc){
 const sec=doc.getSectionCount()-1,para=doc.getParagraphCount(sec)-1;
 doc.copySelectionAcross(0,0,0,sec,para,doc.getParagraphLength(sec,para));
 return JSON.parse(/<!--\[data-hwpjson\]([\s\S]*?)-->/.exec(doc.exportClipboardHancomHtml())[1]);
}
async function roundtrip(bytes,inspect){
 const src=new HwpDocument(bytes),dst=new HwpDocument(blank);
 try{
  const model=copy(src);
  assert.equal(JSON.parse(dst.pasteHwpJsonFragment(0,0,'[]',0,JSON.stringify(model))).ok,true);
  await inspect(await xml(dst.exportHwpx()),await xml(src.exportClipboardHwpx()),model,dst);
 }finally{src.free();dst.free();}
}

test('한글 문서모델: 책갈피·각주·머리말·꼬리말·수식·일반 필드를 함께 붙인다',async()=>{
 await roundtrip(fixture('codes_hangul_all.hwpx'),(after,before)=>{
  for(const tag of ['tbl','pic','rect','line','equation','header','footer','footNote','bookmark','pageHiding']){
   assert.equal(count(after,tag),count(before,tag),tag);
  }
  assert.match(after,/type="CLICK_HERE"/);
  assert.ok(after.includes('type="SUMMERY"'));
  const script=s=>[...s.matchAll(/<hp:script>([\s\S]*?)<\/hp:script>/g)].map(m=>m[1]);
  assert.deepEqual(script(after),script(before));
  assert.match(after,/<hp:fieldEnd beginIDRef="\d+"/);
 });
});

test('한글 문서모델: 표 칸의 책갈피와 메모 범위를 함께 보존한다',async()=>{
 await roundtrip(fixture('codes_hangul_cells.hwpx'),(after,before)=>{
  for(const tag of ['tbl','tc','bookmark','fieldBegin','fieldEnd','autoNum'])assert.equal(count(after,tag),count(before,tag),tag);
  const name=s=>[...s.matchAll(/<hp:bookmark[^>]*name="([^"]*)"/g)].map(m=>m[1]);
  assert.deepEqual(name(after),name(before));
 });
});

test('한글 문서모델: 선·타원·다각형을 빈 그림으로 바꾸지 않고 좌표와 글상자를 보존한다',async()=>{
 await roundtrip(fixture('shapes_hangul.hwpx'),(after,before,model)=>{
  const types={line:611084654,polygon:611348332,ellipse:610626668,rect:611476835,arc:610366051};
  for(const [kind,ci]of Object.entries(types)){
   const records=[];const visit=rc=>{records.push(rc);for(const child of rc.co||[])visit(child);};
   for(const c of Object.values(model.cs))if(c.rc)visit(c.rc);
   const expected=records.filter(rc=>rc.ci===ci).length;
   assert.ok(expected>0,kind+' fixture');
   assert.equal(count(after,kind),expected,kind);
  }
  assert.equal(count(after,'pic'),0);
  for(const kind of ['connectLine','curve','container'])assert.equal(count(after,kind),count(before,kind),kind);
  assert.ok(after.includes('<hc:endPt x="9000" y="3000"'));
  assert.ok(after.includes('<hc:center x="5000" y="3000"'));
  const texts=s=>[...s.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map(m=>m[1]).filter(Boolean);
  for(const text of texts(before))assert.ok(texts(after).includes(text),'글상자/본문: '+text);
 });
});

test('한글 문서모델: 탭·줄바꿈·묶음/고정폭 공백·하이픈을 보존한다',async()=>{
 const z=await JSZip.loadAsync(fixture('hangul_trk_brk_base.hwpx'));
 const section=await z.file('Contents/section0.xml').async('string');
 z.file('Contents/section0.xml',section.replace(/<hp:t>[^<]*<\/hp:t>/,
  // Keep the legacy input spelling so both engines are exercised; 0.9 #7993
  // canonicalizes it to Hancom's `hypen` without losing the control.
  '<hp:t>A<hp:tab width="4000" leader="3" type="2"/>B<hp:lineBreak/>C<hp:nbSpace/>D<hp:fwSpace/>E<hp:hyphen/>F</hp:t>'));
 await roundtrip(await z.generateAsync({type:'uint8array'}),(after,before)=>{
  for(const tag of ['tab','lineBreak','nbSpace','fwSpace','hypen']){
   assert.equal(count(before,tag),1,tag+' source element is retained');
   assert.equal(count(after,tag),1,tag+' is retained after model paste');
  }
  assert.deepEqual(after.match(/<hp:tab[^>]*\/>/g),before.match(/<hp:tab[^>]*\/>/g));
 });
 z.file('Contents/section0.xml',section.replace(/<hp:t>[^<]*<\/hp:t>/,
  '<hp:t>L\u00A0M\u00ADN\u2007O</hp:t>'));
 await roundtrip(await z.generateAsync({type:'uint8array'}),(after,before)=>{
  for(const text of [after,before]){
   assert.equal(count(text,'nbSpace'),0,'literal nonbreaking space keeps its representation');
   assert.equal(count(text,'hyphen'),0,'literal soft hyphen keeps its representation');
   assert.equal(count(text,'fwSpace'),0,'literal figure space keeps its representation');
   assert.ok(text.includes('L\u00A0M\u00ADN\u2007O'),'literal characters remain in text');
  }
 });
 // Occupied destination and a supplementary scalar exercise actual insertion,
 // partial selection, character-vs-UTF16 offsets, and both clipboard carriers.
 const withText=async text=>{
  const zip=await JSZip.loadAsync(fixture('hangul_trk_brk_base.hwpx'));
  zip.file('Contents/section0.xml',section.replace(/<hp:t>[^<]*<\/hp:t>/,'<hp:t>'+text+'</hp:t>'));
  return zip.generateAsync({type:'uint8array'});
 };
 const mixed='S\u00A0A<hp:nbSpace/>B\u00ADC<hp:hyphen/>D\u2007E<hp:fwSpace/>F';
 const src=new HwpDocument(await withText(mixed));
 try{
  src.copySelection(0,0,1,0,src.getParagraphLength(0,0)-1);
  const model=JSON.parse(/<!--\[data-hwpjson\]([\s\S]*?)-->/.exec(src.exportClipboardHancomHtml())[1]);
  for(const kind of ['native','json']){
   const dst=new HwpDocument(await withText('L\u00A0\u00AD\u2007😀R'));
   try{
    const before=dst.saveSnapshot();
    if(kind==='native')dst.pasteDocumentFragment(0,0,'[]',5,src.exportClipboardHwpx());
    else dst.pasteHwpJsonFragment(0,0,'[]',5,JSON.stringify(model));
    const check=async bytes=>{
     const result=await xml(bytes);
     for(const tag of ['nbSpace','hypen','fwSpace'])assert.equal(count(result,tag),1,kind+' mixed '+tag);
     for(const c of ['\u00A0','\u00AD','\u2007'])assert.equal([...result].filter(x=>x===c).length,2,kind+' literal '+c.codePointAt(0));
     assert.equal([...result].filter(x=>x==='😀').length,1,'supplementary scalar stays intact');
    };
    await check(dst.exportHwpx());
    const after=dst.saveSnapshot();dst.restoreSnapshot(before);
    assert.equal(count(await xml(dst.exportHwpx()),'nbSpace'),0,'snapshot undo restores literal target');
    dst.restoreSnapshot(after);await check(dst.exportHwpx());
    const binary=new HwpDocument(dst.exportHwp());
    try{await check(binary.exportHwpx());}finally{binary.free();}
    // Insert and delete before the copied controls must shift their origins.
    dst.insertText(0,0,0,'앞😀');dst.deleteText(0,0,0,2);await check(dst.exportHwpx());
   }finally{dst.free();}
  }
 }finally{src.free();}
});

test('한글 문서모델: 알 수 없는 도형은 원문을 바꾸지 않고 거절한다',async()=>{
 const src=new HwpDocument(fixture('shapes_hangul.hwpx')),dst=new HwpDocument(blank);
 try{
  const model=copy(src);Object.values(model.cs).find(c=>c.rc).rc.ci=1;
  const before=await xml(dst.exportHwpx());
  assert.throws(()=>dst.pasteHwpJsonFragment(0,0,'[]',0,JSON.stringify(model)),/지원하지 않는.*도형/);
  assert.equal(await xml(dst.exportHwpx()),before);
 }finally{src.free();dst.free();}
});

test('부분 복사: 가운데 탭의 폭·채움·종류를 앞뒤 대상 탭과 섞지 않는다',async()=>{
 async function withText(text){
  const z=await JSZip.loadAsync(fixture('hangul_trk_brk_base.hwpx'));
  const s=await z.file('Contents/section0.xml').async('string');
  z.file('Contents/section0.xml',s.replace(/<hp:t>[^<]*<\/hp:t>/,'<hp:t>'+text+'</hp:t>'));
  return z.generateAsync({type:'uint8array'});
 }
 const src=new HwpDocument(await withText('A<hp:tab width="1000" leader="1" type="1"/>B<hp:tab width="2000" leader="3" type="2"/>C'));
 const destination=await withText('L<hp:tab width="3000" leader="2" type="1"/>R<hp:tab width="4000" leader="4" type="2"/>Z');
 try{
  src.copySelection(0,0,2,0,5);
  const model=JSON.parse(/<!--\[data-hwpjson\]([\s\S]*?)-->/.exec(src.exportClipboardHancomHtml())[1]);
  for(const kind of ['native','json']){
   const dst=new HwpDocument(destination);
   try{
    if(kind==='native')dst.pasteDocumentFragment(0,0,'[]',2,src.exportClipboardHwpx());
    else dst.pasteHwpJsonFragment(0,0,'[]',2,JSON.stringify(model));
    const result=await xml(dst.exportHwpx());
    assert.deepEqual([...result.matchAll(/<hp:tab width="(\d+)" leader="(\d+)" type="(\d+)"/g)].map(m=>m.slice(1)),
     [['3000','2','1'],['2000','3','2'],['4000','4','2']],kind);
   }finally{dst.free();}
  }
 }finally{src.free();}
});

test('수식 캡션: 다른 문서로 붙여도 원래 문단 서식을 참조한다',async()=>{
 await roundtrip(fixture('toc_source.hwpx'),async(after,before,model,dst)=>{
  const doc=await HwpxDoc.load(dst.exportHwpx());
  const p=doc.paragraphs().find(p=>p.text==='수식  수식 캡션 나');
  assert.ok(p);
  const fmt=doc.inspectFormatting(p.ref).paragraph;
  assert.deepEqual(fmt.lineSpacing,{type:'PERCENT',value:150});
  assert.equal(fmt.spaceAfterPt,8);
  assert.equal(fmt.leftMarginPt,0);
 });
});
