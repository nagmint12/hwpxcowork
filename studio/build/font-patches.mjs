import { fileURLToPath } from 'node:url';

const localFaces = fileURLToPath(new URL('../fonts/exact-local-faces.ts', import.meta.url)).replaceAll('\\', '/');

// Supply exact local faces before the existing, awaited font preparation.
// This changes no document font declarations, metrics policy, LineSegs or WASM.
export const FONT_PATCHES = [
  {
    id: 'exact-local-face-import', file: 'src/core/font-loader.ts',
    why: 'CSS 가족명과 다른 HWP 전체 글꼴명은 local(fullName/PostScriptName)으로 확인한다',
    anchor: 'type FontEntry = ProjectedWebFontEntry;',
    replace: () => `import { isExactLocalFaceName, loadExactLocalFaces, setDocumentFontNames } from ${JSON.stringify(localFaces)};
type FontEntry = ProjectedWebFontEntry & { weight?: string; style?: string };`,
  },
  {
    id: 'exact-local-faces-before-webfonts', file: 'src/core/font-loader.ts',
    why: '첫 화면 측정 전에 설치된 KoPubWorld·나눔바른고딕의 요청 굵기를 확정한다',
    anchor: '  detectOSFonts(detectionNames);',
    replace: () => `  setDocumentFontNames(docFonts ?? []);
  detectOSFonts(detectionNames.filter(name => !isExactLocalFaceName(name)));
  const exactTargets = [...(docFonts ?? []), ...(docFonts ?? []).flatMap(name => projectedSubstituteTargets(name).map(target => target.face))];
  for (const name of await loadExactLocalFaces(exactTargets.filter(name =>
    !isDetectedOSFont(name) && !isRegisteredFontFamily(name)))) {
    detectedOSFonts.add(name);
    detectedOSFontFamilies.add(normalizeFontFamily(name));
  }`,
  },
  {
    id: 'local-font-catalog-targets-import', file: 'src/core/local-fonts.ts',
    why: '현재 문서의 사용 글꼴과 KoPub 한영 별칭으로 파일 읽기 대상을 제한한다',
    anchor: "import { REGISTERED_FONTS } from './font-loader.ts';",
    replace: a => `${a}\nimport { exactLocalFaceNames, getDocumentFontNames } from ${JSON.stringify(localFaces)};`,
  },
  {
    id: 'local-font-catalog-lazy-signature', file: 'src/core/local-fonts.ts',
    why: '전체 설치 목록의 이름 테이블을 읽지 않고 문서 후보를 명시적으로 받는다',
    anchor: 'async function collectLocalFontRecords(fontDataList: readonly FontData[]): Promise<LocalFontRecord[]> {',
    replace: () => `async function collectLocalFontRecords(fontDataList: readonly FontData[], candidateFamilies: readonly string[]): Promise<LocalFontRecord[]> {
  const requested = new Set(candidateFamilies.flatMap(name => [name, ...exactLocalFaceNames(name)]).map(normalizeFontAlias));`,
  },
  {
    id: 'local-font-catalog-lazy-name-tables', file: 'src/core/local-fonts.ts',
    why: '목록에는 FontData 메타데이터만 사용하고 현재 문서가 요청한 face만 SFNT 별칭을 보강한다',
    anchor: "      records[index] = makeLocalFontRecord(fontData, await readSfntFontNames(fontData), 'local-font-access');",
    replace: () => `      const metadata = makeLocalFontRecord(fontData);
      const needed = metadata?.aliases.some(name => requested.has(normalizeFontAlias(name))) ?? false;
      records[index] = needed
        ? makeLocalFontRecord(fontData, await readSfntFontNames(fontData), 'local-font-access')
        : metadata;`,
  },
  {
    id: 'local-font-catalog-document-coverage', file: 'src/core/local-fonts.ts',
    why: '수동 목록 갱신 시 현재 문서 후보를 제한적인 존재 검사에도 전달한다',
    anchor: '    ...(options.candidateFamilies ?? []),',
    replace: () => '    ...(options.candidateFamilies ?? getDocumentFontNames()),',
  },
  {
    id: 'local-font-catalog-document-only-reads', file: 'src/core/local-fonts.ts',
    why: '이전에 열었던 문서의 후보를 현재 문서의 파일 읽기 범위로 누적하지 않는다',
    anchor: '    const enumeratedRecords = await collectLocalFontRecords(fontDataList);',
    replace: () => '    const enumeratedRecords = await collectLocalFontRecords(fontDataList, options.candidateFamilies ?? getDocumentFontNames());',
  },
  {
    id: 'bundled-noto-bold-face', file: 'src/core/font-loader.ts',
    why: '미설치 환경에서도 Noto Sans KR의 진하게 표시는 번들 Bold 파일을 쓴다',
    anchor: 'const FONT_LIST: readonly FontEntry[] = FONT_RULE_WEBFONT_ENTRIES;',
    replace: () => `const FONT_LIST: readonly FontEntry[] = [
  ...FONT_RULE_WEBFONT_ENTRIES,
  { name: 'Noto Sans KR', file: 'fonts/NotoSansKR-Bold.woff2', format: 'woff2', weight: '700', ruleId: 'cowork.noto-bold' },
];`,
  },
  {
    id: 'webfont-key-includes-weight', file: 'src/core/font-loader.ts',
    why: '같은 가족 이름의 보통·진하게 등록 상태를 구분한다',
    anchor: "return [normalizeFontFamily(entry.name), entry.file, entry.format ?? 'woff2', entry.unicodeRange ?? ''].join('\\u0000');",
    replace: a => a.replace("entry.unicodeRange ?? ''", "entry.unicodeRange ?? '', entry.weight ?? '400', entry.style ?? 'normal'"),
  },
  {
    id: 'webfont-css-weight', file: 'src/core/font-loader.ts',
    why: 'CSS도 FontFace와 같은 굵기 정보를 사용한다',
    anchor: 'font-display: swap;${ur}',
    replace: () => "font-display: swap; font-weight: ${f.weight ?? '400'}; font-style: ${f.style ?? 'normal'};${ur}",
  },
  {
    id: 'webfont-api-weight', file: 'src/core/font-loader.ts',
    why: 'Noto Bold 파일을 보통 굵기로 잘못 등록하지 않는다',
    anchor: "new FontFace(entry.name, `url(${entry.file}) format('${fmt}')`)",
    replace: a => a.slice(0, -1) + ", { weight: entry.weight ?? '400', style: entry.style ?? 'normal' })",
  },
];
