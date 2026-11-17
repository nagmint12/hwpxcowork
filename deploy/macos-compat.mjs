// Electron 44+ requires macOS 13. Pin the final Monterey-compatible series.
export const MACOS_COMPAT = Object.freeze({
  electron: '43.8.10', node: '22.23.5', minimum: '12.0', target: '12.1',
  source: 'https://www.electronjs.org/docs/latest/breaking-changes#removed-macos-12-support',
});
