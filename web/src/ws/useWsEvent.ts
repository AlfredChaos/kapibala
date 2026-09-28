// useWsEvent 订阅钩子 + WsClient 模块单例（T-P5-02；DES/15 §3「事件分发」逐字）。
// 职责分工：
// - createWsClient 是纯数据层（ws/WsClient.ts）——不碰 React；
// - initWsClient 由 AuthProvider 在会话上下文装配一次（token/refresh 都来自 §4 client）；
//   被动 effect 子先于父——装配晚于订阅页面挂载是常态次序；
// - useWsEvent(type, handler) 组件内订阅——handler 里做精确 patch / invalidateQueries
//   （§3 逐字）；unmount 自动退订。handler 用 ref 转发：渲染期换引用不产生重订。
//   订阅面经 useSyncExternalStore 盯单例就绪（null→client 重订；reset 测试缝退订），
//   否则「订阅 effect 跑时 singleton 尚为 null」= 该页终身收不到帧（实锤竞态）。
// - inconsistency toast / ws_backlog_expired 全量 refetch 是订阅者职责
//   （全局 toast 组件归页面骨架卡；本文件只保证事件可达，收口在 WsClient.onBacklogExpired）。
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  createWsClient,
  type WsClient,
  type WsClientDeps,
  type WsEventHandler,
  type WsEventType,
} from './WsClient.js';

let singleton: WsClient | null = null;

/**
 * 单例就绪监听集（竞态修复）：useWsEvent 经 useSyncExternalStore 订阅——
 * React 被动 effect 子先于父执行（mount 时页面 effect 先跑、AuthProvider 的
 * initWsClient effect 在后），订阅 effect 读 singleton 时仍可能为 null；
 * null→client / client→null（resetWsClient 测试缝）跃迁通知已挂组件重订。
 */
const readyListeners = new Set<() => void>();

/** useSyncExternalStore 的 subscribe 端（模块级引用稳定） */
function subscribeReady(onChange: () => void): () => void {
  readyListeners.add(onChange);
  return () => {
    readyListeners.delete(onChange);
  };
}

function notifyReady(): void {
  for (const l of readyListeners) l();
}

/** 装配单例（AuthProvider 调用一次；幂等——重复调用返回既有实例） */
export function initWsClient(deps: WsClientDeps): WsClient {
  if (singleton === null) {
    singleton = createWsClient(deps);
    notifyReady(); // null→client：已挂订阅者重跑 effect 真正挂上
  }
  return singleton;
}

/** 测试/重建缝：清空模块单例（测试间隔离——disconnect 后调用） */
export function resetWsClient(): void {
  if (singleton === null) return;
  singleton = null;
  notifyReady(); // client→null：已挂订阅者退订旧实例（不倒灌旧单例帧）
}

/** 取已装配的单例（未装配 = 无会话期：返回 null，订阅退化为空转） */
export function getWsClient(): WsClient | null {
  return singleton;
}

/**
 * 订阅 WS 事件（DES/15 §3：useWsEvent(type, handler)）。
 * type 收窄 payload（contract 判别联合）；handler 引用变化不触发重订（ref 转发）。
 * 未装配单例时为空转（登录页/未初始化阶段调它不炸——守卫已挡页面，防御性兜底）。
 * useSyncExternalStore 盯 singleton 就绪：装配晚于挂载（被动 effect 次序）也必订阅。
 */
export function useWsEvent<T extends WsEventType>(type: T, handler: WsEventHandler<T>): void {
  const ref = useRef(handler);
  ref.current = handler;
  const client = useSyncExternalStore(subscribeReady, getWsClient);
  useEffect(() => {
    if (client === null) return undefined;
    return client.subscribe(type, (frame) => ref.current(frame));
  }, [client, type]);
}

/**
 * ws_backlog_expired 兜底收口（DES/15 §3 末条：WsClient.onBacklogExpired 的 React 侧接线）。
 * 服务端补发缺口（sinceSeq 超出保留窗）→ 页面级全量 refetch 挂这里。
 * inconsistency 帧本体仍走普通订阅面 useWsEvent('inconsistency', …)——不建第二通道；
 * 本钩子只是 onBacklogExpired 专用收口的等价就绪接线（同一竞态窗口同样存在）。
 */
export function useWsBacklogExpired(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  const client = useSyncExternalStore(subscribeReady, getWsClient);
  useEffect(() => {
    if (client === null) return undefined;
    return client.onBacklogExpired(() => ref.current());
  }, [client]);
}
