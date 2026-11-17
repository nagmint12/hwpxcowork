// A cancelled close keeps the document intact. Discard is explicit and never saves.
export function createCloseGuard({ isDirty, confirmDiscard, close, onError = console.error }) {
  let discarding = false;
  let pending = false;
  return async event => {
    if (discarding || !isDirty()) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    try {
      if (await confirmDiscard()) {
        discarding = true;
        close();
      }
    } catch (error) {
      discarding = false;
      onError(error);
    } finally {
      pending = false;
    }
  };
}
