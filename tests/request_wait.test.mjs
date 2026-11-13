import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWait, tutorialWaitText } from '../web/request-wait.js';

test('ChatGPT receipt means waiting to start, not processing or manual copying',()=>{
  const r={status:'pending',automation:{method:'mcp-events',state:'delivered'}};
  assert.equal(requestWait(r).label,'ChatGPT 실행 대기');
  assert.equal(requestWait(r).manualCopy,false);
  assert.match(tutorialWaitText(r),/작업을 시작하기를 기다리/);
  assert.doesNotMatch(tutorialWaitText(r),/10~40|API가|작성하고/);
  assert.match(tutorialWaitText({...r,status:'working'}),/ChatGPT.*작성하고/);
});

test('disconnected and failed event delivery do not promise automatic processing',()=>{
  for(const state of ['needs_subscription','failed']){
    const wait=requestWait({automation:{method:'mcp-events',state}});
    assert.equal(wait.manualCopy,true);assert.doesNotMatch(wait.text,/알림을 받았습니다/);
  }
  assert.equal(requestWait({status:'pending'}),null);
  assert.match(tutorialWaitText({status:'pending',delivery:{at:'now'}}),/전달했습니다/);
});
