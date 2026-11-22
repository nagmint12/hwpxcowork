import { Buffer } from 'buffer/';
import process from 'process/browser.js';
globalThis.Buffer = Buffer;
globalThis.process = process;
globalThis.setImmediate ??= (callback, ...args) => setTimeout(callback, 0, ...args);
export { Buffer, process };
export const global = globalThis;
