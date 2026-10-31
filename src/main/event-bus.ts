/**
 * 主进程事件总线（契约 §6.4 E-1、E-2、E-4）。
 *
 * 两条出口：
 * - `emit(name, payload)`：进程内订阅者 + `evt:broadcast` 转发到渲染侧（唯一信封形态由 preload 校验）；
 * - `sendCommand(channel, payload)`：§3.5 的单向命令（`cmd:render-intent` / `cmd:voice`）。
 *
 * 渲染侧句柄由 shell 在 start/stop 时注入（全进程只有 shell 碰 BrowserWindow）。
 * 订阅顺序 = 注册顺序；同一生产者的事件保持发出顺序（E-2）。
 */
import type { EventName, EventPayloads } from '../shared/events';

export interface RendererSink {
  /** 渲染侧 → 事件（`evt:broadcast`），信封在 shell 侧拼装 */
  event(name: EventName, payload: EventPayloads[EventName]): void;
  /** 渲染侧 → 命令（`cmd:render-intent` / `cmd:voice`）；无窗口时返回 false */
  command(channel: string, payload: unknown): boolean;
}

export type EventHandler<K extends EventName> = (payload: EventPayloads[K]) => void;

export interface EventBus {
  setRendererSink(sink: RendererSink | null): void;
  emit<K extends EventName>(name: K, payload: EventPayloads[K]): void;
  subscribe<K extends EventName>(name: K, handler: EventHandler<K>): () => void;
  sendCommand(channel: string, payload: unknown): boolean;
}

type AnyHandler = (payload: never) => void;

export function createEventBus(): EventBus {
  let sink: RendererSink | null = null;
  const handlers = new Map<EventName, Set<AnyHandler>>();

  return {
    setRendererSink(next: RendererSink | null): void {
      sink = next;
    },

    emit<K extends EventName>(name: K, payload: EventPayloads[K]): void {
      const set = handlers.get(name);
      if (set) {
        for (const handler of [...set]) {
          try {
            (handler as (value: EventPayloads[K]) => void)(payload);
          } catch (error) {
            // 订阅者异常不得打断其他订阅者，也不得让事件源头抛错（E-4）
            console.warn(`[bus] 事件订阅者抛错 name=${name}`, error);
          }
        }
      }
      try {
        sink?.event(name, payload);
      } catch (error) {
        console.warn(`[bus] 渲染侧事件转发失败 name=${name}`, error);
      }
    },

    subscribe<K extends EventName>(name: K, handler: EventHandler<K>): () => void {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      const stored = handler as unknown as AnyHandler;
      set.add(stored);
      return () => {
        set?.delete(stored);
      };
    },

    sendCommand(channel: string, payload: unknown): boolean {
      if (!sink) return false;
      try {
        return sink.command(channel, payload);
      } catch (error) {
        console.warn(`[bus] 命令下发失败 channel=${channel}`, error);
        return false;
      }
    },
  };
}

/**
 * 进程级单例：shell 注入渲染侧句柄，orchestrator / voice 通过它发事件与命令。
 * 只有 shell 持有 BrowserWindow（§7.2），因此句柄注入点也在 shell。
 */
export const appBus = createEventBus();
