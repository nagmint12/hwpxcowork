// 튜토리얼은 docs/ 밖에서 편집한다. 완료 시 폴더를 옮겨 HWPX·버전·메모·첨부를 함께 보존한다.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';

export class TutorialStore extends Store {
  constructor(dataDir) {
    super(dataDir);
    this.sessions = new Store(path.join(dataDir, 'tutorial-sessions'));
  }

  _docDir(id) {
    const normal = super._docDir(id); // id 검증도 여기서 한다
    if (fs.existsSync(normal) || !this.sessions) return normal;
    const temporary = this.sessions._docDir(id);
    return fs.existsSync(temporary) ? temporary : normal;
  }

  readMeta(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) return null;
    const file = path.join(this._docDir(id), 'meta.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  create(args) {
    return args.extra?.tutorialSession ? this.sessions.create(args) : super.create(args);
  }

  list() { return super.list().filter(m => !m.tutorialSession); }

  // 완료 도중 디스크 오류가 나도 연습 목록에서 찾아 다시 저장할 수 있다.
  listSessions() { return [...this.sessions.list(), ...super.list().filter(m => m.tutorialSession)]; }

  promoteTutorial(id) {
    const target = super._docDir(id);
    if (!fs.existsSync(target)) fs.renameSync(this.sessions._docDir(id), target);
  }
}
