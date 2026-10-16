// test/schema-repair.test.ts —— 源列改名后按规则起草修复：guessRenames 按类型与列统计猜改名，rewriteMappingYaml 改写表达式并加注释（纯函数）
import { describe, expect, it } from 'vitest';
import type { ColumnProfile } from '../app/.server/pipeline/source-engine';
import { guessRenames, rewriteMappingYaml, type Rename } from '../app/.server/pipeline/schema-repair';

const col = (name: string, type: string, rest: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullRate: 0, distinct: 6, min: null, max: null, ...rest });
const ts = (name: string, min: string, max: string, nullRate = 0) => col(name, 'TIMESTAMP', { min, max, nullRate });

describe('guessRenames', () => {
  it('类型不同的新列不算候选；没有候选的旧列不改写', () => {
    expect(guessRenames([ts('paid_at', '2024-04-01', '2024-06-30')], [col('paid_at_text', 'VARCHAR', { length: { min: 19, max: 19 } })])).toEqual([]);
  });

  it('多个候选时取得分最高的（取值范围相同胜过重叠），其余写进候选', () => {
    const renames = guessRenames(
      [ts('paid_at', '2024-04-01', '2024-06-30')],
      [ts('shipped_at', '2024-04-02', '2024-07-03'), ts('paid_time', '2024-04-01', '2024-06-30'), ts('refunded_at', '2023-01-01', '2023-02-01', 0.9)],
    );
    expect(renames).toEqual([{ from: 'paid_at', to: 'paid_time', reason: '类型相同（TIMESTAMP）、取值范围相同、空值率相近', others: ['shipped_at'] }]);
  });

  it('文本列看常见取值与长度范围；一列新列只配给一列旧列', () => {
    const top = (...values: string[]) => values.map(value => ({ value, rows: 1 }));
    const renames = guessRenames(
      [col('state', 'VARCHAR', { top: top('paid', 'refunded'), length: { min: 4, max: 8 } }), col('kind', 'VARCHAR', { top: top('paid'), nullRate: 0.5 })],
      [col('status', 'VARCHAR', { top: top('paid', 'refunded'), length: { min: 4, max: 8 } })],
    );
    expect(renames).toEqual([{ from: 'state', to: 'status', reason: '类型相同（VARCHAR）、常见取值相同、长度范围相同、空值率相近', others: [] }]);
  });
});

describe('rewriteMappingYaml', () => {
  const rename: Rename = { from: 'paid_at', to: 'paid_time', reason: '类型相同（TIMESTAMP）、取值范围相同', others: ['shipped_at'] };

  it('改写字段表达式、对象写法的 expr、扩展字段与 where，并加注释写明依据与其余候选', () => {
    const yaml = rewriteMappingYaml(`model: 1
entity: order
table: orders
fields:
  created_at: from_timezone(created_at, 'UTC')
  paid_at: from_timezone(paid_at, 'UTC')
  status: { expr: string(paid_at), dictionary: { a: paid } }
extensions:
  x_paid:
    type: text
    expr: string(paid_at)
where: paid_at is not null
`, [rename]);
    const note = '# 平台猜测 paid_at 改名为 paid_time：类型相同（TIMESTAMP）、取值范围相同；其他候选：shipped_at';
    expect(yaml).toContain(`  created_at: from_timezone(created_at, 'UTC')\n`);
    expect(yaml).toContain(`  paid_at: from_timezone(paid_time, 'UTC') ${note}\n`);
    expect(yaml).toContain(`  status: { expr: string(paid_time), dictionary: { a: paid } } ${note}\n`);
    expect(yaml).toContain(`    expr: string(paid_time) ${note}\n`);
    expect(yaml).toContain(`where: paid_time is not null ${note}\n`);
  });

  it('原有的行尾注释保留在平台注释后面', () => {
    const yaml = rewriteMappingYaml(`fields:\n  paid_at: paid_at  # 原注释\n`, [{ ...rename, others: [] }]);
    expect(yaml).toContain('paid_at: paid_time # 平台猜测 paid_at 改名为 paid_time：类型相同（TIMESTAMP）、取值范围相同；原注释\n');
  });

  it('带双引号的字段名整个替换；新列名需要引号时加上', () => {
    const yaml = rewriteMappingYaml(`fields:\n  a: concat("paid at", "paid at")\n`, [{ from: 'paid at', to: "in", reason: '类型相同（VARCHAR）', others: [] }]);
    expect(yaml).toContain(`a: concat("in", "in") # 平台猜测 paid at 改名为 in：类型相同（VARCHAR）\n`);
  });
});
