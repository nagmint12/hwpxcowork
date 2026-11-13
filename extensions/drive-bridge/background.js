import {createBridgeWorker,ALARM} from './worker.js';
import {doorayOrigin} from './shared.js';
const worker=createBridgeWorker();
chrome.runtime.onInstalled.addListener(async()=>{
  await chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.storage.session?.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  await worker.ensure();
});
chrome.runtime.onStartup.addListener(()=>{void worker.ensure();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void worker.ensure();});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.connection)void(changes.connection.newValue?worker.ensure(true):worker.stop(false));});
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  const respond=p=>{Promise.resolve(p).then(reply).catch(e=>reply({error:e.message}));return true;};
  if(msg?.action==='startBackground')return respond(worker.ensure(true));
  if(msg?.action==='getStatus')return respond(worker.getStatus());
  if(msg?.action==='disconnect')return respond(worker.disconnect());
  if(msg?.action==='openDooray')return respond(doorayOrigin().then(origin=>chrome.tabs.create({url:origin+'/drive/',active:true})).then(()=>({ok:true})));
  if(msg?.action==='openRunner')return respond(chrome.tabs.query({url:chrome.runtime.getURL('bridge.html')}).then(tabs=>tabs.length?chrome.tabs.update(tabs[0].id,{active:true}):chrome.tabs.create({url:chrome.runtime.getURL('bridge.html')})).then(()=>({ok:true})));
});
void worker.ensure();
