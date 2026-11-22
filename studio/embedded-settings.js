// Boot before Studio reads its native settings. This frame has its own
// settings key, so the standalone editor retains its own view preferences.
(() => {
  if (window === window.parent || new URLSearchParams(location.search).get('chrome') !== 'embed') return;
  try {
    const nativeKey = 'rhwp-settings';
    const embeddedKey = 'hwpx-cowork.studio-settings';
    const storage = window.localStorage;
    const prototype = Storage.prototype;
    const { getItem, setItem, removeItem } = prototype;
    const isStudioSettings = (target, key) => target === storage && key === nativeKey;
    function seededSettings() {
      let previous;
      try { previous = JSON.parse(getItem.call(storage, nativeKey) || '{}'); } catch { previous = {}; }
      const view = previous?.view;
      return JSON.stringify({ ...previous, view: { ...view, toolbarBasic: typeof view?.toolbarBasic === 'boolean' ? view.toolbarBasic : false } });
    }
    prototype.getItem = function (key) {
      if (!isStudioSettings(this, key)) return getItem.call(this, key);
      return getItem.call(this, embeddedKey) ?? seededSettings();
    };
    prototype.setItem = function (key, value) {
      return setItem.call(this, isStudioSettings(this, key) ? embeddedKey : key, value);
    };
    prototype.removeItem = function (key) {
      return removeItem.call(this, isStudioSettings(this, key) ? embeddedKey : key);
    };
  } catch { /* 기존 설정을 읽을 수 없는 iframe에서는 Studio 기본값을 사용한다. */ }
})();
