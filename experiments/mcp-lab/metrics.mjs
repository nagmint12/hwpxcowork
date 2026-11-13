// Payload measurements are NOT billable model token counts. No document text or keys are logged.
const size = value => { const s = JSON.stringify(value) ?? ''; return { chars: s.length, bytes: Buffer.byteLength(s) }; };
export function createMetrics() {
  const records = [];
  return {
    list(tools) { const n = size(tools); records.push({ kind: 'tools/list', tools: tools.length, schemaChars: n.chars, schemaBytes: n.bytes }); },
    call(name, args, result, elapsedMs, before = null) {
      const input = size(args), output = size(result);
      const images = (result.content || []).filter(c => c.type === 'image');
      const textChars = (result.content || []).filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0);
      records.push({ kind: 'tools/call', name, inputChars: input.chars, inputBytes: input.bytes,
        resultChars: output.chars, resultBytes: output.bytes, textChars,
        imageBlocks: images.length, imageBytes: images.reduce((n, c) => n + Buffer.byteLength(c.data || '', 'base64'), 0),
        elapsedMs: Math.round(elapsedMs * 100) / 100, isError: !!result.isError,
        ...(before ? { originalResultChars: size(before).chars } : {}) });
    },
    snapshot() { return { measurement: 'serialized payload size, not model tokens', modelTokens: null,
      records: structuredClone(records), toolCalls: records.filter(x => x.kind === 'tools/call').length }; },
  };
}
