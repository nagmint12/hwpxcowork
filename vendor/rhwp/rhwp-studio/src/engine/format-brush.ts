// [hwpx-cowork] Alt+C keeps its own format buffer; Ctrl+C content is untouched.
import { clipboardBase64, clipboardBytes } from './portable-clipboard';

export type FormatBrushMode = 'character' | 'paragraph' | 'both' | 'characterStyle' | 'paragraphStyle';
export interface FormatBrushInfo {
  paragraphStyleName: string | null;
  characterStyleName: string | null;
  hasParagraphStyle: boolean;
  hasCharacterStyle: boolean;
}
export interface FormatBrush {
  version: 1;
  updatedAt: number;
  mode: FormatBrushMode;
  preset: string;
  info: FormatBrushInfo;
}
const KEY = 'hwpx.format-brush.v1';
const MODES = new Set<FormatBrushMode>(['character', 'paragraph', 'both', 'characterStyle', 'paragraphStyle']);
let current: FormatBrush | null = null;
let channel: BroadcastChannel | null = null;

function valid(value: unknown): value is FormatBrush {
  const b = value as FormatBrush | null;
  return !!b && b.version === 1 && Number.isSafeInteger(b.updatedAt) && b.updatedAt > 0
    && MODES.has(b.mode) && typeof b.preset === 'string'
    && b.preset.length <= 12 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(b.preset)
    && !!b.info && typeof b.info.hasParagraphStyle === 'boolean' && typeof b.info.hasCharacterStyle === 'boolean';
}
function remember(brush: FormatBrush): void {
  current = brush;
  try { sessionStorage.setItem(KEY, JSON.stringify(brush)); } catch { /* memory remains available */ }
}
if (typeof window !== 'undefined') {
  try {
    const restored = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (valid(restored)) current = restored;
  } catch { /* storage unavailable */ }
  try {
    channel = new BroadcastChannel(KEY);
    channel.onmessage = ({ data }) => {
      if (data?.request) { if (current) channel?.postMessage({ brush: current }); }
      else if (valid(data?.brush) && (!current || data.brush.updatedAt > current.updatedAt)) remember(data.brush);
    };
    channel.postMessage({ request: true });
  } catch { /* same-tab operation does not need BroadcastChannel */ }
}
export function readFormatBrush(): FormatBrush | null { return current; }
export function storeFormatBrush(mode: FormatBrushMode, bytes: Uint8Array, info: FormatBrushInfo): void {
  const brush: FormatBrush = { version: 1, updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
    mode, preset: clipboardBase64(bytes), info };
  remember(brush);
  channel?.postMessage({ brush });
}
export function formatBrushBytes(brush: FormatBrush): Uint8Array { return clipboardBytes(brush.preset); }
