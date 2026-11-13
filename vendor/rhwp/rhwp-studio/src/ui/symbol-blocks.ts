/**
 * [hwpx-cowork] 문자표 대화상자 왼쪽 '문자 영역' 목록.
 *
 * 블록 구성(이름·범위·개수 38개)은 유니코드 블록 그대로 두고 **차례만** 한/글 2022 '사용자 문자표'
 * 그룹 차례에 가깝게 놓는다. 근거: 한/글 2022 설치 기본값
 * `HOffice120/Bin/ProofTools/Dics/ko-KR/UserCodeMapSet.ini`(UTF-16, Count=30 — 기호1, 기호2, 영어/숫자, …).
 * 규칙: 블록마다 그 블록 문자를 가장 많이 담은 그룹을 찾고, 그 절반 이상을 담은 그룹 가운데 가장 앞 그룹을
 * 그 블록의 자리로 삼는다. 같은 그룹 안에서는 그 그룹 자료에 먼저 나오는 블록부터. 사용자 문자표에 문자가
 * 하나도 없는 블록은 맨 뒤에 원래 유니코드 차례로 둔다. 대응표: research/hangul2022-features-20261111/impl/ledger_symbols.md
 *
 * symbols-dialog.ts 에서 분리했다 — node 시험이 런타임 편집기 모듈 없이 차례를 확인한다(tests/symbols-block-order.test.ts).
 */
import { t } from '../i18n/index.ts';
import type { UnicodeBlock } from './unicode-block.ts';

export const UNICODE_BLOCKS: UnicodeBlock[] = [
  // ── 한/글 사용자 문자표: 기호1
  { name: t('dialog.symbols.label.x2b0b4f'), start: 0x3000, end: 0x303F },
  { name: t('dialog.symbols.label.x75c51f'), start: 0x25A0, end: 0x25FF },
  // ── 한/글 사용자 문자표: 기호2
  { name: t('dialog.symbols.label.x45592a'), start: 0x02B0, end: 0x02FF },
  { name: t('dialog.symbols.label.x62e882'), start: 0x2600, end: 0x26FF },
  { name: t('dialog.symbols.label.xf5e1d0'), start: 0x2580, end: 0x259F },
  // ── 한/글 사용자 문자표: 영어/숫자
  { name: t('dialog.symbols.label.xbd09a6'), start: 0xFF00, end: 0xFFEF },
  // ── 한/글 사용자 문자표: 한글자모
  { name: t('dialog.symbols.label.xc72323'), start: 0x3130, end: 0x318F },
  // ── 한/글 사용자 문자표: 그리스어
  { name: t('dialog.symbols.label.xd4cd54'), start: 0x2150, end: 0x218F },
  { name: t('dialog.symbols.label.x07cd74'), start: 0x0370, end: 0x03FF },
  // ── 한/글 사용자 문자표: 선문자
  { name: t('dialog.symbols.label.xc57c60'), start: 0x2500, end: 0x257F },
  // ── 한/글 사용자 문자표: 단위기호
  { name: t('dialog.symbols.label.x4e4d67'), start: 0x3300, end: 0x33FF },
  // ── 한/글 사용자 문자표: 히라가나
  { name: t('dialog.symbols.label.xd49fce'), start: 0x3040, end: 0x309F },
  // ── 한/글 사용자 문자표: 가타카나
  { name: t('dialog.symbols.label.x02c330'), start: 0x30A0, end: 0x30FF },
  // ── 한/글 사용자 문자표: 러시아어
  { name: t('dialog.symbols.label.x4b6933'), start: 0x0400, end: 0x04FF },
  // ── 한/글 사용자 문자표: 특수외국어
  { name: t('dialog.symbols.label.x9a801f'), start: 0x0100, end: 0x017F },
  // ── 한/글 사용자 문자표: 발음기호(서유럽)
  { name: t('dialog.symbols.label.xb1d5b2'), start: 0x0250, end: 0x02AF },
  // ── 한/글 사용자 문자표: 서유럽어 추가
  { name: t('dialog.symbols.label.x11acc8'), start: 0x0080, end: 0x00FF },
  // ── 한/글 사용자 문자표: 발음기호(중국)
  { name: t('dialog.symbols.label.x9c6d5f'), start: 0x0180, end: 0x024F },
  // ── 한/글 사용자 문자표: 화살표
  { name: t('dialog.symbols.label.xef18fc'), start: 0x2190, end: 0x21FF },
  { name: t('dialog.symbols.label.x638f83'), start: 0x2900, end: 0x297F },
  { name: t('dialog.symbols.label.x00805b'), start: 0x27F0, end: 0x27FF },
  // ── 한/글 사용자 문자표: 수학연산자
  { name: t('dialog.symbols.label.xdd71ac'), start: 0x27C0, end: 0x27EF },
  { name: t('dialog.symbols.label.xb6cd10'), start: 0x2980, end: 0x29FF },
  { name: t('dialog.symbols.label.x64dd0a'), start: 0x2200, end: 0x22FF },
  { name: t('dialog.symbols.label.xbfe9c9'), start: 0x2000, end: 0x206F },
  // ── 한/글 사용자 문자표: 문장부호
  { name: t('dialog.symbols.label'), start: 0x0020, end: 0x007F },
  // ── 한/글 사용자 문자표: 화폐기호
  { name: t('dialog.symbols.label.x0d145b'), start: 0x20A0, end: 0x20CF },
  // ── 한/글 사용자 문자표: 글자꼴기호
  { name: t('dialog.symbols.label.x9caeb1'), start: 0x2100, end: 0x214F },
  // ── 한/글 사용자 문자표: 첨자
  { name: t('dialog.symbols.label.x86998a'), start: 0x2070, end: 0x209F },
  // ── 한/글 사용자 문자표: 여러 가지 수
  { name: t('dialog.symbols.label.xcf7f7d'), start: 0x4E00, end: 0x4FFF },
  // ── 한/글 사용자 문자표: 특수기호 및 딩뱃기호
  { name: t('dialog.symbols.label.x5a8996'), start: 0x2700, end: 0x27BF },
  // ── 한/글 사용자 문자표: 기술기호
  { name: t('dialog.symbols.label.xfd7ad4'), start: 0x2300, end: 0x23FF },
  // ── 사용자 문자표에 문자가 없는 블록(원래 유니코드 차례)
  { name: t('dialog.symbols.label.x1c16b9'), start: 0x0300, end: 0x036F },
  { name: t('dialog.symbols.label.x091eb3'), start: 0x2400, end: 0x243F },
  { name: t('dialog.symbols.label.x4703a0'), start: 0x2440, end: 0x245F },
  { name: t('dialog.symbols.label.x9aaee4'), start: 0x2800, end: 0x28FF },
  { name: t('dialog.symbols.label.xcbdcf3'), start: 0xAC00, end: 0xAD0F },
  { name: t('dialog.symbols.label.x4ed4cb'), start: 0xB098, end: 0xB1FF },
];
