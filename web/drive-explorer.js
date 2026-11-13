import {ref,computed,inject,watch,nextTick,onMounted,onBeforeUnmount} from '/vendor/vue.esm-browser.prod.js';
import {api,state,toast,fmtSize} from './util.js';
import {ICON} from './icons.js';
import {driveImportTargets,defaultDriveImportTarget,driveDocumentChoices} from './drive-library.js';
import {canImportDriveFile,driveRows,driveTree,folderKey,importSpaceTargets} from './drive-explorer-model.js';

const PERSONAL_PROJECT='personal'; // 프로젝트 검색용 표시. 실제 ID는 연결한 확장에서 확인한다.
// 드라이브 정책 안내(2026-10-30): 목록은 내 화면에만, AI 는 드라이브를 쓰지 않음, 쓰기는 개인 프로젝트에서 본인만
const DRIVE_POLICY=['AI는 드라이브 폴더 목록을 알 수 없습니다.','폴더 목록은 내 화면에만 보이며 서버에 저장되지 않습니다.','가져오기·업로드·삭제·이름 바꾸기는 내가 직접 할 때만 실행되고, AI는 요청할 수 없습니다.','업로드·삭제·이름 바꾸기는 개인 프로젝트에서만 됩니다.'];
const svg=path=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons={...ICON,upload:svg('<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>'),download:svg('<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>'),import:svg('<path d="M14 3h6v18H4V9m-2-5h10m-4-4 4 4-4 4"/>'),refresh:svg('<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>'),expand:svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>')};

export const DriveTab={
  props:{library:{type:Object,default:null},libraryLocation:{type:Object,default:null}},emits:['imported'],
  template:`<Teleport to="body" :disabled="!expanded">
    <div v-if="expanded" class="dx-backdrop"></div>
    <section ref="root" class="drive-panel dx" :class="{'dx-expanded':expanded}" data-testid="drive-panel" :aria-busy="busy" :role="expanded?'dialog':undefined" :aria-modal="expanded?'true':undefined" aria-label="외부 드라이브" @keydown="panelKey">
      <header class="dx-header">
        <span class="dx-brand" aria-hidden="true" v-html="icons.folder"></span>
        <span class="dx-provider">두레이 드라이브</span>
        <span class="dx-connected" :class="{online:status.connected}"><i></i>{{status.connected?'연결됨':'연결 필요'}}</span>
        <span class="spacer"></span>
        <button class="dx-text" @click="openModal('settings')">연결 설정</button>
        <button class="dx-icon" @click="expanded=!expanded" :aria-label="expanded?'크게 보기 닫기':'드라이브 크게 보기'" :title="expanded?'크게 보기 닫기':'크게 보기'"><span v-html="expanded?icons.x:icons.expand"></span></button>
      </header>
      <div class="dx-layout">
        <aside class="dx-sidebar" aria-label="프로젝트와 폴더">
          <div class="dx-side-title">프로젝트</div>
          <select v-if="projects.length>1" v-model="projectId" :disabled="busy" @change="changeProject" aria-label="프로젝트 선택"><option v-for="p in projects" :value="p.id">{{p.name}}</option></select>
          <nav class="dx-tree"><button v-for="node in tree" :key="node.id" :class="{current:node.id===folderId}" :style="{paddingLeft:(12+node.depth*16)+'px'}" @click="goPath(node.path)" :disabled="busy||!status.connected" :aria-current="node.id===folderId?'page':undefined"><span class="dx-folder-icon" v-html="icons.folder"></span><span>{{node.name}}</span></button></nav>
          <div class="dx-side-note">개발 범위 · 개인 프로젝트</div>
          <ul class="dx-policy" data-testid="drive-policy" aria-label="드라이브 개인정보 안내"><li v-for="t in DRIVE_POLICY" :key="t">{{t}}</li></ul>
          <div class="dx-side-bottom" v-if="status.aiEnabled"><button class="dx-text" @click="openModal('ai')">AI 사용 설정 <span v-if="pendingProposals.length" class="dx-count">{{pendingProposals.length}}</span></button></div>
        </aside>
        <main class="dx-main">
          <div class="dx-toolbar">
            <button class="primary" @click="pickUpload" :disabled="busy||!ready||!writable" :title="writable?'':'개인 프로젝트에서만 업로드할 수 있습니다'"><span class="dx-ic" v-html="icons.upload"></span>업로드</button>
            <button @click="downloadSelected" :disabled="busy||!ready||!selectedFiles.length"><span class="dx-ic" v-html="icons.download"></span>다운로드</button>
            <button @click="openImport()" :disabled="busy||!ready||!importable" :title="selectedFiles.length&&!importable?'HWPX 문서만 편집함으로 가져올 수 있습니다':'선택한 HWPX를 개인·공용편집함으로 가져오기'"><span class="dx-ic" v-html="icons.import"></span>편집함으로 가져오기</button>
            <details class="dx-more" ref="more"><summary aria-label="추가 작업" :aria-disabled="busy">···</summary><div class="dx-menu"><button @click="openModal('library')" :disabled="busy||!ready||!writable">편집함 문서 올리기</button><button @click="pickReplacement" :disabled="busy||!ready||!writable||selectedFiles.length!==1">선택 파일 교체…</button><button data-testid="drive-rename" @click="renameSelected" :disabled="busy||!ready||!writable||selectedFiles.length!==1">이름 바꾸기…</button><button data-testid="drive-delete" class="dx-danger" @click="deleteSelected" :disabled="busy||!ready||!writable||!selectedFiles.length">삭제(휴지통으로)</button><button @click="loginConnected" :disabled="busy||!status.connected">두레이에서 열기</button><button v-if="status.aiEnabled" @click="openModal('ai')">AI 사용 설정{{pendingProposals.length?' · '+pendingProposals.length:''}}</button></div></details>
            <span class="spacer"></span><button class="dx-icon" @click="loadFolder" :disabled="busy||!status.connected" aria-label="폴더 새로고침" title="새로고침"><span v-html="icons.refresh"></span></button>
            <input ref="uploadInput" class="dx-hidden" type="file" multiple aria-label="업로드할 파일" @change="uploadInputChanged"><input ref="replaceInput" class="dx-hidden" type="file" aria-label="교체할 파일" @change="replacementChanged">
          </div>
          <div class="dx-location"><button class="dx-icon" @click="goPath(crumbs.slice(0,-1))" :disabled="busy||!ready||crumbs.length<2" aria-label="상위 폴더" title="상위 폴더">↑</button><nav aria-label="현재 드라이브 폴더"><template v-for="(c,i) in crumbs" :key="c.id"><span v-if="i" class="dx-separator">›</span><button @click="goPath(crumbs.slice(0,i+1))" :disabled="busy||!status.connected" :aria-current="i===crumbs.length-1?'page':undefined">{{c.name}}</button></template></nav><input type="search" v-model="query" placeholder="이 폴더에서 찾기" aria-label="이 폴더에서 찾기" :disabled="busy"></div>
          <details class="dx-policy-mini" data-testid="drive-policy-mini"><summary>AI는 폴더 목록을 알 수 없습니다 · 목록은 서버에 저장되지 않습니다</summary><ul class="dx-policy"><li v-for="t in DRIVE_POLICY" :key="t">{{t}}</li></ul></details>
          <div class="dx-message dx-error" v-if="error&&!modal" role="alert">{{error}}<button class="dx-text" @click="error=''">닫기</button></div>
          <div class="dx-message dx-success" v-if="imported.length" role="status"><span>{{imported.length}}개 문서를 {{importedWhere}}에 가져왔습니다.</span><a v-for="doc in imported" :key="doc.id" :href="'#/doc/'+doc.id">문서 열기 · {{doc.title}}</a><button class="dx-text" @click="imported=[]" aria-label="가져오기 알림 닫기">×</button></div>
          <div class="dx-files" :class="{'dx-dragging':dragging}" @dragenter.prevent="dragEnter" @dragover.prevent="dragOver" @dragleave.prevent="dragLeave" @drop.prevent="dropFiles">
            <template v-if="!status.connected"><div class="dx-empty"><span class="dx-empty-icon" v-html="icons.folder"></span><b>두레이 파일과 폴더를 탐색하세요</b><p>브라우저를 연결하면 파일과 폴더가 여기에 표시됩니다.</p><button class="primary" @click="openModal('settings')">드라이브 연결</button></div></template>
            <template v-else>
              <table class="dx-table" aria-label="드라이브 파일 목록"><thead><tr><th class="dx-check"><input type="checkbox" :checked="allSelected" :indeterminate="someSelected" @change="selectAll($event.target.checked)" :disabled="busy||!visibleFiles.length" aria-label="현재 목록 파일 전체 선택"></th><th><button class="dx-sort" @click="descending=!descending" :aria-label="'이름 '+(descending?'오름차순':'내림차순')+' 정렬'">이름 <span>{{descending?'↓':'↑'}}</span></button></th><th class="dx-type">종류</th><th class="dx-size">크기</th></tr></thead><tbody>
                <tr v-for="f in rows" :key="f.id" :data-file-id="f.id" :class="{selected:selected.includes(f.id),folder:f.type==='folder'}" @click="rowClick(f,$event)" @dblclick="openFile(f)" :aria-selected="f.type==='file'?selected.includes(f.id):undefined"><td class="dx-check" @click.stop @dblclick.stop><input v-if="f.type==='file'" type="checkbox" :checked="selected.includes(f.id)" @change="toggleFile(f)" :disabled="busy" :aria-label="f.name+' 선택'"></td><td class="dx-name"><button @click.stop="rowClick(f,$event)" @keydown.enter.prevent="openFile(f)" :disabled="busy" :title="f.type==='folder'?'폴더 열기':canImportDriveFile(f)?'두 번 클릭하여 편집기로 열기':f.name"><span class="dx-file-icon" :class="{hwpx:canImportDriveFile(f)}" v-html="f.type==='folder'?icons.folder:icons.file"></span><span>{{f.name}}</span></button></td><td class="dx-type">{{fileType(f)}}</td><td class="dx-size">{{f.type==='folder'?'—':fmtSize(f.size)}}</td></tr>
              </tbody></table>
              <div class="dx-empty" v-if="!rows.length"><span class="dx-empty-icon" v-html="icons.folder"></span><b>{{busy?'폴더를 불러오는 중…':query?'찾는 파일이 없습니다':'폴더가 비어 있습니다'}}</b><p v-if="!busy&&!query">파일을 끌어 놓거나 업로드 버튼을 누르세요.</p></div>
            </template>
            <div v-if="dragging" class="dx-drop-label">{{crumbs.at(-1).name}}에 업로드</div>
          </div>
          <footer class="dx-footer"><span role="status">{{progress||(selectedFiles.length?selectedFiles.length+'개 선택':rows.length+'개 항목')}}<span v-if="query"> · 현재 목록 검색</span></span><span class="spacer"></span><button @click="previousPage" :disabled="busy||!ready||!page" aria-label="이전 페이지">‹</button><span>{{page+1}}</span><button @click="next" :disabled="busy||!ready||nextPage==null" aria-label="다음 페이지">›</button></footer>
        </main>
      </div>
    </section>
    <Teleport to="body"><dialog ref="dialog" v-if="modal" class="dx-dialog" :aria-label="modalTitle" @cancel.prevent="closeModal">
      <header><h2>{{modalTitle}}</h2><button class="dx-icon" @click="closeModal" :disabled="busy" aria-label="창 닫기"><span v-html="icons.x"></span></button></header>
      <div class="dx-dialog-body">
        <div class="dx-message dx-error" v-if="error" role="alert">{{error}}</div>
        <template v-if="modal==='import'">
          <p class="dx-dialog-lead">{{openAfterImport?'문서를 편집함으로 가져온 뒤 편집기로 엽니다. 저장할 위치를 선택하세요.':'선택한 HWPX '+selectedFiles.length+'개를 편집할 수 있는 문서로 가져옵니다.'}}</p>
          <div class="dx-space-choice"><label v-for="space in ['private','public']"><input type="radio" v-model="importSpace" :value="space" :disabled="busy||!targetsFor(space).length">{{space==='private'?'내 개인편집함':'공용편집함'}}</label></div>
          <label class="dx-field">저장할 폴더<select v-model="importKey" :disabled="busy||!spaceTargets.length" aria-label="가져올 편집함 폴더"><option v-for="t in spaceTargets" :key="t.key" :value="t.key">{{t.label}}</option></select></label>
          <p class="dx-hint">{{importSpace==='public'?'공용편집함의 폴더 권한에 따라 공유됩니다.':'선택한 개인편집함 폴더의 공유 권한을 따릅니다.'}} 원본 파일은 드라이브에 유지됩니다.</p><p v-if="!spaceTargets.length" class="dx-hint">이 편집함에 작성할 수 있는 폴더가 없습니다.</p>
          <ul class="dx-chosen"><li v-for="f in selectedFiles">{{f.name}}</li></ul>
        </template>
        <template v-if="modal==='library'">
          <p class="dx-dialog-lead">{{crumbs.map(c=>c.name).join(' / ')}}에 올립니다.</p>
          <label class="dx-field">편집함 문서<select v-model="libraryDocId" :disabled="busy" aria-label="드라이브로 올릴 편집함 문서"><option value="">문서 선택</option><option v-for="doc in libraryDocs" :value="doc.id">{{doc.label}}</option></select></label>
          <p class="dx-hint">저장된 공동 문서를 새 파일로 올립니다. 승인 대기 중인 개인 수정은 포함하지 않습니다.</p>
          <details v-if="status.files.length" class="dx-stored"><summary>서버 보관 파일 ({{status.files.length}})</summary><div v-for="f in status.files" :key="f.id"><span>{{f.name}}</span><small>{{fmtSize(f.size)}}</small><button @click="uploadStored(f)" :disabled="busy">올리기</button><button v-if="d&&status.aiEnabled" @click="attach(f)" :disabled="busy">AI 첨부</button><button @click="removeStored(f)" :disabled="busy" :aria-label="f.name+' 보관 사본 지우기'">×</button></div></details>
        </template>
        <template v-if="modal==='settings'">
          <p class="dx-dialog-lead">{{status.connected?'브라우저가 연결되어 있습니다.':'이 화면을 연 채로 확장 아이콘을 누르고 [이 cowork 서버에 연결]을 누르세요.'}}</p><p class="dx-hint">지금 로그인한 cowork 계정으로 바로 연결합니다(코드 입력 없음). 서버를 다시 켜도 연결이 유지되며, 별도의 창을 열어 둘 필요가 없습니다. 같은 브라우저에서 두레이에 직접 로그인하세요.</p>
          <ul class="dx-policy"><li v-for="t in DRIVE_POLICY" :key="t">{{t}}</li></ul>
          <div class="dx-dialog-actions"><button @click="extensionZip" :disabled="busy">확장프로그램 받기</button><button @click="pair" :disabled="busy" title="다른 브라우저의 확장에 직접 입력할 때만 씁니다">코드로 연결</button></div>
          <div class="dx-pair" v-if="pairing"><strong>{{pairing.code}}</strong><span>서버 {{origin}}</span><small>5분간 유효 · 확장 아이콘의 [코드로 연결]에 입력</small></div>
          <p v-if="status.bridge?.paired&&!status.connected" class="dx-hint">등록된 확장의 응답을 기다리고 있습니다. 확장을 설치한 브라우저가 실행 중인지 확인하세요.</p>
          <p v-if="status.bridge?.version" class="dx-hint">확장 {{status.bridge.version}} · 최신 0.6.0<template v-if="status.bridge.version!=='0.6.0'"> — 사용자별 개인 프로젝트 연결을 위해 확장을 업데이트하세요.</template></p>
          <p class="dx-hint">두레이에서 본인의 개인 프로젝트를 열어 두세요. 해당 주소의 프로젝트 ID와 개인 드라이브 여부를 확인하여 지금 cowork 계정에 연결합니다.</p>
          <button v-if="status.connected" @click="loginConnected" :disabled="busy">연결된 브라우저에서 두레이 열기</button><span v-else class="muted">확장 아이콘에서 두레이 주소를 저장하고 로그인하세요.</span>
          <details><summary>설치·업데이트 방법</summary><ol><li>확장 ZIP을 폴더에 풉니다. 업데이트는 기존 설치 폴더에 덮어씁니다.</li><li>Chrome은 chrome://extensions, Brave는 brave://extensions를 엽니다.</li><li>처음에는 개발자 모드에서 압축해제된 확장을 로드합니다. 업데이트는 기존 Cowork 확장의 새로고침을 누릅니다.</li><li>이 화면을 연 탭에서 확장 아이콘을 누르고 [이 cowork 서버에 연결]을 누릅니다. 처음 한 번 이 서버 접근을 허용합니다.</li></ol></details>
          <button v-if="status.bridge?.paired" class="dx-danger" @click="disconnect" :disabled="busy">브라우저 연결 해제</button>
        </template>
        <template v-if="modal==='ai'">
          <label class="dx-ai-choice"><input type="checkbox" :checked="sameContext&&status.context?.aiAllowed" @change="allowAi($event.target.checked)" :disabled="busy||!sameContext||!ready">현재 폴더 목록을 AI에 보여주기</label><p class="dx-hint">지금 보고 있는 목록만 공유합니다. 폴더를 옮기면 해제됩니다. 파일 업로드 제안은 확인 후 실행합니다.</p>
          <div class="dx-proposal" v-for="p in pendingProposals" :key="p.id"><b>{{p.name}}</b><p>{{p.reason}}</p><small>{{p.target.provider}} / {{p.target.folderId}} · {{p.replaceId?'기존 파일 교체':'새 파일'}}</small><div class="dx-dialog-actions"><button @click="resolveProposal(p,true)" :disabled="busy">확인 후 실행</button><button @click="resolveProposal(p,false)" :disabled="busy">거절</button></div></div><p v-if="!pendingProposals.length" class="dx-hint">대기 중인 업로드 제안이 없습니다.</p>
        </template>
      </div>
      <footer><span class="dx-hint" role="status">{{progress}}</span><button @click="closeModal" :disabled="busy">{{modal==='import'||modal==='library'?'취소':'닫기'}}</button><button v-if="modal==='import'" class="primary" @click="importSelected" :disabled="busy||!importTarget||!importable">{{openAfterImport?'가져와서 열기':'가져오기'}}</button><button v-if="modal==='library'" class="primary" @click="uploadLibrary" :disabled="busy||!libraryDocId">올리기</button></footer>
    </dialog></Teleport>
  </Teleport>`,
  setup(props,{emit}){
    const d=inject('doc',null),root=ref(null),dialog=ref(null),more=ref(null),uploadInput=ref(null),replaceInput=ref(null);
    const status=ref({connected:false,providers:[],files:[],proposals:[],maxBytes:52428800}),provider=ref('dooray'),projectId=ref(PERSONAL_PROJECT),projects=ref([{id:PERSONAL_PROJECT,name:'개인 프로젝트'}]),crumbs=ref([{id:'root',name:'개인 프로젝트'}]);
    const items=ref([]),listed=ref(false),selected=ref([]),query=ref(''),descending=ref(false),busy=ref(false),error=ref(''),progress=ref(''),expanded=ref(false),modal=ref(''),pairing=ref(null),dragging=ref(false),cache=ref(new Map());
    const page=ref(0),nextPage=ref(null),imported=ref([]),importedWhere=ref(''),libraryState=ref(null),libraryDocId=ref(''),importKey=ref(''),importSpace=ref('private'),openAfterImport=ref(false);
    let disposed=false,timer,initialized=false,refreshQueue=Promise.resolve(),dragDepth=0,replaceTarget=null,modalFocus=null,expandFocus=null,bodyOverflow='';
    const selectedProvider=computed(()=>status.value.providers.find(p=>p.id===provider.value));
    const folderId=computed(()=>crumbs.value.at(-1).id),target=()=>({provider:provider.value,projectId:projectId.value,folderId:folderId.value});
    // 쓰기(업로드·교체·삭제·이름 바꾸기)는 서버가 허용한 프로젝트(개인 프로젝트)에서만
    const writable=computed(()=>(status.value.writeProjects||[]).includes(projectId.value));
    const ready=computed(()=>status.value.connected&&listed.value),rows=computed(()=>driveRows(items.value,query.value,descending.value));
    const visibleFiles=computed(()=>rows.value.filter(f=>f.type==='file')),selectedFiles=computed(()=>items.value.filter(f=>f.type==='file'&&selected.value.includes(f.id)));
    const importable=computed(()=>selectedFiles.value.length>0&&selectedFiles.value.every(canImportDriveFile));
    const allSelected=computed(()=>visibleFiles.value.length>0&&visibleFiles.value.every(f=>selected.value.includes(f.id))),someSelected=computed(()=>!allSelected.value&&visibleFiles.value.some(f=>selected.value.includes(f.id)));
    const tree=computed(()=>driveTree(cache.value,provider.value,projectId.value,crumbs.value[0].name));
    const sameContext=computed(()=>{const c=status.value.context,t=target();return !!c&&c.provider===t.provider&&c.projectId===t.projectId&&c.folderId===t.folderId;});
    const pendingProposals=computed(()=>status.value.proposals.filter(p=>p.status==='pending'&&p.target.provider==='dooray'&&p.target.projectId===projectId.value));
    const importTargets=computed(()=>driveImportTargets(props.library||libraryState.value,state.me)),libraryDocs=computed(()=>driveDocumentChoices(props.library||libraryState.value,state.me));
    const targetsFor=space=>importSpaceTargets(importTargets.value,space,state.me),spaceTargets=computed(()=>targetsFor(importSpace.value)),importTarget=computed(()=>spaceTargets.value.find(t=>t.key===importKey.value));
    const modalTitle=computed(()=>({import:openAfterImport.value?'문서 열기':'편집함으로 가져오기',library:'편집함 문서 올리기',settings:'드라이브 연결',ai:'AI 사용 설정'})[modal.value]);
    watch(spaceTargets,list=>{if(!list.some(t=>t.key===importKey.value))importKey.value=list[0]?.key||'';});
    watch(query,()=>{selected.value=[];});
    async function refreshLibrary(){if(!props.library)libraryState.value=await api('/api/library');}
    function refresh(){const task=refreshQueue.catch(()=>{}).then(async()=>{const s=await api('/api/drive');if(!disposed)status.value=s;});refreshQueue=task;return task;}
    async function action(fn){if(busy.value||disposed)return;busy.value=true;error.value='';if(more.value)more.value.open=false;try{return await fn();}catch(e){if(!disposed)error.value=e.message;else toast('드라이브: '+e.message,{kind:'error',ms:6000});return null;}finally{busy.value=false;progress.value='';}}
    // 다른 탭으로 이동해 화면이 사라져도 이미 시작한 전송은 결과 확인·사본 정리까지 마친다.
    async function waitJob(j){const end=Date.now()+190000;while(Date.now()<end){const r=await api('/api/drive/jobs/'+j.id);if(r.status==='done')return r.result;if(r.status==='failed')throw Error(r.error);await new Promise(r=>setTimeout(r,500));}throw Error('처리 결과를 확인하지 못했습니다. 드라이브에서 결과를 확인한 뒤 다시 시도하세요.');}
    async function job(action,extra={}){return waitJob(await api('/api/drive/jobs',{method:'POST',body:{...target(),action,...extra}}));}
    function resetPages(){page.value=0;nextPage.value=null;}
    function remember(){const key=folderKey(provider.value,projectId.value,folderId.value),old=cache.value.get(key);const folders=new Map((old?.folders||[]).map(f=>[f.id,f]));for(const f of items.value)if(f.type==='folder')folders.set(f.id,{id:f.id,name:f.name});cache.value.set(key,{...target(),path:crumbs.value.map(c=>({...c})),folders:[...folders.values()]});}
    async function readFolder(){if(disposed)return;progress.value='폴더를 불러오는 중…';const r=await job('list',{page:page.value});if(disposed)return;items.value=r.items;nextPage.value=r.nextPage??null;listed.value=true;selected.value=[];remember();await refresh();}
    async function readProjects(){if(disposed)return;const r=await job('projects',{projectId:PERSONAL_PROJECT,folderId:'root'});if(disposed)return;if(!r.projects?.length)throw Error('두레이에서 개인 프로젝트를 열어 주세요.');projects.value=r.projects;const id=r.projects[0].id;if(projectId.value!==id){projectId.value=id;crumbs.value=[{id:'root',name:'개인 프로젝트'}];items.value=[];selected.value=[];cache.value=new Map();listed.value=false;resetPages();}await refresh();}
    const loadFolder=()=>action(async()=>{await readProjects();await readFolder();});
    const goPath=path=>action(async()=>{if(!path.length)return;crumbs.value=path.map(c=>({...c}));items.value=[];selected.value=[];query.value='';listed.value=false;resetPages();await readFolder();});
    function changeProject(){crumbs.value=[{id:'root',name:projects.value.find(p=>p.id===projectId.value)?.name||'내 드라이브'}];items.value=[];selected.value=[];query.value='';listed.value=false;resetPages();if(status.value.connected)return action(async()=>{await readProjects();await readFolder();});}
    const next=()=>action(async()=>{page.value=nextPage.value;await readFolder();});
    const previousPage=()=>action(async()=>{page.value=Math.max(0,page.value-1);await readFolder();});
    function toggleFile(f){if(busy.value)return;selected.value=selected.value.includes(f.id)?selected.value.filter(id=>id!==f.id):[...selected.value,f.id];}
    function rowClick(f,e){if(busy.value)return;if(f.type==='folder')return goPath([...crumbs.value,{id:f.id,name:f.name}]);if(e.ctrlKey||e.metaKey)toggleFile(f);else selected.value=[f.id];}
    function selectAll(checked){selected.value=checked?visibleFiles.value.map(f=>f.id):[];}
    const fileType=f=>f.type==='folder'?'폴더':f.name.split('.').length>1?f.name.split('.').at(-1).toUpperCase():'파일';
    async function saveBlob(bytes,name){const url=URL.createObjectURL(new Blob([bytes]));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
    async function cleanup(f){try{await api('/api/drive/files/'+f.id,{method:'DELETE'});}catch{/* 성공한 전송의 임시 사본은 다음 정리 때 제거할 수 있다. */}}
    async function remoteStage(f){const r=await job('download',{fileId:f.id,expectedRevision:f.revision});const s=await api('/api/drive');status.value=s;const local=s.files.find(x=>x.id===r.stagedId);if(!local)throw Error('전송된 파일을 찾을 수 없습니다.');return local;}
    const downloadSelected=()=>action(async()=>{const files=[...selectedFiles.value];for(let i=0;i<files.length;i++){progress.value=`다운로드 ${i+1}/${files.length} · ${files[i].name}`;const f=await remoteStage(files[i]);await saveBlob(await api('/api/drive/files/'+f.id),f.name);await cleanup(f);}await refresh();toast(files.length+'개 파일을 다운로드했습니다.');});
    async function openModal(kind){if(busy.value)return;if(more.value)more.value.open=false;modalFocus=document.activeElement;error.value='';modal.value=kind;if(kind==='library'||kind==='import')refreshLibrary().catch(e=>{error.value=e.message;});await nextTick();dialog.value?.showModal();}
    function closeModal(){if(busy.value)return;dialog.value?.close();modal.value='';error.value='';nextTick(()=>modalFocus?.isConnected&&modalFocus.focus());}
    function openImport(openEditor=false){if(!importable.value)return;openAfterImport.value=openEditor;const t=defaultDriveImportTarget(importTargets.value,state.me,props.libraryLocation);importSpace.value=t?.location.space||'private';importKey.value=t?.key||'';openModal('import');}
    function openFile(f){
      if(busy.value||!ready.value||modal.value)return;
      if(f.type==='folder')return goPath([...crumbs.value,{id:f.id,name:f.name}]);
      if(!canImportDriveFile(f)){toast('편집기로 열 수 있는 형식은 HWPX입니다. 이 파일은 다운로드해서 열어 주세요.');return;}
      selected.value=[f.id];openImport(true);
    }
    const importSelected=()=>action(async()=>{
      if(!importable.value||!importTarget.value)throw Error('HWPX 문서와 저장할 폴더를 선택하세요.');
      const where=importTarget.value,files=[...selectedFiles.value],shouldOpen=openAfterImport.value;
      imported.value=[];importedWhere.value=where.label;
      for(let i=0;i<files.length;i++){
        progress.value=`가져오기 ${i+1}/${files.length} · ${files[i].name}`;
        const f=await remoteStage(files[i]);
        const doc=await api('/api/drive/files/'+f.id+'/open',{method:'POST',body:{location:where.location}});
        imported.value.push(doc);emit('imported',doc);await cleanup(f);
      }
      await refresh();await refreshLibrary();dialog.value?.close();modal.value='';
      nextTick(()=>modalFocus?.isConnected&&modalFocus.focus());toast(files.length+'개 문서를 가져왔습니다.');
      if(shouldOpen&&!disposed&&imported.value.length===1)location.hash='#/doc/'+imported.value[0].id;
    });
    function pickUpload(){if(ready.value&&!busy.value)uploadInput.value.click();}
    function pickReplacement(){if(selectedFiles.value.length!==1||!ready.value)return;replaceTarget={...selectedFiles.value[0]};more.value.open=false;replaceInput.value.click();}
    function uploadInputChanged(e){const files=[...e.target.files];e.target.value='';if(files.length)uploadFiles(files);}
    function replacementChanged(e){const f=e.target.files[0];e.target.value='';const original=replaceTarget;replaceTarget=null;if(f&&original&&confirm(`${crumbs.value.map(c=>c.name).join(' / ')} / ${original.name}\n이 파일을 ${f.name}의 내용으로 교체할까요?`))uploadFiles([f],original);}
    function uploadFiles(files,replace=null){return action(async()=>{if(!ready.value)throw Error('연결 후 업로드할 폴더를 여세요.');if(files.some(f=>f.size>status.value.maxBytes))throw Error('파일은 '+fmtSize(status.value.maxBytes)+'까지 올릴 수 있습니다.');for(let i=0;i<files.length;i++){const file=files[i];progress.value=`업로드 ${i+1}/${files.length} · ${file.name}`;const f=await api('/api/drive/files',{method:'POST',raw:true,body:await file.arrayBuffer(),headers:{'x-file-name':encodeURIComponent(file.name),'x-file-mime':file.type||'application/octet-stream'}});await job('upload',{stagedId:f.id,name:replace?.name||file.name,replaceId:replace?.id||null,expectedRevision:replace?.revision});await cleanup(f);}toast(files.length+'개 파일을 올렸습니다.');await readFolder();});}
    function dragEnter(e){if(!e.dataTransfer?.types.includes('Files'))return;dragDepth++;if(ready.value&&!busy.value)dragging.value=true;}
    function dragOver(e){if(e.dataTransfer)e.dataTransfer.dropEffect=ready.value&&!busy.value?'copy':'none';}
    function dragLeave(){if(--dragDepth<=0){dragDepth=0;dragging.value=false;}}
    function dropFiles(e){dragDepth=0;dragging.value=false;const files=[...(e.dataTransfer?.files||[])];if(files.length&&ready.value&&!busy.value)uploadFiles(files);}
    // 삭제 = 두레이 휴지통으로(두레이에서 되살림). 이름 바꾸기 = 같은 폴더 안에서. 둘 다 목록에서 본 revision 이 그대로일 때만
    const deleteSelected=()=>action(async()=>{if(!writable.value)throw Error('개인 프로젝트에서만 삭제할 수 있습니다.');const files=[...selectedFiles.value];if(!files.length||!confirm(files.map(f=>f.name).join('\n')+'\n\n'+files.length+'개 파일을 두레이 휴지통으로 옮길까요?'))return;for(let i=0;i<files.length;i++){progress.value=`삭제 ${i+1}/${files.length} · ${files[i].name}`;await job('delete',{fileId:files[i].id,expectedRevision:files[i].revision});}toast(files.length+'개 파일을 휴지통으로 옮겼습니다.');await readFolder();});
    const renameSelected=()=>action(async()=>{if(!writable.value)throw Error('개인 프로젝트에서만 이름을 바꿀 수 있습니다.');const f=selectedFiles.value[0];if(!f)return;const name=prompt('새 파일 이름',f.name)?.trim();if(!name||name===f.name)return;progress.value='이름 바꾸는 중…';await job('rename',{fileId:f.id,expectedRevision:f.revision,name});toast('이름을 바꿨습니다.');await readFolder();});
    const uploadLibrary=()=>action(async()=>{const id=libraryDocId.value;if(d?.id===id){await d.s.editor?.saveNow?.();if(d.s.draft?.dirty||d.s.editor?.dirty)throw Error('문서 저장이 끝난 뒤 다시 시도하세요.');}progress.value='편집함 문서를 올리는 중…';const f=await api('/api/drive/documents/'+encodeURIComponent(id)+'/stage',{method:'POST'});await job('upload',{stagedId:f.id,name:f.name});await cleanup(f);await readFolder();dialog.value?.close();modal.value='';toast('편집함 문서를 드라이브에 올렸습니다.');});
    const uploadStored=f=>action(async()=>{progress.value=f.name+' 올리는 중…';await job('upload',{stagedId:f.id,name:f.name});await readFolder();toast('파일을 드라이브에 올렸습니다.');});
    const attach=f=>action(async()=>{await api('/api/drive/files/'+f.id+'/attach',{method:'POST',body:{docId:d.id}});await d.refresh(['attachments']);toast('AI 요청에서 첨부 파일을 선택할 수 있습니다.');});
    const removeStored=f=>action(async()=>{await api('/api/drive/files/'+f.id,{method:'DELETE'});await refresh();});
    const extensionZip=()=>action(async()=>saveBlob(await api('/api/drive/extension.zip'),'cowork-drive-bridge.zip'));
    const pair=()=>action(async()=>{pairing.value=await api('/api/drive/pair',{method:'POST'});});
    const disconnect=()=>action(async()=>{if(!confirm('브라우저 연결을 해제할까요?'))return;await api('/api/drive/connection',{method:'DELETE'});await refresh();});
    const loginConnected=()=>action(async()=>{await job('login');toast('연결된 브라우저에서 드라이브를 열었습니다.');});
    const allowAi=allowed=>action(async()=>{await api('/api/drive/ai-context',{method:'POST',body:{allowed}});await refresh();});
    const resolveProposal=(p,accept)=>action(async()=>{if(accept&&!confirm(`${p.name}\n${p.replaceId?'기존 파일을 교체합니다.':'제안한 폴더에 새 파일을 올립니다.'}\n실행할까요?`))return;const r=await api('/api/drive/proposals/'+p.id,{method:'POST',body:{accept}});if(r.job){progress.value='AI 제안을 실행하는 중…';await waitJob(r.job);await readFolder();toast('업로드 제안을 실행했습니다.');}await refresh();});
    function panelKey(e){if(!expanded.value||modal.value)return;if(e.key==='Escape'){expanded.value=false;e.preventDefault();}if(e.key==='Tab'){const els=[...root.value.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],summary')].filter(el=>el.getClientRects().length);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}
    watch(expanded,async v=>{if(v){expandFocus=document.activeElement;bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';await nextTick();root.value?.querySelector('[aria-label="크게 보기 닫기"]')?.focus();}else{document.body.style.overflow=bodyOverflow;await nextTick();if(expandFocus?.isConnected)expandFocus.focus();}});
    watch(()=>status.value.connected,connected=>{if(initialized&&connected&&!busy.value)action(async()=>{await readProjects();await readFolder();});});
    onMounted(async()=>{await action(async()=>{await Promise.all([refresh(),refreshLibrary()]);if(status.value.connected){await readProjects();await readFolder();}});if(disposed)return;initialized=true;timer=setInterval(()=>{if(document.visibilityState!=='hidden'&&!busy.value)refresh().catch(()=>{});},3000);});
    onBeforeUnmount(()=>{disposed=true;clearInterval(timer);if(expanded.value)document.body.style.overflow=bodyOverflow;});
    return {DRIVE_POLICY,writable,deleteSelected,renameSelected,d,icons,root,dialog,more,uploadInput,replaceInput,status,provider,projectId,projects,crumbs,folderId,ready,rows,selected,selectedFiles,visibleFiles,allSelected,someSelected,importable,query,descending,busy,error,progress,expanded,modal,modalTitle,pairing,dragging,page,nextPage,tree,selectedProvider,sameContext,pendingProposals,imported,importedWhere,importSpace,importKey,spaceTargets,importTarget,targetsFor,libraryDocs,libraryDocId,openAfterImport,origin:location.origin,fmtSize,canImportDriveFile,fileType,changeProject,loadFolder,goPath,next,previousPage,rowClick,toggleFile,selectAll,downloadSelected,openModal,closeModal,openImport,openFile,importSelected,pickUpload,pickReplacement,uploadInputChanged,replacementChanged,dragEnter,dragOver,dragLeave,dropFiles,uploadLibrary,uploadStored,attach,removeStored,extensionZip,pair,disconnect,loginConnected,allowAi,resolveProposal,panelKey};
  },
};
