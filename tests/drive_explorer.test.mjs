import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compile} from '@vue/compiler-dom';
import {driveRows,driveTree,folderKey,canImportDriveFile,importSpaceTargets} from '../web/drive-explorer-model.js';

test('탐색기: 폴더 먼저 정렬·현재 목록 검색·원본 보존',()=>{
  const items=[{id:'a',name:'나.hwpx',type:'file'},{id:'b',name:'가.pdf',type:'file'},{id:'c',name:'폴더',type:'folder'}];
  assert.deepEqual(driveRows(items).map(f=>f.id),['c','b','a']);
  assert.deepEqual(driveRows(items,'HWPX').map(f=>f.id),['a']);
  assert.deepEqual(driveRows(items,'',true).map(f=>f.id),['c','a','b']);
  assert.deepEqual(items.map(f=>f.id),['a','b','c']);
  assert.equal(canImportDriveFile(items[0]),true);assert.equal(canImportDriveFile(items[1]),false);
  assert.equal(canImportDriveFile({name:'가.hwpx',type:'folder'}),false);
});
test('폴더 나무는 이미 방문한 프로젝트 경로만 사용한다',()=>{
  const cache=new Map([
    [folderKey('dooray','personal','root'),{provider:'dooray',projectId:'personal',path:[{id:'root',name:'개인 프로젝트'}],folders:[{id:'a',name:'자료'}]}],
    [folderKey('dooray','personal','a'),{provider:'dooray',projectId:'personal',path:[{id:'root',name:'개인 프로젝트'},{id:'a',name:'자료'}],folders:[{id:'b',name:'회의'}]}],
    ['other',{provider:'dooray',projectId:'real',path:[{id:'root',name:'실사용'}],folders:[{id:'secret',name:'접근 금지'}]}],
  ]);
  const rows=driveTree(cache,'dooray','personal','개인 프로젝트');
  assert.deepEqual(rows.map(r=>[r.id,r.depth]),[['root',0],['a',1],['b',2]]);
  assert.deepEqual(rows[2].path.map(f=>f.name),['개인 프로젝트','자료','회의']);
});
test('가져오기 위치는 내 개인 문서함·작성 가능한 공용 문서함으로 구분한다',()=>{
  const targets=[{location:{space:'private',owner:'나'}},{location:{space:'private',owner:'다른 사람'}},{location:{space:'public'}}];
  assert.deepEqual(importSpaceTargets(targets,'private',{name:'나'}),[targets[0]]);
  assert.deepEqual(importSpaceTargets(targets,'public',{name:'나'}),[targets[2]]);
});
test('탐색기와 문서함 Vue 템플릿 컴파일',()=>{
  for(const [path,marker] of [['web/drive-explorer.js','template:`'],['web/app.js','template: `<div class="listpage">']]){
    const source=fs.readFileSync(path,'utf8'),start=source.indexOf(marker);assert.ok(start>=0);
    const open=source.indexOf('`',start),end=source.indexOf('`,',open+1);
    compile(source.slice(open+1,end));
  }
});
