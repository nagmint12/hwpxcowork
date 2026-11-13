import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {HwpxDoc} from '../engine/doc.js';import {startServer,uploadDoc} from './helpers/server.mjs';
test('메모가 든 표를 붙여넣어 저장하면 개체 가져오기와 메모 복원이 같은 메모를 두 번 넣지 않는다',async()=>{
 const s=await startServer();
 try{
  const blank=fs.readFileSync('server/templates/blank.hwpx'),source=fs.readFileSync('tests/fixtures/codes_hangul_cells.hwpx'),head=await HwpxDoc.load(source),expected=head.memos();assert.equal(expected.length,1);
  const doc=await uploadDoc(s.base,s.tokens.a,blank,'memo-table-copy.hwpx'),headers={Authorization:'Bearer '+s.tokens.a,'Content-Type':'application/octet-stream'};
  for(const seq of [1,2]){
   const response=await fetch(s.base+'/api/docs/'+doc.id+'/live?base=1&seq='+seq,{method:'PUT',headers,body:source});assert.equal(response.status,200);const result=await response.json();assert.equal(result.unsupported,0);
   const file=await fetch(s.base+'/api/docs/'+doc.id+'/file?kind=working',{headers}),saved=await HwpxDoc.load(new Uint8Array(await file.arrayBuffer()));
   assert.equal(saved.memos().length,1,'동일한 메모는 한 번만 저장한다');assert.equal(saved.memos()[0].text,expected[0].text);
  }
 }finally{await s.stop();}
});
