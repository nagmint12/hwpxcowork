import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { getPageLayout, editPageLayout, elements } from '../engine/page-layout.js';
import { normalizePageLayoutOps } from '../server/page-layout-schema.js';
import { openSkillArchive } from '../server/skill-archive.js';
import { Service } from '../server/service.js';
import { codexToolPolicy } from '../server/codex-mcp.js';
import { buildBlankTemplate } from '../scripts/build-blank-template.mjs';
import { startServer, root, uploadDoc } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const json = r => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content.find(c => c.type === 'text').text); };
const body = d => d.sections.flatMap(s => s.bodyParas.map(p => Section.text(p, 'final')));

test('표준서식 새 문서: 바탕글 10pt, 나머지 스타일·용지 유지, 내용과 개체 제거', async () => {
  const bytes = await buildBlankTemplate(), d = await HwpxDoc.load(bytes);
  const original = await HwpxDoc.load(await fs.readFile(path.join(root, 'tutorial', '결과보고서.hwpx')));
  const normal = d.header.style({ name: '바탕글' });
  const originalNormal = original.header.style({ name: '바탕글' });
  assert.deepEqual(d.formattingCatalog().styles, original.formattingCatalog().styles.map(style =>
    style.id === originalNormal.styleId ? { ...style, charPrId: normal.charPr } : style));
  assert.equal(d.header.charHeight(normal.charPr), 1000);
  const charXml = d.header.block('charPr', normal.charPr);
  const fontRef = elements(charXml, 'hh:fontRef')[0];
  const groups = elements(d.header.xml, 'hh:fontface');
  for (const slot of ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user']) {
    const group = groups.find(el => el.attrs.lang === slot.toUpperCase());
    assert.equal(elements(group.xml, 'hh:font').find(el => el.attrs.id === fontRef.attrs[slot]).attrs.face, 'Noto Sans KR');
  }
  const originalChar = original.header.block('charPr', originalNormal.charPr);
  assert.equal(charXml, originalChar.replace(`id="${originalNormal.charPr}"`, `id="${normal.charPr}"`)
    .replace(/\bheight="\d+"/, 'height="1000"').replace(elements(originalChar, 'hh:fontRef')[0].xml, fontRef.xml));
  assert.ok(d.sections[0].bodyParas[0].runs.every(run => run.charPr === normal.charPr));
  assert.equal(d.sections.length, 1); assert.deepEqual(body(d), ['']);
  assert.equal(d.memos().length, 0); assert.equal(d.changes().length, 0);
  assert.equal(d.tables().length, 0); assert.equal(d.figures().length, 0);
  assert.ok(![...d.container.files.keys()].some(n => /^(BinData|Preview)\/|masterpage/.test(n)));
  const layout = getPageLayout(d).sections[0];
  assert.deepEqual(layout.headers, []); assert.deepEqual(layout.footers, []); assert.deepEqual(layout.page_numbers, []); assert.deepEqual(layout.master_pages, []);
  assert.deepEqual(layout.paper, getPageLayout(original).sections[1].paper);
  // Hancom drops secPr when its run also contains an empty hp:t.
  const settingsRun = d.sections[0].bodyParas[0].runs.find(r => d.sections[0].xml.slice(r.start,r.end).includes('<hp:secPr'));
  assert.equal(elements(d.sections[0].xml.slice(settingsRun.start,settingsRun.end),'hp:t').length,0);
  const zip = await JSZip.loadAsync(bytes), names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  assert.deepEqual(names.slice(0,2), ['mimetype','version.xml']);
  for (const n of names.slice(0,2)) assert.equal(zip.file(n)._data.compression.magic, '\x00\x00');
});

test('쪽 구성 엔진: 용지·시작번호·머리말·꼬리말·쪽 번호·바탕쪽 그림을 실제 HWPX에 저장', async () => {
  const d = await HwpxDoc.load(await buildBlankTemplate());
  const ops = normalizePageLayoutOps([
    { op:'paper', section:0, orientation:'landscape', margins:{left:20,right:20,top:15,bottom:15} },
    { op:'section', section:0, hide_first_number:true, starts_on:'ODD' },
    { op:'header', section:0, text:'홀수 머리말', apply_to:'ODD', style:'&머리말(홀)' },
    { op:'footer', section:0, text:'센터 보고서', style:'&꼬리말(홀)' },
    { op:'page_number', section:0, position:'BOTTOM_CENTER', format:'ROMAN_SMALL', start:3 },
    { op:'master_page', section:0, text:'바탕쪽', attachment_id:'a1' },
  ]);
  const original = body(d); editPageLayout(d, ops, { attachmentBytes: () => makePng(8,8) });
  const reopened = await HwpxDoc.load(await d.save()), layout = getPageLayout(reopened).sections[0];
  assert.deepEqual(body(reopened), original);
  assert.equal(layout.paper.orientation, 'landscape'); assert.ok(Math.abs(layout.paper.margins.left-20)<0.01);
  assert.equal(layout.start.page, '3'); assert.equal(layout.visibility.hideFirstPageNum, '1');
  assert.equal(layout.headers[0].text, '홀수 머리말'); assert.equal(layout.headers[0].applyPageType, 'ODD');
  assert.equal(layout.footers[0].text, '센터 보고서'); assert.equal(layout.page_numbers[0].formatType, 'ROMAN_SMALL');
  assert.equal(layout.master_pages[0].images.length,1); assert.ok(reopened.binaryItem(layout.master_pages[0].images[0]));
  editPageLayout(reopened,normalizePageLayoutOps([{op:'header',section:0,text:'양쪽 머리말'}]));
  assert.equal(getPageLayout(reopened).sections[0].headers.length,1);
  assert.equal(getPageLayout(reopened).sections[0].headers[0].text,'양쪽 머리말');
  editPageLayout(reopened, normalizePageLayoutOps(['header','footer','page_number','master_page'].map(op => ({op,section:0,clear:true}))));
  assert.deepEqual(getPageLayout(reopened).sections[0].master_pages, []);
  assert.ok(![...reopened.container.files.keys()].some(n=>/masterpage/.test(n)));
});

test('구역 나누기·합치기: 본문·메모와 구역 매니페스트 보존', async () => {
  const d = await HwpxDoc.load(await buildBlankTemplate());
  d.insertParagraphAfter(0,0,'두 번째',{}); d.insertParagraphAfter(0,1,'세 번째',{});
  d.addMemo('s0/p2',{author:'테스트',text:'유지할 메모'});
  const texts = body(d);
  const split = editPageLayout(d, normalizePageLayoutOps([{op:'split_section',before_ref:'s0/p1'}]));
  assert.equal(d.sections.length,2); assert.deepEqual(body(d),texts); assert.equal(d.memos().length,1);
  assert.deepEqual(split.mapping.find(m=>m.old[1]===2).to,[1,1]);
  assert.equal(elements(d.sections[1].xml,'hp:secPr').length,1);
  assert.equal((await HwpxDoc.load(await d.save())).sections.length,2);
  editPageLayout(d,normalizePageLayoutOps([{op:'merge_section',section:0}]));
  assert.equal(d.sections.length,1); assert.deepEqual(body(d),texts); assert.equal(d.memos().length,1);
  assert.equal(elements(d.sections[0].xml,'hp:secPr').length,1);
  assert.deepEqual(d.container.sectionNames(),['Contents/section0.xml']);
});

test('기존 text=null .skill 첨부도 설치·셸 없이 MCP용 본문 추출, 참조 자료 읽기와 경로 제한', async () => {
  const z = new JSZip(); z.file('report/SKILL.md','# 보고서 스킬\n'.repeat(100)); z.file('report/reference/spec.md','참조 서식'); z.file('report/assets/template.hwpx',await buildBlankTemplate());
  const bytes = await z.generateAsync({type:'nodebuffer'});
  const a = {aid:'a6',name:'report.skill',kind:'other',text:null};
  const fake = { _meta:()=>({}), _att:()=>a, attach:{bytes:()=>bytes,maxTextChars:200000} };
  const extracted = await Service.prototype.attachmentText.call(fake,'doc','a6');
  assert.equal(extracted.kind,'skill'); assert.match(extracted.text,/# 보고서 스킬/); assert.match(extracted.text,/reference\/spec.md/);
  const archive = await openSkillArchive(bytes); assert.equal((await archive.read('reference/spec.md')).text,'참조 서식');
  await assert.rejects(archive.read('../SKILL.md'),{code:'SKILL_RESOURCE'});
  const bad = new JSZip(); bad.file('../SKILL.md','escape'); await assert.rejects(openSkillArchive(await bad.generateAsync({type:'nodebuffer'})),{code:'SKILL_RESOURCE'});
});

test('머리말·꼬리말 삽입과 구역 나누기로 표 칸 제안·요청의 중첩 주소가 바뀌어도 원래 칸 유지', {timeout:30000}, async () => {
  const d=await HwpxDoc.load(await buildBlankTemplate());
  d.insertTableAfter(0,0,{rows:[['A','B'],['C','D']],headerRows:1},{});
  const sec=d.sections[0], table=elements(sec.xml,'hp:tbl')[0].xml, host=sec.bodyParas[1];
  let xml=sec.xml.slice(0,host.start)+sec.xml.slice(host.end);
  xml=xml.replace('<hp:t/>',table+'<hp:t/>'); sec.load(xml);
  d.insertParagraphAfter(0,0,'second',{}); d.insertParagraphAfter(0,1,'third',{});
  const cell=d.paragraphs().find(p=>p.text==='C'); assert.ok(cell);
  const srv=await startServer({ai:'off'}), client=new Client({name:'codex',version:'test'});
  try {
    const api=srv.api('a'), doc=await uploadDoc(srv.base,srv.tokens.a,await d.save()), route=`/api/docs/${doc.id}`;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${srv.tokens.a}`}}}));
    const call=(name,args={})=>client.callTool({name,arguments:{doc_id:doc.id,...args}});
    const req=(await api(`${route}/requests`,{method:'POST',body:{kind:'review',route:'queue',target:{ref:cell.ref}}})).request;
    json(await call('start_request',{request_id:req.rid}));
    const cellProposal=json(await call('propose_change',{ref:cell.ref,find:'C',replace:'changed C',request_id:req.rid,expected_attempt:1}));
    const layout=json(await call('propose_page_layout',{ops:[{op:'header',section:0,text:'머리말'},{op:'footer',section:0,text:'꼬리말'},{op:'split_section',before_ref:'s0/p1'}],request_id:req.rid,expected_attempt:1}));
    json(await call('complete_request',{request_id:req.rid,summary:'표와 쪽 구성 제안'}));
    await api(`${route}/proposals/${layout.pid}/apply`,{method:'POST',body:{}});
    const after=await HwpxDoc.load(await api(`${route}/file`)), proposals=await api(`${route}/proposals`), changed=proposals.find(p=>p.pid===cellProposal.pid);
    assert.equal(after.text(changed.ref,'final'),'C'); assert.notEqual(changed.ref,cell.ref);
    const request=await api(`${route}/requests/${req.rid}`); assert.equal(after.text(request.target.ref,'final'),'C');
    assert.equal(after.sections.length,2);
    await api(`${route}/proposals/${layout.pid}/undo`,{method:'POST',body:{}});
    const undone=await HwpxDoc.load(await api(`${route}/file`)), again=(await api(`${route}/proposals`)).find(p=>p.pid===cellProposal.pid);
    assert.equal(undone.text(again.ref,'final'),'C'); assert.equal(undone.sections.length,1);
    // A later proposal/edit must prevent snapshot undo from overwriting that work.
    const p=json(await call('propose_page_layout',{ops:[{op:'paper',section:0,margins:{left:22}}]}));
    await api(`${route}/proposals/${p.pid}/apply`,{method:'POST',body:{}});
    const edit=await api(`${route}/proposals`,{method:'POST',body:{ref:'s0/p2',find:'third',replace:'new third',memo:false}});
    await api(`${route}/proposals/${edit.pid}/apply`,{method:'POST',body:{}});
    const denied=await api.res(`${route}/proposals/${p.pid}/undo`,{method:'POST',body:{}}); assert.equal(denied.status,409); assert.equal(denied.data.error,'STALE');
    assert.equal((await HwpxDoc.load(await api(`${route}/file`))).text('s0/p2','final'),'new third');
  } finally {await client.close().catch(()=>{}); await srv.stop();}
});

test('HTTP MCP 전체 경로: 스킬 첨부→내부 자료→쪽 구성 제안→사람 적용/복구→재시작 뒤 새 문서', {timeout:30000}, async () => {
  const srv = await startServer({ai:'off'}), client = new Client({name:'codex',version:'test'});
  try {
    const api = srv.api('a'), doc = await api('/api/library/docs',{method:'POST',body:{}}), route=`/api/docs/${doc.id}`;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${srv.tokens.a}`}}}));
    const call = (name,args={}) => client.callTool({name,arguments:{doc_id:doc.id,...args}});
    const tools=(await client.listTools()).tools.map(t=>t.name);
    for (const name of ['read_skill_resource','export_skill_resource','get_page_layout','propose_page_layout']) assert.ok(tools.includes(name));
    const z = new JSZip(); z.file('standard/SKILL.md','# 표준서식 지침\n'.repeat(120)); z.file('standard/reference/spec.md','서식 기준'); z.file('standard/assets/template.hwpx',await buildBlankTemplate());
    const attachment=await api(`${route}/attachments`,{method:'POST',headers:{'x-file-name':'standard.skill'},body:await z.generateAsync({type:'nodebuffer'})});
    const req=(await api(`${route}/requests`,{method:'POST',body:{kind:'instruct',instruction:'첨부 스킬의 서식을 적용해줘',target:{ref:'s0/p0'},attachments:[attachment.aid],route:'queue'}})).request;
    json(await call('start_request',{request_id:req.rid}));
    assert.match(json(await call('get_request',{request_id:req.rid})).skillGuide,/read_skill_resource/);
    const skill=json(await call('read_skill_resource',{attachment_id:attachment.aid,max_chars:100}));
    assert.equal(skill.next_from,100); assert.ok(skill.resources.some(f=>f.path==='assets/template.hwpx'));
    assert.match(json(await call('read_skill_resource',{attachment_id:attachment.aid,from:100})).text,/표준서식 지침/);
    const exported=json(await call('export_skill_resource',{attachment_id:attachment.aid,resource:'assets/template.hwpx',request_id:req.rid,expected_attempt:1})); assert.ok(exported.aid);
    const before=json(await call('get_page_layout'));
    const p=json(await call('propose_page_layout',{ops:[{op:'paper',section:0,margins:{left:25}},{op:'footer',section:0,text:'대학혁신센터'},{op:'page_number',section:0,position:'BOTTOM_CENTER',start:1}],request_id:req.rid,expected_attempt:1}));
    assert.equal(p.type,'page_layout'); assert.equal(p.status,'pending'); assert.deepEqual(json(await call('get_page_layout')),before);
    json(await call('complete_request',{request_id:req.rid,summary:'서식 및 쪽 구성 제안을 남겼습니다.'}));
    await api(`${route}/proposals/${p.pid}/apply`,{method:'POST',body:{}});
    const applied=json(await call('get_page_layout')); assert.equal(applied.sections[0].footers[0].text,'대학혁신센터'); assert.equal(applied.sections[0].page_numbers[0].pos,'BOTTOM_CENTER');
    await api(`${route}/proposals/${p.pid}/undo`,{method:'POST',body:{}});
    assert.deepEqual(json(await call('get_page_layout')),before);
    const file=await api(`${route}/file`); assert.deepEqual(body(await HwpxDoc.load(file)),['']);
    const policy=codexToolPolicy({type:'request',docId:doc.id,requestId:req.rid,attempt:1},async()=>({attempt:1,status:'working',claim:{mine:true}}));
    for (const name of ['read_skill_resource','export_skill_resource','get_page_layout','propose_page_layout']) assert.ok(policy.allows(name));
    await assert.rejects(policy.bind('propose_page_layout',{doc_id:'other'}),{code:'MCP_SCOPE'});
    await client.close(); await srv.restart({ai:'off'});
    const next=await api('/api/library/docs',{method:'POST',body:{}}); const nextDoc=await HwpxDoc.load(await api(`/api/docs/${next.id}/file`)); assert.ok(nextDoc.formattingCatalog().styles.some(s=>s.name==='&본문 1.'));
  } finally { await client.close().catch(()=>{}); await srv.stop(); }
});
