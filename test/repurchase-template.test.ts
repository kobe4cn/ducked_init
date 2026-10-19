// test/repurchase-template.test.ts —— 复购模板：参数校验与默认值、编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileRepurchase, parseRepurchaseDefinition, parseRepurchaseParams, REPURCHASE_DEFAULTS } from '../app/.server/pipeline/templates/repurchase';
import { TASK_KINDS, TEMPLATES, templateOfKind } from '../app/.server/pipeline/templates';

let instance: DuckDBInstance;
let con: DuckDBConnection;

// 两个数据源 s1、s2；c1 在两个源里各有一个 customer_id：窗口外 2023-06-01 一单，窗口内 3-01、4-15、6-30 各一单；
// c2 同一天两单；c3 只有一单；c4 只有已退款与晚于 as_of 的订单；s2:x 打通不到消费者
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  con = await instance.connect();
  await con.run(`SET TimeZone = 'UTC';
    CREATE SCHEMA silver;
    CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
    INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3'), ('s1','4','c4');
    CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, _source VARCHAR, _customer_source VARCHAR);
    INSERT INTO silver."order" VALUES
      ('o1', '1', 'paid', 800, '2023-06-01 10:00:00+00', '2023-06-01 10:00:00+00', 's1', 's1'),
      ('o2', '10', 'completed', 200, '2024-03-01 10:00:00+00', NULL, 's2', 's2'),
      ('o3', '1', 'paid', 100, '2024-04-15 10:00:00+00', '2024-04-15 10:00:00+00', 's1', 's1'),
      ('o4', '1', 'paid', 100, '2024-06-30 10:00:00+00', '2024-06-30 10:00:00+00', 's1', 's1'),
      ('o5', '2', 'shipped', 50, '2024-05-01 08:00:00+00', '2024-05-01 08:00:00+00', 's1', 's1'),
      ('o6', '2', 'paid', 50, '2024-05-01 20:00:00+00', '2024-05-01 20:00:00+00', 's1', 's1'),
      ('o7', '3', 'paid', 70, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00', 's1', 's1'),
      ('o8', '4', 'refunded', 90, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00', 's1', 's1'),
      ('o9', '4', 'paid', 90, '2024-07-02 10:00:00+00', '2024-07-02 10:00:00+00', 's1', 's1'),
      ('o10', 'x', 'paid', 999, '2024-06-15 10:00:00+00', '2024-06-15 10:00:00+00', 's2', 's2');`);
});

afterAll(() => {
  con?.closeSync();
  instance?.closeSync();
});

const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();

describe('复购模板：参数', () => {
  it('只给 asOf 时取默认参数；注册表登记了 repurchase 模板与任务类型，带通用表单', () => {
    expect(parseRepurchaseParams({ asOf: '2024-07-01' })).toEqual({ asOf: '2024-07-01', ...REPURCHASE_DEFAULTS, statuses: ['completed', 'paid', 'shipped'] });
    expect(parseRepurchaseDefinition({ windowDays: 60 })).toEqual({ lookbackDays: 365, windowDays: 60, statuses: ['completed', 'paid', 'shipped'] });
    expect(TEMPLATES.repurchase.parse).toBe(parseRepurchaseParams);
    expect(TASK_KINDS.repurchase).toBe('gold.repurchase');
    expect(templateOfKind('gold.repurchase')).toBe('repurchase');
    expect(TEMPLATES.repurchase.form.map(f => f.key)).toEqual(['lookbackDays', 'windowDays', 'statuses']);
  });

  it.each([
    [{}, /asOf/],
    [{ asOf: '2024-07-01', windowDays: 0 }, /windowDays/],
    [{ asOf: '2024-07-01', windowDays: 731 }, /windowDays/],
    [{ asOf: '2024-07-01', lookbackDays: 0 }, /lookbackDays/],
    [{ asOf: '2024-07-01', periods: 12 }, /periods/],
  ])('不合法的参数 %j 报出原因', (params, message) => {
    expect(() => parseRepurchaseParams(params)).toThrow(message);
  });

  it('asOf 不属于定义', () => {
    expect(() => parseRepurchaseDefinition({ asOf: '2024-07-01' })).toThrow(/asOf/);
  });

  it('同样的参数编译出同样的 SQL，不依赖当前时间', () => {
    const sql = compileRepurchase(parseRepurchaseParams({ asOf: '2024-07-01' }));
    expect(compileRepurchase(parseRepurchaseParams({ asOf: '2024-07-01' }))).toBe(sql);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
  });
});

describe('复购模板：编译出的 SQL', () => {
  it('多源订单合到同一消费者，首单与第二单都取窗口内的；同一天两单相隔 0 天；只有一单时第二单为空、不算复购', async () => {
    const rows = await run(compileRepurchase(parseRepurchaseParams({ asOf: '2024-07-01' })));
    expect(rows).toEqual([
      // o1 在窗口外；o2 没有支付时间，按下单时间 3-01；3-01 → 4-15 相隔 45 天
      { consumer_id: 'c1', orders: 3, first_order_date: '2024-03-01', second_order_date: '2024-04-15', days_to_second: 45, repurchased: true },
      { consumer_id: 'c2', orders: 2, first_order_date: '2024-05-01', second_order_date: '2024-05-01', days_to_second: 0, repurchased: true },
      { consumer_id: 'c3', orders: 1, first_order_date: '2024-06-01', second_order_date: null, days_to_second: null, repurchased: false },
    ]);
  });

  it('windowDays 是闭区间：45 天时算复购，44 天时不算', async () => {
    const at = async (windowDays: number) =>
      (await run(compileRepurchase(parseRepurchaseParams({ asOf: '2024-07-01', windowDays })))).find(r => r.consumer_id === 'c1')!.repurchased;
    expect(await at(45)).toBe(true);
    expect(await at(44)).toBe(false);
  });

  it('回看天数放宽到 400 天时首单变成窗口外那单', async () => {
    const rows = await run(compileRepurchase(parseRepurchaseParams({ asOf: '2024-07-01', lookbackDays: 400 })));
    expect(rows[0]).toEqual({ consumer_id: 'c1', orders: 4, first_order_date: '2023-06-01', second_order_date: '2024-03-01', days_to_second: 274, repurchased: false });
  });
});
