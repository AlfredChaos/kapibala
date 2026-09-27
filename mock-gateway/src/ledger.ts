// 事件账本的读面与订阅面（T-P1-02；DES/14 §1「append-only 账本 + SSE 回放」）。
// 追加入口仍是 state.ts 的 appendLedger（唯一「帧产生」入口，/_test/emit 与各域共用）；
// 本文件提供：独占语义查询（since）、全量回放、订阅/退订。订阅通知由 appendLedger
// 在帧落账后触发（state.ledgerListeners）——「先入账后投递」因此对全体消费者成立。
import type { GatewayState, LedgerFrame } from './state.js';

export type LedgerListener = (frame: LedgerFrame) => void;

/**
 * `since` 查询：返回 eventId > since 的帧（REQ §2.1 独占语义）。
 * since=0 即全量回放（eventId 从 1 起）。
 */
export function framesSince(state: GatewayState, since: number): LedgerFrame[] {
  return state.ledger.filter((frame) => frame.eventId > since);
}

/** 全历史回放（REQ §2.1：网关保留全部历史事件） */
export function allFrames(state: GatewayState): LedgerFrame[] {
  return [...state.ledger];
}

/** 订阅实时帧；返回退订函数（连接关闭时必须调用，防泄漏与向已关 socket 写帧） */
export function subscribeLedger(state: GatewayState, listener: LedgerListener): () => void {
  state.ledgerListeners.add(listener);
  return () => {
    state.ledgerListeners.delete(listener);
  };
}
