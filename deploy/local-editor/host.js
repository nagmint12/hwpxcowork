// 편집기의 원래 열기·저장 명령을 네이티브 파일 선택과 직접 저장에 연결한다.
export function installLocalHost(editor) {
  const native = globalThis.hwpxLocal;
  if (!native) return;
  const abort = () => new DOMException('선택을 취소했습니다.', 'AbortError');
  const handle = descriptor => ({
    kind: 'file', name: descriptor.name, id: descriptor.id,
    queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    isSameEntry: other => native.same(descriptor.id, other?.id),
    getFile: async () => new File([await native.read(descriptor.id)], descriptor.name),
    createWritable: async () => {
      let bytes;
      return {
        async write(value) { bytes = new Uint8Array(await (value instanceof Blob ? value : new Blob([value])).arrayBuffer()); },
        async close() { if (!bytes) throw new Error('저장할 문서가 없습니다.'); await native.write(descriptor.id, bytes); },
      };
    },
  });
  globalThis.showOpenFilePicker = async () => { const descriptor = await native.open(); if (!descriptor) throw abort(); return [handle(descriptor)]; };
  globalThis.showSaveFilePicker = async options => { const descriptor = await native.saveAs({ name: options?.suggestedName }); if (!descriptor) throw abort(); return handle(descriptor); };
  const receive = async descriptor => {
    try { await editor.ready(); const file = handle(descriptor); await editor.load(await native.read(descriptor.id), descriptor.name, file); }
    catch (error) { alert(error.message || '문서를 열지 못했습니다.'); }
  };
  native.onOpen(receive);
  // 앱 메뉴(파일 → 열기·저장…)는 편집기의 같은 명령을 실행한다. 정한 명령만 받는다.
  const menuCommands = new Set(['file:new-doc', 'file:open', 'file:save', 'file:save-as', 'file:print']);
  native.onCommand?.(id => { if (menuCommands.has(id)) editor.ready().then(() => editor.run?.(id)).catch(error => alert(error.message)); });
  editor.subscribe(() => native.dirty(editor.isDirty()));
  editor.ready().then(async () => { const pending = await native.ready(); if (pending) await receive(pending); }).catch(error => alert(error.message));
}
