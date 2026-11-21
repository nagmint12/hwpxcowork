// A retained editor owns the exact unsaved revision while the user is in another view.
// The router keeps the same keyed iframe. Re-entering the document reuses its undo stack.
export function createDepartureSaves({ changed, failed, afterPaint }) {
  const entries = new Map();
  const publish = () => changed([...entries.keys()]);
  function leave(id, save, isClean, revision = () => 0, title = '') {
    const previous = entries.get(id);
    if (previous?.running) return;
    const entry = { running: true, title };
    entries.set(id, entry);
    publish();
    afterPaint(async () => {
      if (entries.get(id) !== entry) return;
      try {
        // A user may reopen this same iframe, type again and leave while the
        // first request is in flight. Save the newer revision with its own fence.
        while (true) {
          const before = revision();
          await save();
          if (entries.get(id) !== entry) return;
          if (isClean()) break;
          if (revision() === before) throw new Error('저장할 수정 내용이 남아 있습니다.');
        }
        entries.delete(id);
      } catch (error) {
        if (entries.get(id) !== entry) return;
        entry.running = false;
        failed(id, error);
      }
      publish();
    });
  }
  function discard(id) { if (entries.delete(id)) publish(); }
  return { leave, discard, status: id => entries.get(id), pending: id => entries.has(id), hasAny: () => entries.size > 0 };
}
