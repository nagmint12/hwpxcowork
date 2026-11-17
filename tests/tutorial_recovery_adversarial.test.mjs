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
test('드래그는 문구가 포함되거나 검토 도구 막대가 나타나면 성공한다',()=>{
  const e=environment();let toolbar=false;e.toolbarShown=()=>toolbar;e.selHas=text=>!!e.s.selection?.text?.includes(text);
  const steps=buildReportFlow(e);const pick=steps[1];
  assert.equal(pick.until(),false,'선택과 메뉴가 모두 없으면 기다림');
  e.s.selection={ref:'s0/p2',endRef:'s0/p4',start:0,end:100,text:`앞 문장 ${P1}. 뒤 문장`};
  assert.equal(pick.until(),true,'여러 문단과 앞뒤 글자가 함께 골라져도 포함되면 성공');
  e.s.selection.text='일정 부분 기여한 것으로';assert.equal(pick.until(),false,'문구가 잘리고 메뉴도 없으면 아직 선택 중');
  toolbar=true;assert.equal(pick.until(),true,'끝 글자가 빠져도 검토 메뉴가 나타나면 성공');
  e.s.selection={ref:'s0/p99',start:0,end:3,text:'다른 글'};assert.equal(pick.until(),true,'검토 메뉴만으로도 성공');
  e.s.selection=null;assert.equal(pick.until(),true,'선택 알림보다 메뉴가 먼저 표시되어도 성공');
  assert.equal(steps[6].until(),true,'메모를 위한 드래그도 같은 조건');
  toolbar=false;e.s.selection={text:'높은 학생 만족도 향상'};assert.equal(steps[6].until(),true);
});

test('느슨하게 고른 뒤 요청·메모를 열면 연습 문구를 맞춰 후속 완료도 인식한다',()=>{
  const e=environment();const phrases={[P1]:{ref:'s0/p3',start:2,end:2+[...P1].length},'학생 만족도':{ref:'s0/p3',start:30,end:36}};
  e.locate=text=>phrases[text];e.d.request=rid=>e.s.requests.find(r=>r.rid===rid);
  const steps=buildReportFlow(e);
  for(const target of [{ref:'s0/p2',endRef:'s0/p4',start:0,end:100,text:`앞 ${P1}. 뒤`},{ref:'s0/p3',start:2,end:10,text:'일정 부분 기여'},{ref:'s0/p99',start:0,end:3,text:'다른 글'}]){
    e.s.composer={kind:'instruct',target,phase:'edit',instruction:'직접 쓴 지시'};
    assert.equal(steps[2].until(),true);steps[3].enter();
    assert.deepEqual(e.s.composer.target,{...phrases[P1],endRef:'s0/p3',text:P1,refs:['s0/p3']});
    assert.equal(e.s.composer.instruction,'직접 쓴 지시');
    e.s.composer.rid=3;e.s.requests=[{rid:3,target:e.s.composer.target,status:'pending'}];
    assert.equal(steps[3].until(),true,'실제 전송한 요청을 다음 단계에서 찾음');
    e.s.composer=null;e.ctx.rid1=null;e.s.requests=[];
    e.s.popover={kind:'memo',target,text:'직접 쓴 메모'};
    assert.equal(steps[7].until(),true);steps[8].enter();
    assert.deepEqual(e.s.popover.target,{...phrases['학생 만족도'],endRef:'s0/p3',text:'학생 만족도',refs:['s0/p3']});
    assert.equal(e.s.popover.text,'직접 쓴 메모');
    e.s.memos=[{id:'new',...e.s.popover.target}];assert.equal(steps[8].until(),true,'실제 추가된 메모를 다음 단계에서 찾음');
  }
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
  const e=environment();const undo=step(buildAiReview(e),'반영한 제안 되돌리기');assert.equal(undo.action, undefined);assert.equal(undo.until(),false);
  e.s.requests=[{rid:1,example:true,status:'done'}];e.s.proposals=[{rid:1,pid:1,status:'rejected'},{rid:1,pid:2,status:'rejected'}];assert.equal(undo.until(),false);assert.equal(undo.lost(), 4);
  e.s.proposals[0].status='applied';e.d.undoProposal=async p=>{p.status='undone';};await e.d.undoProposal(e.s.proposals[0]);assert.equal(undo.until(),true);
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
test('직접 선택 단계는 다시 진입해도 대행 선택이나 창 열기를 실행하지 않는다', async () => {
  for (const build of [buildReportFlow, buildEditorBasics, buildAiReview]) {
    const e = environment(); let calls = 0;
    e.selectFor = e.d.openComposer = e.d.openPopover = () => { calls++; };
    const steps = build(e);
    const pick = steps.find(s => /고칠 글 고르기|의견을 남길 글 선택|글을 골라 요청 준비하기/.test(s.title));
    assert.equal(pick.action, undefined); assert.equal(pick.quick, undefined);
    pick.enter?.(); pick.until(); pick.enter?.(); pick.until(); assert.equal(calls, 0);
  }
});

test('연습 문단 주소가 이동하면 다른 문단을 덮어쓰지 않고 준비 지점을 찾는다',async()=>{
  const e=environment();e.s.paragraphs=[{ref:'s0/p0',text:'앞 문단'},{ref:'s0/p1',text:PRACTICE},{ref:'s0/p2',text:'뒤 문단'}];let writes=0;e.cw=()=>({debug:{text:()=> '다른 문단 내용'}});e.d.editor={applyText:async()=>{writes++;return{ok:true};}};e.d.saveDraftNow=async()=>{};e.d.refresh=async()=>{};
  const steps=buildEditorBasics(e);step(steps,'문장을 직접 고쳐 보기').enter();e.s.paragraphs.unshift({ref:'new',text:'새 문단'});e.s.paragraphs[2]={ref:'s0/p1',text:'다른 문단 내용'};
  assert.equal(step(steps,'고친 글 되돌리기').action,undefined);assert.equal(step(steps,'고친 글 되돌리기').lost(),2);assert.equal(writes,0);
});
test('문단 구조와 주변 본문이 유지된 정상 연습은 원래 문장으로 돌리고 큰 본문을 ctx에 복제하지 않는다',async()=>{
  const e=environment();e.s.paragraphs=[{ref:'s0/p0',text:'주변 본문'.repeat(20000)},{ref:'s0/p1',text:PRACTICE},{ref:'s0/p2',text:'뒤 문단'}];let text=PRACTICE;const calls=[];
  e.locate=()=>({ref:'s0/p1',start:0,end:[...PRACTICE].length});e.cw=()=>({debug:{text:()=>text}});e.d.editor={applyText:async operation=>{calls.push(operation);text=operation.replace;e.s.paragraphs[1].text=text;return{ok:true};}};e.d.saveDraftNow=async()=>{};e.d.refresh=async()=>{};
  const steps=buildEditorBasics(e);const edit=step(steps,'문장을 직접 고쳐 보기');const undo=step(steps,'고친 글 되돌리기');edit.enter();assert.ok(JSON.stringify(e.ctx).length<1000);
  assert.equal(edit.action,undefined);assert.equal(undo.action,undefined);text='직접 고친 문장';e.s.paragraphs[1].text=text;assert.equal(edit.until(),true);text=PRACTICE;e.s.paragraphs[1].text=text;assert.equal(undo.until(),true);assert.equal(calls.length,0);
  e.s.paragraphs[0].text='다른 문단도 변경';assert.equal(undo.until(),true);assert.equal(calls.length,0);
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
