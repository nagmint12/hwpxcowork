import { DriveService } from '../drive.js';
import { createDrivePackage } from '../drive-package.js';

export function installDriveRoutes({ app, service, config, auth, wrap, rawAttachment, bodyBytes, safeDecode, root }) {
  const drive = new DriveService({ config, service }); service.drive = drive;
  const bridge = (req,res,next) => { try { req.user=drive.bridge(/^Bearer (.+)$/i.exec(req.headers.authorization||'')?.[1],req.get('x-cowork-drive-version'));next(); }catch(e){res.status(e.status||401).json({error:e.code,message:e.message});} };
  const claim=req=>req.get('x-drive-claim');
  const send=(res,f)=>res.set({'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.entry.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}).send(f.bytes);
  app.use('/api/drive', (req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/api/drive',auth,wrap(async(req,res)=>res.json(drive.status(req.user))));
  app.post('/api/drive/pair',auth,wrap(async(req,res)=>res.json(drive.pairCode(req.user))));
  app.delete('/api/drive/connection',auth,wrap(async(req,res)=>res.json(drive.disconnect(req.user))));
  app.get('/api/drive/extension.zip',auth,wrap(async(req,res)=>res.type('zip').attachment('cowork-drive-bridge.zip').send(await createDrivePackage(root))));
  app.post('/api/drive/jobs',auth,wrap(async(req,res)=>res.json(drive.create(req.user,req.body))));
  app.get('/api/drive/jobs/:job',auth,wrap(async(req,res)=>res.json(drive.deliver(req.user,req.params.job))));
  app.post('/api/drive/ai-context',auth,wrap(async(req,res)=>res.json(drive.allowAi(req.user,req.body.allowed))));
  app.post('/api/drive/proposals/:id',auth,wrap(async(req,res)=>res.json(drive.resolveProposal(req.user,req.params.id,req.body.accept===true))));
  app.post('/api/drive/files',auth,rawAttachment,wrap(async(req,res)=>res.json(drive.stage(req.user,bodyBytes(req),safeDecode(req.get('x-file-name')||'','file'),req.get('x-file-mime')))));
  app.get('/api/drive/files/:file',auth,wrap(async(req,res)=>send(res,drive.bytes(req.user,req.params.file))));
  app.delete('/api/drive/files/:file',auth,wrap(async(req,res)=>res.json(drive.deleteFile(req.user,req.params.file))));
  app.post('/api/drive/files/:file/open',auth,wrap(async(req,res)=>res.json(await drive.importDocument(req.user,req.params.file,req.body?.location))));
  app.post('/api/drive/documents/:id/stage',auth,wrap(async(req,res)=>res.json(await drive.prepareDocument(req.user,req.params.id))));
  app.post('/api/drive/files/:file/attach',auth,wrap(async(req,res)=>{const f=drive.bytes(req.user,req.params.file);service.assertDocRead(req.body?.docId,req.user);res.json(await service.addAttachment(req.body.docId,{name:f.entry.name,bytes:f.bytes},req.user));}));
  // 이 API는 브라우저 확장 전용 토큰만 받는다. 일반 cowork 토큰·두레이 쿠키는 사용하지 않는다.
  app.post('/api/drive/bridge/pair',wrap(async(req,res)=>res.json(drive.pair(req.body?.code))));
  app.get('/api/drive/bridge/jobs',bridge,wrap(async(req,res)=>res.json(drive.claim(req.user))));
  app.post('/api/drive/bridge/disconnect',bridge,wrap(async(req,res)=>res.json(drive.disconnect(req.user))));
  app.get('/api/drive/bridge/jobs/:job/file',bridge,wrap(async(req,res)=>{const j=drive.claimed(req.user,req.params.job,claim(req));if(j.action!=='upload')return res.status(409).json({message:'업로드 작업이 아닙니다.'});send(res,drive.bytes(req.user,j.payload.stagedId));}));
  app.post('/api/drive/bridge/jobs/:job/file',bridge,rawAttachment,wrap(async(req,res)=>res.json(drive.receive(req.user,req.params.job,claim(req),bodyBytes(req),safeDecode(req.get('x-file-name')||'','file'),req.get('x-file-mime')))));
  app.post('/api/drive/bridge/jobs/:job/result',bridge,wrap(async(req,res)=>res.json(drive.finish(req.user,req.params.job,claim(req),req.body))));
  return drive;
}
