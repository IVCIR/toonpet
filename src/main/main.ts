// 进程入口。只做三件事：留启动痕迹、拦住 node 模式误用、把真正的启动交给 bootstrap。
//
// 注意：这里**不能**静态 import 'electron'，否则 require 会被提升到模块顶部，
// 环境检查就永远跑在 Electron 加载之后了。
import { writeBootBreadcrumb } from './boot-breadcrumb';

writeBootBreadcrumb();

if (process.env['ELECTRON_RUN_AS_NODE'] === '1') {
  // 此时 electron 以 Node 模式运行，不会创建任何窗口；GUI 进程没有 console，
  // 所以这条信息同时依赖 boot.log（上一行已写）。
  console.error(
    '[main] ELECTRON_RUN_AS_NODE=1：electron 正在以 Node 模式运行，不会创建窗口。清掉该环境变量后重试。',
  );
  process.exit(78);
}

void import('./bootstrap')
  .then(({ bootstrap }) => {
    bootstrap();
  })
  .catch((error: unknown) => {
    console.error('[main] 启动失败', error);
    process.exit(1);
  });
