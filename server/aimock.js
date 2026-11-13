// 모의 AI: 네트워크 없이 종류별로 정해진(결정적) 결과를 만든다. 시험·시연용.
// 결과 모양은 ai.run 과 같다(docs/V2_SPEC.md §6). 글은 실제 문장처럼(…(안1) 같은 표시 없음).

const EMPTY = () => ({ proposals: [], alternatives: [], comments: [], inserts: [], tables: [] });

/** 앞 글자에 받침이 있는지(한글 음절만) */
function hasBatchim(ch) {
  const c = ch ? ch.codePointAt(0) : 0;
  if (c < 0xAC00 || c > 0xD7A3) return false;
  return (c - 0xAC00) % 28 !== 0;
}

// 문장 끝 바꾸기(…습니다 → …음, …한다 → …함)
const ENDINGS = [
  [/했습니다(?=\.|$)/g, '하였음'], [/합니다(?=\.|$)/g, '함'], [/됩니다(?=\.|$)/g, '됨'], [/있습니다(?=\.|$)/g, '있음'], [/없습니다(?=\.|$)/g, '없음'],
  [/입니다(?=\.|$)/g, '임'], [/였습니다(?=\.|$)/g, '였음'], [/습니다(?=\.|$)/g, '음'],
  [/했다(?=\.|$)/g, '하였음'], [/한다(?=\.|$)/g, '함'], [/된다(?=\.|$)/g, '됨'], [/있다(?=\.|$)/g, '있음'], [/없다(?=\.|$)/g, '없음'],
  [/이다(?=\.|$)/g, '임'], [/였다(?=\.|$)/g, '였음'], [/났다(?=\.|$)/g, '남'],
];
const ENDINGS_BACK = [[/하였음(?=\.|$)/g, '하였습니다'], [/함(?=\.|$)/g, '합니다'], [/됨(?=\.|$)/g, '됩니다'], [/있음(?=\.|$)/g, '있습니다'], [/없음(?=\.|$)/g, '없습니다'], [/임(?=\.|$)/g, '입니다'], [/남(?=\.|$)/g, '났습니다']];

function applyAll(s, rules) { let out = s; for (const [re, to] of rules) out = out.replace(re, to); return out; }
function endingSwap(s) { const a = applyAll(s, ENDINGS); return a !== s ? a : applyAll(s, ENDINGS_BACK); }
function josaAnd(s) { return s.replace(/(\S) 및 /g, (m, prev) => `${prev}${hasBatchim(prev) ? '과' : '와'} `); }

const PHRASES = [
  ['에 대한', '에 관한'], ['을 통해', '을 통하여'], ['를 통해', '를 통하여'], ['위해서', '위해'], ['하였다', '했다'], ['하는 것이 필요', '해야 할 필요가 있'],
  ['것으로 나타났다', '것으로 확인되었다'], ['것으로 나타남', '것으로 확인됨'], ['할 수 있는', '가능한'], ['매우 ', ''], ['상당히 ', ''], ['보다 ', ''],
];
function phraseSwap(s) { for (const [a, b] of PHRASES) if (s.includes(a)) return s.replace(a, b); return s; }
function tidy(s) { return s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim(); }

// 문장 첫 연결어 바꾸기(뜻이 같은 말로)
const CONJ = [['다만 ', '그러나 '], ['그러나 ', '다만 '], ['또한 ', '아울러 '], ['아울러 ', '또한 '], ['따라서 ', '이에 따라 '], ['즉, ', '다시 말해, '], ['특히 ', '무엇보다 '], ['이는 ', '이러한 결과는 '], ['반면 ', '이와 달리 ']];
function conjSwap(s) { for (const [a, b] of CONJ) if (s.startsWith(a)) return b + s.slice(a.length); return s; }
const startsWithConj = (s) => CONJ.some(([a]) => s.startsWith(a));
// 끝맺음을 '…것으로 나타남/보임' 꼴로(…함 → …한 것으로 나타남, …임 → …인 것으로 보임, 있음/없음 → 있는/없는 것으로 나타남)
function nominalEnding(s) {
  const m = /([가-힣]+?)(있음|없음|함|임)(\.?)$/.exec(s);
  if (!m) return s;
  const [all, stem, end, dot] = m;
  const to = end === '있음' ? `${stem}있는 것으로 나타남` : end === '없음' ? `${stem}없는 것으로 나타남` : end === '함' ? `${stem}한 것으로 나타남` : `${stem}인 것으로 보임`;
  return s.slice(0, s.length - all.length) + to + (dot || '.');
}

/** 선택 글을 대신할 안 count 개(서로 다르고 원문과도 다름) */
export function alternativesFor(sel, count = 1) {
  const base = String(sel || '');
  const t = tidy(base);
  const T = { end: ['끝맺음을 바꿈', endingSwap], conj: ['연결어를 바꿈', conjSwap], josa: ["'및'을 조사로 이음", josaAnd], phrase: ['표현을 간결하게 다듬음', phraseSwap], nominal: ['끝맺음을 보고서 문체로 바꿈', nominalEnding] };
  const recipes = [['end'], ['phrase', 'josa', 'conj'], ['conj', 'nominal'], ['josa', 'end', 'phrase'], ['nominal'], []];
  const reasons = new Map();
  const out = [];
  const push = (s, why) => { if (s && s !== base && !out.includes(s)) { out.push(s); reasons.set(s, why); } };
  for (const r of recipes) {
    let s = t; const done = [];
    for (const k of r) { const n = T[k][1](s); if (n !== s) done.push(T[k][0]); s = n; }
    push(s, done.join(' · ') || '문장 앞뒤 공백을 정리함');
  }
  if (!startsWithConj(t)) for (const pre of ['아울러 ', '특히 ', '또한 ']) { if (out.length >= count) break; push(pre + t, '연결어를 넣어 흐름을 이음'); }
  let k = 0; while (out.length < count) { k++; push(`${t}${'.'.repeat(k)}`, '다른 표현'); }
  return out.slice(0, count).map((text) => ({ text, reason: reasons.get(text) || '다른 표현' }));
}

const POLISH_RULES = {
  concise: [['하는 것이 필요함', '해야 함'], ['하는 것이 필요하다', '해야 한다'], ['할 수 있는', '가능한'], ['에 대한', '에 관한'], ['매우 ', ''], ['상당히 ', ''], ['위해서', '위해'], ['하였다', '했다']],
  formal: [],
  spelling: [['  ', ' '], [' ,', ','], [' .', '.'], ['할수', '할 수'], ['있을것', '있을 것'], ['것 이다', '것이다'], ['되요', '돼요'], ['안되', '안 되']],
  plain: [['제고', '높이기'], ['도모', '꾀함'], ['수립', '세움'], ['추진', '진행'], ['활용', '사용'], ['파악', '살펴봄'], ['기 위해', '려고']],
};

/** 글 안에서 한 군데만 바꾸는 {find, replace, reason} (없으면 null) */
export function onePolish(text, preset = 'concise') {
  const s = String(text || '');
  if (!s.trim()) return null;
  const rules = POLISH_RULES[preset] || POLISH_RULES.concise;
  for (const [a, b] of rules) if (s.includes(a)) return { find: a, replace: b, reason: preset === 'spelling' ? '띄어쓰기·맞춤법' : preset === 'plain' ? '쉬운 말로' : '간결하게' };
  // ' 및 ' → 와/과
  const m = /(\S) 및 /.exec(s);
  if (m) return { find: m[0], replace: `${m[1]}${hasBatchim(m[1]) ? '과' : '와'} `, reason: "'및' 대신 조사로 잇기" };
  // 문장 끝 하나
  for (const [re, to] of preset === 'formal' || preset === 'concise' || !preset ? ENDINGS : []) {
    re.lastIndex = 0; const mm = re.exec(s); re.lastIndex = 0;
    if (mm) return { find: mm[0], replace: to, reason: '공문서체 끝맺음' };
  }
  const t = tidy(s); if (t !== s && t) return { find: s, replace: t, reason: '공백 정리' };
  const last = [...s.trimEnd()].pop();
  if (last === '.') { const w = /(\S+)\.\s*$/.exec(s); if (w) return { find: w[0].trim(), replace: w[1], reason: '끝 마침표 정리' }; }
  const w2 = /(\S+)\s*$/.exec(s); if (w2) return { find: w2[1], replace: `${w2[1]}.`, reason: '문장 끝에 마침표' };
  return null;
}

/** 첨부 글에서 첫 시트 표(행 배열)와 이름 */
export function firstSheet(attachments = []) {
  for (const a of attachments) {
    if (!a.text) continue;
    const blocks = String(a.text).split(/\n(?=## 시트: )/);
    const b = blocks.find((x) => x.startsWith('## 시트: '));
    if (!b) continue;
    const [head, ...rows] = b.split('\n');
    const name = /^## 시트: (.*?) \(\d+×\d+\)$/.exec(head)?.[1] || '시트';
    return { name, rows: rows.map((r) => r.split('\t')), attachment: a.name };
  }
  return null;
}

/**
 * 지시 글의 서식 요청 → 서식 객체(FormatSchema 꼴, 없으면 null). 요청 창에 서식 칸이 없으므로 지시만 보고 서식 제안을 만든다(시험·시연용 몇 낱말).
 * '굵게 해제'·'굵게 하지 말고' 같은 끄기 표현은 false.
 */
export function formatFromInstruction(instruction) {
  const t = String(instruction || '');
  const char = {}; const paragraph = {};
  const flag = (re, key) => { const m = re.exec(t); if (m) char[key] = !/^\s*(해제|빼|없애|풀|끄|지우|말)/.test(t.slice(m.index + m[0].length)); };
  flag(/굵게|진하게|볼드/, 'bold'); flag(/기울임|기울게|이탤릭/, 'italic'); flag(/밑줄/, 'underline');
  const size = /(\d+(?:\.\d+)?)\s*(?:pt|포인트)/i.exec(t); if (size) char.sizePt = Number(size[1]);
  const align = /(가운데|중앙|오른쪽|왼쪽|양쪽)\s*(?:으로\s*|로\s*)?정렬/.exec(t);
  if (align) paragraph.align = { 가운데: 'CENTER', 중앙: 'CENTER', 오른쪽: 'RIGHT', 왼쪽: 'LEFT', 양쪽: 'JUSTIFY' }[align[1]];
  const out = {};
  if (Object.keys(char).length) out.char = char;
  if (Object.keys(paragraph).length) out.paragraph = paragraph;
  return Object.keys(out).length ? out : null;
}

function targetParaText(input) {
  const line = (input.context || []).find((c) => c.ref === input.target.ref);
  return line ? line.text : (input.target.text || '');
}

export function mockRun(input) {
  const { kind, preset, label = kind, target = {}, tables = [], attachments = [], options = {} } = input;
  // 시험용: 지시에 '#모의실패' 가 있으면 실패를 흉내 낸다(AI_FAILED 경로 확인)
  if (/#모의실패/.test(input.instruction || '')) throw new Error('모의 AI 실패(시험용 표시 #모의실패)');
  const out = EMPTY();
  const sel = target.text || targetParaText(input);
  const ref = target.ref;
  const bodyRef = (r) => (/^s\d+\/p\d+/.exec(r || '') || [r])[0];
  let summary = '';
  switch (kind) {
    case 'suggest': {
      out.alternatives = alternativesFor(sel, Math.max(1, Math.min(5, options.count || 1)));
      summary = `선택한 문장을 대신할 문장 ${out.alternatives.length}안을 제안함`;
      break;
    }
    case 'polish': {
      if (preset === 'factcheck') {
        const n = /\d[\d,.]*\s*(%|명|건|개|원|점)?/.exec(sel);
        out.comments.push({ ref, find: n ? n[0].trim() : '', text: n ? `수치 「${n[0].trim()}」의 출처·기준 시점을 첨부 자료와 대조해 확인해 주세요.` : '수치나 사실 관계를 뒷받침할 근거(출처)를 덧붙이면 좋겠습니다.' });
        summary = '수치·사실 확인이 필요한 곳에 의견 1건을 남김';
        break;
      }
      const p = onePolish(sel, preset || 'concise');
      if (p) out.proposals.push({ ref, ...p });
      summary = p ? `${label} 기준으로 한 군데를 고치도록 제안함` : '고칠 곳을 찾지 못함';
      break;
    }
    case 'review': {
      const long = [...sel].length > 60;
      out.comments.push({ ref, find: '', text: long ? '문장이 길어 핵심이 잘 드러나지 않습니다. 두 문장으로 나누는 것을 검토해 주세요.' : '내용이 분명합니다. 앞뒤 문단과 용어가 일치하는지만 확인해 주세요.' });
      const p = onePolish(sel, 'concise');
      if (p) out.proposals.push({ ref, ...p });
      summary = `선택 범위를 검토해 의견 1건${p ? '과 수정 제안 1건' : ''}을 남김`;
      break;
    }
    case 'instruct': {
      // 차례 새로 고침 지시면 tocUpdates(스타일·한 줄 맞추기 말이 있으면 함께, 지금 하라는 말이니 바로 적용)
      const ins = input.instruction || '';
      if (/차례/.test(ins) && /새로\s*고침|새로고침|갱신|업데이트/.test(ins)) {
        out.tocUpdates = [{ tocRef: '', applyStyles: /스타일/.test(ins), oneLine: /한\s*줄/.test(ins), applyNow: true, reason: '지시에 따라 차례를 새로 고침' }];
        summary = '지시에 따라 차례를 새로 고침';
        break;
      }
      // 대상에 표가 있고 표 구조·테두리 지시면 표 고치기(tableEdits): 테두리·바깥선 → 위·아래 바깥선 0.4mm, 열·칸 지우기 → 마지막 칸, 행·줄 지우기 → 마지막 줄
      const tb = tables[0];
      if (tb?.key && /테두리|바깥|선을|선 |(열|칸|행|줄).{0,4}(삭제|지우|지워)/.test(ins)) {
        const ops = /(열|칸).{0,4}(삭제|지우|지워)/.test(ins) ? [{ op: 'delete_cols', cols: [tb.cols - 1] }]
          : /(행|줄).{0,4}(삭제|지우|지워)/.test(ins) ? [{ op: 'delete_rows', rows: [tb.rows - 1] }]
          : [{ op: 'border', sides: ['top', 'bottom'], line: { width_mm: 0.4 } }];
        out.tableEdits = [{ table: tb.key, ops, reason: '지시에 따라 표를 고침' }];
        summary = '지시에 따라 표 고치기 제안 1건을 남김';
        break;
      }
      // 지시에 서식 요청(굵게·가운데 정렬 …)만 있으면 서식 제안(formats — 글은 그대로). 문단 모양은 문단 전체를 대상으로
      const fmt = formatFromInstruction(input.instruction);
      if (fmt) {
        const whole = !!fmt.paragraph || !target.text;
        out.formats = [{ ref, find: whole ? targetParaText(input) : sel, format: fmt, reason: '지시에 따라 서식을 바꿈' }];
        summary = `지시에 따라 서식 제안 ${out.formats.length}건을 남김`;
        break;
      }
      const p = onePolish(sel, 'concise');
      if (p) out.proposals.push({ ref, ...p });
      out.comments.push({ ref, find: '', text: '요청한 방향에 맞춰 검토했습니다. 제안을 확인한 뒤 적용해 주세요.' });
      const sh = firstSheet(attachments);
      if (sh && /표/.test(input.instruction || '')) out.tables.push(tableFromSheet(sh, bodyRef(ref)));
      if (/추가|덧붙|문단/.test(input.instruction || '')) out.inserts.push({ afterRef: bodyRef(ref), text: '이와 관련한 세부 추진 일정과 담당 부서는 별도 계획에 따라 정리함.', reason: '지시에 따라 내용 보완' });
      summary = `지시에 따라 제안 ${out.proposals.length}건·의견 ${out.comments.length}건${out.tables.length ? '·표 1개' : ''}${out.inserts.length ? '·문단 1개' : ''}를 남김`;
      break;
    }
    case 'fill_table': {
      const t = tables[0];
      const sh = firstSheet(attachments);
      if (t && sh) {
        const cells = (t.cells || []).filter((c) => c.refs && c.refs.length);
        const empties = cells.filter((c) => !String(c.text || '').trim() && c.row > 0);
        const valueAt = (r, c) => (sh.rows[r] && sh.rows[r][c] != null && String(sh.rows[r][c]).trim()) || null;
        const firstNums = sh.rows.flat().filter((v) => /^-?[\d,.]+%?$/.test(String(v).trim()));
        let k = 0;
        for (const c of empties.slice(0, 2)) {
          const v = valueAt(c.row, c.col) || firstNums[k++] || null;
          if (v) out.proposals.push({ ref: c.refs[0], find: '', replace: v, reason: `첨부 「${sh.attachment}」 ${sh.name} 시트 ${c.row + 1}행 ${c.col + 1}열 값` });
        }
        if (!out.proposals.length) {
          for (const c of cells.filter((x) => x.row > 0 && x.col > 0)) {
            const v = valueAt(c.row, c.col);
            if (v && v !== String(c.text || '').trim() && String(c.text || '').trim()) { out.proposals.push({ ref: c.refs[0], find: String(c.text).trim(), replace: v, reason: `첨부 「${sh.attachment}」 ${sh.name} 시트 값과 다름` }); break; }
          }
        }
      }
      summary = out.proposals.length ? `첨부 자료 수치로 표 칸 ${out.proposals.length}개를 채우도록 제안함` : '첨부 자료에서 채울 값을 찾지 못함';
      break;
    }
    case 'make_table': {
      const sh = firstSheet(attachments);
      const t = sh ? tableFromSheet(sh, bodyRef(ref)) : { afterRef: bodyRef(ref), caption: '표. 요약', headerRows: 1, rows: [['구분', '내용'], ['항목', [...sel].slice(0, 20).join('') || '-']], reason: '첨부가 없어 대상 문단으로 틀만 만듦' };
      out.tables.push(t);
      summary = `${sh ? `첨부 「${sh.attachment}」` : '대상 문단'} 자료로 ${t.rows.length}×${t.rows[0].length} 표를 만들도록 제안함`;
      break;
    }
    case 'insert': {
      out.inserts.push({ afterRef: bodyRef(ref), text: '이와 관련한 세부 추진 일정과 담당 부서는 별도 계획에 따라 정리함.', reason: '앞 문단 내용을 보완' });
      summary = '대상 문단 뒤에 보완 문단 1개를 제안함';
      break;
    }
    default: summary = '처리할 수 없는 종류';
  }
  return {
    ...out,
    summary: `(모의 AI) ${summary}`,
    instructionSummary: input.instruction ? `(모의 AI) ${label} 지시 처리` : `(모의 AI) ${label}`,
    usage: { input: 0, output: 0 }, model: 'mock',
  };
}

function tableFromSheet(sh, afterRef) {
  const rows = sh.rows.slice(0, 5).map((r) => r.slice(0, 6).map((v) => String(v ?? '')));
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(cols - r.length).fill('')]);
  return { afterRef, caption: `표. ${sh.name}`, headerRows: 1, rows: norm.length ? norm : [['']], reason: `첨부 「${sh.attachment}」 ${sh.name} 시트 앞 ${norm.length}행` };
}
