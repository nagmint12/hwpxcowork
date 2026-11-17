import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import express from 'express';
import { installReleaseDownloads } from '../server/release-downloads.js';
import { windowsSetupSettings, windowsSetupZip } from '../server/windows-setup.js';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('간편 설치 ZIP: 여섯 선택을 고정하고 공식 게시 파일의 크기·해시·주소를 담는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-setup-route-'));
  const dir = path.join(root, 'artifacts/release-20261114'); fs.mkdirSync(dir, { recursive: true });
  const data = Buffer.from('fixture program'), p = { target:'bundle', file:'hwpx-cowork-0.5.0-20261114.zip', topFolder:'hwpx-cowork-0.5.0', bytes:data.length, sha256:sha(data) };
  const manifest = { downloadBase:'https://example.test/download', packages:[p] };
  fs.writeFileSync(path.join(dir, p.file), data); fs.writeFileSync(path.join(dir,'release.json'), JSON.stringify(manifest));
  const app=express(); installReleaseDownloads(app,{root}); const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/download/windows-setup.zip`;
  try {
    for (const mode of ['personal','shared']) for (const ai of ['codex','claude-code','none']) {
      const response=await fetch(`${base}?mode=${mode}&ai=${ai}`); assert.equal(response.status,200);
      assert.match(response.headers.get('content-disposition'),new RegExp(`hwpx-setup-${mode}-${ai}\\.zip`));
      const zip=await JSZip.loadAsync(await response.arrayBuffer()), prefix=`hwpx-setup-${mode}-${ai}/`;
      const settings=JSON.parse(await zip.file(prefix+'install-settings.json').async('string'));
      assert.equal(settings.mode,mode); assert.equal(settings.ai,ai);
      assert.deepEqual(settings.bundle,{ url:`https://example.test/download/${p.file}`, bytes:p.bytes, sha256:p.sha256, topFolder:p.topFolder });
      assert.match(await zip.file(prefix+'설치 시작.bat').async('string'),/setup\.ps1/);
      const script=await zip.file(prefix+'setup.ps1').async('nodebuffer'); assert.deepEqual([...script.subarray(0,3)],[239,187,191]);
      assert.ok(!Object.keys(zip.files).some(name=>name.endsWith('/config.json')));
    }
    for(const query of ['mode=invalid','ai=openai','mode[]=personal','mode=personal&mode=shared']) assert.equal((await fetch(base+'?'+query)).status,400);
    fs.appendFileSync(path.join(dir,p.file),'bad'); assert.equal((await fetch(base)).status,503);
    fs.unlinkSync(path.join(dir,p.file)); const missing=await fetch(base); assert.equal(missing.status,503); assert.equal((await missing.json()).error,'SETUP_NOT_AVAILABLE');
    assert.throws(()=>windowsSetupSettings({...manifest,downloadBase:'http://other.test'},[p],'personal','none'),/BAD_SETUP_SOURCE/);
    assert.throws(()=>windowsSetupSettings(manifest,[{...p,archived:true}],'personal','none'),/NO_SETUP_BUNDLE/);
  } finally { await new Promise(r=>server.close(r)); assert.ok(root.startsWith(os.tmpdir()+path.sep)); fs.rmSync(root,{recursive:true,force:true}); }
});

const runPs = (script,args=[]) => new Promise(resolve=>{
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-NoOpen',...args],{windowsHide:true});
  let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
  child.once('error',error=>resolve({code:-1,output:String(error)})); child.once('exit',code=>resolve({code,output}));
});
test('Windows 실제 설치 스크립트: 경로 공백·한글, 재실행, 손상·경로 탈출·기존 파일 보존', {skip:process.platform!=='win32'}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hwpx-setup-한글 space-'));
  const top='hwpx-cowork-0.5.0', entry=`${top}/hwpx-cowork-server/app/scripts/setup-user.bat`;
  const fixture=new JSZip(); fixture.file(entry,'@echo off\r\necho %*>>"%~dp0calls.txt"\r\nexit /b 0\r\n');
  const good=await fixture.generateAsync({type:'nodebuffer'});
  const unsafe=new JSZip(); unsafe.file(entry,'@exit /b 0\r\n'); unsafe.file('../outside.txt','no'); const bad=await unsafe.generateAsync({type:'nodebuffer'});
  const server=http.createServer((req,res)=>res.end(req.url==='/unsafe.zip'?bad:good)).listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  async function prepare(name,{data=good,url='/good.zip',...changes}={}) {
    const settings={schema:1,mode:'personal',ai:'codex',bundle:{url:base+url,bytes:data.length,sha256:sha(data),topFolder:top},...changes};
    const zip=await JSZip.loadAsync(await windowsSetupZip(settings)); const dst=path.join(root,name);
    fs.mkdirSync(dst); for(const [name,file] of Object.entries(zip.files)) if(!file.dir) fs.writeFileSync(path.join(dst,path.basename(name)),await file.async('nodebuffer'));
    return dst;
  }
  try {
    const target=await prepare('정상 설치'); let result=await runPs(path.join(target,'setup.ps1')); assert.equal(result.code,0,result.output);
    const app=path.join(target,'program/hwpx-cowork-server/app'), calls=path.join(app,'scripts/calls.txt');
    assert.match(fs.readFileSync(calls,'utf8'),/--mode personal --ai codex --install-cli --start/);
    const workspace=JSON.parse(fs.readFileSync(path.join(target,'Hwpx Cowork.code-workspace'),'utf8').replace(/^\uFEFF/,'')); assert.equal(workspace.folders[0].path.toLowerCase(),app.replaceAll('/','\\').toLowerCase()); // Windows 드라이브 이름의 대소문자는 같은 경로다.
    assert.match(fs.readFileSync(path.join(target,'VS Code에 붙여넣기.txt'),'utf8'),/구독 로그인이 필요하면/);
    fs.writeFileSync(path.join(app,'keep.txt'),'preserve'); result=await runPs(path.join(target,'setup.ps1')); assert.equal(result.code,0,result.output); assert.equal(fs.readFileSync(path.join(app,'keep.txt'),'utf8'),'preserve'); assert.equal(fs.readFileSync(calls,'utf8').trim().split(/\r?\n/).length,2);
    const corrupt=await prepare('손상',{bundle:{url:base+'/good.zip',bytes:good.length,sha256:'0'.repeat(64),topFolder:top}}); result=await runPs(path.join(corrupt,'setup.ps1')); assert.notEqual(result.code,0); assert.ok(!fs.existsSync(path.join(corrupt,'program')));
    const traversal=await prepare('경로 탈출',{data:bad,url:'/unsafe.zip'}); result=await runPs(path.join(traversal,'setup.ps1')); assert.notEqual(result.code,0); assert.ok(!fs.existsSync(path.join(traversal,'program'))); assert.ok(!fs.existsSync(path.join(traversal,'outside.txt')));
    const existing=await prepare('기존 설치'); fs.mkdirSync(path.join(existing,'program')); fs.writeFileSync(path.join(existing,'program/keep.txt'),'original'); result=await runPs(path.join(existing,'setup.ps1')); assert.notEqual(result.code,0); assert.equal(fs.readFileSync(path.join(existing,'program/keep.txt'),'utf8'),'original');
  } finally { await new Promise(r=>server.close(r)); assert.ok(root.startsWith(os.tmpdir()+path.sep)); fs.rmSync(root,{recursive:true,force:true}); }
});
