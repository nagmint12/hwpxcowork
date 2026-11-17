// Electron requires a synchronous decision to resume the original action.
// Keep cancel as default; allow close/reload/navigation only after explicit
// discard, preserving which action the user requested instead of destroying it.
export function createBlockedCloseHandler({ confirmDiscard, onError = console.warn }) {
  let pending = false;
  return event => {
    if (pending) return;
    pending = true;
    try { if (confirmDiscard() === true) event.preventDefault(); }
    catch (error) { onError(error); }
    finally { pending = false; }
  };
}
