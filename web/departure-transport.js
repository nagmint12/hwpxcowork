// The first reply confirms that the private HWPX copy is on disk. Only the
// canonical edit service's final reply can advance the draft revision/mark clean.
export async function submitDeparture(api, base, path, options, received) {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) return api(path, options);
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
  const status = `${base}/departure-saves/${key}`;
  let receipt;
  try {
    receipt = await api(path + (path.includes('?') ? '&' : '?') + 'departure=' + key, options);
  } catch (error) {
    if (error.status) throw error;
    // The response may have been lost after acceptance. Query the same job
    // before any caller retries its write.
    try { return await api(status); }
    catch (lookup) { throw lookup.code === 'NO_RECEIPT' || !lookup.status ? error : lookup; }
  }
  if (receipt?.receipt !== key) return receipt; // older server returned its ordinary final result
  received(key);
  return api(status);
}
