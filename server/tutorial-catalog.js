// 배포된 설명서는 공통 원본으로만 읽는다. 복사·붙여넣기 시험이 쓰는 원본 HWPX는 수정하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { AI_SAMPLES, ORIGINAL_AI_SAMPLES } from './tutorial-samples.js';

const IDS = ['overview', 'clipboard', 'ai-requests', 'ai-connect', 'admin'];
// 일반 사용자의 '튜토리얼' 폴더는 예약하거나 숨기지 않는다.
// 옛 설명서 복원과의 호환 이름만 이곳에서 관리하며 개인 폴더에는 적용하지 않는다.
export const LEGACY_TUTORIAL_FOLDER_NAME = '튜토리얼hidden';
export function legacyTutorialFolder(folder) {
  return folder?.space === 'public' && ['따라하기 설명서', LEGACY_TUTORIAL_FOLDER_NAME].includes(folder.name);
}
const DESCRIPTIONS = [
  '문서 열기와 편집, 메모, 저장을 둘러봅니다.',
  '한글과 복사·붙여넣기, 표와 그림 편집을 연습합니다.',
  'AI 요청, 제안 검토와 반영, 메모와 답글을 연습합니다.',
  '내 PC에서 쓰는 Codex·Claude Code를 연결해 요청을 바로 처리하게 합니다. 구독 요금제 그대로라 추가 비용이 없습니다. ChatGPT 웹(고급)과 API 키(유료)는 필요할 때만 고릅니다.',
  '관리자 앱, 계정과 문서함 관리를 알아봅니다.',
];

// 설명서 파일 이름의 '00 '~'04 ' 는 파일 차례일 뿐 튜토리얼 메뉴 번호가 아니다 — 제목에서는 뺀다(메뉴 번호는 /api/tutorial 이 순서대로 매긴다).
export const CONNECT_TITLE = 'AI 연결 — 내 PC의 Codex·Claude Code';
export function manualCatalog(root) {
  const dir = path.join(root, 'docs', 'manuals');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return []; }
  return manifest.documents.map((item, i) => ({
    id: IDS[item.order] || `manual-${i}`, title: item.order === 3 ? CONNECT_TITLE : item.file.replace(/\.hwpx$/i, '').replace(/^\d+\s*/, '').replace(/따라\s*하기/g, '튜토리얼'),
    description: DESCRIPTIONS[item.order] || '문서의 안내를 따라 연습합니다.',
    file: item.order === 3 && fs.existsSync(path.join(root, 'tutorial', 'AI 연결 — 사용자 가이드.hwpx')) ? path.join(root, 'tutorial', 'AI 연결 — 사용자 가이드.hwpx') : path.join(dir, item.file),
    guided: item.order !== 4, reference: item.order === 4, source: 'manual',
  }));
}

/**
 * 한/글 '변경 내용 추적'을 켠 채로 열리게 한다(2026-11-04): header.xml 의 <hh:trackchageConfig flags> 첫 비트(1)가 켬이다
 * — 한/글 2022 실측(56 → 57 이면 IsTrackChange=1, 다시 저장해도 57; artifacts/tutorial-simplify-20261104/hangul/).
 */
export async function withTrackChangeOn(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file('Contents/header.xml'); if (!file) return bytes;
  const old = await file.async('string');
  let next = old.replace(/(<hh:trackchageConfig\s[^>]*flags=")(\d+)(")/, (m, a, n, b) => `${a}${Number(n) | 1}${b}`);
  if (next === old && !/<hh:trackchageConfig[\s/>]/.test(old)) next = old.replace(/<\/hh:head>\s*$/, '<hh:trackchageConfig flags="57"/></hh:head>');
  if (next === old) return bytes;
  zip.file('Contents/header.xml', next);
  for (const name of ['mimetype', 'version.xml']) if (zip.file(name)) zip.file(name, await zip.file(name).async('nodebuffer'), { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// 변경 추적을 켠 채 시작하는 것은 2026-11-04 되돌렸다(반영 오류) — 고친 뒤 다시 켤 때 withTrackChangeOn 을 감싼다
export async function tutorialBytes(item) {
  return sourceBytes(item);
}

async function sourceBytes(item) {
  const bytes = fs.readFileSync(item.file);
  if (item.source !== 'manual') return bytes;
  const zip = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(zip.files)) {
    if (!/\.xml$|^Preview\/PrvText\.txt$/i.test(name)) continue;
    const old = await zip.file(name).async('string');
    const updated = old
      .replace('공용 문서함 › 따라하기 설명서 폴더의 문서는 서버를 처음 켤 때 자동으로 들어갑니다. 누구나 읽을 수 있고, 따라 해 보며 고쳐도 됩니다. 화면 위 [사용 설명서] 단추는 연결·설정 안내이고, 이 폴더는 직접 해 보는 문서입니다.', '상단 [튜토리얼] 메뉴에서 원하는 연습을 시작하세요. 각 연습은 본인만 사용할 수 있는 임시 문서로 열립니다. [완료하고 문서함에 저장]을 누르면 연습한 문서가 개인 문서함에 저장됩니다. 화면 위 [사용 설명서]는 연결·설정 안내입니다.')
      .replace('이 폴더의 문서는 모두가 함께 쓰는 공용 문서입니다. 연습한 뒤에는 Ctrl+Z 로 되돌리거나, [한글로 저장]한 파일을 개인 문서함에 올려 마음껏 연습하세요.', '이 문서는 본인의 임시 연습 문서입니다. 완료 전에는 문서함에 표시되지 않습니다. 튜토리얼 메뉴에서 이어하거나 버릴 수 있고, 처음부터 시작하면 새 임시 문서가 열립니다. 완료한 문서는 그대로 보관됩니다.')
      .replace('서버를 처음 켤 때 남겨 둔 실제 기록', '튜토리얼을 시작할 때 준비한 예시 기록')
      .replace('데이터 폴더의 .manuals-seeded.json 을 지우고 서버를 다시 켜면 ‘따라하기 설명서’ 폴더에 새로 들어갑니다(같은 이름 폴더가 있으면 그 안에). 끄려면 설정 config.json 의 &quot;manuals&quot;: { &quot;seed&quot;: false }. 개발 서버에는 node scripts/seed-manuals.mjs --url … --token ….', '상단 [튜토리얼] 메뉴에서 [처음부터 시작]을 누르면 새 임시 문서로 다시 연습합니다. 계정마다 문서를 미리 복사하거나 서버를 다시 켤 필요가 없습니다. 완료한 연습 문서는 개인 문서함에 남습니다.')
      .replace(/따라\s*하기/g, '튜토리얼');
    let current = updated.replace(/데이터 폴더의 \.manuals-seeded\.json[^<]*/g, '상단 [튜토리얼] 메뉴에서 [처음부터 시작]을 누르면 새 임시 문서로 다시 연습합니다. 계정마다 문서를 미리 복사하거나 서버를 다시 켤 필요가 없습니다. 완료한 문서는 개인 문서함에 남습니다.');
    if ((item.sourceId || item.id) === 'ai-requests') {
      for (const key of ['A','B','C']) current = current.replaceAll(ORIGINAL_AI_SAMPLES[key], AI_SAMPLES[key]);
      current = current.replaceAll('4. 연습용 예시', '4. AI에게 실제로 맡겨 볼 예시').replaceAll('3. 이 문서에 남은 실제 기록', '3. 준비된 예시 기록').replaceAll('요청 2 — 줄바꿈 맞추기', '요청 2 — 운영 계획 요약');
    }
    if (current !== old) zip.file(name, current);
  }
  for (const name of ['mimetype', 'version.xml']) if (zip.file(name)) zip.file(name, await zip.file(name).async('nodebuffer'), { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * AI 활용 심화·AI로 보고서 만들기의 연습 보고서(docs/TUTORIAL_AI_ADVANCED_PLAN_2026-11-04.md). 연습 보고서와 첨부 엑셀은 scripts/build-tutorial-advanced.mjs 가 만든다(가상 자료).
 * 개인 AI 연결 없이 늘 준비된 예시 답변으로 진행한다(ownAi 표시 = 예시 답변 경로, 2026-11-04). 원본이 없으면 항목을 내지 않는다
 */
export function advancedCatalog(root) {
  const file = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
  if (!fs.existsSync(file)) return [];
  const xlsx = path.join(root, 'tutorial', '재수강 경험자 설문 결과(가상).xlsx');
  // 'AI로 보고서 만들기'의 내 skill 작업(K1)이 요청에 붙이는 예시 skill(2026-11-12, scripts/tutorial-advanced/build-ai-work.mjs) — 같은 연습 문서를 쓰는 코스 모두에 붙는다
  const skill = path.join(root, 'tutorial', '보고서 작성 규칙(예시).skill');
  return [{ id: 'ai-advanced', title: 'AI 활용 심화 — 시각화·표·보고서', description: '그림 만들기·그림 바꾸기·표 서식과 오탈자·문서 교정·결론 쓰기 5가지를 준비된 AI 답변으로 맡기고 반영해 봅니다.',
    file, guided: true, source: 'advanced', ownAi: true, attachments: [xlsx, skill].filter((f) => fs.existsSync(f)).map((f) => ({ file: f, name: path.basename(f) })) }];
}

// 예전 공용 설명서만 메뉴로 대체한다. 사용자가 연습한 문서는 목록에 그대로 보존한다.
export function legacyTutorialTemplate(meta, library) {
  const folder = library.folder(meta.folderId);
  if (meta.space === 'private' || !legacyTutorialFolder(folder)) return false;
  if (!/^0[0-4] .+\.hwpx$/.test(meta.fileName || '')) return false;
  // 누가 편집했든 기록이 하나라도 있으면 숨기지 않는다(예전 예시 AI 기록도 보존).
  if (meta.version > 1 || meta.proposals?.length || meta.requests?.length || meta.attachments?.length || Object.keys(meta.memoThreads || {}).length) return false;
  return true;
}
