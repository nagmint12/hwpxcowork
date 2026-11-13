import {serverUrl,serverJson,doorayUrl} from './shared.js';
const status=document.querySelector('#status');
const site=await chrome.storage.local.get('doorayOrigin');document.querySelector('#dooray-origin').value=site.doorayOrigin||'';
document.querySelector('#dooray-settings').onsubmit=async e=>{
  e.preventDefault();try{
    const origin=doorayUrl(document.querySelector('#dooray-origin').value);
    if(!await chrome.permissions.request({origins:[origin+'/*']}))throw Error('선택한 두레이 사이트 접근 권한이 필요합니다.');
    const current=await chrome.storage.local.get(['doorayOrigin','connection']);
    if(current.connection&&current.doorayOrigin!==origin){const result=await chrome.runtime.sendMessage({action:'disconnect'});if(result?.error)throw Error(result.error);}
    await chrome.storage.local.set({doorayOrigin:origin});status.textContent='두레이 주소를 저장했습니다. 같은 브라우저에서 로그인하고 개인 프로젝트를 연 뒤 cowork 서버에 연결하세요.';
  }catch(e){status.textContent=e.message;}
};
const saved=await chrome.storage.local.get(['connection','driveStatus']);document.querySelector('#server').value=saved.connection?.server||'';status.textContent=saved.driveStatus?.message||'';
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.driveStatus)status.textContent=changes.driveStatus.newValue?.message||'';});
// 한 번 쓰는 연결 코드를 확장 토큰으로 바꾸고 백그라운드 연결을 시작한다(코드 입력·버튼 연결 공통)
async function finishPair(server,code){
  const data=await serverJson({server},'/api/drive/bridge/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  if(typeof data.token!=='string'||typeof data.user!=='string')throw Error('cowork 연결 응답이 올바르지 않습니다. 서버 주소를 확인하세요.');
  await chrome.storage.local.set({connection:{server,token:data.token,user:data.user}});
  const started=await chrome.runtime.sendMessage({action:'startBackground'});if(started?.error)throw Error(started.error);
  status.textContent=`${data.user} 계정으로 연결했습니다. 별도 창을 켜 둘 필요가 없습니다.`;
}
document.querySelector('#pair').onsubmit=async e=>{
  e.preventDefault();try{
    const server=serverUrl(document.querySelector('#server').value);
    const granted=await chrome.permissions.request({origins:[server+'/*']});if(!granted)throw Error('선택한 cowork 서버 접근 권한이 필요합니다.');
    await finishPair(server,document.querySelector('#code').value);document.querySelector('#code').value='';
  }catch(e){status.textContent=e.message;}
};
document.querySelector('#runner').onclick=async()=>{try{const result=await chrome.runtime.sendMessage({action:'openRunner'});if(result?.error)throw Error(result.error);}catch(e){status.textContent=e.message;}};
document.querySelector('#login').onclick=async()=>{try{const result=await chrome.runtime.sendMessage({action:'openDooray'});if(result?.error)throw Error(result.error);}catch(e){status.textContent=e.message;}};
// 버튼 하나로 연결: 아이콘을 누른 탭이 로그인한 cowork 화면이면, 그 탭 안에서 cowork 토큰으로 연결 코드를 받아 온다.
// cowork 토큰은 탭 밖(확장)으로 나오지 않고 5분짜리 한 번 쓰는 코드만 넘어온다. 탭 접근은 아이콘을 누른 동안만(activeTab).
const [tab]=await chrome.tabs.query({active:true,currentWindow:true}).catch(()=>[]);
let origin=null;try{if(tab?.url)origin=serverUrl(new URL(tab.url).origin);}catch{origin=null;}
if(origin&&tab?.id!=null){
  const probe=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{try{const r=await fetch(location.origin+'/api/config',{headers:{'ngrok-skip-browser-warning':'1'}});const j=await r.json();return {cowork:j?.name==='hwpx-cowork',loggedIn:!!localStorage.getItem('hwpx.token')};}catch{return {cowork:false};}}}).catch(()=>null);
  const info=probe?.[0]?.result;
  if(info?.cowork){
    document.querySelector('#quick').hidden=false;document.querySelector('#quick-none').hidden=true;
    document.querySelector('#quick-text').textContent=info.loggedIn?`${origin} — 이 화면에 로그인한 계정으로 연결합니다.`:`${origin} — 이 화면에서 먼저 cowork 에 로그인하세요.`;
    document.querySelector('#quick-connect').disabled=!info.loggedIn;
    document.querySelector('#quick-connect').onclick=async()=>{
      try{
        // 권한 요청은 클릭 직후 먼저(사용자 동작 안에서) 한다
        const granted=await chrome.permissions.request({origins:[origin+'/*']});if(!granted)throw Error('이 cowork 서버 접근 권한이 필요합니다.');
        status.textContent='연결하는 중…';
        const out=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
          const token=localStorage.getItem('hwpx.token');if(!token)return {error:'login'};
          const r=await fetch(location.origin+'/api/drive/pair',{method:'POST',headers:{Authorization:'Bearer '+token,'ngrok-skip-browser-warning':'1'}});
          if(!r.ok)return {error:'HTTP '+r.status};const j=await r.json();return {code:j.code};
        }});
        const result=out?.[0]?.result;
        if(result?.error==='login')throw Error('이 화면에서 먼저 cowork 에 로그인하세요.');
        if(typeof result?.code!=='string')throw Error('연결 코드를 받지 못했습니다'+(result?.error?` (${result.error})`:'')+'. 화면을 새로 고친 뒤 다시 누르세요.');
        await finishPair(origin,result.code);
      }catch(e){status.textContent=e.message;}
    };
  }
}
