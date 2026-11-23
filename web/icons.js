// 작은 선 아이콘(16px, currentColor). 이모지 대신 써서 글꼴에 따라 색·크기가 달라지지 않게 한다.
const P = {
  plus: '<path d="M8 2.5v11M2.5 8h11"/>',
  review: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="m5 7 1.5 1.5L9.2 5.8"/>',
  suggest: '<path d="M8 1.8v3M8 11.2v3M1.8 8h3M11.2 8h3"/><path d="m8 5.2 1 1.8 1.8 1-1.8 1-1 1.8-1-1.8-1.8-1 1.8-1z"/>',
  polish: '<path d="m2.5 13.5 7.5-7.5"/><path d="m9 4 1.5-1.5 3 3L12 7"/><path d="M4 2.5v2M3 3.5h2M12.5 10v2M11.5 11h2"/>',
  instruct: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M5 6h6M5 8.2h4"/>',
  attach: '<path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.6"/>',
  fill: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6h12M6.5 2.5v11"/><path d="m9 11.5 3-3 1 1-3 3H9z"/>',
  table: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6.2h12M2 9.8h12M6 2.5v11M10 2.5v11"/>',
  para: '<path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h6"/><path d="M12 9v5M9.5 11.5h5"/>',
  memo: '<path d="M3 2.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5V11H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"/>',
  edit: '<path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3z"/><path d="m9 4 3 3"/>',
  copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M3.5 10.5H3A1 1 0 0 1 2 9.5V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"/>',
  check: '<path d="m3 8.5 3.2 3.2L13 4.8"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.8 6H10a3.5 3.5 0 0 1 0 7H6"/>',
  reopen: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.3 4.5l.7 9h6l.7-9"/>',
  more: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  down: '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
  folder: '<path d="M2 4.2a1 1 0 0 1 1-1h3.2l1.4 1.6H13a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  people: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13.5c.4-2.4 2-3.6 4-3.6s3.6 1.2 4 3.6"/><circle cx="11.3" cy="6" r="1.7"/><path d="M11 9.6c1.6.1 2.7 1.2 3 3.4"/>',
  move: '<path d="M2 8h9"/><path d="m8 4.5 3.5 3.5L8 11.5"/><path d="M14 3v10"/>',
  file: '<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/>',
  // PC 폴더 연결(web/local.js): 이 PC · 검토 서버로 보내기
  pc: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 13.5h4M8 11v2.5"/>',
  send: '<path d="M8 10V2.5"/><path d="m5 5.2 3-3 3 3"/><path d="M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/>',
};
export const ICON = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${v}</svg>`]));
export const Ic = { props: { n: String }, template: '<span class="ic" v-html="svg"></span>', computed: { svg() { return ICON[this.n] || ''; } } };
