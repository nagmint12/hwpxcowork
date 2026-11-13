import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { projectTextFormats } from '../engine/format-projection.js';

const source=stripTypeScriptTypes(fs.readFileSync(new URL('../studio/plugin/controller.ts',import.meta.url),'utf8'),{mode:'transform'})
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm,'').replace(/^export /gm,'');
const cpSlice=(v,s,e)=>[...v].slice(s,e).join('');const cpLen=v=>[...v].length;
const {CoworkController}=vm.runInNewContext(`${source}\n;({CoworkController});`,{console,projectTextFormats,cpSlice,cpLen,
  jsonCopy:v=>JSON.parse(JSON.stringify(v)),requireCharShapeRunsDocument:d=>d,parseCharShapeRuns:v=>JSON.parse(v),
  internals:{placeCaret(){}},safe:(_label,fn)=>fn()});

function fixture(body,cell=null){
  const events=[];const runs=len=>JSON.stringify([{startOffset:0,endOffset:len,charShapeId:0}]);
  const doc={getParagraphLength:(_s,p)=>cpLen(body[p]),getTextRange:(_s,p,s,e)=>cpSlice(body[p],s,e),getCharShapeRuns:(_s,_p,_a,n)=>runs(n),setCharShapeRuns(){},
    replaceText(_s,p,s,n,text){events.push({op:'text',p,text});body[p]=cpSlice(body[p],0,s)+text+cpSlice(body[p],s+n);},
    splitParagraph(_s,p,offset){events.push({op:'split',p});body.splice(p,1,cpSlice(body[p],0,offset),cpSlice(body[p],offset));},
    insertText(_s,p,offset,text){events.push({op:'insert',p,text});body[p]=cpSlice(body[p],0,offset)+text+cpSlice(body[p],offset);},
    getCellParagraphLength:(_s,_p,_ci,_c,cp)=>cpLen(cell[cp]),getTextInCell:(_s,_p,_ci,_c,cp,s,e)=>cpSlice(cell[cp],s,e),
    getCharShapeRunsInCellByPath:(_s,_p,_path,_s0,n)=>runs(n),setCharShapeRunsInCellByPath(){},
    deleteTextInCell(_s,_p,_ci,_c,cp,s,n){cell[cp]=cpSlice(cell[cp],0,s)+cpSlice(cell[cp],s+n);},
    insertTextInCell(_s,_p,_ci,_c,cp,s,text){events.push({op:'cellText',cp,text});cell[cp]=cpSlice(cell[cp],0,s)+text+cpSlice(cell[cp],s);},
    splitParagraphInCellByPath(_s,_p,path,offset){const cp=JSON.parse(path)[0].cellParaIndex;cell.splice(cp,1,cpSlice(cell[cp],0,offset),cpSlice(cell[cp],offset));},
    insertTextInCellByPath(_s,_p,path,offset,text){const cp=JSON.parse(path)[0].cellParaIndex;cell[cp]=cpSlice(cell[cp],0,offset)+text+cpSlice(cell[cp],offset);},
  };
  const c=Object.create(CoworkController.prototype);c.geo={toPosition:p=>p};c.align={invalidate(){}};c.host={transaction(_label,fn){fn({deferPagination(){},doc:()=>doc});}};
  return{events,commit:edits=>c.commit('test',edits,{},true,true)};
}
const text=(para,s,e,value,cell)=>({op:'text',cur:{sec:0,para,...(cell?{cell}:{})},s,e,text:value});
const insert=(para,lines,len,count,cell,objectOnly=false)=>({op:'insert',cur:{sec:0,para,...(cell?{cell}:{})},lines,len,count,objectOnly});

test('편집기 배치는 첫 입력부터 실제로 실행하고 뒤 글의 오프셋을 보정한다',()=>{
  const body=['앞 뒤'];const f=fixture(body);const out=f.commit([text(0,0,1,'앞앞'),text(0,2,3,'나중')]);
  assert.equal(out.ok,true);assert.deepEqual(f.events.filter(e=>e.op==='text').map(e=>e.text),['앞앞','나중']);assert.deepEqual(body,['앞앞 나중']);
});
test('편집기 FIFO 문단 삽입은 같은 자리의 등록 순서와 뒤 원문 주소를 보존한다',()=>{
  const body=['원문','뒤원문'];const f=fixture(body);
  const out=f.commit([insert(0,['첫추가'],2,2),text(0,0,2,'긴 원문'),insert(0,['둘추가','계속'],2,2),text(1,0,3,'뒷변경')]);
  assert.equal(out.ok,true);assert.deepEqual(body,['긴 원문','첫추가','둘추가','계속','뒷변경']);
  assert.deepEqual(f.events.filter(e=>e.op==='text').map(e=>e.text),['긴 원문','뒷변경']);
});
test('편집기 FIFO는 표 칸의 문단 번호와 바뀐 길이도 보정한다',()=>{
  const cell=['앞 뒤','원래다음'];const body=[''];const f=fixture(body,cell);const c={ci:0,cell:0,cpara:0};
  const out=f.commit([text(0,0,1,'앞앞',c),insert(0,['첫'],3,0,c),insert(0,['둘'],3,0,c),text(0,0,4,'마지막',{...c,cpara:1})]);
  assert.equal(out.ok,true);assert.deepEqual(cell,['앞앞 뒤','첫','둘','마지막']);
});
test('개체만 있는 문단 뒤 삽입도 입력 순서로 두고 원래 다음 문단을 수정한다',()=>{
  const body=['','뒤원문'];const f=fixture(body);
  const out=f.commit([insert(0,['첫'],0,2,null,true),insert(0,['둘'],0,2,null,true),text(1,0,3,'수정한뒤')]);
  assert.equal(out.ok,true);assert.deepEqual(body,['','첫','둘','수정한뒤']);
});
