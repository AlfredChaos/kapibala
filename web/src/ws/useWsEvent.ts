// useWsEvent 订阅钩子 + WsClient 模块单例（T-P5-02；DES/15 §3「事件分发」逐字）。
// 职责分工：
// - createWsClient 是纯数据层（ws/WsClient.ts）——不碰 React；
// - initWsClient 由 AuthProvider 在会话上下文装配一次（token/refresh 都来自 §4 client）；
// - useWsEvent(type, handler) 组件内订阅——handler 里做精确 patch / invalidateQueries
//   （§3 逐字）；unmount 自动退订。handler 用 ref 转发：渲染期换引用不产生重订。
// - inconsistency toast / ws_backlog_expired 全量 refetch 是订阅者职责
//   （全局 toast 组件归页面骨架卡；本文件只保证事件可达，收口在 WsClient.onBacklogExpired）。
import { useEffect, useRef } from 'react';
import {
  createWsClient,
  type WsClient,
  type WsClientDeps,
  type WsEventHandler,
  type WsEventType,
} from './WsClient.js';

let singleton: WsClient | null = null;

/** 装配单例（AuthProvider 调用一次；幂等——重复调用返回既有实例） */
export function initWsClient(deps: WsClientDeps): WsClient {
  if (singleton === null) singleton = createWsClient(deps);
  return singleton;
}

/** 测试/重建缝：清空模块单例（测试间隔离——disconnect 后调用） */
export function resetWsClient(): void {
  singleton = null;
}

/** 取已装配的单例（未装配 = 无会话期：返回 null，订阅退化为空转） */
export function getWsClient(): WsClient | null {
  return singleton;
}

/**
 * 订阅 WS 事件（DES/15 §3：useWsEvent(type, handler)）。
 * type 收窄 payload（contract 判别联合）；handler 引用变化不触发重订（ref 转发）。
 * 未装配单例时为空转（登录页/未初始化阶段调它不炸——守卫已挡页面，防御性兜底）。
 */
export function useWsEvent<T extends WsEventType>(type: T, handler: WsEventHandler<T>): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const client = singleton;
    if (client === null) return undefined;
    return client.subscribe(type, (frame) => ref.current(frame));
  }, [type]);
}
