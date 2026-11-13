// 엔진 API가 공통으로 사용하는 오류. 서버는 코드별 사용자 메시지로 변환한다.
export class EngineError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
