// Keep font choices synchronous (selection/undo). Prepare faces afterwards and
// refresh only the same document. No keystroke subscription or document writes.
export function createFontResourceQueue({ generation, prepare, refresh, onError = console.warn }) {
  let pending = new Set(), pendingGeneration, running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.size) {
        const expected = pendingGeneration;
        const names = [...pending]; pending.clear();
        if (generation() !== expected) continue;
        try {
          await prepare(names);
          if (generation() === expected) await refresh();
        } catch (error) { onError(error); }
      }
    } finally { running = false; }
  };
  return name => {
    if (typeof name !== 'string' || !name.trim()) return;
    const current = generation();
    if (pendingGeneration !== current) { pending.clear(); pendingGeneration = current; }
    pending.add(name);
    queueMicrotask(() => { void drain(); });
  };
}
