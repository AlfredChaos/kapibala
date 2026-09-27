// C3 globalSetup（T-P8-03）：主进程、webServer 拉起之后跑一次。
// 职责：清掉上一轮 backend 写的 .e2e-state.json（stale stage=ready 会让测试误读旧 group/run id）。
// 不在 playwright.config.ts 顶层做——config 在每个 worker 里会再求值一次，顶层 rmSync 会
// 在测试进行到一半时把本轮 backend 写的 state 删掉（踩坑记录见 JOURNAL T-P8-03）。
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  try {
    rmSync(join(dirname(fileURLToPath(import.meta.url)), '.e2e-state.json'));
  } catch {
    /* 首轮无文件 */
  }
}
