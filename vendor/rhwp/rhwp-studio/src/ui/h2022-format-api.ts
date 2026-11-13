/**
 * [hwpx-cowork] 한/글 2022 서식·쪽 엔진 호출 (2026-11-11, h2022-format).
 * 2026-11-12: 동적 `wasm.doc` 호출을 WasmBridge 정식 메서드로 옮겼다 — 쓰기 메서드는 mutation-method-registry 의
 * MUTATING_METHODS 에 분류돼 mutation-routing-guard 가 본다. 부르는 곳은 `wasm.<메서드>` 로 직접 부른다(감시 시험의 수신자 규칙). 여기에는 옛 엔진 판별만 둔다.
 */
import type { WasmBridge } from '@/core/wasm-bridge';

/** 이 엔진에 서식·쪽 새 API(getColumnDefAt·setPageNumbering)가 있는가 — 옛 엔진이면 종전 경로를 쓴다 */
export function hasH2022Format(wasm: WasmBridge): boolean {
  const d = (wasm as unknown as { doc?: Record<string, unknown> }).doc;
  return !!d && typeof d.getColumnDefAt === 'function' && typeof d.setPageNumbering === 'function';
}
