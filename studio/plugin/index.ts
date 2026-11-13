// cowork studio 플러그인 진입(docs/V3_SPEC.md §1.3). 빌드 시점 패치 allow-cowork-plugin 이 main.ts 의 resolvePlugin 에서
// `(await import('@cowork/studio-plugin')).coworkStudioPlugin` 으로 가져온다(동적 import — 별도 청크, 임의 URL 로드 없음).
// 호스트는 createStudio(…, { plugins: ['cowork'] }) 로 올리고, iframe.contentWindow.rhwpCowork 로 부른다(같은 출처).
import type { PluginHost, PluginSurface, StudioPlugin } from '@/plugin/types';
import { CoworkController } from './controller';
import { PLUGIN_VERSION } from './types';

let current: CoworkController | null = null;

export const coworkStudioPlugin: StudioPlugin = {
  id: 'cowork',
  apiVersion: 1,

  activate(host: PluginHost): PluginSurface {
    current?.deactivate();
    const c = new CoworkController(host);
    c.activate();
    current = c;
    // RPC 표면(부모가 plugins.invoke 로 부를 수 있는 것)은 최소로 — 호스트 API 는 window.rhwpCowork(같은 출처 직접 호출)
    return {
      version: () => PLUGIN_VERSION,
      ping: () => 'pong',
      stats: () => JSON.parse(JSON.stringify(c.stats())) as unknown,
    };
  },

  deactivate(): void {
    current?.deactivate();
    current = null;
  },
};

export default coworkStudioPlugin;
