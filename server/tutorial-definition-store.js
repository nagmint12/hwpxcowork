// 관리자가 편집한 코스 구성은 서비스 설정·원본 문서와 별도로 보관한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './store.js';
import { defaultTutorialDefinition, normalizeTutorialDefinition, TUTORIAL_MODULES } from '../web/tutorial-definition.js';
import { validateTutorialStepReferences } from '../web/tutorial-modules/compose.js';

const revisionOf = definition => crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');

export function createTutorialDefinitionStore({ dataDir, error, defaults = defaultTutorialDefinition }) {
  const file = path.join(dataDir, 'tutorial-definition.json');
  const fail = (code, message, status) => { throw error(code, message, status); };
  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (raw == null) {
      const definition = defaults();
      return { definition, revision: revisionOf(definition) };
    }
    try {
      const definition = normalizeTutorialDefinition(JSON.parse(raw));
      validateTutorialStepReferences(definition);
      return { definition, revision: revisionOf(definition) };
    } catch {
      return fail('BAD_TUTORIAL_DEFINITION_FILE', '저장된 튜토리얼 구성을 읽을 수 없습니다. 구성 파일을 확인해 주세요.', 500);
    }
  }
  function admin(user) {
    if (user?.role !== 'admin') fail('ADMIN_REQUIRED', '관리자만 튜토리얼 구성을 편집할 수 있습니다.', 403);
  }
  function snapshot(user, sources) {
    admin(user);
    return { ...read(), modules: TUTORIAL_MODULES, sources };
  }
  function save(user, value, sources) {
    admin(user);
    const current = read();
    if (typeof value?.revision !== 'string' || value.revision !== current.revision)
      fail('TUTORIAL_DEFINITION_CONFLICT', '튜토리얼 구성이 변경되었습니다. 새로 불러온 뒤 다시 저장해 주세요.', 409);
    let definition;
    try { definition = normalizeTutorialDefinition(value?.definition); validateTutorialStepReferences(definition); }
    catch (e) { fail('BAD_TUTORIAL_DEFINITION', e.message || '튜토리얼 구성이 올바르지 않습니다.', 400); }
    fs.mkdirSync(dataDir, { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(definition, null, 2)}\n`);
    return { definition, revision: revisionOf(definition), modules: TUTORIAL_MODULES, sources };
  }
  return { read, snapshot, save };
}
