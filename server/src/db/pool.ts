// pg Pool 工厂（T-P0-04）。连接参数只来自校验过的 DATABASE_URL；
// 显式创建 / 显式关闭，不做进程级单例（测试要按库隔离，单例会把连接泄漏进下一个用例）。
import { Pool } from 'pg';

export function createPool(connectionString: string, options: { max?: number } = {}): Pool {
  return new Pool({ connectionString, max: options.max ?? 10 });
}
