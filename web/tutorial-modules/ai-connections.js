// 'AI 연결' 실습(2026-11-13 재구성). 글은 web/tutorial-connect.js 에 있고(내려받는 한/글 가이드와 같은 글), 이 파일은 화면 단계로 엮는다.
// 순서 = 연결 우선순위: ① 내 PC의 Codex·Claude Code(먼저) ② ChatGPT 웹(선택·고급) ③ API 키(선택·유료).
// 붙여넣을 내용은 복사 상자(commandExample), 실제 계정 화면은 그림(image)으로만 보여 주고 아무것도 저장하지 않는다.
import { connectGuide, CONNECT_TIERS, CONNECT_SOURCES, EXAMPLE_MCP_URL } from '../tutorial-connect.js';
import { stepHelpers, el, image, practice, external, commandExample } from './common.js';

export function buildAiConnections(env) {
  const { ctx, config } = env;
  const { finish, intro } = stepHelpers(env);
  let mcpUrl = '';
  try { mcpUrl = new URL('/mcp', config.publicUrl || location.origin).href; } catch { mcpUrl = EXAMPLE_MCP_URL; }
  const guide = connectGuide(mcpUrl);
  const item = id => guide.find(step => step.id === id);
  const at = title => steps.findIndex(step => step.title === title);
  const blocks = (root, id) => { for (const block of item(id).blocks || []) commandExample(root, block.label, block.value); };
  const base = (id, extra = {}) => ({ title: item(id).title, text: item(id).text, center: true, next: '다음 단계', example: root => blocks(root, id), ...extra });
  const choose = root => {
    const group = el('div', null, 'tour-choices'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', '연결 방법 선택');
    for (const tier of CONNECT_TIERS) {
      const b = el('button', tier.choice); b.type = 'button'; b.title = tier.note; b.setAttribute('aria-pressed', String((ctx.connectionChoice || 'agent') === tier.id));
      b.addEventListener('click', () => { ctx.connectionChoice = tier.id; for (const other of group.children) other.setAttribute('aria-pressed', String(other === b)); });
      group.append(b);
    }
    root.append(group);
  };
  const firstOf = { agent: item('token').title, chatgpt: item('chatgpt-add').title, api: item('api').title };
  const steps = [
    intro('AI 연결 — 내 PC의 AI부터', '내 PC에서 쓰는 Codex나 Claude Code를 이 문서 서버에 연결하면, 웹에서 보낸 요청을 바로 처리합니다. 이미 쓰는 구독 요금제로 처리하므로 추가 비용이 없습니다. ChatGPT 웹 연결(고급)과 API 키(유료)는 필요할 때만 고릅니다.'),
    { title: '어떤 AI를 연결할까요', center: true,
      text: CONNECT_TIERS.map((tier, i) => `${'①②③'[i]} ${tier.chapter}: ${tier.note}`).join('\n'),
      example: choose, next: 'Codex·Claude Code 연결하기',
      action: { label: '고른 안내 보기', run: () => at(firstOf[ctx.connectionChoice] || firstOf.agent) } },
    base('token'),
    base('vscode'),
    base('codex', { example: root => { blocks(root, 'codex'); external(root, CONNECT_SOURCES.codex, 'Codex MCP 공식 안내 ↗'); } }),
    base('claude', { example: root => { blocks(root, 'claude'); external(root, CONNECT_SOURCES.claude, 'Claude Code MCP 공식 안내 ↗'); } }),
    base('check', { next: '완료 단계로', nextTo: finish.title, action: { label: '선택 연결도 보기', run: () => at(item('chatgpt-add').title) } }),
    base('chatgpt-add', { next: '입력 화면 보기',
      example: root => { image(root, 'chatMenu', [1486, 20, 92, 52], env.advance); external(root, 'https://chatgpt.com/plugins', 'ChatGPT Plugins 열기 ↗'); } }),
    base('chatgpt-form', { next: '사용 방법 보기',
      example: root => { image(root, 'chatForm', [35, 605, 1128, 82], env.advance, [0, 220, 1200, 860]); blocks(root, 'chatgpt-form'); practice(root, [{ label: 'Name', value: 'HWPX 공동 검토' }, { label: 'Authentication', value: 'OAuth' }]); } }),
    base('chatgpt-use', { next: 'API 키(유료)도 보기', action: { label: '완료 단계로', run: () => at(finish.title) },
      example: root => { blocks(root, 'chatgpt-use'); external(root, CONNECT_SOURCES.chatgpt, 'OpenAI 공식 MCP 안내 ↗'); } }),
    base('api', { next: '완료 단계로', nextTo: finish.title,
      example: root => { image(root, 'apiCreate', [850, 370, 270, 70], env.advance); practice(root, [{ label: '연결', value: 'API' }, { label: '모델 ID', value: '내 계정에서 쓸 수 있는 모델' }, { label: 'API 키 — 실제 키가 아닌 예시', value: 'demo-not-a-real-key', secret: true }], '입력 위치를 보여 주는 예시입니다. 키와 계정 설정은 저장하지 않습니다.'); } }),
    finish,
  ];
  return steps;
}
