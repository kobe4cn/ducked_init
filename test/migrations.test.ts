// 迁移目录的形状：每个迁移都由 drizzle-kit 生成，带 snapshot.json；手写的 SQL 没有快照，下一次 db:generate 会算错差异
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '../drizzle');

describe('迁移目录', () => {
  it('每个迁移都有 migration.sql 和 snapshot.json（用 pnpm db:generate 生成，不要手写）', () => {
    const dirs = readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const incomplete = dirs.filter(d => !['migration.sql', 'snapshot.json'].every(f => existsSync(join(DIR, d, f))));
    expect(incomplete).toEqual([]);
  });
});
