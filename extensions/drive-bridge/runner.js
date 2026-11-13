import {doorayAction} from './dooray.js';
import {base64ToBytes,bytesToBase64,DOORAY_DISCOVERY,doorayOrigin} from './shared.js';

export async function personalTab(api=chrome,onCreated=()=>{},projectId=null,origin=null) {
  origin ||= await doorayOrigin(api);
  if(!await api.permissions.contains({origins:[origin+'/*']}))throw Error('확장프로그램의 두레이 사이트 접근을 허용하세요.');
  const tabs=await api.tabs.query({url:origin+'/drive/*'});
  const isPersonal=tab=>{try{const u=new URL(tab.url),id=/^\/drive\/(\d+)(?:\/|$)/.exec(u.pathname)?.[1];return u.origin===origin&&!!id&&(!projectId||id===projectId);}catch{return false;}};
  const tab=tabs.find(isPersonal);if(tab)return tab.id;
  const created=await api.tabs.create({url:origin+'/drive/'+(projectId||''),active:false});
  onCreated(created.id);
  for(let i=0;i<60;i++){const t=await api.tabs.get(created.id);if(t.status==='complete'){if(!isPersonal(t))throw Error('이 브라우저에서 두레이에 직접 로그인한 뒤 개인 프로젝트를 열어 주세요.');return t.id;}await new Promise(r=>setTimeout(r,250));}
  throw Error('두레이 탭을 열지 못했습니다. 직접 로그인 후 다시 시도하세요.');
}
export async function runDooray(job,blob,api=chrome) {
  if(job.target?.provider&&job.target.provider!=='dooray')throw Error('현재 지원하지 않는 드라이브입니다.');
  const discovery=job.action==='projects';
  if(!/^\d{1,30}$/.test(job.target?.projectId||'')&&!(['projects','login'].includes(job.action)&&job.target?.projectId===DOORAY_DISCOVERY))throw Error('개인 프로젝트 밖의 작업은 차단되었습니다.');
  const origin=await doorayOrigin(api);
  if(!await api.permissions.contains({origins:[origin+'/*']}))throw Error('확장프로그램의 두레이 사이트 접근을 허용하세요.');
  if(job.action==='login'){await api.tabs.create({url:origin+'/drive/',active:true});return {opened:true};}
  const execute=async(tabId,args)=>{
    let out;try{out=await api.scripting.executeScript({target:{tabId},func:doorayAction,args:[{...job,...args,origin,transport:true}]});}catch(e){throw Error('두레이 탭 실행에 실패했습니다. 사이트 접근 권한과 로그인 상태를 확인하세요. '+String(e.message||e).slice(0,200));}
    const result=out[0]?.result;if(result?.ok!==true)throw Error(result?.error||'두레이 페이지에서 응답을 받지 못했습니다. 로그인 상태를 확인하세요.');return result.value;
  };
  if(discovery){
    const tabs=await api.tabs.query({url:origin+'/drive/*'});
    const found=new Map();
    for(const tab of tabs){
      const u=new URL(tab.url);if(u.origin!==origin||!/^\/drive\/\d+(?:\/|$)/.test(u.pathname))continue;
      try{const result=await execute(tab.id,{});for(const p of result.projects||[])if(p.type==='private')found.set(p.id,p);}catch{/* 공유 프로젝트·만료된 로그인 탭은 선택하지 않는다. */}
    }
    if(found.size>1)throw Error('서로 다른 개인 프로젝트 탭이 열려 있습니다. 연결할 개인 프로젝트만 열고 다시 시도하세요.');
    if(found.size===1)return {projects:[...found.values()]};
    // 기본 드라이브 주소가 개인 프로젝트로 이동하는 브라우저도 지원한다.
  }
  let helperId=null;
  try{
  const tabId=await personalTab(api,id=>{helperId=id;},discovery?null:job.target.projectId,origin);
  const exec=args=>execute(tabId,args);
  if(['projects','list','delete','rename'].includes(job.action))return exec({});
  let transferId;
  try{
    if(job.action==='download'){
      const info=await exec({action:'downloadStart'});transferId=info.transferId;const parts=[];
      for(let offset=0;offset<info.size;offset+=262144){const chunk=await exec({action:'downloadChunk',transferId,offset});const b=base64ToBytes(chunk.data);if(b.length!==Math.min(262144,info.size-offset))throw Error('다운로드 조각 크기가 일치하지 않습니다.');parts.push(b);}
      return {blob:new Blob(parts,{type:info.mime}),name:info.name,mime:info.mime};
    }
    transferId=(await exec({action:'uploadStart'})).transferId;
    for(let offset=0;offset<blob.size;offset+=262144)await exec({action:'uploadChunk',transferId,data:bytesToBase64(new Uint8Array(await blob.slice(offset,offset+262144).arrayBuffer()))});
    return await exec({action:'uploadCommit',transferId});
  }finally{if(transferId)await exec({action:'release',transferId}).catch(()=>{});}
  }finally{if(helperId!=null)try{const tab=await api.tabs.get(helperId);if(!tab.active)await api.tabs.remove(helperId);}catch{}}
}
