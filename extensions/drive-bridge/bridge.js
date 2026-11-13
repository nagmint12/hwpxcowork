// 이 페이지는 선택적인 두레이 연결 상태 화면이다. 작업 실행은 background 서비스 워커가 맡는다.
const status=document.querySelector('#status');
const saved=await chrome.storage.local.get(['connection','driveStatus']);
document.querySelector('#account').textContent=saved.connection?`${saved.connection.user} · ${saved.connection.server}`:'확장 아이콘에서 cowork 서버를 연결하세요.';
function render(state){
  status.textContent=state?.message||'백그라운드 연결을 준비하고 있습니다…';
  const list=document.querySelector('#log');list.replaceChildren();
  for(const item of state?.logs||[]){const li=document.createElement('li');li.textContent=new Date(item.at).toLocaleTimeString('ko-KR')+' '+item.message;list.append(li);}
}
render(saved.driveStatus);
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.driveStatus)render(changes.driveStatus.newValue);});
const command=async action=>{try{const result=await chrome.runtime.sendMessage({action});if(result?.error)throw Error(result.error);}catch(e){status.textContent=e.message;}};
document.querySelector('#disconnect').onclick=()=>command('disconnect');document.querySelector('#retry').onclick=()=>command('startBackground');
document.querySelector('#login').onclick=()=>command('openDooray');
if(saved.connection)await command('startBackground');
