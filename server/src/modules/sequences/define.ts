// 序列定义（T-P6-01；DES/07 §1 逐字）。入参校验不过 → 400 VALIDATION_ERROR；
// 通过即原样存 sequence.steps（jsonb 快照）、返回 { id }。
// **定义阶段不做占位符校验**（占位符与启动参数相关，预检在启动时做——§1 明文）。
import type { Pool } from 'pg';
import { TEXT_MAX_LENGTH } from '../../constants.js';
import { AppError } from '../../http/plugins/errors.js';

export interface SequenceStepDef {
  readonly index: number;
  readonly accountRole: 'admin' | 'member';
  readonly text: string;
  readonly delaySeconds: number;
}

function fail(message: string): never {
  throw new AppError('VALIDATION_ERROR', message);
}

function isStepDef(v: unknown): v is SequenceStepDef {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    Number.isInteger(s['index']) && (s['index'] as number) > 0 &&
    (s['accountRole'] === 'admin' || s['accountRole'] === 'member') &&
    typeof s['text'] === 'string' && s['text'].length > 0 && s['text'].length <= TEXT_MAX_LENGTH &&
    Number.isInteger(s['delaySeconds']) && (s['delaySeconds'] as number) >= 0
  );
}

/** POST /api/sequences 的域入口：校验 → INSERT → { id } */
export async function defineSequence(pool: Pool, body: unknown): Promise<{ id: string }> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b['name'] !== 'string' || b['name'].length === 0) {
    fail('name must be a non-empty string');
  }
  const steps = b['steps'];
  if (!Array.isArray(steps) || steps.length === 0) {
    fail('steps must be a non-empty array');
  }
  const seen = new Set<number>();
  for (const s of steps) {
    if (!isStepDef(s)) {
      fail('each step requires: index positive int, accountRole admin|member, text 1-2000 chars, delaySeconds >= 0');
    }
    if (seen.has(s.index)) {
      fail(`duplicate step index: ${s.index}`);
    }
    seen.add(s.index);
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "sequence" (id, name, steps) VALUES (gen_random_uuid(), $1, $2::jsonb) RETURNING id`,
    [b['name'], JSON.stringify(steps)],
  );
  return { id: rows[0]?.id ?? '' };
}
