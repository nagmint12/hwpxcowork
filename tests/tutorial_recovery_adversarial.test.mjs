import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFlow } from '../web/tutorial-modules/report-flow.js';
import { buildAiReview } from '../web/tutorial-modules/ai-review.js';
import { buildEditorBasics } from '../web/tutorial-modules/editor-basics.js';
import { buildAdvanced } from '../web/tutorial-modules/advanced.js';
const P1='일정 부분 기여한 것으로 보인다';
const PRACTICE='이 문단의 아무 글이나 고쳐 보세요';
const environment=()=>({describe:true,d:{},s:{paragraphs:[],requests:[],proposals:[],memos:[],draft:{}},ctx:{},config:{},clipboard:{},
  saveButton(){},focusIn(){},rectOf(){},pad:v=>v,q(){},fdoc(){},inFrame(){},frameRect(){},selectFor(){},locate(){},phraseRect(){},cw(){},toolbarShown:()=>false,selHas:()=>false,motionReduced:()=>true});
const step=(steps,title)=>steps.find(s=>s.title===title);
test('선택 문구 일부가 같아도 다른 문단과 틀린 범위는 첫 선택을 완료하지 않는다',()=>{
  const e=environment();e.locate=()=>({ref:'s0/p3',start:2,end:2+[...P1].length});e.toolbarShown=()=>true;e.selHas=()=>true;
  const pick=buildReportFlow(e)[1];e.s.selection={ref:'s0/p99',start:2,end:2+[...P1].length,text:P1};assert.equal(pick.until(),false);
  e.s.selection.ref='s0/p3';e.s.selection.end--;assert.equal(pick.until(),false);e.s.selection.end++;assert.equal(pick.until(),true);
});
test('다른 메모의 후속 요청·다른 문단의 차례 요청은 채택하지 않는다',()=>{
  const e=environment();e.ctx.reqs0=[1];e.ctx.reqs1=[1];e.ctx.memoId='wanted';e.ctx.tocRef='s0/p3';e.s.requests=[{rid:2,followUp:{memoId:'other'},target:{ref:'s0/p99'},instruction:'차례 새로고침해줘'}];
  const steps=buildReportFlow(e);assert.equal(steps[10].until(),false);assert.equal(steps[13].until(),false);
  e.s.requests[0].followUp.memoId='wanted';assert.equal(steps[10].until(),true);e.s.requests[0].target.ref='s0/p3';assert.equal(steps[13].until(),true);
});
test('실패·취소된 차례 요청은 완료가 아니다',()=>{
  const e=environment();e.ctx.rid3=2;e.d.request=()=>e.s.requests[0];const wait=buildReportFlow(e)[14];
  for(const status of ['failed','cancelled','pending','working']){e.s.requests=[{rid:2,status}];assert.equal(wait.until(),false,status);}
  e.s.requests[0].status='done';assert.equal(wait.until(),false,'완료 응답만으로 차례 갱신을 인정하지 않음');
  e.s.proposals=[{rid:1,type:'toc',status:'applied'},{rid:2,type:'toc',status:'pending'}];assert.equal(wait.until(),false);
  e.s.proposals[1].status='applied';assert.equal(wait.until(),true);
});
test('없는 제안과 거절한 제안은 반영 되돌리기 성공이 아니다',async()=>{
  const e=environment();const undo=step(buildAiReview(e),'반영한 제안 되돌리기');await assert.rejects(undo.action.run());assert.equal(undo.until(),false);
  e.s.requests=[{rid:1,example:true,status:'done'}];e.s.proposals=[{rid:1,pid:1,status:'rejected'},{rid:1,pid:2,status:'rejected'}];assert.equal(undo.until(),false);await assert.rejects(undo.action.run());
  e.s.proposals[0].status='applied';e.d.undoProposal=async p=>{p.status='undone';};await undo.action.run();assert.equal(undo.until(),true);
});

test('모두 반영된 상태에서는 중간 단계를 통과하지 않고 첫 반영 전 복구를 안내한다', () => {
  const e = environment();
  e.s.requests = [{ rid: 1, example: true, status: 'done' }];
  e.s.proposals = [{ rid: 1, pid: 2, status: 'applied' }, { rid: 1, pid: 1, status: 'applied' }];
  const steps = buildAiReview(e);
  for (const title of ['제안 하나 반영하기', '마음에 들지 않는 제안 거절', '반영한 제안 되돌리기']) {
    const current = step(steps, title);
    assert.equal(current.until(), false, title);
    assert.equal(steps[current.lost()].title, '제안 하나 반영하기');
  }
});
test('같은 단계에 다시 진입해도 이전 선택의 비동기 완료가 창을 열지 않는다',async()=>{
  for(const kind of ['report','memo','review']){
    const e=environment();e.s.paragraphs=[{ref:'s0/p1',text:PRACTICE},{ref:'s0/p2',text:'예시 문단 A — 본 조사 내용'}];let identity={};e.stepIdentity=()=>identity;e.isCurrentStep=()=>true;
    let resolve;let opened=0;e.selectFor=()=>new Promise(r=>{resolve=r;});e.d.openComposer=e.d.openPopover=()=>{opened++;};
    const steps=kind==='report'?buildReportFlow(e):kind==='memo'?buildEditorBasics(e):buildAiReview(e);
    const act=kind==='report'?steps[1]:step(steps,kind==='memo'?'의견을 남길 글 선택':'글을 골라 요청 준비하기');const pending=act.action.run();identity={};resolve({ref:'s0/p1'});await pending;assert.equal(opened,0,kind);
  }
});
test('연습 문단 주소가 이동한 뒤 원래 문장 버튼은 다른 문단을 덮어쓰지 않는다',async()=>{
  const e=environment();e.s.paragraphs=[{ref:'s0/p0',text:'앞 문단'},{ref:'s0/p1',text:PRACTICE},{ref:'s0/p2',text:'뒤 문단'}];let writes=0;e.cw=()=>({debug:{text:()=> '다른 문단 내용'}});e.d.editor={applyText:async()=>{writes++;return{ok:true};}};e.d.saveDraftNow=async()=>{};e.d.refresh=async()=>{};
  const steps=buildEditorBasics(e);step(steps,'문장을 직접 고쳐 보기').enter();e.s.paragraphs.unshift({ref:'new',text:'새 문단'});e.s.paragraphs[2]={ref:'s0/p1',text:'다른 문단 내용'};
  await assert.rejects(step(steps,'고친 글 되돌리기').action.run(),/다시|복구/);assert.equal(writes,0);
});
test('문단 구조와 주변 본문이 유지된 정상 연습은 원래 문장으로 돌리고 큰 본문을 ctx에 복제하지 않는다',async()=>{
  const e=environment();e.s.paragraphs=[{ref:'s0/p0',text:'주변 본문'.repeat(20000)},{ref:'s0/p1',text:PRACTICE},{ref:'s0/p2',text:'뒤 문단'}];let text=PRACTICE;const calls=[];
  e.locate=()=>({ref:'s0/p1',start:0,end:[...PRACTICE].length});e.cw=()=>({debug:{text:()=>text}});e.d.editor={applyText:async operation=>{calls.push(operation);text=operation.replace;e.s.paragraphs[1].text=text;return{ok:true};}};e.d.saveDraftNow=async()=>{};e.d.refresh=async()=>{};
  const steps=buildEditorBasics(e);const edit=step(steps,'문장을 직접 고쳐 보기');const undo=step(steps,'고친 글 되돌리기');edit.enter();assert.ok(JSON.stringify(e.ctx).length<1000);
  await edit.action.run();assert.equal(edit.until(),true);await undo.action.run();assert.equal(undo.until(),true);assert.equal(text,PRACTICE);assert.equal(calls.length,2);
  e.s.paragraphs[0].text='다른 문단도 변경';await assert.rejects(undo.action.run(),/복구/);assert.equal(calls.length,2);
});
test('요청 번호가 없으면 보고서 반영은 다른 요청의 버튼으로 대체하지 않는다',()=>{
  const e=environment();const unrelated={getBoundingClientRect:()=>({width:1,height:1})};e.q=(_sel,root)=>root?unrelated:null;
  const old=globalThis.document;globalThis.document={querySelector:()=>({})};try{assert.equal(buildReportFlow(e)[12].click(),null);}finally{globalThis.document=old;}
});
test('AI 작업 모듈은 tutorialStep 없는 무관 요청을 자기 결과로 채택하지 않는다',()=>{
  const e=environment();e.moduleKey='one';e.ctx.beforeS1=[];e.s.requests=[{rid:2,status:'done'}];const steps=buildAdvanced(e,[{id:'S1',title:'그림',target:{doc:true},prompt:'그림 생성',look:'확인'}]);assert.equal(steps[1].until(),false);
});
test('AI 작업 모듈은 같은 단계 재진입 전 선택과 실패한 결과를 재사용하지 않는다',async()=>{
  const e=environment();e.moduleKey='one';let identity={};e.stepIdentity=()=>identity;e.isCurrentStep=()=>true;let resolve;let opens=0;e.selectFor=()=>new Promise(r=>{resolve=r;});e.d.openComposer=()=>{opens++;};
  const steps=buildAdvanced(e,[{id:'S1',title:'그림',target:{para:'표 제목'},prompt:'그림 생성',look:'확인'}]);const pending=steps[1].action.run();identity={};resolve({ref:'s0/p1'});await pending;assert.equal(opens,0);
  e.ctx.ridS1=2;e.s.requests=[{rid:2,status:'failed',tutorialStep:'S1'}];e.s.proposals=[{rid:2,status:'applied'}];assert.equal(steps[2].until(),false);e.s.requests[0].status='done';assert.equal(steps[2].until(),true);
});
test('메모 개수만 늘어도 다른 문단의 메모와 다른 답글 창은 완료로 세지 않는다',()=>{
  for(const kind of ['report','editor']){
    const e=environment();e.locate=()=>({ref:'s0/p3',start:2,end:8});e.s.paragraphs=[{ref:'s0/p3',text:PRACTICE}];const steps=kind==='report'?buildReportFlow(e):buildEditorBasics(e);
    const write=step(steps,kind==='report'?'8. 메모 쓰기':'메모를 직접 남기기');if(kind==='report')steps[6].enter();else write.enter();
    e.s.memos=[{id:'wrong',ref:'s0/p99',start:2,end:8}];assert.equal(write.until(),false,kind);e.s.memos.push({id:'right',ref:'s0/p3',start:2,end:8});assert.equal(write.until(),true,kind);write.leave();assert.equal(kind==='report'?e.ctx.memoId:e.ctx.overviewMemoId,'right');
    if(kind==='editor'){write.enter();assert.equal(write.until(),true,'새로고침 때 이전 메모 baseline을 덮지 않음');e.s.reply={memoId:'wrong'};assert.equal(step(steps,'여백의 메모와 답글').until(),false);}
  }
});
test('차례 원문이 없어지면 기본 s0/p0이나 같은 숫자 주소의 다른 문단에 요청하지 않는다',async()=>{
  const e=environment();e.ctx.tocRef='s0/p0';e.ctx.tocOriginal='제목 차례';e.s.paragraphs=[{ref:'s0/p0',text:'다른 문단'}];let opened=0;e.d.openComposer=()=>{opened++;};
  await assert.rejects(buildReportFlow(e)[13].action.run(),/복구/);assert.equal(opened,0);
});
