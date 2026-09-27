// 事务助手（T-P0-04）：BEGIN / COMMIT / ROLLBACK 一处收口，回调拿到的 client 即事务载体。
// 宪法 §3-1（先持久化后外部效果）依赖精确事务边界——所有多写原子路径必须走这里，禁止手拼 BEGIN。
import type { Pool, PoolClient } from 'pg';

export async function tx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyOnRelease = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ROLLBACK 失败几乎必然意味着连接已死 → 归还时销毁（release(true)）。
      // 原始错误才是根因，回滚失败只是连接死亡的衍生症状——不吞、不覆盖。
      destroyOnRelease = true;
    }
    throw err;
  } finally {
    client.release(destroyOnRelease);
  }
}
