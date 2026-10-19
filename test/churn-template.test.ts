// test/churn-template.test.ts —— 流失预警模板：参数校验与默认值、编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHURN_DEFAULTS, compileChurn, parseChurnDefinition, parseChurnParams } from '../app/.server/pipeline/templates/churn';
import { TASK_KINDS, TEMPLATES, templateOfKind } from '../app/.server/pipeline/templates';

let instance: DuckDBInstance;
let con: DuckDBConnection;

// 两个数据源 s1、s2；c1 在两个源里各有一个 customer_id：3-01（没有支付时间）、4-15、6-30 各一单（平均间隔 60.5 天）；
// c2 在 6-01、6-02、6-03 各一单（平均间隔 1 天，按 7 天算）；c3 只有两单；c4 有一单已退款；s2:x 打通不到消费者
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  con = await instance.connect();
  await con.run(`SET TimeZone = 'UTC';
    CREATE SCHEMA silver;
    CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
    INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3'), ('s1','4','c4');
    CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, _source VARCHAR, _customer_source VARCHAR);
    INSERT INTO silver."order" VALUES
      ('o1', '10', 'completed', 200, '2024-03-01 10:00:00+00', NULL, 's2', 's2'),
      ('o2', '1', 'paid', 100, '2024-04-15 10:00:00+00', '2024-04-15 10:00:00+00', 's1', 's1'),
      ('o3', '1', 'paid', 100, '2024-06-30 10:00:00+00', '2024-06-30 10:00:00+00', 's1', 's1'),
      ('o4', '2', 'paid', 10, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00', 's1', 's1'),
      ('o5', '2', 'paid', 10, '2024-06-02 10:00:00+00', '2024-06-02 10:00:00+00', 's1', 's1'),
      ('o6', '2', 'shipped', 10, '2024-06-03 10:00:00+00', '2024-06-03 10:00:00+00', 's1', 's1'),
      ('o7', '3', 'paid', 30, '2024-05-01 10:00:00+00', '2024-05-01 10:00:00+00', 's1', 's1'),
      ('o8', '3', 'paid', 30, '2024-05-11 10:00:00+00', '2024-05-11 10:00:00+00', 's1', 's1'),
      ('o9', '4', 'paid', 40, '2024-05-01 10:00:00+00', '2024-05-01 10:00:00+00', 's1', 's1'),
      ('o10', '4', 'paid', 40, '2024-05-02 10:00:00+00', '2024-05-02 10:00:00+00', 's1', 's1'),
      ('o11', '4', 'refunded', 40, '2024-05-03 10:00:00+00', '2024-05-03 10:00:00+00', 's1', 's1'),
      ('o12', 'x', 'paid', 999, '2024-06-15 10:00:00+00', '2024-06-15 10:00:00+00', 's2', 's2'),
      ('o13', 'x', 'paid', 999, '2024-06-16 10:00:00+00', '2024-06-16 10:00:00+00', 's2', 's2'),
      ('o14', 'x', 'paid', 999, '2024-06-17 10:00:00+00', '2024-06-17 10:00:00+00', 's2', 's2');`);
});

afterAll(() => {
  con?.closeSync();
  instance?.closeSync();
});

const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();

describe('流失预警模板：参数', () => {
  it('只给 asOf 时取默认参数；注册表登记了 churn 模板与任务类型，带通用表单', () => {
    expect(parseChurnParams({ asOf: '2024-07-01' })).toEqual({ asOf: '2024-07-01', ...CHURN_DEFAULTS, statuses: ['completed', 'paid', 'shipped'] });
    expect(parseChurnDefinition({ minOrders: 2 })).toEqual({ lookbackDays: 730, minOrders: 2, silenceMultiplier: 2, minGapDays: 7, statuses: ['completed', 'paid', 'shipped'] });
    expect(TEMPLATES.churn.parse).toBe(parseChurnParams);
    expect(TASK_KINDS.churn).toBe('gold.churn');
    expect(templateOfKind('gold.churn')).toBe('churn');
    expect(TEMPLATES.churn.form.map(f => f.key)).toEqual(['lookbackDays', 'minOrders', 'silenceMultiplier', 'minGapDays', 'statuses']);
  });

  it.each([
    [{}, /asOf/],
    [{ asOf: '2024-07-01', minOrders: 1 }, /minOrders/],
    [{ asOf: '2024-07-01', silenceMultiplier: 0 }, /silenceMultiplier/],
    [{ asOf: '2024-07-01', minGapDays: 0 }, /minGapDays/],
    [{ asOf: '2024-07-01', lookbackDays: 3651 }, /lookbackDays/],
    [{ asOf: '2024-07-01', decay: 2 }, /decay/],
  ])('不合法的参数 %j 报出原因', (params, message) => {
    expect(() => parseChurnParams(params)).toThrow(message);
  });

  it('asOf 不属于定义', () => {
    expect(() => parseChurnDefinition({ asOf: '2024-07-01' })).toThrow(/asOf/);
  });

  it('同样的参数编译出同样的 SQL，不依赖当前时间', () => {
    const sql = compileChurn(parseChurnParams({ asOf: '2024-07-01' }));
    expect(compileChurn(parseChurnParams({ asOf: '2024-07-01' }))).toBe(sql);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
  });
});

describe('流失预警模板：编译出的 SQL', () => {
  it('订单数够的消费者都在，有风险的与没风险的都有；平均间隔不足 minGapDays 时按 minGapDays；不够单数的、打通不到的不在', async () => {
    expect(await run(compileChurn(parseChurnParams({ asOf: '2024-07-01' })))).toEqual([
      // 3-01 → 6-30 共 121 天 / 2；沉默 1 天
      { consumer_id: 'c1', orders: 3, avg_gap_days: 60.5, recency_days: 1, silence_ratio: 0.02, at_risk: false },
      // 沉默 28 天 > 2 × max(1, 7)
      { consumer_id: 'c2', orders: 3, avg_gap_days: 1, recency_days: 28, silence_ratio: 4, at_risk: true },
    ]);
  });

  it('silenceMultiplier 是严格大于：4 倍时 c2 沉默 28 天恰好不算；minOrders 2 时两单的 c3、c4 也在', async () => {
    const at = async (params: Record<string, unknown>) => run(compileChurn(parseChurnParams({ asOf: '2024-07-01', ...params })));
    expect((await at({ silenceMultiplier: 4 })).find(r => r.consumer_id === 'c2')!.at_risk).toBe(false);
    expect((await at({ silenceMultiplier: 3 })).find(r => r.consumer_id === 'c2')!.at_risk).toBe(true);
    const two = await at({ minOrders: 2 });
    expect(two.map(r => r.consumer_id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    // c3：5-01 → 5-11 间隔 10 天，沉默 51 天 > 20
    expect(two[2]).toEqual({ consumer_id: 'c3', orders: 2, avg_gap_days: 10, recency_days: 51, silence_ratio: 5.1, at_risk: true });
  });

  it('minGapDays 放大后沉默 28 天的 c2 不再有风险', async () => {
    const [, c2] = await run(compileChurn(parseChurnParams({ asOf: '2024-07-01', minGapDays: 14 })));
    expect(c2).toMatchObject({ silence_ratio: 2, at_risk: false });
  });
});
