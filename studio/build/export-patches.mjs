export const EXPORT_PATCHES = [
  {
    id: 'off-thread-hwpx-export-import',
    file: 'src/main.ts',
    why: '협업·자동 저장 HWPX 압축을 Web Worker에서 수행한다',
    anchor: '    async exportHwpx() {\n      await initPromise;\n      return wasm.exportHwpx();\n    },',
    replace: () => `    async exportHwpx() {
      await initPromise;
      return exportHwpxOffThread(wasm);
    },`,
  },
  {
    id: 'off-thread-hwpx-export-helper',
    file: 'src/main.ts',
    why: '저장 작업자를 편집기 번들에 연결한다',
    anchor: "import { WasmBridge } from '@/core/wasm-bridge';",
    replace: (a) => `${a}\nimport { exportHwpxOffThread, primeHwpxCompression } from '@cowork/performance/export-hwpx';`,
  },
  {
    id: 'prime-hwpx-compression-on-open',
    file: 'src/main.ts',
    why: '원본 ZIP의 미변경 압축 항목을 백그라운드에서 준비하여 첫 저장부터 재사용한다',
    anchor: '    const docInfo = await loadDocumentForOpen(data, fileName);\n    prepareCanvasRendererDocument();',
    replace: (a) => a.replace('    prepareCanvasRendererDocument();', '    primeHwpxCompression(data);\n    prepareCanvasRendererDocument();'),
  },
  {
    id: 'reset-hwpx-compression-on-new-document',
    file: 'src/main.ts',
    why: '새 문서 생성 시 이전 문서의 압축 캐시를 해제한다',
    anchor: '      const docInfo = wasm.createNewDocument();\n      prepareCanvasRendererDocument();',
    replace: (a) => a.replace('      prepareCanvasRendererDocument();', '      primeHwpxCompression();\n      prepareCanvasRendererDocument();'),
  },
  {
    id: 'uncompressed-hwpx-bridge',
    file: 'src/core/wasm-bridge.ts',
    why: '기존 HWPX XML 생성·저장 훅을 그대로 사용하고 압축만 분리한다',
    anchor: '  exportHwpx(): Uint8Array {\n    if (!this.doc) throw new Error(\'문서가 로드되지 않았습니다\');\n    this.onBeforeExport?.();\n    return this.doc.exportHwpx();\n  }',
    replace: (a) => `${a}

  exportHwpxUncompressed(): Uint8Array | null {
    if (!this.doc) throw new Error('문서가 로드되지 않았습니다');
    const exportFn = (this.doc as unknown as { exportHwpxUncompressed?: () => Uint8Array }).exportHwpxUncompressed;
    if (typeof exportFn !== 'function') return null;
    this.onBeforeExport?.();
    return exportFn.call(this.doc);
  }`,
  },
];
