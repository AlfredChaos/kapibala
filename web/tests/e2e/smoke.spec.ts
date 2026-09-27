// C3 冒烟（T-P8-03；REQ C3 逐字：登录 → 打开群 → 看到 agent run 的步骤）。
// 全栈：server(:3000,后端装配)+mock-gateway+mock-agent+PG 由 webServer 拉起；
// vite dev :5173 同源代理。数据由 scripts/e2e/backend.ts 预置（群 active +
// 一次已终态 agent run，steps 含 send_message + finish），本测试只走浏览器路径。
// 仅此一条 E2E（卡片 d「不扩面」）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

interface E2eState {
  readonly groupId: string;
  readonly runId: string;
  readonly webUrl: string;
}

function statePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '.e2e-state.json');
}

/** backend.ts 装配完成才写 stage=ready（config 在拉起前已删旧文件——存在即本轮） */
async function readState(): Promise<E2eState> {
  for (let i = 0; i < 480; i++) {
    try {
      const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as E2eState & {
        stage?: string;
      };
      if (parsed.stage === 'ready') return parsed;
    } catch {
      /* 尚未写出 / 半写出 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('e2e state file never reached stage=ready (backend assembly failed?)');
}

test('C3：登录 → 打开群 → 看到 agent run 的步骤（kind/工具名可见）', async ({ page }) => {
  const state = await readState();

  // 登录（页面 1：用户名/密码表单 + 提交）
  await page.goto('/login');
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/accounts/, { timeout: 15_000 });

  // 打开群详情（页面 3：run 列表区块含最近 run 入口）
  await page.goto(`/groups/${state.groupId}`);
  const runLink = page.locator(`a[href="/agent-runs/${state.runId}"]`);
  await expect(runLink).toBeVisible({ timeout: 15_000 });
  await runLink.click();

  // agent run 步骤可见：kind 行 + 工具名（页面 4：steps 时间线 kind/工具名）
  await page.waitForURL(/\/agent-runs\//, { timeout: 15_000 });
  await expect(page.locator('[data-testid="step-list"]')).toBeVisible({ timeout: 15_000 });
  // playbook：send_message 工具步 + final 收尾步（kind/工具名逐字可见性断言）
  await expect(page.locator('[data-testid="step-list"]')).toContainText('send_message');
  await expect(page.locator('[data-testid="step-list"]')).toContainText('final');
});
