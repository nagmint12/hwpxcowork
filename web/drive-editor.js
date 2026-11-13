// 편집기 내부 드라이브 패널은 사용 중지 상태로 보관한다.
// 문서 목록은 drive.js의 탐색기를 직접 사용한다. 편집기에서 다시 제공하려면
// 이 정의를 panels.js의 PANEL_TABS에 넣고 view.js의 패널 표시 규칙도 함께 활성화한다.
import {DriveTab} from './drive.js';

export const EditorDrivePanel={
  name:'EditorDrivePanel',
  components:{DriveTab},
  template:'<DriveTab/>',
};
export const EDITOR_DRIVE_TAB=Object.freeze({id:'drive',label:'드라이브',comp:EditorDrivePanel});
