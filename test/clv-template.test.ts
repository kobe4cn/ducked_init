// test/clv-template.test.ts —— CLV 模板：参数校验与默认值、编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLV_DEFAULTS, compileClv, parseClvDefinition, parseClvParams } from '../app/.server/pipeline/templates/clv';
import { TASK_KINDS, TEMPLATES, templateOfKind } from '../app/.server/pipeline/templates';

let instance: DuckDBInstance;
let con: DuckDBConnection;

// 两个数据源 s1、s2；c1 在两个源里各有一个 customer_id：窗口外 2022-01-01 一单，窗口内 3-01（没有支付时间）、4-15、6-30 各一单；
// c2 只有 6-21 一单（客龄不足 30 天）；c3 只有已退款与晚于 as_of 的订单；s2:x 打通不到消费者
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  con = await instance.connect();
  await con.run(`SET TimeZone = 'UTC';
    CREATE SCHEMA silver;
    CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
    INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3');
    CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, _source VARCHAR, _customer_source VARCHAR);
    INSERT INTO silver."order" VALUES
      ('o1', '1', 'paid', 800, '2022-01-01 10:00:00+00', '2022-01-01 10:00:00+00', 's1', 's1'),
      ('o2', '10', 'completed', 200, '2024-03-01 10:00:00+00', NULL, 's2', 's2'),
      ('o3', '1', 'paid', 100, '2024-04-15 10:00:00+00', '2024-04-15 10:00:00+00', 's1', 's1'),
      ('o4', '1', 'paid', 100, '2024-06-30 10:00:00+00', '2024-06-30 10:00:00+00', 's1', 's1'),
      ('o5', '2', 'shipped', 50, '2024-06-21 08:00:00+00', '2024-06-21 08:00:00+00', 's1', 's1'),
      ('o6', '3', 'refunded', 90, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00', 's1', 's1'),
      ('o7', '3', 'paid', 90, '2024-07-02 10:00:00+00', '2024-07-02 10:00:00+00', 's1', 's1'),
      ('o8', 'x', 'paid', 999, '2024-06-15 10:00:00+00', '2024-06-15 10:00:00+00', 's2', 's2');`);
});

afterAll(() => {
  con?.closeSync();
  instance?.closeSync();
});

const run = async (sql: string) => (await con.runAndReadAll(`SELECT * REPLACE (clv::VARCHAR AS clv) FROM (${sql})`)).getRowObjectsJson();

describe('CLV 模板：参数', () => {
  it('只给 asOf 时取默认参数；注册表登记了 clv 模板与任务类型，带通用表单', () => {
    expect(parseClvParams({ asOf: '2024-07-01' })).toEqual({ asOf: '2024-07-01', ...CLV_DEFAULTS, statuses: ['completed', 'paid', 'shipped'] });
    expect(parseClvDefinition({ decay: 3 })).toEqual({ lookbackDays: 730, horizonDays: 365, minTenureDays: 30, decay: 3, statuses: ['completed', 'paid', 'shipped'] });
    expect(TEMPLATES.clv.parse).toBe(parseClvParams);
    expect(TASK_KINDS.clv).toBe('gold.clv');
    expect(templateOfKind('gold.clv')).toBe('clv');
    expect(TEMPLATES.clv.form.map(f => f.key)).toEqual(['lookbackDays', 'horizonDays', 'minTenureDays', 'decay', 'statuses']);
  });

  it.each([
    [{}, /asOf/],
    [{ asOf: '2024-07-01', horizonDays: 0 }, /horizonDays/],
    [{ asOf: '2024-07-01', minTenureDays: 366 }, /minTenureDays/],
    [{ asOf: '2024-07-01', decay: 0 }, /decay/],
    [{ asOf: '2024-07-01', decay: 11 }, /decay/],
    [{ asOf: '2024-07-01', decay: 1.5 }, /decay/],
    [{ asOf: '2024-07-01', lookbackDays: 0 }, /lookbackDays/],
    [{ asOf: '2024-07-01', windowDays: 90 }, /windowDays/],
  ])('不合法的参数 %j 报出原因', (params, message) => {
    expect(() => parseClvParams(params)).toThrow(message);
  });

  it('asOf 不属于定义', () => {
    expect(() => parseClvDefinition({ asOf: '2024-07-01' })).toThrow(/asOf/);
  });

  it('同样的参数编译出同样的 SQL，不依赖当前时间', () => {
    const sql = compileClv(parseClvParams({ asOf: '2024-07-01' }));
    expect(compileClv(parseClvParams({ asOf: '2024-07-01' }))).toBe(sql);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
  });
});

describe('CLV 模板：编译出的 SQL', () => {
  it('多源订单合到同一消费者，各列与按公式手算的一致；客龄不足 minTenureDays 时按 minTenureDays；没有计入订单的不在', async () => {
    const rows = await run(compileClv(parseClvParams({ asOf: '2024-07-01' })));
    expect(rows.map(r => r.consumer_id)).toEqual(['c1', 'c2']);
    // c1：3 单 400，客龄 3-01 → 7-01 = 122 天，沉默 1 天；p_alive = exp(−1 / max(122 / 3, 30) / 2)；clv = 400 / 3 × 3 × 365 / 122 × p_alive
    expect(rows[0]).toMatchObject({ orders: 3, monetary: 400, recency_days: 1, tenure_days: 122, clv: '1182.10' });
    expect(rows[0].avg_order_value).toBeCloseTo(133.3333, 4);
    expect(rows[0].freq_per_year).toBeCloseTo(8.97541, 4);
    expect(rows[0].p_alive).toBeCloseTo(0.98778, 4);
    // c2：1 单 50，客龄 10 天按 30 天，沉默 10 天；p_alive = exp(−10 / 30 / 2)；clv = 50 × 365 / 30 × p_alive
    expect(rows[1]).toMatchObject({ orders: 1, monetary: 50, avg_order_value: 50, recency_days: 10, tenure_days: 30, clv: '514.94' });
    expect(rows[1].freq_per_year).toBeCloseTo(12.16667, 4);
    expect(rows[1].p_alive).toBeCloseTo(0.84648, 4);
  });

  it('decay、horizonDays、minTenureDays 按公式生效；回看放宽后算进窗口外那单', async () => {
    const c2 = async (params: Record<string, unknown>) => (await run(compileClv(parseClvParams({ asOf: '2024-07-01', ...params })))).find(r => r.consumer_id === 'c2')!;
    // exp(−10 / 30 / 1)
    expect((await c2({ decay: 1 })).p_alive).toBeCloseTo(0.71653, 4);
    // 50 × 730 / 30 × exp(−1/6)
    expect((await c2({ horizonDays: 730 })).clv).toBe('1029.89');
    // 客龄 60：p_alive = exp(−10 / 60 / 2)
    expect(await c2({ minTenureDays: 60 })).toMatchObject({ tenure_days: 60 });
    expect((await c2({ minTenureDays: 60 })).p_alive).toBeCloseTo(0.92004, 4);

    const [c1] = await run(compileClv(parseClvParams({ asOf: '2024-07-01', lookbackDays: 1000 })));
    // 2022-01-01 → 2024-07-01 = 912 天
    expect(c1).toMatchObject({ orders: 4, monetary: 1200, tenure_days: 912 });
  });
});
