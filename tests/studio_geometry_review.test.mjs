import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../studio/plugin/geometry.ts', import.meta.url), 'utf8'), { mode: 'transform' })
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '').replace(/^export /gm, '');
const { Geometry } = vm.runInNewContext(`${source}\n; ({ Geometry });`, { virtualScrollOf() { throw new Error('Must not move editor'); } });
const plain = v => JSON.parse(JSON.stringify(v));
const image = (controlIdx, extra = {}) => ({ type:'image',secIdx:1,paraIdx:53,controlIdx,x:10,y:20,w:500,h:200,...extra });
function fixture(pages) {
  return new Geometry(() => ({ wasm: { pageCount:pages.length,getPageControlLayout:page=>({controls:pages[page]}) } }));
}

test('그림은 같은 본문 문단의 실제 개체 영역을 읽고 다른 구역·셀·주석·머리말의 그림은 섞지 않는다', () => {
  const g=fixture([[image(2),image(5,{x:40}),image(0,{secIdx:0}),image(0,{paraIdx:52}),image(0,{cellIdx:0}),image(0,{noteRef:{kind:'footnote'}}),image(0,{headerFooter:{kind:'header'}}),image(0,{outerTableControlIdx:1})]]);
  assert.deepEqual(plain(g.objectRects({sec:1,para:53},'image',0)),[{pageIndex:0,x:10,y:20,width:500,height:200}]);
  assert.deepEqual(plain(g.objectRects({sec:1,para:53},'image',1)),[{pageIndex:0,x:40,y:20,width:500,height:200}]);
});

test('여러 쪽으로 나뉜 같은 표의 영역을 보존하고 그림 영역과 구분한다', () => {
  const g=fixture([[image(0),image(3,{type:'table',w:560,h:120})],[image(3,{type:'table',y:80,w:560,h:200})]]);
  assert.deepEqual(plain(g.objectRects({sec:1,para:53},'table',0)),[{pageIndex:0,x:10,y:20,width:560,height:120},{pageIndex:1,x:10,y:80,width:560,height:200}]);
});

test('없어진 개체·잘못된 순번·미지원 중첩 개체는 다른 그림으로 대체하지 않는다', () => {
  const g=fixture([[image(0)]]);
  for(const index of [-1,0.5,NaN,1]) assert.deepEqual(plain(g.objectRects({sec:1,para:53},'image',index)),[]);
  assert.deepEqual(plain(g.objectRects({sec:1,para:52},'image',0)),[]);
  assert.deepEqual(plain(g.objectRects({sec:1,para:53,cell:{ci:0}},'image',0)),[]);
});
