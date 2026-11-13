// 실제 모델 없이 Codex 프로세스와 설정된 stdio MCP를 실행하는 시험용 CLI.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function fakeCodex(base, { mode = 'inspect', auth = '-', receipt = path.join(base, 'receipt.json'), catalog = [], selection = null, selectionMode = 'ok' } = {}) {
  const script = path.join(base, 'fake-codex.mjs');
  const client = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js', import.meta.url).href;
  const stdio = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js', import.meta.url).href;
  const image = new URL('./image.mjs', import.meta.url).href;
  await fs.writeFile(script, `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from ${JSON.stringify(client)};
import { StdioClientTransport } from ${JSON.stringify(stdio)};
import { makePng } from ${JSON.stringify(image)};
const [mode, receipt, auth, ...args] = process.argv.slice(2);
if(args[0]==='debug' && args[1]==='models') { console.log(${JSON.stringify(JSON.stringify({ models: catalog }))}); process.exit(0); }
if(args.includes('--version')) { console.log('codex-cli 0.164.0-test'); process.exit(0); }
if(args.includes('--help')) { console.log(mode==='old' ? '--sandbox' : '--no-daemon --strict-config --ignore-user-config --sandbox --skip-git-repo-check --json --output-schema --ephemeral'); process.exit(0); }
if(args[0]==='features') { console.log('apps plugins remote_plugin'.split(' ').map(n=>n+' stable true').join('\\n')); process.exit(0); }
if(args[0]==='login') { const ready=mode!=='logout' && (auth==='-' || fs.readFileSync(auth,'utf8')==='ready'); console.log(mode==='api'?'Logged in using an API key':ready?'Logged in using ChatGPT':'Not logged in'); process.exit(ready?0:1); }
const promptChunks=[];for await(const chunk of process.stdin) promptChunks.push(chunk);const prompt=Buffer.concat(promptChunks).toString('utf8');
const config=Object.fromEntries(args.filter((s,i)=>args[i-1]==='-c').map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
const state={pid:process.pid,args,prompt,cwd:process.cwd(),env:process.env,config};
if(args.includes('--output-schema')) {
 state.schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 state.instructions=fs.readFileSync(JSON.parse(config.model_instructions_file),'utf8');
 fs.writeFileSync(receipt+'.selection.json',JSON.stringify(state));
 if(${JSON.stringify(selectionMode)}==='slow') await new Promise(r=>setTimeout(r,20000));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(${JSON.stringify(selection)})}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:30,output_tokens:10,cached_input_tokens:5}}));
 process.exit(${selectionMode === 'fail' ? 2 : 0});
}
if(prompt.includes('<document_context>')) state.requestContext=JSON.parse(prompt.split('<document_context>')[1].split('</document_context>')[0]);
const failure=e=>{state.error=e?.stack || String(e);fs.writeFileSync(receipt,JSON.stringify(state));process.exit(2);};
process.on('uncaughtException',failure);process.on('unhandledRejection',failure);
fs.writeFileSync(receipt,JSON.stringify(state));
if(mode==='slow') await new Promise(r=>setTimeout(r,20000));
if(mode==='fail') {console.error('private provider secret-token');process.exit(2);}
if(mode==='overflow') { process.stdout.write('X'.repeat(17*1024*1024));await new Promise(r=>setTimeout(r,1000)); }
if(mode==='mcp' || mode==='features' || mode==='mcp-fail-after') {
 const c=new Client({name:'codex-cli-test',version:'test'});
 const transport=new StdioClientTransport({command:JSON.parse(config['mcp_servers.hwpx.command']),args:JSON.parse(config['mcp_servers.hwpx.args']),env:process.env,stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 try {
  await c.connect(transport);
  let toolCount=0;const nativeCall=c.callTool.bind(c);c.callTool=async(...args)=>{try{return await nativeCall(...args);}finally{console.log(JSON.stringify({type:'item.completed',item:{id:'tool-'+(++toolCount),type:'mcp_tool_call'}}));}};
  const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content.filter(x=>x.type==='text').map(x=>x.text).join('\\n'));};
  state.tools=(await c.listTools()).tools.map(t=>t.name);
  assert.ok(state.tools.includes('propose_table_edit'));assert.ok(state.tools.includes('propose_figure'));assert.ok(state.tools.includes('download_attachment_file'));
  assert.ok(!state.tools.includes('apply_proposal'));
  const r=await call('get_request');state.request=r;
  assert.ok(state.requestContext,'worker must supply full initial request context');
  assert.deepEqual(state.requestContext.contextItems,r.contextItems);
  assert.equal(state.requestContext.formattingHeader.rawHeaderXml,r.formattingHeader.rawHeaderXml);
  state.instructions=fs.readFileSync(JSON.parse(config.model_instructions_file),'utf8');
  const reading=await c.callTool({name:'read_document',arguments:{max_chars:200000}});assert.ok(!reading.isError);state.document=reading.content;
  const guide=await c.callTool({name:'get_writing_guide',arguments:{}});assert.ok(!guide.isError);state.guide=guide.content;
  assert.ok((await c.callTool({name:'get_request',arguments:{doc_id:'another-document'}})).isError);
  assert.ok((await c.callTool({name:'complete_request',arguments:{expected_attempt:999,summary:'wrong attempt'}})).isError);
  assert.ok((await c.callTool({name:'apply_proposal',arguments:{pid:1}})).isError);
  const find=r.targetText || r.target.text || '';
  await call('propose_changes',{proposals:[{ref:r.target.ref,find,replace:find+' 자동 검토',reason:'표현 보완'}]});
  await call('add_memo',{ref:r.target.ref,text:'자동 검토 의견입니다.'});
  if(mode==='features') {
   assert.match(r.followUp.memoText,/표 1/);
   assert.ok((await call('list_memos')).length);
   const t=r.tables[0];assert.ok(t,'target table missing');
   await call('propose_table_edit',{table:t.key,ops:[{op:'merge',range:{row_from:0,row_to:0,col_from:0,col_to:1}}],reason:'셀 합치기'});
   await call('propose_format',{ref:r.target.ref,find,format:{char:{bold:true}},reason:'강조'});
   const figs=await call('list_figures');assert.ok(figs.length);
   const source=await call('export_figure',{figure:figs[0].figure});
   const downloaded=await call('download_attachment_file',{attachment_id:source.aid});assert.ok(fs.statSync(downloaded.path).isFile());
   const out=path.join(process.cwd(),'work','out','replacement.png');fs.writeFileSync(out,makePng(320,200));
   const uploaded=await call('upload_result_file',{path:out});
   await call('propose_figure',{replace_ref:figs[0].figure,attachment_id:uploaded.aid});
  }
  await call('complete_request',{summary:'표현 보완안과 확인 의견을 남겼습니다.'});
  state.toolCount=toolCount;fs.writeFileSync(receipt,JSON.stringify(state));
 }finally{await c.close();}
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:200,output_tokens:20}}));
if(mode==='mcp-fail-after') process.exit(2);
`, 'utf8');
  return { file: process.execPath, args: [script, mode, receipt, auth] };
}
