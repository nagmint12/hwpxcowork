import { Buffer } from 'buffer/';
import { deflate, inflate, deflateRaw, inflateRaw } from 'pako';
export const deflateRawSync = (data, options) => Buffer.from(deflateRaw(data, options));
export const inflateRawSync = data => Buffer.from(inflateRaw(data));
export const deflateSync = (data, options) => Buffer.from(deflate(data, options));
export const inflateSync = data => Buffer.from(inflate(data));
export default { deflateRawSync, inflateRawSync, deflateSync, inflateSync };
