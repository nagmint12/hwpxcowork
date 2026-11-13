// 브라우저 로그인은 브라우저에만 둔다. 서버는 전송 파일·일회성 작업만 보관한다.
// 2026-10-30 정책: 폴더 목록은 그 사용자 화면에만 보인다 — 서버는 확장이 보낸 목록을 메모리에서 한 번 건네주고 지우며 디스크에 쓰지 않는다.
// AI 는 드라이브를 쓰지 않는다(DRIVE_AI_ENABLED=false: 목록 공유·업로드 제안·파일 준비 MCP 도구 없음). 소스는 다시 켤 때를 위해 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import { ServiceError } from './service.js';

export const DOORAY_DISCOVERY = 'personal';
export const DRIVE_MAX_BYTES = 50 * 1024 * 1024;
/** AI 드라이브 기능(현재 폴더 목록을 AI 에 보여주기·AI 업로드 제안·prepare_drive_file). 다시 쓰려면 true — 그때는 목록이 서버 디스크(context)에 남는다 */
export const DRIVE_AI_ENABLED = false;
const projectId = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const newer = (v, min) => { const a = String(v || '0').split('.').map(Number), b = min.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; } return true; };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const id = () => crypto.randomBytes(16).toString('hex');
const fail = (code, message, status = 400) => { throw new ServiceError(code, message, status); };
const safeId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(s);
const providers = new Set(['dooray']);
const activeTarget = target => providers.has(target?.provider) && (projectId(target.projectId) || target.projectId === DOORAY_DISCOVERY);
const actions = new Set(['projects', 'list', 'download', 'upload', 'login', 'delete', 'rename']);
export function fileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\\/\x00-\x1f]/.test(value) || ['.', '..'].includes(value)) fail('DRIVE_NAME', '올바른 파일 이름을 지정하세요.');
  return value.trim();
}
export function validateTarget(v) {
  if (!v || typeof v.provider !== 'string' || !safeId(v.projectId) || !safeId(v.folderId || 'root')) fail('DRIVE_TARGET', '드라이브·프로젝트·폴더를 확인하세요.');
  if (!providers.has(v.provider)) fail('DRIVE_PROVIDER_DISABLED', '현재 연결할 수 없는 드라이브입니다.', 403);
  if (!activeTarget(v)) fail('DRIVE_SCOPE', '올바른 두레이 개인 프로젝트를 선택하세요.', 403);
  return { provider: v.provider, projectId: v.projectId, folderId: v.folderId || 'root' };
}
export class DriveService {
  constructor({ config, service, now = Date.now, aiEnabled = DRIVE_AI_ENABLED }) {
    this.service = service; this.now = now; this.aiEnabled = aiEnabled === true; this.dir = path.join(config.dataDir, 'drive'); this.config = config;
    this.pairs = new Map(); this.jobs = new Map(); this.sessions = new Map();
    this.events=new EventEmitter();
    this.maxBytes = Math.min(config.attachments?.maxBytes || DRIVE_MAX_BYTES, DRIVE_MAX_BYTES);
    this.restoreSessions();
  }
  // 브라우저 연결(확장 토큰의 해시만)을 사용자별 index.json 에 남겨 서버를 다시 켜도 다시 연결하지 않게 한다(2026-10-30)
  restoreSessions() {
    let owners = [];
    try { owners = fs.readdirSync(this.dir); } catch { return; }
    for (const owner of owners) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(this.dir, owner, 'index.json'), 'utf8')).bridge;
        if (b && /^[0-9a-f]{64}$/.test(b.tokenHash || '') && typeof b.user?.name === 'string' && hash(b.user.name) === owner) this.sessions.set(owner, { tokenHash: b.tokenHash, user: { name: b.user.name, role: b.user.role }, lastSeen: null, version: b.version || null, projectId: projectId(b.projectId) ? b.projectId : null });
      } catch { /* 깨진 파일은 연결 없음으로 */ }
    }
  }
  rememberBridge(user, session) { const state = this.read(user); state.bridge = session ? { tokenHash: session.tokenHash, user: session.user, version: session.version || null, projectId: session.projectId || null, pairedAt: new Date(this.now()).toISOString() } : null; this.save(user, state); }
  owner(user) { if (!user?.name) fail('DRIVE_AUTH', '로그인이 필요합니다.', 401); return hash(user.name); }
  read(user) {
    const owner = this.owner(user); const p = path.join(this.dir, owner, 'index.json');
    let state;
    try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) { if (e.code !== 'ENOENT') throw e; return { files: [], context: null, bridge: null, proposals: [] }; }
    // AI 기능을 끈 동안에는 예전에 남은 폴더 목록(context)을 디스크에서 지운다 — 목록은 서버에 저장하지 않는다
    if (!this.aiEnabled && state.context) { state.context = null; this.save(user, state); }
    return state;
  }
  save(user, state) {
    const dir = path.join(this.dir, this.owner(user)); fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, 'index.tmp'); fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, path.join(dir, 'index.json'));
  }
  publicFile(f) { const { disk, ...out } = f; return out; }
  status(user) {
    this.expire(); const state = this.read(user); const session = this.sessions.get(this.owner(user));
    return { connected: !!session && session.lastSeen != null && this.now() - session.lastSeen < 70000, maxBytes: this.maxBytes,
      bridge: { paired:!!session, version:session?.version||null, lastSeenAt:session?.lastSeen!=null?new Date(session.lastSeen).toISOString():null, minimumVersion:'0.6.0' },
      providers: [{ id: 'dooray', name: '두레이', projectId: session?.projectId || null, scope: '개인 프로젝트', loginUrl: null }],
      aiEnabled: this.aiEnabled, writeProjects: session?.projectId ? [session.projectId] : [],
      context: this.aiEnabled && activeTarget(state.context) ? state.context : null, files: state.files.map(f => this.publicFile(f)), proposals: this.aiEnabled ? state.proposals.filter(p => activeTarget(p.target)) : [],
      // 작업 목록에는 결과(폴더 목록·파일 이름)를 싣지 않는다 — 결과는 그 작업을 요청한 화면이 한 번만 받는다(deliver)
      jobs: [...this.jobs.values()].filter(j => j.owner === this.owner(user) && activeTarget(j.target)).slice(-20).map(j => this.jobView(j, false)) };
  }
  pairCode(user) {
    this.expire(); for (const [k,v] of this.pairs) if (v.user.name === user.name) this.pairs.delete(k);
    const code = crypto.randomBytes(9).toString('hex').toUpperCase();
    this.pairs.set(code, { user: { name:user.name, role:user.role }, expires: this.now()+300000 });
    return { code, expiresAt: new Date(this.now()+300000).toISOString() };
  }
  pair(code) {
    this.expire(); const pair = this.pairs.get(String(code || '').replace(/\s|-/g,'').toUpperCase());
    if (!pair) fail('DRIVE_PAIR', '연결 코드가 없거나 만료되었습니다.', 401);
    this.pairs.delete(String(code).replace(/\s|-/g,'').toUpperCase());
    const token = id()+id(); const owner = this.owner(pair.user);
    const session = { tokenHash: hash(token), user: pair.user, lastSeen: null };
    this.sessions.set(owner, session); this.rememberBridge(pair.user, session);
    this.events.emit('connection',owner);
    return { token, user: pair.user.name, maxBytes: this.maxBytes };
  }
  bridge(token, version = '') {
    const digest = hash(String(token || ''));
    for (const [owner, s] of this.sessions) if (s.tokenHash === digest) {
      // 지운 사용자의 연결은 받지 않고, 역할은 지금 설정을 따른다(다시 켠 뒤 되살린 연결 포함)
      if (Array.isArray(this.config.users)) {
        const current = this.config.users.find(u => u.name === s.user.name);
        if (!current) { this.sessions.delete(owner); try { this.rememberBridge(s.user, null); } catch { /* 기록 실패는 무시 */ } break; }
        s.user = { name: current.name, role: current.role || 'editor' };
      }
      s.lastSeen = this.now();if(/^\d+\.\d+\.\d+$/.test(version))s.version=version;return s.user;
    }
    fail('DRIVE_BRIDGE_AUTH', '확장프로그램을 다시 연결하세요.', 401);
  }
  disconnect(user) {
    if (this.sessions.delete(this.owner(user))) this.rememberBridge(user, null);
    this.events.emit('connection',this.owner(user));
    for (const [k,v] of this.pairs) if(v.user.name===user.name)this.pairs.delete(k);
    for (const j of this.jobs.values()) if (j.owner === this.owner(user) && ['pending','running'].includes(j.status)) { j.status = 'failed'; j.error = '연결이 해제되었습니다. 실행 중이던 전송은 드라이브에서 결과를 확인하세요.'; }
    return { ok: true };
  }
  expire() {
    for (const [k,p] of this.pairs) if (p.expires < this.now()) this.pairs.delete(k);
    for (const [k,j] of this.jobs) {
      if (this.now()-j.created > 600000) this.jobs.delete(k);
      else if (['pending','running'].includes(j.status) && this.now()-j.created > 180000) { const pending=j.status==='pending'; j.status = 'failed'; j.error = pending ? '확장프로그램 응답 시간이 지났습니다.' : '응답 시간이 지났습니다. 드라이브 결과를 확인하세요. 자동으로 재전송하지 않습니다.'; }
    }
  }
  jobView(j, withResult = true) { return { id:j.id, action:j.action, provider:j.target.provider, status:j.status, result:withResult ? j.result || null : null, error:j.error || null }; }
  /** 화면이 작업 결과를 받는다(GET /api/drive/jobs/:id). 끝난 작업의 결과(목록·파일 이름)는 건넨 뒤 메모리에서도 지운다 — 다시 읽으면 delivered */
  deliver(user, jobId) {
    const j = this.job(user, jobId); const view = this.jobView(j);
    if (j.status === 'done') { view.delivered = !!j.delivered; j.result = null; j.delivered = true; }
    return view;
  }
  job(user, jobId) { this.expire(); const j=this.jobs.get(jobId); if(!j || j.owner!==this.owner(user))fail('DRIVE_JOB','전송 작업이 없습니다.',404); return j; }
  create(user, body) {
    this.expire(); const target=validateTarget(body); if(!actions.has(body.action))fail('DRIVE_ACTION','지원하지 않는 작업입니다.');
    const session=this.sessions.get(this.owner(user)); if(!session || session.lastSeen==null || this.now()-session.lastSeen>70000)fail('DRIVE_OFFLINE','확장프로그램에 서버를 연결해 주세요. 백그라운드 연결 상태는 확장 아이콘에서 확인할 수 있습니다.',409);
    if (!newer(session.version, '0.6.0')) fail('DRIVE_BRIDGE_OLD', '사용자별 드라이브 연결을 위해 확장을 0.6.0 이상으로 업데이트하세요.', 409);
    if (!['projects','login'].includes(body.action) && (!projectId(target.projectId) || target.projectId !== session.projectId)) fail('DRIVE_SCOPE', '이 계정에 연결된 개인 프로젝트를 먼저 확인하세요. 드라이브를 새로 연결하거나 새로고침하세요.', 403);
    if ([...this.jobs.values()].filter(j=>j.owner===this.owner(user)&&['pending','running'].includes(j.status)).length >= 4)fail('DRIVE_BUSY','진행 중인 전송이 끝난 뒤 다시 시도하세요.',409);
    const payload={ page:Math.max(0,Math.min(1000,Number(body.page)||0)), pageToken:String(body.pageToken||'').slice(0,3000) };
    if (body.action === 'delete' || body.action === 'rename') {
      if (!safeId(body.fileId)) fail('DRIVE_FILE_ID', '파일을 선택하세요.');
      payload.fileId = body.fileId; payload.expectedRevision = String(body.expectedRevision || '').slice(0, 200);
      if (!payload.expectedRevision) fail('DRIVE_REVISION', '대상 파일의 최신 정보를 다시 읽어 주세요.', 409);
      if (body.action === 'rename') payload.name = fileName(body.name);
    }
    if (body.action === 'download' || body.replaceId) {
      if(!safeId(body.fileId || body.replaceId))fail('DRIVE_FILE_ID','파일을 선택하세요.');
      payload.fileId=body.fileId || body.replaceId; payload.expectedRevision=String(body.expectedRevision || '').slice(0,200);
      if(body.replaceId && !payload.expectedRevision)fail('DRIVE_REVISION','교체 대상의 최신 정보를 다시 읽어 주세요.',409);
    }
    if(body.action==='upload') {
      const state=this.read(user); const f=state.files.find(f=>f.id===body.stagedId); if(!f)fail('DRIVE_LOCAL_FILE','서버 파일을 선택하세요.',404);
      Object.assign(payload,{ stagedId:f.id, name:fileName(body.name || f.name), size:f.size, mime:f.mime, replaceId:body.replaceId || null });
    }
    const j={ id:id(),owner:this.owner(user),target,action:body.action,payload,status:'pending',created:this.now() };
    this.jobs.set(j.id,j);this.events.emit('work',j.owner); return this.jobView(j);
  }
  claim(user) {
    this.expire(); const owner=this.owner(user);
    if([...this.jobs.values()].some(j=>j.owner===owner&&j.status==='running'))return {job:null};
    const j=[...this.jobs.values()].find(j=>j.owner===owner&&j.status==='pending'&&activeTarget(j.target)); if(!j)return {job:null};
    j.status='running'; j.claim=id(); return {job:{id:j.id,claim:j.claim,action:j.action,target:j.target,...j.payload,maxBytes:this.maxBytes}};
  }
  claimed(user,jobId,claim) { const j=this.job(user,jobId); if(j.status!=='running'||j.claim!==claim)fail('DRIVE_CLAIM','이미 종료되었거나 다른 실행기의 작업입니다.',409);return j; }
  finish(user,jobId,claim,body) {
    const j=this.claimed(user,jobId,claim);
    if(body.error) {j.status='failed';j.error=String(body.error).slice(0,700);return this.jobView(j);}
    if(j.action==='download'&&!j.stagedId)fail('DRIVE_BYTES','파일 바이트가 도착하지 않았습니다.',409);
    const result=body.result || {};
    if(j.action==='login') {
      j.result={opened:result.opened===true};
    } else if(j.action==='list') {
      if(!Array.isArray(result.items)||result.items.length>100)fail('DRIVE_LIST','폴더 목록 형식이 올바르지 않습니다.');
      const items=result.items.map(f=>{if(!safeId(f.id))fail('DRIVE_LIST','파일 ID가 올바르지 않습니다.');return {id:f.id,name:fileName(f.name),type:f.type==='folder'?'folder':'file',size:Math.max(0,Number(f.size)||0),mime:String(f.mime||'').slice(0,150),revision:String(f.revision||'').slice(0,200)};});
      j.result={items,total:Math.max(0,Number(result.total)||items.length),nextPage:result.nextPage??null,nextPageToken:String(result.nextPageToken||'').slice(0,3000)};
      if(this.aiEnabled){const state=this.read(user); const previous=state.context;
      state.context={...j.target,folderName:String(result.folderName||'선택한 폴더').slice(0,240),items,page:j.payload.page,pageToken:j.payload.pageToken,nextPage:j.result.nextPage,nextPageToken:j.result.nextPageToken,at:new Date(this.now()).toISOString(),aiAllowed:!!previous?.aiAllowed&&JSON.stringify(j.target)===JSON.stringify({provider:previous.provider,projectId:previous.projectId,folderId:previous.folderId})};
      this.save(user,state);}
    } else if(j.action==='projects') {
      const projects = result.projects;
      if (!Array.isArray(projects) || projects.length !== 1 || !projectId(projects[0].id) || projects[0].type !== 'private' || !projectId(projects[0].driveId)) fail('DRIVE_SCOPE', '로그인한 브라우저에서 개인 드라이브를 확인하지 못했습니다.', 403);
      const session = this.sessions.get(this.owner(user));
      if (!session) fail('DRIVE_BRIDGE_AUTH', '확장프로그램을 다시 연결하세요.', 401);
      session.projectId = projects[0].id;
      this.rememberBridge(user, session);
      for (const pending of this.jobs.values()) if (pending.owner === j.owner && !['projects','login'].includes(pending.action) && pending.target.projectId !== session.projectId && pending.status === 'pending') { pending.status = 'failed'; pending.error = '연결된 개인 프로젝트가 변경되었습니다. 목록을 다시 읽어 주세요.'; }
      j.result={projects:[{id:projects[0].id,name:'개인 프로젝트'}]};
    } else if(j.action==='download') j.result={stagedId:j.stagedId};
    else if(j.action==='delete') j.result={id:j.payload.fileId,deleted:result.deleted===true};
    else j.result={id:safeId(result.id)?result.id:null,name:String(result.name||j.payload.name).slice(0,240),revision:String(result.revision||'').slice(0,200)};
    j.status='done';return this.jobView(j);
  }
  stage(user,bytes,name,mime='application/octet-stream',source=null) {
    name=fileName(name); if(!Buffer.isBuffer(bytes)||bytes.length>this.maxBytes)fail('DRIVE_SIZE','파일 크기 한도를 초과했습니다.',413);
    const state=this.read(user);if(state.files.length>=50||state.files.reduce((s,f)=>s+f.size,0)+bytes.length>this.maxBytes*5)fail('DRIVE_QUOTA','서버 보관 파일을 정리한 뒤 다시 올려 주세요.',409);
    const key=id();const dir=path.join(this.dir,this.owner(user));fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,key),bytes,{mode:0o600});
    const entry={id:key,name,size:bytes.length,mime:String(mime).slice(0,150),sha256:hash(bytes),at:new Date(this.now()).toISOString(),source};
    state.files.push(entry);this.save(user,state);return entry;
  }
  bytes(user,key) {const f=this.read(user).files.find(f=>f.id===key);if(!f)fail('DRIVE_LOCAL_FILE','서버 파일이 없습니다.',404);return {entry:f,bytes:fs.readFileSync(path.join(this.dir,this.owner(user),f.id))};}
  async importDocument(user,key,location=null) {
    const file=this.bytes(user,key);
    // 외부 드라이브의 개인 전송 파일은 목적지를 생략해도 공용 문서함으로 노출하지 않는다.
    const target=location??{space:'private',owner:user.name,folderId:null};
    if(!target||typeof target!=='object'||Array.isArray(target)||(!target.space&&!target.folderId))fail('DRIVE_LIBRARY_TARGET','저장할 문서함과 폴더를 선택하세요.');
    return this.service.createDocument({fileName:file.entry.name,bytes:file.bytes,user,location:target});
  }
  async prepareDocument(user,docId,attachmentId=null) {
    this.service.assertDocRead(docId,user);
    const meta=this.service._meta(docId);const location=this.service.library.locOf(meta);
    if(attachmentId){const f=await this.service.getAttachment(docId,attachmentId);return this.stage(user,f.bytes,f.entry.name,f.entry.mime,{kind:'library-attachment',docId,attachmentId,location});}
    const snapshot=await this.service.workingSnapshot(docId);
    return this.stage(user,Buffer.from(snapshot.bytes),`${meta.title||'공동 문서'}.hwpx`,'application/vnd.hancom.hwpx',{kind:'library',docId,version:snapshot.version,location});
  }
  receive(user,jobId,claim,bytes,name,mime) {
    const j=this.claimed(user,jobId,claim);if(j.action!=='download'||j.stagedId)fail('DRIVE_ACTION','파일을 받을 수 없는 작업입니다.',409);
    const f=this.stage(user,bytes,name,mime,{...j.target,fileId:j.payload.fileId,revision:j.payload.expectedRevision});j.stagedId=f.id;return f;
  }
  deleteFile(user,key) {const s=this.read(user);const f=s.files.find(f=>f.id===key);if(!f)fail('DRIVE_LOCAL_FILE','서버 파일이 없습니다.',404);if([...this.jobs.values()].some(j=>j.owner===this.owner(user)&&j.payload.stagedId===key&&['running','pending'].includes(j.status)))fail('DRIVE_BUSY','전송 중인 파일입니다.',409);fs.unlinkSync(path.join(this.dir,this.owner(user),f.id));s.files=s.files.filter(f=>f.id!==key);this.save(user,s);return {ok:true};}
  /** AI 기능을 끈 동안 AI 경로(문맥·허용·제안)는 403 */
  assertAi() {if(!this.aiEnabled)fail('DRIVE_AI_DISABLED','AI 드라이브 기능은 꺼져 있습니다. AI는 드라이브 폴더 목록을 알 수 없습니다.',403);}
  aiContext(user) {this.assertAi();const s=this.read(user);return {context:activeTarget(s.context)&&s.context.aiAllowed?s.context:null,files:s.files.map(f=>this.publicFile(f)),note:'사용자가 AI 사용을 허용한 두레이 폴더 한 쪽만 표시됩니다. 전체 탐색은 제공하지 않습니다. 업로드 제안은 사용자가 드라이브 화면에서 실행합니다.'};}
  allowAi(user,allowed) {this.assertAi();const s=this.read(user);if(!activeTarget(s.context))fail('DRIVE_CONTEXT','두레이 폴더를 먼저 선택하세요.');s.context.aiAllowed=allowed===true;this.save(user,s);return {ok:true};}
  propose(user,body) {
    this.assertAi();const s=this.read(user),ctx=s.context;if(!ctx?.aiAllowed)fail('DRIVE_AI_SCOPE','사용자가 현재 폴더의 AI 사용을 허용해야 합니다.',403);
    if(!s.files.some(f=>f.id===body.stagedId))fail('DRIVE_LOCAL_FILE','서버 파일을 선택하세요.',404);
    if(body.replaceId&&!ctx.items.some(f=>f.id===body.replaceId&&f.type==='file'))fail('DRIVE_AI_SCOPE','현재 폴더에 표시된 파일만 교체 대상으로 제안할 수 있습니다.',403);
    if(s.proposals.filter(p=>p.status==='pending'&&activeTarget(p.target)).length>=20)fail('DRIVE_BUSY','대기 중인 업로드 제안을 처리하세요.',409);
    const p={id:id(),target:validateTarget(ctx),stagedId:body.stagedId,name:fileName(body.name||s.files.find(f=>f.id===body.stagedId).name),replaceId:body.replaceId||null,expectedRevision:ctx.items.find(f=>f.id===body.replaceId)?.revision||'',reason:String(body.reason||'').slice(0,1000),status:'pending'};
    s.proposals=s.proposals.slice(-49);s.proposals.push(p);this.save(user,s);return p;
  }
  resolveProposal(user,key,accept) {this.assertAi();const s=this.read(user);const p=s.proposals.find(p=>p.id===key&&p.status==='pending');if(!p)fail('DRIVE_PROPOSAL','대기 중인 제안이 없습니다.',404);let job=null;if(accept){if(!s.context?.aiAllowed||JSON.stringify(validateTarget(s.context))!==JSON.stringify(p.target))fail('DRIVE_AI_SCOPE','제안한 폴더를 다시 선택하고 AI 사용을 허용하세요.',409);job=this.create(user,{...p.target,...p,action:'upload'});}p.status=accept?'accepted':'rejected';this.save(user,s);return {proposal:p,job};}
}
