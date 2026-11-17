#!/usr/bin/env node
// 미리 검증한 server-win과 공식 CLI를 모두 포함하는 오프라인 ZIP 여섯 가지. 받는 PC에서 설치/다운로드하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { assertFontDistributionZip } from './rhwp-original-font-policy.mjs';
const arg = (name, fallback) => { const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]; };
const base=path.resolve(arg('--base','artifacts/offline-windows-20261114/base'));
const tools=path.resolve(arg('--tools','artifacts/offline-windows-20261114/tools'));
const out=path.resolve(arg('--out','artifacts/offline-windows-20261114/packages'));
const root=process.cwd(),source=JSON.parse(fs.readFileSync(path.join(base,'release.json'))),p=source.packages.find(p=>p.target==='server-win');assert(p);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const coreBytes=fs.readFileSync(path.join(base,p.file));assert.equal(sha(coreBytes),p.sha256);
let zip=await JSZip.loadAsync(coreBytes);const top=p.topFolder;
assert(top==='hwpx-cowork-server');assert(zip.file(top+'/runtime/node.exe'));assert(zip.file(top+'/app/node_modules/express/package.json'));
// 원본 rhwp 글꼴은 유지하고 철회한 HFT 비교 보고서만 제외한다.
for(const name of Object.keys(zip.files))if(name.includes('/web/reports/hft-native-20261106/'))zip.remove(name);
function walk(dir, prefix=''){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{assert(!e.isSymbolicLink(),'No symlinks in offline tools');return e.isDirectory()?walk(path.join(dir,e.name),prefix+e.name+'/'):[{name:prefix+e.name,file:path.join(dir,e.name)}];});}
let toolsFiles=0;
for(const file of walk(tools)){
  // 공식 postinstall이 동일 바이너리를 최상위 bin에 복사한다. 실행에 쓰는 bin은 그대로 보존하고 중복 사본만 뺀다.
  if(file.name==='node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe')continue;
  assert(!/(^|\/)(config\.json|\.env|\.credentials\.json|auth\.json|settings\.local\.json)$/.test(file.name));
  zip.file(`${top}/app/.hwpx-tools/${file.name}`,fs.readFileSync(file.file));toolsFiles++;
}
const claude=fs.readFileSync(path.join(tools,'node_modules/@anthropic-ai/claude-code/bin/claude.exe'));assert(claude.length>1000000&&claude.toString('ascii',0,2)==='MZ');
const upstreamNative=fs.readFileSync(path.join(tools,'node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe'));assert.equal(sha(claude),sha(upstreamNative));
for(const [file,url] of [['CODEX-LICENSE.txt','https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/LICENSE'],['CODEX-NOTICE.txt','https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/NOTICE']]){
  const response=await fetch(url);if(response.status===404&&file.includes('NOTICE'))continue;assert(response.ok);zip.file(`${top}/NOTICES/${file}`,await response.text());
}
zip.file(`${top}/NOTICES/AI-CLI-SOURCES.txt`,'Unmodified official CLI binaries installed from npm registry.\n@openai/codex 0.169.0: https://github.com/openai/codex/tree/rust-v0.169.0\n@anthropic-ai/claude-code 2.1.323: https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.323\nClaude Code terms: https://code.claude.com/docs/en/legal-and-compliance\nEach user signs into the official CLI with their own account. No account, token or paid API key is included.\n');
const changed=['web/onboarding.js','web/onboarding-model.js','web/onboarding.css','server/download-page.js','server/download-page.css','server/release-downloads.js'];
for(const name of changed)zip.file(`${top}/app/${name}`,fs.readFileSync(path.join(root,name)));
const ps=Buffer.concat([Buffer.from([239,187,191]),fs.readFileSync('deploy/portable/offline/offline-start.ps1')]);zip.file(top+'/offline-start.ps1',ps);
zip.file(top+'/FONT-POLICY.txt','Only fonts identical to original rhwp v0.9.0 are included, including its embedded equation font. FontDB/HFT source fonts and extracted outlines are not distributed. Numeric matching and corrections are retained.\n');
for(const [name,flag] of [['설치 시작.bat',''],['종료.bat',' -Stop'],['상태 확인.bat',' -Status']])zip.file(`${top}/${name}`,`@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0offline-start.ps1"${flag}\r\nif errorlevel 1 pause\r\n`);
fs.mkdirSync(out,{recursive:true});const results=[];
// 큰 공통 바이너리는 한 번만 압축한다. 아래 여섯 ZIP은 압축된 본문을 재사용하고 선택 파일만 다르다.
const payload=path.join(out,'payload.zip');assert(!fs.existsSync(payload),'Preserve prior payload');
await pipeline(zip.generateNodeStream({type:'nodebuffer',streamFiles:true,compression:'DEFLATE',compressionOptions:{level:6},platform:'DOS'}),fs.createWriteStream(payload));
zip=await JSZip.loadAsync(fs.readFileSync(payload));
await assertFontDistributionZip(fs.readFileSync(payload));
for(const mode of ['personal','shared'])for(const ai of ['none','codex','claude-code']){
  const file=`hwpx-cowork-server-0.5.0-20261114-win-x64-offline-${mode}-${ai}.zip`,target=path.join(out,file);assert(!fs.existsSync(target),'Preserve prior package '+file);
  zip.file(top+'/install-options.json',JSON.stringify({schema:1,mode,ai,offline:true},null,2));
  zip.file(top+'/먼저 읽기.txt','\uFEFF'+`오프라인 완전 포함판 · Windows x64\r\n\r\n1. ZIP 전체를 압축 해제합니다.\r\n2. 설치 시작.bat을 더블클릭합니다.\r\n\r\n선택: ${mode==='personal'?'개인':'공동'} 서버 / ${ai}\r\n프로그램·Node24.22.2·라이브러리·편집기·Codex0.169.0·Claude Code2.1.323이 포함되어 있습니다. 원본 rhwp와 동일한 글꼴을 포함하며, PC에 설치된 글꼴도 사용합니다. 이 PC에서 다운로드나 npm 설치 없이 문서함을 시작합니다. 관리자 권한은 필요 없습니다.\r\nAI를 골랐어도 문서함은 AI 없이 먼저 엽니다. 구독 AI 로그인·요청에는 인터넷과 본인 계정이 필요합니다. 인터넷 연결 후 VS Code에 붙여넣기.txt의 메시지로 연결합니다. VS Code 자체와 확장 프로그램은 포함하지 않습니다.\r\n종료.bat으로 이 설치의 서버를 끕니다. 실행 기록과 문서는 app/userdata-${mode}/에 저장되며, 다른 설치의 문서를 복사하거나 변경하지 않습니다.\r\n공동 서버는 먼저 이 PC에서만 열립니다. 인터넷 공개 주소와 권한 설정은 별도입니다.\r\nadmin-app/start-server는 직접 구성하는 고급 실행 파일입니다. 기본 사용은 설치 시작.bat을 쓰세요.\r\n`);
  console.log('Packing '+file);const stream=zip.generateNodeStream({type:'nodebuffer',streamFiles:true,compression:'DEFLATE',compressionOptions:{level:6},platform:'DOS'});await pipeline(stream,fs.createWriteStream(target));
  const bytes=fs.readFileSync(target);results.push({target:`windows-offline-${mode}-${ai}`,file,bytes:bytes.length,sha256:sha(bytes),version:'0.5.0',title:`Windows 오프라인 완전 포함 · ${mode==='personal'?'개인':'공동'} 서버 · ${ai}`,topFolder:top,mode,ai,offline:true,arch:'x64',node:'24.22.2',cli:{codex:'0.169.0',claude:'2.1.323'},downloadUrl:'https://cowork.example.com/download/'+file});console.log('Built '+bytes.length);
}
fs.writeFileSync(path.join(out,'release.json'),JSON.stringify({version:'0.5.0',releasedOn:'2026-11-14',builtAt:new Date().toISOString(),packages:results,toolsFiles,claudeNativeUnmodified:true},null,2));
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),results.map(p=>`${p.sha256}  ${p.file}`).join('\n')+'\n');
