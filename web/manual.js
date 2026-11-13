// 로컬 사용 설명서용 Markdown 표시기. 원문 HTML은 모두 글자로 표시하고, 제한된 Markdown만 고정 태그로 만든다.
// DOM·외부 라이브러리 없이 동작하므로 브라우저와 보안 회귀 시험이 같은 구현을 쓴다.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const RELATIVE_BASE = 'https://manual.invalid/';
const RESOURCE_LINKS = new Map([
  ['AGENT_SETUP.md', '/manual-resources/AGENT_SETUP.md'],
  ['./AGENT_SETUP.md', '/manual-resources/AGENT_SETUP.md'],
  ['../deploy/Caddyfile.example', '/manual-resources/Caddyfile.example'],
]);

/** 실행 스킴·제어 문자·프로토콜 상대 주소·인증정보를 막고 http(s)와 일반 상대 링크만 허용한다. */
export function safeManualUrl(value) {
  let url = String(value || '').trim();
  if (!url || /[\u0000-\u0020\u007f\\<>"']/.test(url) || url.startsWith('//')) return null;
  if (/&(?:#\w+|colon|tab|newline);/i.test(url)) return null;
  const path = url.split(/[?#]/, 1)[0];
  if (RESOURCE_LINKS.has(path)) url = RESOURCE_LINKS.get(path) + url.slice(path.length);
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^https?:\/\//i.test(url) ? url : null;
    // 콜론으로 시작하는 스킴을 인코딩한 문자열도 설명서 링크로 사용할 이유가 없다.
    if (/^(?:javascript|data|vbscript)%3a/i.test(url)) return null;
    return parsed.origin === new URL(RELATIVE_BASE).origin ? url : null;
  } catch { return null; }
}

function closing(text, from, open, close) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

function linkAt(text, at) {
  const labelEnd = closing(text, at + 1, '[', ']');
  if (labelEnd < 0 || text[labelEnd + 1] !== '(') return null;
  const end = closing(text, labelEnd + 2, '(', ')');
  if (end < 0) return null;
  let destination = text.slice(labelEnd + 2, end).trim();
  const titled = /^(\S+)(?:\s+["']([^"']*)["'])$/.exec(destination);
  if (titled) destination = titled[1];
  if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
  return { label: text.slice(at + 1, labelEnd), destination, end };
}

function inline(text, depth = 0) {
  if (depth > 12) return escapeHtml(text);
  let html = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[\\`*{}\[\]()>#+.!_|~-]/.test(text[i + 1] || '')) { html += escapeHtml(text[i + 1]); i += 2; continue; }
    if (text[i] === '`') {
      let n = 1; while (text[i + n] === '`') n++;
      const end = text.indexOf('`'.repeat(n), i + n);
      if (end >= 0) { html += `<code>${escapeHtml(text.slice(i + n, end))}</code>`; i = end + n; continue; }
    }
    if (text[i] === '[') {
      const link = linkAt(text, i);
      if (link) {
        const safeHref = safeManualUrl(link.destination);
        // 본문 제목의 고유 접두사와 맞춰 기존 도움말 목차의 id와 충돌하지 않게 한다.
        const href = safeHref?.startsWith('#') ? (safeHref === '#' ? '#manual' : `#manual-${safeHref.slice(1)}`) : safeHref;
        const label = inline(link.label, depth + 1);
        html += href ? `<a href="${escapeHtml(href)}"${/^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>` : label;
        i = link.end + 1; continue;
      }
    }
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const mark = text.slice(i, i + 2); const end = text.indexOf(mark, i + 2);
      if (end > i + 2) { html += `<strong>${inline(text.slice(i + 2, end), depth + 1)}</strong>`; i = end + 2; continue; }
    }
    if (text[i] === '*' || text[i] === '_') {
      const end = text.indexOf(text[i], i + 1);
      // 파일·환경 변수의 밑줄은 그대로 둔다.
      if (end > i + 1 && (text[i] === '*' || !/[\p{L}\p{N}]/u.test(text[i - 1] || ''))) { html += `<em>${inline(text.slice(i + 1, end), depth + 1)}</em>`; i = end + 1; continue; }
    }
    html += escapeHtml(text[i]); i++;
  }
  return html;
}

function tableCells(line) {
  const out = []; let cell = ''; let ticks = 0; const source = line.trim();
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && source[i + 1] === '|') { cell += '\\|'; i++; continue; }
    if (source[i] === '`') {
      let n = 1; while (source[i + n] === '`') n++;
      ticks = ticks === n ? 0 : ticks || n; cell += '`'.repeat(n); i += n - 1; continue;
    }
    if (source[i] === '|' && !ticks) { out.push(cell.trim()); cell = ''; } else cell += source[i];
  }
  out.push(cell.trim());
  if (source.startsWith('|')) out.shift();
  if (source.endsWith('|') && !source.endsWith('\\|')) out.pop();
  return out;
}
const fence = (line) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const listItem = (line) => /^( *)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const heading = (line) => /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
const rule = (line) => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
function tableAt(lines, i) {
  if (!lines[i]?.includes('|') || !lines[i + 1]) return false;
  const head = tableCells(lines[i]); const divider = tableCells(lines[i + 1]);
  return head.length === divider.length && divider.length > 0 && divider.every((s) => /^:?-{3,}:?$/.test(s));
}

/** 설명서 본문 → 안전한 HTML. 필요한 제목 깊이는 headingOffset으로 조절한다. */
export function renderManual(markdown, { headingOffset = 0 } = {}) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const ids = new Map();
  const offset = Number.isInteger(headingOffset) ? Math.max(0, Math.min(5, headingOffset)) : 0;
  const headingId = (text) => {
    const slug = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    const n = (ids.get(slug) || 0) + 1; ids.set(slug, n);
    return `manual-${slug}${n > 1 ? `-${n}` : ''}`;
  };
  const blockStart = (items, i) => !items[i]?.trim() || !!fence(items[i]) || !!heading(items[i]) || !!listItem(items[i]) || /^ {0,3}>/.test(items[i]) || rule(items[i]) || tableAt(items, i);
  function blocks(items, depth = 0) {
    if (depth > 24) return `<p>${escapeHtml(items.join('\n'))}</p>`;
    let html = ''; let i = 0;
    while (i < items.length) {
      const line = items[i];
      if (!line.trim()) { i++; continue; }
      const open = fence(line);
      if (open) {
        const content = []; const mark = open[1][0]; const size = open[1].length; i++;
        while (i < items.length && !new RegExp(`^ {0,3}${mark}{${size},}\\s*$`).test(items[i])) content.push(items[i++]);
        if (i < items.length) i++;
        const lang = open[2].trim().split(/\s/)[0];
        html += `<pre><code${/^[a-z0-9_-]{1,40}$/i.test(lang) ? ` class="language-${lang.toLowerCase()}"` : ''}>${escapeHtml(content.join('\n'))}</code></pre>`;
        continue;
      }
      const h = heading(line);
      if (h) { const level = Math.min(6, h[1].length + offset); html += `<h${level} id="${escapeHtml(headingId(h[2]))}">${inline(h[2])}</h${level}>`; i++; continue; }
      if (rule(line)) { html += '<hr>'; i++; continue; }
      if (tableAt(items, i)) {
        const heads = tableCells(items[i]); const dividers = tableCells(items[i + 1]);
        const align = dividers.map((s) => s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left');
        html += '<div class="manual-table-wrap"><table><thead><tr>' + heads.map((s, n) => `<th scope="col" class="align-${align[n]}">${inline(s)}</th>`).join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < items.length && items[i].trim() && items[i].includes('|')) {
          const cells = tableCells(items[i++]);
          html += '<tr>' + heads.map((_, n) => `<td class="align-${align[n]}">${inline(cells[n] || '')}</td>`).join('') + '</tr>';
        }
        html += '</tbody></table></div>'; continue;
      }
      if (/^ {0,3}>/.test(line)) {
        const quote = [];
        while (i < items.length && /^ {0,3}>/.test(items[i])) quote.push(items[i++].replace(/^ {0,3}> ?/, ''));
        html += `<blockquote>${blocks(quote, depth + 1)}</blockquote>`; continue;
      }
      const first = listItem(line);
      if (first) {
        const indent = first[1].length; const ordered = /^\d/.test(first[2]); const tag = ordered ? 'ol' : 'ul';
        const start = ordered ? Number.parseInt(first[2], 10) : 1;
        html += `<${tag}${ordered && Number.isSafeInteger(start) && start !== 1 ? ` start="${start}"` : ''}>`;
        while (i < items.length) {
          const current = listItem(items[i]);
          if (!current || current[1].length !== indent || /^\d/.test(current[2]) !== ordered) break;
          const inner = []; const label = current[3]; i++;
          while (i < items.length) {
            if (!items[i].trim()) {
              if (i + 1 < items.length && /^ +\S/.test(items[i + 1]) && /^ */.exec(items[i + 1])[0].length > indent) { inner.push(''); i++; continue; }
              break;
            }
            const pad = /^ */.exec(items[i])[0].length;
            if (pad <= indent) break;
            inner.push(items[i++].slice(Math.min(pad, indent + 2)));
          }
          html += `<li>${inline(label)}${inner.length ? blocks(inner, depth + 1) : ''}</li>`;
          if (!items[i]?.trim()) {
            let next = i; while (next < items.length && !items[next].trim()) next++;
            const upcoming = listItem(items[next] || '');
            if (upcoming && upcoming[1].length === indent && /^\d/.test(upcoming[2]) === ordered) i = next;
            else break;
          }
        }
        html += `</${tag}>`; continue;
      }
      const paragraph = [line.trim()]; i++;
      while (i < items.length && !blockStart(items, i)) paragraph.push(items[i++].trim());
      html += `<p>${inline(paragraph.join(' '))}</p>`;
    }
    return html;
  }
  return blocks(lines);
}
