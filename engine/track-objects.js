// [hwpx-cowork] 표·그림·차트·도형 변경 추적(2026-10-30) — 개체를 변경 추적 표식으로 감싸는 꼴(OBJECT_TRACK)과 변경 이름.
// 읽는 쪽(engine/section.js)은 hp:t 안·run 단계 표식을 모두 읽어 개체 anchor 에 ins/del 을 세우므로, 한/글 실측에 따라 바뀌는 것은 여기(쓰는 쪽)뿐이다.
// 엔진(engine/doc.js)의 아래쪽 코드는 개체 anchor 의 ins/del 과 파서가 알아본 '개체에 붙은 표식'(begin.attach)만 본다.
import { shapeName } from './shapes.js';

/**
 * 개체 변경 추적 표식 꼴(쓰는 쪽 전략 — 한/글 실측으로 정한다. 읽는 쪽은 꼴과 상관없다):
 *  - name: 꼴 이름('marks-in-t' = 개체 앞뒤의 빈 hp:t 안 표식 | 'marks-in-run' = run 의 직접 자식 표식)
 *  - wrap(objXml, { type, id }): run 안에서 개체 XML 을 대신할 XML(개체를 표식으로 감싼 것)
 *  - headerType(type): 머리 항목(hh:trackChange type) 종류 — 글과 같으면 type 그대로
 *  - paraEnd: 개체 문단째 넣기·지우기에 paraend="1" 을 쓰는가(지금은 쓰지 않는다 — 문단 구조는 글과 같은 규칙)
 *  - modify.props: 짝지은 개체의 속성(옮김·크기·배치·모양) 고침 — 'direct'(추적 없이 고침) | 'replace'(옛 것 지움 + 새 것 넣음)
 *  - modify.replaceXml: 통째 바꿈(표 뼈대·고칠 수 없는 도형) — 'direct'(옛 개체 안 처리 안 된 변경을 먼저 수락한 뒤 바꿈) | 'replace'
 * 자리표시(2026-10-30 실측 전): 빈 hp:t 안 표식, 글과 같은 Insert/Delete, paraend 없음, 고침은 직접.
 */
export const OBJECT_TRACK = {
  name: 'marks-in-t',
  wrap(objXml, { type, id }) {
    const b = type === 'Insert' ? 'insert' : 'delete';
    const begin = `<hp:${b}Begin Id="${id}" TcId="${id}"/>`;
    const end = `<hp:${b}End Id="${id}" TcId="${id}" paraend="0"/>`;
    return OBJECT_TRACK.name === 'marks-in-run' ? `${begin}${objXml}${end}` : `<hp:t>${begin}</hp:t>${objXml}<hp:t>${end}</hp:t>`;
  },
  headerType: (type) => type,
  paraEnd: false,
  modify: { props: 'direct', replaceXml: 'direct' },
};
const DEFAULT_TRACK = { ...OBJECT_TRACK, modify: { ...OBJECT_TRACK.modify } };

/** 표식 꼴 바꾸기(시험·실측 전환용) — patch 의 값으로 덮어쓴다. patch 가 null 이면 자리표시로 되돌린다 → 지금 꼴 */
export function setObjectTrackStyle(patch) {
  if (patch == null) { Object.assign(OBJECT_TRACK, DEFAULT_TRACK, { modify: { ...DEFAULT_TRACK.modify } }); return OBJECT_TRACK; }
  const { modify, ...rest } = patch;
  Object.assign(OBJECT_TRACK, rest);
  if (modify) OBJECT_TRACK.modify = { ...OBJECT_TRACK.modify, ...modify };
  return OBJECT_TRACK;
}

/**
 * [hwpx-cowork] 문단 나눔 변경 추적 꼴(2026-10-30 한/글 2022 실측 — scratchpad breakA):
 *  - 나눔만의 변경 = 폭 0 쌍 <hp:{insert|delete}Begin/><hp:{insert|delete}End paraend="1"/> 을 그 물리 문단 마지막 hp:t 맨 끝에(한/글이 끝에서 Delete·
 *    머리에서 Backspace·'앞 나눔 + 문단 글' 골라 지우기에 쓰는 꼴 그대로 — 한/글이 다시 저장해도 남는다. 다시 저장하면 번호를 문서 차례로 다시 매기고
 *    잇닿은 같은 종류 범위를 하나로 합친다 — engine/doc.js _normalizeChanges 가 펼친다)
 *  - 문단 통째 지우기 = 앞 문단 나눔 지움(b꼴). 앞 문단이 최종본에서 비었으면(한/글은 수락할 때 빈 앞 문단을 버리고 뒤 문단 속성을 남긴다) 지운 문단
 *    자기 나눔(a꼴 — 지운 문단이 자리를 내준다) — deleteBreakAfter
 *  - 문단 넣기 = 앞 문단 나눔 넣음(A{+¶+} N — 한/글 Enter 뒤 입력과 같다). 앞 나눔이 이미 넣은 나눔이면 새 문단 자기 나눔
 *  - 한/글은 합친 문단에 이어지는 문단의 문단 모양을 앞 문단 것으로 바꾸고 ParaShape 변경으로 적는다 — 우리는 적지 않는다(paraShape: false)
 */
export const BREAK_TRACK = { deleteForm: 'b', emptyPrevOwnBreak: true, paraShape: false };

/** 문단 나눔 변경 이름(changes() label): type 'Insert'|'Delete', hasText = 글도 든 범위 → '문단 나눔 지움' · '글과 문단 나눔 넣음' … */
export function breakChangeLabel(type, hasText = false) {
  return `${hasText ? '글과 ' : ''}문단 나눔 ${type === 'Insert' ? '넣음' : '지움'}`;
}

/** 개체 종류 → { what, name } (changes() 의 objects[] — 웹 이름표·MCP 설명) */
const WHAT = {
  'hp:tbl': ['table', '표'], 'hp:pic': ['picture', '그림'], 'hp:chart': ['chart', '차트'], 'hp:equation': ['equation', '수식'], 'hp:ole': ['ole', 'OLE 개체'],
  'hp:textart': ['shape', '글맵시'], 'hp:video': ['other', '동영상'],
};
const SHAPES = new Set(['hp:line', 'hp:rect', 'hp:ellipse', 'hp:arc', 'hp:polygon', 'hp:curve', 'hp:connectLine', 'hp:container']);

/**
 * 개체 요소 이름(anchorTag — 한/글 차트 switch 는 'hp:chart')·XML → { what: 'table'|'picture'|'chart'|'shape'|'equation'|'ole'|'other', name }
 * (name: 표·그림·차트·선·사각형·글상자·묶음·수식·OLE 개체·개체 …)
 */
export function objectWhat(tag, xml = '') {
  if (WHAT[tag]) return { what: WHAT[tag][0], name: WHAT[tag][1] };
  if (SHAPES.has(tag)) return { what: 'shape', name: shapeName(tag, xml) };
  return { what: 'other', name: '개체' };
}

/**
 * 변경 이름(changes() label): type 'Insert'|'Delete', objects = [{ what, name }], hasText = 글도 든 범위(섞임) →
 * '표 넣음' · '그림 2개 지움' · '차트 넣음' · '글상자 지움' · '도형 넣음: 선' · '표·그림 지움' · '글과 표 지움'
 */
export function objectChangeLabel(type, objects = [], hasText = false) {
  const verb = type === 'Insert' ? '넣음' : '지움';
  const isShape = (o) => o.what === 'shape' && o.name !== '글상자';
  const groups = new Map();
  for (const o of objects) { const k = isShape(o) ? '도형' : (o.name || '개체'); groups.set(k, (groups.get(k) || 0) + 1); }
  const what = [...groups].map(([k, n]) => (n > 1 ? `${k} ${n}개` : k)).join('·') || '개체';
  const shapes = [...new Set(objects.filter(isShape).map((o) => o.name))];
  return `${hasText ? `글과 ${what}` : what} ${verb}${shapes.length ? `: ${shapes.join(', ')}` : ''}`;
}
