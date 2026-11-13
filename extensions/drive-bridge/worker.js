import {serverFetch,serverJson,serverUrl} from './shared.js';
import {runDooray} from './runner.js';
export const ALARM='cowork-drive-background';
// 유휴 종료 시 알람으로 복구하고 작업 도착은 WebSocket으로 받는다. 별도 실행 창과 빠른 반복 폴링이 필요 없다.
export function createBridgeWorker({api=chrome,Socket=WebSocket,json=serverJson,request=serverFetch}={}){
  let connection=null,socket=null,pingTimer=null,generation=0,busy=false,wakeWanted=false,paused=false;
  let state={connected:false,message:'서버 연결이 필요합니다.',paused:false,logs:[]};
  const current=(c,g)=>connection===c&&generation===g;
  async function status(message,connected=false,errorCode=null){
    state={...state,message,connected,errorCode,paused,at:Date.now()};await api.storage.local.set({driveStatus:state});
    await api.action?.setBadgeText?.({text:connected?'':paused?'!':'…'});
  }
  async function log(message){state={...state,logs:[{at:Date.now(),message:String(message).slice(0,700)},...(state.logs||[])].slice(0,30)};await api.storage.local.set({driveStatus:state});}
  function closeSocket(){clearInterval(pingTimer);pingTimer=null;const old=socket;socket=null;if(old)try{old.close();}catch{}}
  async function fault(e,c,g){
    if(!current(c,g))return;const expired=e.status===401&&e.code==='DRIVE_BRIDGE_AUTH';
    paused=expired||['BRIDGE_HTML_RESPONSE','BRIDGE_BAD_JSON'].includes(e.code);if(paused)closeSocket();
    await status(expired?'서버 연결이 만료되었습니다. 확장 아이콘에서 새 코드로 연결하세요.':e.message,false,e.code||null);
  }
  async function execute(job,c){
    if(job.target?.provider!=='dooray')throw Error('현재 지원하지 않는 드라이브 작업입니다.');
    const headers={'x-drive-claim':job.claim};let blob=null;
    if(job.action==='upload'){const r=await request(c,`/api/drive/bridge/jobs/${job.id}/file`,{headers});blob=await r.blob();if(blob.size!==job.size||blob.size>job.maxBytes)throw Error('서버 파일 크기가 일치하지 않습니다.');}
    const result=await runDooray(job,blob,api);
    if(job.action==='download'){await request(c,`/api/drive/bridge/jobs/${job.id}/file`,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','x-file-name':encodeURIComponent(result.name),'x-file-mime':result.mime},body:result.blob});return {};}
    return result;
  }
  async function drain(){
    if(!connection||paused)return;if(busy){wakeWanted=true;return;}busy=true;const c=connection,g=generation;
    try{
      do{
        wakeWanted=false;
        for(let i=0;i<8&&current(c,g)&&!paused;i++){
          const {job}=await json(c,'/api/drive/bridge/jobs');if(!current(c,g))return;
          if(!job){await status('백그라운드 연결됨 · 창을 닫아도 동작합니다.',true);break;}
          await status('파일 작업 중…',true);await api.storage.local.set({driveInFlight:{id:job.id,action:job.action,at:Date.now()}});
          let body;try{body={result:await execute(job,c)};}catch(e){body={error:String(e.message||e).slice(0,700)};}
          if(!current(c,g))return;
          // 결과 회신이 끊겨도 원격 쓰기를 반복하지 않는다. 서버 작업은 한 번만 선점한다.
          await json(c,`/api/drive/bridge/jobs/${job.id}/result`,{method:'POST',headers:{'Content-Type':'application/json','x-drive-claim':job.claim},body:JSON.stringify(body)});
          await api.storage.local.remove('driveInFlight');await log(body.error||`${job.target.provider} ${job.action} 완료`);
        }
      }while(wakeWanted&&current(c,g)&&!paused);
    }catch(e){await fault(e,c,g);}finally{busy=false;if(wakeWanted&&!paused&&connection)queueMicrotask(()=>{void drain();});}
  }
  function connectSocket(){
    if(!connection||paused||socket)return;const c=connection,g=generation,u=new URL(serverUrl(c.server));u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/api/drive/bridge/events';
    let ws;try{ws=new Socket(u.href,['cowork-drive-v1',c.token,'v-'+api.runtime.getManifest().version]);}catch{void drain();return;}socket=ws;
    ws.onopen=()=>{if(!current(c,g)||socket!==ws){ws.close();return;}pingTimer=setInterval(()=>{if(socket===ws&&ws.readyState===1)ws.send(JSON.stringify({type:'ping'}));},20000);void drain();};
    ws.onmessage=e=>{if(!current(c,g)||socket!==ws)return;try{const m=JSON.parse(e.data);if(m.type==='work'||m.type==='ready')void drain();}catch{}};
    ws.onerror=()=>{};ws.onclose=()=>{if(socket!==ws)return;socket=null;clearInterval(pingTimer);pingTimer=null;if(current(c,g)&&!paused)void drain();};
  }
  async function ensure(manual=false){
    const saved=await api.storage.local.get(['connection','driveStatus']);const next=saved.connection;if(!next){await stop(false);return {ok:false};}
    if(!connection||connection.token!==next.token||connection.server!==next.server){generation++;closeSocket();connection=next;paused=!manual&&saved.driveStatus?.paused===true;state={connected:false,message:'백그라운드 연결 중…',paused,logs:[]};}
    if(manual)paused=false;if(!await api.alarms.get(ALARM))await api.alarms.create(ALARM,{periodInMinutes:0.5});
    if(!paused){const live=socket?.readyState===1;connectSocket();if(manual||!live)void drain();}return {ok:!paused};
  }
  async function stop(remove=true){generation++;connection=null;paused=false;closeSocket();await api.alarms.clear(ALARM);if(remove)await api.storage.local.remove('connection');await status('연결을 해제했습니다.');return {ok:true};}
  async function disconnect(){const c=connection;if(c)await request(c,'/api/drive/bridge/disconnect',{method:'POST'}).catch(()=>{});return stop();}
  return {ensure,drain,stop,disconnect,getStatus:()=>state};
}
