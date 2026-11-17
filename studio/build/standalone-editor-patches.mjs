import { PERFORMANCE_PATCHES } from './performance-patches.mjs';
import { STANDALONE_FONT_PATCHES } from './standalone-font-patches.mjs';

// [hwpx-cowork] The offline desktop previously included only font patches, so
// typing rescanned font catalogs, rewrote the toolbar and collected whole-document
// metrics. Use the web editor's same input/measurement path with the same WASM.
// The build and regression tests must consume this exact selection.
export const STANDALONE_EDITOR_PATCHES = [...PERFORMANCE_PATCHES, ...STANDALONE_FONT_PATCHES];
