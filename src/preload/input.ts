/**
 * 输入条页面的 preload（ADR 0016 D1）。
 *
 * 与主窗口 preload 分开：输入页只需要一个出口 `submit(text) → cmd:respond`，
 * 不暴露事件总线、不暴露探针/拖拽/语音通道。这样"输入条能做什么"是白名单式的，
 * 而不是"和角色页一样能做什么"。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';

const api = {
  /** 提交一行文本（§3.5 `cmd:respond`，renderer → main）。 */
  submit(text: string): void {
    if (typeof text !== 'string') return;
    ipcRenderer.send(IPC_CHANNELS.respond, text);
  },
};

contextBridge.exposeInMainWorld('petInput', api);

export type PetInputApi = typeof api;
