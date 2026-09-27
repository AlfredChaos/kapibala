// @kapibala/contract 入口：跨包共享契约类型的唯一出口（T-P0-02）。
// 消费方（server / web / mock-gateway / mock-agent）只读引用；扩类型回本任务串行变更（任务卡 e 项）。
export * from './agent-protocol.js';
export * from './gateway-errors.js';
export * from './api-errors.js';
export * from './ws-events.js';
