// 파일·로그인 정보는 싣지 않고, 개인 브리지에 작업 도착만 알린다. 토큰을 URL에 넣지 않는다.
import {WebSocketServer,WebSocket} from 'ws';
export function createDriveSocket(drive){
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,handleProtocols:protocols=>protocols.has('cowork-drive-v1')?'cowork-drive-v1':false});
  const owners=new Map();
  const notify=owner=>{for(const ws of owners.get(owner)||[])if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'work'}));};
  const revoke=owner=>{for(const ws of owners.get(owner)||[])ws.close(4001,'Reconnect required');};
  drive.events.on('work',notify);drive.events.on('connection',revoke);
  return {
    upgrade(req,socket,head){
      const protocols=String(req.headers['sec-websocket-protocol']||'').split(',').map(s=>s.trim());
      const token=protocols[1],version=/^v-(\d+\.\d+\.\d+)$/.exec(protocols[2]||'')?.[1]||'';
      let user;try{if(protocols[0]!=='cowork-drive-v1'||!/^\w{64}$/.test(token||''))throw Error('auth');user=drive.bridge(token,version);}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
      const owner=drive.owner(user);
      wss.handleUpgrade(req,socket,head,ws=>{
        if(!owners.has(owner))owners.set(owner,new Set());owners.get(owner).add(ws);
        ws.on('error',()=>{});
        ws.on('close',()=>{owners.get(owner)?.delete(ws);if(!owners.get(owner)?.size)owners.delete(owner);});
        ws.on('message',raw=>{try{const m=JSON.parse(String(raw));if(m.type!=='ping')return;drive.bridge(token,version);ws.send(JSON.stringify({type:'pong'}));}catch{ws.close(4001,'Reconnect required');}});
        ws.send(JSON.stringify({type:'ready'}));
      });
    },
    close(){drive.events.off('work',notify);drive.events.off('connection',revoke);for(const set of owners.values())for(const ws of set)ws.terminate();owners.clear();wss.close();},
  };
}
