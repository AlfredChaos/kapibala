// PATCH /api/groups/:id + GET /api/groups(/:id)（T-P3-08；DES/04 §5 逐字、REQ §2.3 群行）。
// PATCH {agentEnabled?, autoKickEnabled?}：条件更新 + ws_event(group_updated)（§5 扩展事件类型）。
// 关闭 agentEnabled 时若群有 running agent run → 「取消请求」即 group.agent_enabled=false 本身
// （run executor 步结束检查点读库收口，A5-10/X-2；不在本事务改 run 状态）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { AppError } from '../plugins/errors.js';
import { getGroup, listGroups } from '../../modules/groups/query.js';
import { tx } from '../../db/tx.js';

interface PatchBody {
  agentEnabled?: unknown;
  autoKickEnabled?: unknown;
}

export async function registerGroupStateRoutes(app: App, deps: RouteDeps): Promise<void> {
  // 读路径：admin/viewer 均可（auth:'required'）
  app.get('/api/groups', { config: { auth: 'required' } }, async () => listGroups(deps.pool));
  app.get('/api/groups/:id', { config: { auth: 'required' } }, async (request) => {
    const { id } = request.params as { id: string };
    return getGroup(deps.pool, id);
  });

  // 写路径：admin only（auth:'write'）
  app.patch('/api/groups/:id', { config: { auth: 'write' } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as PatchBody;
    const agentEnabled = body.agentEnabled;
    const autoKickEnabled = body.autoKickEnabled;
    if (
      (agentEnabled !== undefined && typeof agentEnabled !== 'boolean') ||
      (autoKickEnabled !== undefined && typeof autoKickEnabled !== 'boolean')
    ) {
      throw new AppError('VALIDATION_ERROR', 'agentEnabled/autoKickEnabled must be boolean');
    }
    const updated = await tx(deps.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE "group" SET agent_enabled = COALESCE($2, agent_enabled),
                            auto_kick_enabled = COALESCE($3, auto_kick_enabled),
                            updated_at=now()
         WHERE id=$1 AND status <> 'creating'`,
        [id, agentEnabled ?? null, autoKickEnabled ?? null],
      );
      if (rowCount !== 1) return false;
      await client.query("INSERT INTO ws_event (type, payload) VALUES ('group_updated', $1::jsonb)", [
        JSON.stringify({ groupId: id }),
      ]);
      return true;
    });
    if (!updated) throw new AppError('GROUP_NOT_FOUND', `unknown group: ${id}`);
    // A5-10：关闭 agentEnabled → 不写 agent_run.status；executor 步结束检查 agent_enabled 收口
    return getGroup(deps.pool, id);
  });
}
