import {ref,computed,inject,watch,nextTick,onMounted,onBeforeUnmount} from '/vendor/vue.esm-browser.prod.js';
import {api,state,toast,fmt,fmtSize} from './util.js';
import {ICON} from './icons.js';
import {driveImportTargets,defaultDriveImportTarget,driveDocumentChoices} from './drive-library.js';
import {canImportDriveFile,driveRows,driveTree,folderKey,importSpaceTargets} from './drive-explorer-model.js';

// 2026-11-17 두레이 서비스 API 방식: 사용자가 두레이에서 직접 만든 개인 API 인증 토큰을 한 번 등록하면 서버가 내 개인 드라이브를 다룬다(확장프로그램 없음).
// 2026-11-18 프로젝트 드라이브: 왼쪽 드라이브 목록 = 내 드라이브 + 사용자가 [프로젝트 추가]로 허용한 프로젝트(서버 status.drives — 없는 옛 서버면 내 드라이브만)
const PROVIDER='dooray',PERSONAL='personal',ALL_ACTIONS=['list','download','upload','delete','rename'];
// 드라이브 정책 안내: 목록은 내 화면에만, AI 는 드라이브를 쓰지 않음, 쓰기는 본인만·개인 드라이브만, 토큰은 암호문으로만
const DRIVE_POLICY=['AI는 드라이브 폴더 목록과 파일을 알 수 없습니다.','폴더 목록은 내 화면에만 보이며 서버에 저장되지 않습니다.','가져오기·업로드·삭제·이름 바꾸기는 내가 직접 할 때만 실행됩니다.','두레이 토큰은 서버에 암호화해 보관하고 다시 보여 주지 않으며, 내 개인 드라이브에만 씁니다.'];
const svg=path=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons={...ICON,upload:svg('<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>'),download:svg('<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>'),import:svg('<path d="M14 3h6v18H4V9m-2-5h10m-4-4 4 4-4 4"/>'),refresh:svg('<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>'),expand:svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>')};
/** 사용자가 넣은 사이트 주소 → 열 수 있는 https 주소(두레이 도메인만) */
export function doorayHome(site){let s=String(site||'').trim();if(!s)return '';if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(s))s='https://'+s;try{const u=new URL(s);return u.protocol==='https:'&&/(^|\.)(dooray\.com|gov-dooray\.com|dooray\.co\.kr|gov-dooray\.co\.kr)$/i.test(u.hostname)?u.origin:'';}catch{return '';}}

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
        <aside class="dx-sidebar" aria-label="폴더">
          <div class="dx-side-title">드라이브</div>
          <nav class="dx-tree dx-drives" data-testid="drive-list" aria-label="드라이브"><button v-for="dv in drives" :key="dv.key" :class="{current:dv.key===driveKey}" :aria-current="dv.key===driveKey?'page':undefined" :disabled="busy||!status.connected" @click="switchDrive(dv.key)" :title="dv.kind==='project'?'프로젝트 드라이브 · 목록·내려받기·새 파일 올리기':'내 개인 드라이브'"><span class="dx-folder-icon" v-html="icons.folder"></span><span>{{dv.name}}</span><small v-if="dv.kind==='project'">{{dv.scope==='public'?'공개':'프로젝트'}}</small></button></nav>
          <button v-if="projectsSupported" class="dx-text dx-add-project" data-testid="drive-add-project" @click="openModal('projects')" :disabled="busy||!status.connected">+ 프로젝트 추가</button>
          <div class="dx-side-title">폴더</div>
          <nav class="dx-tree"><button v-for="node in tree" :key="node.id" :class="{current:node.id===folderId}" :style="{paddingLeft:(12+node.depth*16)+'px'}" @click="goPath(node.path)" :disabled="busy||!status.connected" :aria-current="node.id===folderId?'page':undefined"><span class="dx-folder-icon" v-html="icons.folder"></span><span>{{node.name}}</span></button></nav>
          <div class="dx-side-note">{{currentDrive.kind==='project'?'프로젝트 드라이브 · 목록·내려받기·새 파일 올리기':'두레이 API · 내 개인 드라이브'}}</div>
          <ul class="dx-policy" data-testid="drive-policy" aria-label="드라이브 개인정보 안내"><li v-for="t in DRIVE_POLICY" :key="t">{{t}}</li></ul>
        </aside>
        <main class="dx-main">
          <div class="dx-toolbar">
            <button class="primary" @click="pickUpload" :disabled="busy||!ready||!writable"><span class="dx-ic" v-html="icons.upload"></span>업로드</button>
            <button @click="downloadSelected" :disabled="busy||!ready||!selectedFiles.length"><span class="dx-ic" v-html="icons.download"></span>다운로드</button>
            <button @click="openImport()" :disabled="busy||!ready||!importable" :title="selectedFiles.length&&!importable?'HWPX 문서만 문서함으로 가져올 수 있습니다':'선택한 HWPX를 개인·공용 문서함으로 가져오기'"><span class="dx-ic" v-html="icons.import"></span>문서함으로 가져오기</button>
            <details class="dx-more" ref="more"><summary aria-label="추가 작업" :aria-disabled="busy">···</summary><div class="dx-menu"><button @click="openModal('library')" :disabled="busy||!ready||!writable">문서함 문서 올리기</button><button @click="pickReplacement" :disabled="busy||!ready||!personalWritable||selectedFiles.length!==1" :title="personalWritable?'':'내 드라이브에서만 됩니다'">선택 파일 교체…</button><button data-testid="drive-rename" @click="renameSelected" :disabled="busy||!ready||!personalWritable||selectedFiles.length!==1" :title="personalWritable?'':'내 드라이브에서만 됩니다'">이름 바꾸기…</button><button data-testid="drive-delete" class="dx-danger" @click="deleteSelected" :disabled="busy||!ready||!personalWritable||!selectedFiles.length" :title="personalWritable?'':'내 드라이브에서만 됩니다'">삭제(휴지통으로)</button><button @click="openDooray(status.account?.site,'/drive/')" :disabled="!status.account">두레이에서 열기</button></div></details>
            <span class="spacer"></span><button class="dx-icon" @click="loadFolder" :disabled="busy||!status.connected" aria-label="폴더 새로고침" title="새로고침"><span v-html="icons.refresh"></span></button>
            <input ref="uploadInput" class="dx-hidden" type="file" multiple aria-label="업로드할 파일" @change="uploadInputChanged"><input ref="replaceInput" class="dx-hidden" type="file" aria-label="교체할 파일" @change="replacementChanged">
          </div>
          <div class="dx-location"><button class="dx-icon" @click="goPath(crumbs.slice(0,-1))" :disabled="busy||!ready||crumbs.length<2" aria-label="상위 폴더" title="상위 폴더">↑</button><nav aria-label="현재 드라이브 폴더"><template v-for="(c,i) in crumbs" :key="c.id"><span v-if="i" class="dx-separator">›</span><button @click="goPath(crumbs.slice(0,i+1))" :disabled="busy||!status.connected" :aria-current="i===crumbs.length-1?'page':undefined">{{c.name}}</button></template></nav><input type="search" v-model="query" placeholder="이 폴더에서 찾기" aria-label="이 폴더에서 찾기" :disabled="busy"></div>
          <details class="dx-policy-mini" data-testid="drive-policy-mini"><summary>AI는 폴더 목록을 알 수 없습니다 · 토큰은 암호화해 보관합니다</summary><ul class="dx-policy"><li v-for="t in DRIVE_POLICY" :key="t">{{t}}</li></ul></details>
          <div class="dx-message dx-error" v-if="error&&!modal" role="alert">{{error}}<button class="dx-text" @click="error=''">닫기</button></div>
          <div class="dx-message dx-success" v-if="imported.length" role="status"><span>{{imported.length}}개 문서를 {{importedWhere}}에 가져왔습니다.</span><a v-for="doc in imported" :key="doc.id" :href="'#/doc/'+doc.id">문서 열기 · {{doc.title}}</a><button class="dx-text" @click="imported=[]" aria-label="가져오기 알림 닫기">×</button></div>
          <div class="dx-files" :class="{'dx-dragging':dragging}" @dragenter.prevent="dragEnter" @dragover.prevent="dragOver" @dragleave.prevent="dragLeave" @drop.prevent="dropFiles">
            <template v-if="!status.connected"><div class="dx-empty"><span class="dx-empty-icon" v-html="icons.folder"></span><b>두레이 드라이브를 연결하세요</b><p>두레이에서 만든 개인 API 토큰을 한 번 등록하면 내 개인 드라이브의 파일과 폴더가 여기에 표시됩니다.</p><button class="primary" @click="openModal('settings')">드라이브 연결</button></div></template>
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
          <p class="dx-dialog-lead">{{openAfterImport?'문서를 문서함으로 가져온 뒤 편집기로 엽니다. 저장할 위치를 선택하세요.':'선택한 HWPX '+selectedFiles.length+'개를 편집할 수 있는 문서로 가져옵니다.'}}</p>
          <div class="dx-space-choice"><label v-for="space in ['private','public']"><input type="radio" v-model="importSpace" :value="space" :disabled="busy||!targetsFor(space).length">{{space==='private'?'내 개인 문서함':'공용 문서함'}}</label></div>
          <label class="dx-field">저장할 폴더<select v-model="importKey" :disabled="busy||!spaceTargets.length" aria-label="가져올 문서함 폴더"><option v-for="t in spaceTargets" :key="t.key" :value="t.key">{{t.label}}</option></select></label>
          <p class="dx-hint">{{importSpace==='public'?'공용 문서함의 폴더 권한에 따라 공유됩니다.':'선택한 개인 문서함 폴더의 공유 권한을 따릅니다.'}} 원본 파일은 드라이브에 유지됩니다.</p><p v-if="!spaceTargets.length" class="dx-hint">이 문서함에 작성할 수 있는 폴더가 없습니다.</p>
          <ul class="dx-chosen"><li v-for="f in selectedFiles">{{f.name}}</li></ul>
        </template>
        <template v-if="modal==='library'">
          <p class="dx-dialog-lead">{{crumbs.map(c=>c.name).join(' / ')}}에 올립니다.</p>
          <label class="dx-field">문서함 문서<select v-model="libraryDocId" :disabled="busy" aria-label="드라이브로 올릴 문서함 문서"><option value="">문서 선택</option><option v-for="doc in libraryDocs" :value="doc.id">{{doc.label}}</option></select></label>
          <p class="dx-hint">저장된 공동 문서를 새 파일로 올립니다. 승인 대기 중인 개인 수정은 포함하지 않습니다.</p>
          <details v-if="status.files.length" class="dx-stored"><summary>서버 보관 파일 ({{status.files.length}})</summary><div v-for="f in status.files" :key="f.id"><span>{{f.name}}</span><small>{{fmtSize(f.size)}}</small><button @click="uploadStored(f)" :disabled="busy">올리기</button><button @click="removeStored(f)" :disabled="busy" :aria-label="f.name+' 보관 사본 삭제'">×</button></div></details>
        </template>
        <template v-if="modal==='projects'">
          <p class="dx-dialog-lead">이 화면에 보일 프로젝트 드라이브를 고르세요. 고른 프로젝트만 왼쪽 드라이브 목록에 보입니다.</p>
          <p class="dx-hint">내 두레이 계정이 볼 수 있는 프로젝트입니다. 프로젝트 드라이브에서는 목록·내려받기·새 파일 올리기만 됩니다. 교체·이름 바꾸기·삭제는 내 드라이브에서만 합니다.</p>
          <p v-if="!projectChoices" class="dx-hint" role="status">두레이에서 프로젝트 목록을 읽는 중…</p>
          <p v-else-if="!projectChoices.length" class="dx-hint">볼 수 있는 프로젝트 드라이브가 없습니다.</p>
          <ul v-else class="dx-project-list" data-testid="drive-project-choices"><li v-for="p in projectChoices" :key="p.driveId"><label><input type="checkbox" :value="p.driveId" v-model="projectPicked" :disabled="busy"><span>{{p.name}}</span><small>{{p.scope==='public'?'공개 프로젝트':'프로젝트'}}</small></label></li></ul>
        </template>
        <template v-if="modal==='settings'">
          <template v-if="status.connected&&!replacing">
            <p class="dx-dialog-lead">두레이 <b>{{status.account.name||'계정'}}</b>의 개인 드라이브에 연결되어 있습니다.</p>
            <div class="dx-pair dx-account" data-testid="drive-account"><span>사이트 {{status.account.site}} · {{status.account.cloudLabel}}</span><span>토큰 {{status.account.keyHint}} · 등록 {{fmt(status.account.connectedAt)}}<template v-if="status.account.checkedAt"> · 확인 {{fmt(status.account.checkedAt)}}</template></span></div>
            <div class="dx-dialog-actions"><button @click="checkConnection" :disabled="busy">연결 확인</button><button @click="startReplace" :disabled="busy">토큰 바꾸기</button><button @click="openDooray(status.account.site,'/drive/')">두레이 드라이브 열기</button></div>
            <ul class="dx-policy"><li v-for="t in DRIVE_POLICY" :key="t">{{t}}</li></ul>
            <button class="dx-danger" @click="disconnect" :disabled="busy">연결 해제(토큰 지우기)</button>
          </template>
          <template v-else>
            <p class="dx-dialog-lead">두레이에서 만든 <b>개인 API 인증 토큰</b>을 한 번 등록하면 내 개인 드라이브를 이 화면에서 다룰 수 있습니다. 두레이 로그인은 내가 직접 합니다.</p>
            <ol class="dx-steps" data-testid="drive-token-steps">
              <li>두레이 사이트 주소를 넣고 <b>두레이 열기</b>를 눌러 로그인합니다.</li>
              <li>두레이 오른쪽 위 내 이름(프로필) → <b>개인 설정 → API → 개인 인증 토큰</b>에서 토큰을 생성합니다. 이름은 'hwpx-cowork'처럼 알아보기 쉽게 적습니다.</li>
              <li>만든 토큰을 복사해 아래 칸에 붙여 넣고 <b>등록</b>을 누릅니다.</li>
            </ol>
            <p class="dx-hint">API 메뉴가 보이지 않으면 기관의 두레이 관리자에게 개인 API 토큰 발급을 요청하세요.</p>
            <label class="dx-field">두레이 사이트 주소<span class="dx-inline"><input v-model.trim="siteInput" type="url" inputmode="url" placeholder="https://회사.dooray.com" autocomplete="url" aria-label="두레이 사이트 주소" :disabled="busy"><button @click="openDooray(siteInput)" :disabled="busy||!doorayHome(siteInput)">두레이 열기</button></span></label>
            <label class="dx-field">개인 API 인증 토큰<span class="dx-inline"><input v-model="tokenInput" type="password" autocomplete="off" spellcheck="false" placeholder="두레이에서 복사한 토큰" aria-label="두레이 개인 API 인증 토큰" :disabled="busy" @keydown.enter.prevent="connectDooray"><button @click="pasteToken" :disabled="busy">붙여넣기</button></span></label>
            <p class="dx-hint">토큰은 내 두레이 계정과 같은 권한입니다. cowork 서버는 토큰을 암호화해 보관하고 화면·AI에 다시 보여 주지 않으며, 내 개인 드라이브에만 씁니다. 더 쓰지 않으면 두레이 개인 설정에서 토큰을 삭제하세요.</p>
            <div class="dx-dialog-actions"><button class="primary" @click="connectDooray" :disabled="busy||!siteInput||!tokenInput.trim()">등록</button><button v-if="replacing" @click="replacing=false;tokenInput=''" :disabled="busy">취소</button></div>
          </template>
        </template>
      </div>
      <footer><span class="dx-hint" role="status">{{progress}}</span><button @click="closeModal" :disabled="busy">{{modal==='import'||modal==='library'||modal==='projects'?'취소':'닫기'}}</button><button v-if="modal==='projects'" class="primary" data-testid="drive-projects-save" @click="saveProjects" :disabled="busy||!projectChoices">저장</button><button v-if="modal==='import'" class="primary" @click="importSelected" :disabled="busy||!importTarget||!importable">{{openAfterImport?'가져와서 열기':'가져오기'}}</button><button v-if="modal==='library'" class="primary" @click="uploadLibrary" :disabled="busy||!libraryDocId">올리기</button></footer>
    </dialog></Teleport>
  </Teleport>`,
  setup(props,{emit}){
    const d=inject('doc',null),root=ref(null),dialog=ref(null),more=ref(null),uploadInput=ref(null),replaceInput=ref(null);
    const status=ref({connected:false,account:null,site:null,files:[],maxBytes:52428800,writeProjects:[]}),crumbs=ref([{id:'root',name:'내 드라이브'}]),driveKey=ref(PERSONAL),projectChoices=ref(null),projectPicked=ref([]);
    const items=ref([]),listed=ref(false),selected=ref([]),query=ref(''),descending=ref(false),busy=ref(false),error=ref(''),progress=ref(''),expanded=ref(false),modal=ref(''),dragging=ref(false),cache=ref(new Map());
    const page=ref(0),nextPage=ref(null),imported=ref([]),importedWhere=ref(''),libraryState=ref(null),libraryDocId=ref(''),importKey=ref(''),importSpace=ref('private'),openAfterImport=ref(false);
    const siteInput=ref(''),tokenInput=ref(''),replacing=ref(false);
    let disposed=false,refreshQueue=Promise.resolve(),dragDepth=0,replaceTarget=null,modalFocus=null,expandFocus=null,bodyOverflow='';
    const folderId=computed(()=>crumbs.value.at(-1).id),target=()=>({provider:PROVIDER,projectId:driveKey.value,drive:driveKey.value,folderId:folderId.value});
    const projectsSupported=computed(()=>Array.isArray(status.value.drives));
    const drives=computed(()=>projectsSupported.value?status.value.drives:status.value.connected?[{key:PERSONAL,name:'내 드라이브',kind:'personal',can:ALL_ACTIONS}]:[]);
    const currentDrive=computed(()=>drives.value.find(d=>d.key===driveKey.value)||{key:PERSONAL,name:'내 드라이브',kind:'personal',can:ALL_ACTIONS});
    const can=a=>status.value.connected&&(currentDrive.value.can||[]).includes(a);
    // 쓰기(업로드·교체·삭제·이름 바꾸기)는 서버가 허용한 곳(내 개인 드라이브)에서만
    const writable=computed(()=>can('upload')),personalWritable=computed(()=>writable.value&&currentDrive.value.kind==='personal');
    const ready=computed(()=>status.value.connected&&listed.value),rows=computed(()=>driveRows(items.value,query.value,descending.value));
    const visibleFiles=computed(()=>rows.value.filter(f=>f.type==='file')),selectedFiles=computed(()=>items.value.filter(f=>f.type==='file'&&selected.value.includes(f.id)));
    const importable=computed(()=>selectedFiles.value.length>0&&selectedFiles.value.every(canImportDriveFile));
    const allSelected=computed(()=>visibleFiles.value.length>0&&visibleFiles.value.every(f=>selected.value.includes(f.id))),someSelected=computed(()=>!allSelected.value&&visibleFiles.value.some(f=>selected.value.includes(f.id)));
    const tree=computed(()=>driveTree(cache.value,PROVIDER,driveKey.value,currentDrive.value.name));
    const importTargets=computed(()=>driveImportTargets(props.library||libraryState.value,state.me)),libraryDocs=computed(()=>driveDocumentChoices(props.library||libraryState.value,state.me));
    const targetsFor=space=>importSpaceTargets(importTargets.value,space,state.me),spaceTargets=computed(()=>targetsFor(importSpace.value)),importTarget=computed(()=>spaceTargets.value.find(t=>t.key===importKey.value));
    const modalTitle=computed(()=>({import:openAfterImport.value?'문서 열기':'문서함으로 가져오기',library:'문서함 문서 올리기',settings:'두레이 드라이브 연결',projects:'프로젝트 드라이브 추가'})[modal.value]);
    watch(spaceTargets,list=>{if(!list.some(t=>t.key===importKey.value))importKey.value=list[0]?.key||'';});
    watch(query,()=>{selected.value=[];});
    async function refreshLibrary(){if(!props.library)libraryState.value=await api('/api/library');}
    function refresh(){const task=refreshQueue.catch(()=>{}).then(async()=>{const s=await api('/api/drive');if(!disposed)status.value=s;});refreshQueue=task;return task;}
    async function action(fn){if(busy.value||disposed)return;busy.value=true;error.value='';if(more.value)more.value.open=false;try{return await fn();}catch(e){if(!disposed)error.value=e.message;else toast('드라이브: '+e.message,{kind:'error',ms:6000});if(e.code==='DOORAY_AUTH'||e.code==='DRIVE_OFFLINE'||e.code==='DOORAY_TOKEN_LOST')refresh().catch(()=>{});return null;}finally{busy.value=false;progress.value='';}}
    // 서버가 두레이 API 를 불러 바로 결과를 준다(다른 탭으로 옮겨도 이미 보낸 요청은 서버에서 끝까지 처리된다)
    async function job(action,extra={}){return api('/api/drive/actions',{method:'POST',body:{...target(),action,...extra}});}
    function resetPages(){page.value=0;nextPage.value=null;}
    function resetFolders(){driveKey.value=PERSONAL;crumbs.value=[{id:'root',name:'내 드라이브'}];items.value=[];selected.value=[];query.value='';cache.value=new Map();listed.value=false;resetPages();}
    function remember(){const key=folderKey(PROVIDER,driveKey.value,folderId.value),old=cache.value.get(key);const folders=new Map((old?.folders||[]).map(f=>[f.id,f]));for(const f of items.value)if(f.type==='folder')folders.set(f.id,{id:f.id,name:f.name});cache.value.set(key,{...target(),path:crumbs.value.map(c=>({...c})),folders:[...folders.values()]});}
    async function readFolder(){if(disposed)return;progress.value='폴더를 불러오는 중…';const r=await job('list',{page:page.value});if(disposed)return;items.value=r.items;nextPage.value=r.nextPage??null;listed.value=true;selected.value=[];remember();}
    const loadFolder=()=>action(async()=>{await refresh();if(status.value.connected)await readFolder();});
    const goPath=path=>action(async()=>{if(!path.length)return;crumbs.value=path.map(c=>({...c}));items.value=[];selected.value=[];query.value='';listed.value=false;resetPages();await readFolder();});
    const next=()=>action(async()=>{page.value=nextPage.value;await readFolder();});
    const previousPage=()=>action(async()=>{page.value=Math.max(0,page.value-1);await readFolder();});
    function toggleFile(f){if(busy.value)return;selected.value=selected.value.includes(f.id)?selected.value.filter(id=>id!==f.id):[...selected.value,f.id];}
    function rowClick(f,e){if(busy.value)return;if(f.type==='folder')return goPath([...crumbs.value,{id:f.id,name:f.name}]);if(e.ctrlKey||e.metaKey)toggleFile(f);else selected.value=[f.id];}
    function selectAll(checked){selected.value=checked?visibleFiles.value.map(f=>f.id):[];}
    const fileType=f=>f.type==='folder'?'폴더':f.name.split('.').length>1?f.name.split('.').at(-1).toUpperCase():'파일';
    async function saveBlob(bytes,name){const url=URL.createObjectURL(new Blob([bytes]));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
    async function cleanup(f){try{await api('/api/drive/files/'+f.id,{method:'DELETE'});}catch{/* 성공한 전송의 임시 사본은 다음 정리 때 제거할 수 있다. */}}
    // 두레이 파일 → 서버 보관 사본(내려받기·가져오기 모두 이 사본을 거친다)
    async function remoteStage(f){const r=await job('download',{fileId:f.id,expectedRevision:f.revision});return {id:r.stagedId,name:r.name||f.name};}
    const downloadSelected=()=>action(async()=>{const files=[...selectedFiles.value];for(let i=0;i<files.length;i++){progress.value=`다운로드 ${i+1}/${files.length} · ${files[i].name}`;const f=await remoteStage(files[i]);await saveBlob(await api('/api/drive/files/'+f.id),f.name);await cleanup(f);}toast(files.length+'개 파일을 다운로드했습니다.');});
    async function openModal(kind){if(busy.value)return;if(more.value)more.value.open=false;modalFocus=document.activeElement;error.value='';modal.value=kind;if(kind==='settings'){replacing.value=false;tokenInput.value='';siteInput.value=status.value.account?.site||status.value.site||siteInput.value||'';}if(kind==='projects'){projectChoices.value=null;projectPicked.value=drives.value.filter(d=>d.kind==='project').map(d=>d.key);api('/api/drive/projects').then(r=>{if(modal.value==='projects')projectChoices.value=r.projects;}).catch(e=>{error.value=e.message;});}if(kind==='library'||kind==='import')refreshLibrary().catch(e=>{error.value=e.message;});await nextTick();dialog.value?.showModal();}
    function closeModal(){if(busy.value)return;dialog.value?.close();modal.value='';error.value='';tokenInput.value='';replacing.value=false;nextTick(()=>modalFocus?.isConnected&&modalFocus.focus());}
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
      await refreshLibrary();dialog.value?.close();modal.value='';
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
    const deleteSelected=()=>action(async()=>{const files=[...selectedFiles.value];if(!files.length||!confirm(files.map(f=>f.name).join('\n')+'\n\n'+files.length+'개 파일을 두레이 휴지통으로 옮길까요?'))return;for(let i=0;i<files.length;i++){progress.value=`삭제 ${i+1}/${files.length} · ${files[i].name}`;await job('delete',{fileId:files[i].id,expectedRevision:files[i].revision});}toast(files.length+'개 파일을 휴지통으로 옮겼습니다.');await readFolder();});
    const renameSelected=()=>action(async()=>{const f=selectedFiles.value[0];if(!f)return;const name=prompt('새 파일 이름',f.name)?.trim();if(!name||name===f.name)return;progress.value='이름 바꾸는 중…';await job('rename',{fileId:f.id,expectedRevision:f.revision,name});toast('이름을 바꿨습니다.');await readFolder();});
    const uploadLibrary=()=>action(async()=>{const id=libraryDocId.value;if(d?.id===id){await d.s.editor?.saveNow?.();if(d.s.draft?.dirty||d.s.editor?.dirty)throw Error('문서 저장이 끝난 뒤 다시 시도하세요.');}progress.value='문서함 문서를 올리는 중…';const f=await api('/api/drive/documents/'+encodeURIComponent(id)+'/stage',{method:'POST'});await job('upload',{stagedId:f.id,name:f.name});await cleanup(f);await readFolder();dialog.value?.close();modal.value='';toast('문서함 문서를 드라이브에 올렸습니다.');});
    const uploadStored=f=>action(async()=>{progress.value=f.name+' 올리는 중…';await job('upload',{stagedId:f.id,name:f.name});await readFolder();toast('파일을 드라이브에 올렸습니다.');});
    const removeStored=f=>action(async()=>{await api('/api/drive/files/'+f.id,{method:'DELETE'});await refresh();});
    // 두레이 토큰 등록·확인·해제 — 토큰 원문은 등록 요청 한 번에만 서버로 보내고 화면에 남기지 않는다
    function openDooray(site,path=''){const home=doorayHome(site);if(!home){error.value='두레이 사이트 주소를 확인하세요(예: https://회사.dooray.com).';return;}window.open(home+path,'_blank','noopener');}
    async function pasteToken(){try{const t=(await navigator.clipboard.readText()).trim();if(t)tokenInput.value=t;else error.value='클립보드가 비어 있습니다.';}catch{error.value='클립보드를 읽지 못했습니다. 토큰 칸에 직접 붙여 넣으세요(Ctrl+V).';}}
    const connectDooray=()=>action(async()=>{if(!siteInput.value||!tokenInput.value.trim())throw Error('두레이 사이트 주소와 토큰을 넣으세요.');progress.value='두레이에서 토큰을 확인하는 중…';const s=await api('/api/drive/connection',{method:'PUT',body:{site:siteInput.value,token:tokenInput.value}});tokenInput.value='';replacing.value=false;status.value=s;resetFolders();toast('두레이 '+(s.account?.name||'')+' 계정의 개인 드라이브를 연결했습니다.');dialog.value?.close();modal.value='';await readFolder();});
    const checkConnection=()=>action(async()=>{progress.value='두레이 연결을 확인하는 중…';status.value=await api('/api/drive/connection/check',{method:'POST'});toast('두레이 연결이 정상입니다.');});
    function startReplace(){replacing.value=true;tokenInput.value='';siteInput.value=status.value.account?.site||siteInput.value;}
    const disconnect=()=>action(async()=>{if(!confirm('두레이 드라이브 연결을 해제할까요?\ncowork 서버에 저장한 토큰을 지웁니다. 두레이의 토큰 자체는 두레이 개인 설정에서 삭제하세요.'))return;await api('/api/drive/connection',{method:'DELETE'});await refresh();resetFolders();});
    // 드라이브 바꾸기: 그 드라이브의 최상위부터(폴더 나무는 드라이브마다 따로 기억)
    function switchDrive(key){if(busy.value||key===driveKey.value)return;const dv=drives.value.find(d=>d.key===key);if(!dv)return;driveKey.value=key;crumbs.value=[{id:'root',name:dv.name}];items.value=[];selected.value=[];query.value='';listed.value=false;resetPages();action(readFolder);}
    const saveProjects=()=>action(async()=>{progress.value='프로젝트 목록을 저장하는 중…';const s=await api('/api/drive/projects',{method:'PUT',body:{driveIds:[...projectPicked.value]}});status.value=s;dialog.value?.close();modal.value='';const n=(s.drives||[]).filter(d=>d.kind==='project').length;toast(n?'프로젝트 드라이브 '+n+'개가 보입니다.':'프로젝트 드라이브를 모두 뺐습니다.');if(!(s.drives||[]).some(d=>d.key===driveKey.value)){driveKey.value=PERSONAL;crumbs.value=[{id:'root',name:'내 드라이브'}];items.value=[];listed.value=false;resetPages();await readFolder();}});
    function panelKey(e){if(!expanded.value||modal.value)return;if(e.key==='Escape'){expanded.value=false;e.preventDefault();}if(e.key==='Tab'){const els=[...root.value.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],summary')].filter(el=>el.getClientRects().length);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}
    watch(expanded,async v=>{if(v){expandFocus=document.activeElement;bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';await nextTick();root.value?.querySelector('[aria-label="크게 보기 닫기"]')?.focus();}else{document.body.style.overflow=bodyOverflow;await nextTick();if(expandFocus?.isConnected)expandFocus.focus();}});
    onMounted(async()=>{await action(async()=>{await Promise.all([refresh(),refreshLibrary()]);if(status.value.connected)await readFolder();});});
    onBeforeUnmount(()=>{disposed=true;if(expanded.value)document.body.style.overflow=bodyOverflow;});
    return {DRIVE_POLICY,writable,personalWritable,drives,driveKey,currentDrive,projectsSupported,projectChoices,projectPicked,switchDrive,saveProjects,deleteSelected,renameSelected,d,icons,root,dialog,more,uploadInput,replaceInput,status,crumbs,folderId,ready,rows,selected,selectedFiles,visibleFiles,allSelected,someSelected,importable,query,descending,busy,error,progress,expanded,modal,modalTitle,dragging,page,nextPage,tree,imported,importedWhere,importSpace,importKey,spaceTargets,importTarget,targetsFor,libraryDocs,libraryDocId,openAfterImport,siteInput,tokenInput,replacing,fmt,fmtSize,canImportDriveFile,fileType,doorayHome,loadFolder,goPath,next,previousPage,rowClick,toggleFile,selectAll,downloadSelected,openModal,closeModal,openImport,openFile,importSelected,pickUpload,pickReplacement,uploadInputChanged,replacementChanged,dragEnter,dragOver,dragLeave,dropFiles,uploadLibrary,uploadStored,removeStored,openDooray,pasteToken,connectDooray,checkConnection,startReplace,disconnect,panelKey};
  },
};
