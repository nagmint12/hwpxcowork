// 기능별 튜토리얼 단계. 실행기와 코스 구성은 이 파일 밖에서 관리합니다.
import { stepHelpers, el } from './common.js';
import { tutorialScene } from '../tutorial-scenes.js';

export function buildClipboard(env) {
  const { d, s, ctx, config, focusIn, rectOf, pad, q, fdoc, inFrame, frameRect, selectFor, locate, phraseRect, cw } = env;
  const { finish, intro, paragraph, focus, frameButton, frameDialog, closeFrameDialog, openShape, reveal, top, memo, memoCard, fill } = stepHelpers(env);
    // 휴대폰: 편집기 메뉴·도구 막대가 기본으로 숨겨져 [복사하기]·[모두 선택]이 없다(Ctrl 단축키도 없다) — 먼저 도구 막대를 켜게 한다
    const charPicked = () => !!s.selection && !s.selection.collapsed && !!String(s.selection.text || '').trim();
    const studio = () => { try { return fdoc()?.defaultView?.rhwpStudio?.automation || null; } catch { return null; } };
    const codesShown = () => { try { return !!studio()?.getContext?.()?.showControlCodes; } catch { return false; } };
    const frameEl = selector => { const node = fdoc()?.querySelector(selector); return node && node.getBoundingClientRect().width ? node : null; };
    const allItem = () => frameEl('.md-item[data-cmd="edit:select-all"]');
    const toolsOn = () => !!frameButton('복사하기');
    const toolsStep = { title: '편집 도구 막대 켜기', text: () => (q('[data-testid="toggle-editor-tools"]') ? '[편집 도구 막대]를 누르세요. 편집기 메뉴와 도구 막대가 나타납니다.' : '휴대폰 화면에서는 편집기 메뉴와 도구 막대가 숨겨져 있습니다. 위 [⋯] 메뉴를 여세요.'),
      ring: () => pad(rectOf(q('[data-testid="toggle-editor-tools"]') || q('[data-testid="bar-more-toggle"]')), 4), open: () => pad(rectOf(q('[data-testid="toggle-editor-tools"]') || q('[data-testid="bar-more-toggle"]')), 4),
      until: toolsOn };
    const steps = [
    intro('한글과 복사·붙여넣기', `웹 문서에서 글·표·그림을 복사하고, 한/글에 붙여넣는 흐름을 그림으로 살펴봅니다. PC에서는 직접 따라 해 볼 수 있고, 그림만 보고 다음 연습으로 이어가도 됩니다.${env.touch ? ' 휴대폰에서는 그림으로 흐름을 확인한 뒤 편집 기능을 둘러보세요.' : ''}`),
    { title: '복사할 내용을 직접 선택하기', text: () => (env.touch ? (allItem() ? '[모두 선택]을 누르세요. 또는 [붙여넣기 흐름 보기]로 붙여넣는 모습을 먼저 살펴보세요.' : '휴대폰에서는 두 쪽에 걸친 영역을 고르기 어려울 수 있습니다. [붙여넣기 흐름 보기]로 붙여넣는 모습을 확인하세요. 직접 복사하려면 ‘영역 시작’을 길게 누르고 ‘영역 끝’까지 끌어 고릅니다.')
      : '문서 안을 누르고 Ctrl+Home → Ctrl+A로 전체를 선택하세요. 또는 ‘영역 시작’부터 ‘영역 끝’까지 끌어 선택할 수 있습니다. 선택하면 복사 단계로 넘어갑니다. 먼저 흐름을 보고 싶으면 [붙여넣기 흐름 보기]를 누르세요.'),
      open: frameRect, ring: () => (env.touch ? pad(inFrame(allItem() || frameEl('.menu-title[data-i18n="menu.edit"]')), 4) || frameRect() : frameRect()),
      // 휴대폰은 편집기 높이가 낮아 studio 가 메뉴 줄을 숨기고(가상 키보드용 규칙) Ctrl+A 도 없다. 연습 영역은 두 쪽에 걸쳐 있어
      // 길게 눌러 끌기도 어렵다 — PC와 휴대폰 모두 붙여넣기 흐름 그림으로 바로 이어갈 수 있습니다.
      next: '붙여넣기 흐름 보기', nextPlain: true, nextTo: '한/글에 붙여넣는 흐름',
      until: () => { const text = String(s.selection?.text || ''); return !s.selection?.collapsed && text.includes('영역 시작') && text.includes('영역 끝'); } },
    { title: '선택한 내용을 실제로 복사하기', text: () => (env.touch ? '편집기 도구 막대의 금빛 [복사하기]를 누르세요. [오려 두기]는 원문을 지우므로 이번에는 복사를 사용합니다. 복사한 내용에 실제 글·표·그림이 담긴 것을 확인한 뒤 다음으로 이동합니다.' : '편집기 위 [복사하기]를 직접 누르거나 Ctrl+C를 누르세요. [오려 두기]·Ctrl+X는 원문을 지우므로 이번에는 복사를 사용합니다. 복사 이벤트에 실제 글·표·그림이 담긴 것을 확인한 뒤 다음으로 이동합니다.'), reveal: () => frameButton('복사하기'), ring: () => pad(inFrame(frameButton('복사하기')), 4), open: frameRect,
      enter: () => { ctx.clipCopyStart = env.clipboard?.seq || 0; }, until: () => env.clipboard?.seq > (ctx.clipCopyStart || 0) && env.clipboard.type === 'copy' && env.clipboard.text.includes('영역 시작') && env.clipboard.text.includes('영역 끝') && env.clipboard.tables > 0 && env.clipboard.images > 0 },
    // 이전 '붙여넣어 복사 결과 확인하기'·'실제 한글 영상'의 저장된 참조(1s3lf9h)와 진행 위치는 유지합니다.
    // 2026-11-12: 촬영 영상(hangul-paste.mp4) 대신 웹 요소로 그린 장면(tutorial-scenes.js)을 보여 줍니다. 단계 ID 는 stepId 로 고정되어 제목을 바꿔도 이어집니다.
    { stepId: '1s3lf9h', title: '한/글에 붙여넣는 흐름', text: '웹에서 고른 글·표·그림을 복사해 한/글에 붙여넣는 흐름입니다. 표의 병합과 칸 너비, 그림 크기가 그대로 옵니다. 다 보지 않아도 다음으로 진행할 수 있습니다.', center: true,
      scene: 'hangul-paste', example: root => tutorialScene(root, 'hangul-paste', { reduced: env.motionReduced }), next: '직접 따라 하는 방법' },
    { title: '한/글에 붙여넣기', text: '직접 해 보려면 한글에서 새 문서를 열고 Ctrl+V를 누르세요. 붙여넣은 표의 병합과 칸 너비, 그림 크기를 확인한 뒤 이 화면으로 돌아오면 됩니다. 한글이 없거나 그림으로 충분하다면 다음으로 계속하세요.', center: true,
      example: root => { const note = el('p', '복사한 내용이 바뀌었다면 이전 단계로 돌아가 웹 문서에서 다시 복사하세요.', 'tour-demo-note'); root.append(note); }, next: '다음 단계' },
    { title: '표의 병합과 칸 너비', text: '표에는 병합한 칸과 서로 다른 열 너비가 있습니다. 한/글에 붙여넣은 표도 같은 구조인지 비교하세요. 웹에서 표 칸을 누르면 표 편집 메뉴를 사용할 수 있습니다.', enter: () => focus('표준서식 표'), ring: () => phraseRect('표준서식 표'), open: frameRect, next: '그림과 도형 보기' },
    { title: '그림·도형의 크기', text: '납작한 그림과 여러 도형을 넣어 둔 예시입니다. 그림을 누른 뒤 [개체 속성]이나 P 키로 크기를 확인합니다. 의도한 크기와 캡션이 함께 유지되는지 살펴보세요.', enter: () => focus('아래 그림은 원래'), reveal: () => frameButton('개체속성'), ring: () => pad(inFrame(frameButton('개체속성')), 4), open: frameRect, next: '조판 부호 보기' },
    { title: '조판 부호 켜기', text: '조판 부호를 켜면 각주·미주·책갈피·누름틀 같은 숨은 구조가 보입니다. 금빛 도구 단추나 아래 [조판 부호 켜기/끄기]를 누르고 문서의 표시를 살펴보세요. 다음 단계로 가면 원래 표시 설정으로 되돌립니다.', reveal: () => frameButton('조판부호'), ring: () => pad(inFrame(frameButton('조판부호')), 4), open: frameRect,
      enter: () => { focus('각주가 있습니다'); const before = codesShown(); return () => { if (codesShown() !== before) studio()?.execute?.('view:ctrl-mark'); }; },
      action: { label: '조판 부호 켜기/끄기', run: () => { const b = frameButton('조판부호'); if (b) b.click(); else if (studio()?.execute) studio().execute('view:ctrl-mark'); else throw new Error('편집기가 준비되면 다시 눌러 주세요.'); } }, next: '다음 단계' },
    { title: '링크·책갈피·수식', text: '책갈피와 하이퍼링크는 위치와 주소를, 누름틀은 안내 글을, 수식은 수식 개체를 유지합니다. 아래 버튼으로 해당 예시 문장으로 이동해 봅니다.', ring: () => phraseRect('책갈피:'), open: frameRect, action: { label: '책갈피 예시로 이동', run: () => { focus('책갈피:'); } }, next: '글자 모양 보기' },
    // 글자 모양 창은 고른 글이 있어야 열린다 — 고르기 전에는 예시 글을, 고른 뒤에는 [글자 모양] 단추를 가리킨다(고르지 않고 단추만 누르면 아무 일도 없었다)
    { title: '글자 모양 열기', text: () => (charPicked() ? '금빛 [글자 모양]을 누르세요. 고른 글의 글꼴·크기·장평·자간이 창에 나옵니다.' : `장평·자간·굵게·기울임·밑줄·위아래첨자 등 서로 다른 모양을 넣었습니다. ‘장평 50%’ 같은 예시 글을 ${env.dragHow || '끌어'} 고른 뒤 [글자 모양]을 누르세요.`),
      open: frameRect, reveal: () => (charPicked() ? frameButton('글자모양') : null), ring: () => (charPicked() ? pad(inFrame(frameButton('글자모양')), 4) : phraseRect('장평 50%')),
      action: { label: '예시 선택 후 글자 모양', run: () => openShape('char', '글자 모양 열기') }, until: () => !!frameDialog('char') },
    { title: '글자 모양 값 확인', text: () => frameDialog('char') ? '열린 글자 모양 창에서 글꼴·크기·장평·자간을 확인하세요. 다음으로 가면 이 창을 닫습니다.' : '글자 모양 창이 열려 있지 않습니다. 아래 [글자 모양 열기]로 현재 선택한 글의 값을 확인하거나 다음으로 진행하세요.',
      ring: () => pad(inFrame(frameDialog('char')), 4), open: () => inFrame(frameDialog('char')) || frameRect(), next: '문단 모양 보기', leave: () => closeFrameDialog('char'),
      action: { label: '글자 모양 열기', show: () => !frameDialog('char'), run: () => openShape('char', '글자 모양 값 확인') } },
    { title: '문단 모양과 줄 간격', text: '가운데·오른쪽 정렬, 줄 간격, 여백과 들여쓰기는 문단 모양입니다. 금빛 [문단 모양]을 눌러 커서가 있는 문단의 값을 확인하세요. 아래 단추는 ‘줄 간격 250%’ 예시 문단을 골라 창을 엽니다.', open: frameRect, reveal: () => frameButton('문단모양'), ring: () => pad(inFrame(frameButton('문단모양')), 4),
      action: { label: '예시 선택 후 문단 모양', run: () => openShape('para', '문단 모양과 줄 간격') }, until: () => !!frameDialog('para') },
    { title: '문단 모양 값 확인', text: () => frameDialog('para') ? '열린 문단 모양 창에서 정렬·줄 간격·들여쓰기·문단 앞뒤 간격을 확인하세요. 다음으로 가면 이 창을 닫습니다.' : '문단 모양 창이 열려 있지 않습니다. 아래 [문단 모양 열기]로 현재 문단의 값을 확인하거나 다음으로 진행하세요.',
      ring: () => pad(inFrame(frameDialog('para')), 4), open: () => inFrame(frameDialog('para')) || frameRect(), next: '표 단축키 보기', leave: () => closeFrameDialog('para'),
      action: { label: '문단 모양 열기', show: () => !frameDialog('para'), run: () => openShape('para', '문단 모양 값 확인') } },
    { title: '표 단축키 연습 위치', text: '연습 표의 칸을 누른 뒤 Ctrl+Enter는 줄 추가, Ctrl+Backspace·Ctrl+Y는 줄 지우기, Alt+Insert는 줄/칸 추가 창, F5 뒤 P는 표/셀 속성입니다. 실제 키 입력은 원하는 항목만 해 보고 Ctrl+Z로 되돌리세요.', enter: () => focus('연습 칸 1'), ring: () => phraseRect('연습 칸 1'), open: frameRect, next: '모양 복사 보기' },
    { title: '모양 복사', text: '원본 글의 모양을 Alt+C 또는 [모양 복사]로 기억하고, 대상 글을 골라 적용합니다. 아래 버튼은 원본 글을 골라 줍니다. 편집기 위 [모양 복사]를 눌러 값을 확인해 보세요.', reveal: () => frameButton('모양복사'), ring: () => pad(inFrame(frameButton('모양복사')), 4), open: frameRect,
      action: { label: '모양 복사 원본 선택', run: () => selectFor('이 글자 모양을 복사하세요') }, next: '반대로 붙여넣기 알아보기' },
    { title: '한/글에서 웹 편집기로 붙여넣기', text: '반대로 한/글의 표나 그림을 복사해 이 문서의 끝에 Ctrl+V로 붙여 넣을 수 있습니다. 브라우저 권한이나 설치 환경에 따라 지원 형식이 다를 수 있으므로 붙은 결과를 확인합니다.', enter: () => focus('한글에서 표나 그림이 든 부분을'), open: frameRect, next: '완료 단계로' }, finish,
    ];
    if (env.touch) steps.splice(1, 0, toolsStep);
    return steps;
}
