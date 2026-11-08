// 真正的启动装配：单实例、启动 shell、启动编排/语音链路、退出清理。
import { app } from 'electron';
import { loadProjectEnv } from './env';
import { logError, logInfo, logWarn } from './log';
import { getRuntime, ensureRuntime, logRuntimeFailure } from './runtime';
import { shell } from './shell/index';
import { runPanelShotIfRequested } from './panel-shot';
import { runSelfTestIfRequested } from './selftest';

export function bootstrap(): void {
  // 最早时机（ADR 0018 D1）：把工程根目录的 .env 灌进 process.env。
  // 必须在 shell / runtime 读取任何配置之前完成；进程环境变量优先，.env 只补空缺。
  loadProjectEnv();

  // ADR 0015 D5：主窗口 focusable=false，永远没有用户手势；必须在 app.ready 之前声明，
  // 否则 AudioContext 常驻 suspended（表现为"解码成功但没声音"）。
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  process.on('uncaughtException', (error) => {
    logError('main', '未捕获异常', error);
  });
  process.on('unhandledRejection', (reason) => {
    logError('main', '未处理的 Promise 拒绝', reason);
  });

  // C-5：同一用户会话只允许一个桌宠进程；二次启动直接退出（§11）。
  const gotSingleInstanceLock = app.requestSingleInstanceLock();

  if (!gotSingleInstanceLock) {
    logWarn('main', '单实例锁已被占用，本实例直接退出（C-5）');
    app.quit();
    return;
  }

  let quitting = false;

  app.on('second-instance', () => {
    shell.notifySecondInstance();
  });

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    // ADR 0015：先停编排/语音（会发 speech_ended），再销毁窗口；
    // 托盘"退出"同样走这条路径：先 stop() 再 quit（ADR 0004 D9）。
    getRuntime()?.stop();
    void shell.stop();
  });

  app.on('window-all-closed', () => {
    if (quitting) return;
    app.quit();
  });

  app
    .whenReady()
    .then(async () => {
      await shell.start();
      try {
        await ensureRuntime().start();
      } catch (error) {
        logRuntimeFailure(error);
        app.quit();
        return;
      }
      logInfo('main', '就绪');
      // ADR 0053：面板的 AI/记忆动作需要 runtime 的运行期后端（换模型、换角色卡、读写 SQLite）。
      // shell 不 import runtime，这里用注入把两者接起来；runtime 装配失败时面板仍然能打开看配置。
      shell.attachPanelBackend(() => getRuntime()?.panel() ?? null);
      // ADR 0054：视觉热键与 cmd:vision-query 也走同一条注入路径。
      // runtime 还在启动窗口里时 `vision()` 会抛，这里兜住返回 null（shell 记 WARN 后放弃本次热键）。
      shell.attachVisionBackend(() => {
        try {
          return getRuntime()?.vision() ?? null;
        } catch {
          return null;
        }
      });
      await runSelfTestIfRequested();
      // ADR 0052 D7：控制面板取证（PET_PANEL_SHOT=1）；正常启动时立即返回
      await runPanelShotIfRequested();
    })
    .catch((error: unknown) => {
      logError('main', '启动失败', error);
      app.quit();
    });
}
