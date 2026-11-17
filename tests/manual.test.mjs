import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderManual, safeManualUrl } from '../web/manual.js';

test('설명서 링크는 웹·상대 주소만 허용하고 보조 자료 경로를 연결한다', () => {
  for (const value of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hello', 'vbscript:msgbox(1)',
    '//evil.example/path', 'https://user:password@example.com', 'https:\\evil.example', 'https://example.com/\nscript',
    'javascript&colon;alert(1)', 'javascript%3aalert(1)', 'https://example.com/"onclick="run', 'file:///secret']) {
    assert.equal(safeManualUrl(value), null, value);
  }
  assert.equal(safeManualUrl('https://example.com/docs?q=1&x=2#part'), 'https://example.com/docs?q=1&x=2#part');
  assert.equal(safeManualUrl('/manual.md'), '/manual.md');
  assert.equal(safeManualUrl('AGENT_SETUP.md#start'), '/manual-resources/AGENT_SETUP.md#start');
  assert.equal(safeManualUrl('./AGENT_SETUP.md'), '/manual-resources/AGENT_SETUP.md');
  assert.equal(safeManualUrl('../deploy/Caddyfile.example'), '/manual-resources/Caddyfile.example');
});

test('원문 HTML·코드·제목·표·링크의 실행 가능한 입력은 글자로 표시한다', () => {
  const html = renderManual([
    '# <img src=x onerror=alert(1)>',
    '<script>alert("run")</script>',
    '[bad](javascript:alert(1)) [entity](javascript&colon;alert(1)) [private](https://user:pw@example.com)',
    '[safe](https://example.com/?a=1&b=2)', '',
    '| 열 | 입력 |', '|---|---|', '| 값 | <svg/onload=alert(1)> |', '',
    '```js"onclick="run', '<iframe src="javascript:alert(1)"></iframe>', '```',
  ].join('\n'));
  assert.doesNotMatch(html, /<(?:img|script|svg|iframe)\b/i);
  assert.doesNotMatch(html, /href="(?:javascript|data|vbscript):/i);
  assert.doesNotMatch(html, /href="https:\/\/user/);
  assert.match(html, /&lt;script&gt;alert\(&quot;run&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg\/onload=alert\(1\)&gt;/);
  assert.match(html, /<pre><code>&lt;iframe/);
  assert.match(html, /href="https:\/\/example.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/);
  assert.equal((html.match(/<a /g) || []).length, 1);
});

test('제목·내부 이동·표·중첩 목록·코드 블록을 읽을 수 있는 구조로 표시한다', () => {
  const html = renderManual([
    '# 제목', '[이동](#제목)', '# 제목', '',
    '| 항목 | 코드 |', '|:---|---:|', '| **강조**와 *기울임* | `a|b`와 a\\|b |', '',
    '3. 첫 항목', '   - 하위 항목', '4. 다음 항목', '',
    '> 인용 **본문**', '',
    '```powershell', '$env:TOKEN = "<키>"', '```',
  ].join('\n'), { headingOffset: 1 });
  assert.match(html, /<h2 id="manual-제목">제목<\/h2>/);
  assert.match(html, /<a href="#manual-제목">이동<\/a>/);
  assert.match(html, /id="manual-제목-2"/);
  assert.match(html, /<th scope="col" class="align-right">코드<\/th>/);
  assert.match(html, /<strong>강조<\/strong>와 <em>기울임<\/em>/);
  assert.match(html, /<code>a\|b<\/code>와 a\|b/);
  assert.match(html, /<ol start="3"><li>첫 항목<ul><li>하위 항목<\/li><\/ul><\/li><li>다음 항목<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>인용 <strong>본문<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<pre><code class="language-powershell">\$env:TOKEN = &quot;&lt;키&gt;&quot;<\/code><\/pre>/);
});

test('실제 배포 설명서의 서버 설정 빠른 안내·전체 절·표와 명령 예제를 표시한다', async () => {
  const markdown = await readFile(new URL('../docs/DEPLOYMENT_AND_AI_GUIDE.md', import.meta.url), 'utf8');
  const html = renderManual(markdown, { headingOffset: 1 });
  const sections = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(sections.includes('서버 주소만 바꾸려면'));
  assert.equal(sections.filter((heading) => /^\d+\./.test(heading)).length, 11);
  for (const heading of sections) assert.ok(html.includes(`>${heading}</h3>`), heading);
  assert.equal((html.match(/<pre><code/g) || []).length, (markdown.match(/^```/gm) || []).length / 2);
  assert.equal((html.match(/<table>/g) || []).length, (markdown.match(/^\|(\s*:?-+:?\s*\|)+\s*$/gm) || []).length);
  // 표 6개: 2026-11-14 '10. … AI 수신 원문과 오류 판정 기록' 절에 경로 표가 더해졌다(바로 위 줄이 원문 표 수와 같은지도 본다)
  assert.equal((html.match(/<table>/g) || []).length, 6);
  assert.match(html, /npm run build:studio/);
  assert.match(html, /bearer_token_env_var = &quot;HWPX_COWORK_TOKEN&quot;/);
  assert.match(html, /href="\/manual-resources\/AGENT_SETUP.md"/);
  assert.match(html, /href="\/manual-resources\/Caddyfile.example"/);
  assert.match(html, /개인 실행기는 세 요청 직렬 처리/);
  assert.doesNotMatch(html, /<h1\b/);
});
