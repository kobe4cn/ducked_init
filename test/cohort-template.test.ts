// test/cohort-template.test.ts —— 同期群模板：参数校验与默认值、编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COHORT_DEFAULTS, compileCohort, parseCohortDefinition, parseCohortParams } from '../app/.server/pipeline/templates/cohort';
import { TASK_KINDS, TEMPLATES, templateOfKind } from '../app/.server/pipeline/templates';

let instance: DuckDBInstance;
let con: DuckDBConnection;

// 两个数据源 s1、s2；c1 在两个源里各有一个 customer_id。c1 首单 2023-12-31（周日）、2024-01-31 与 2024-03-01 各一单；
// c2 首单 2023-06-15（12 个月以前）；c3 只有已退款与晚于 as_of 的订单；s2:x 打通不到消费者
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  con = await instance.connect();
  await con.run(`SET TimeZone = 'UTC';
    CREATE SCHEMA silver;
    CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
    INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3');
    CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, _source VARCHAR, _customer_source VARCHAR);
    INSERT INTO silver."order" VALUES
      ('o1', '1', 'paid', 100, '2023-12-31 10:00:00+00', NULL, 's1', 's1'),
      ('o2', '10', 'completed', 200, '2024-01-31 10:00:00+00', '2024-01-31 10:00:00+00', 's2', 's2'),
      ('o3', '1', 'paid', 300, '2024-03-01 10:00:00+00', '2024-03-01 10:00:00+00', 's1', 's1'),
      ('o4', '2', 'shipped', 50, '2023-06-15 10:00:00+00', '2023-06-15 10:00:00+00', 's1', 's1'),
      ('o5', '2', 'paid', 50, '2024-06-20 10:00:00+00', '2024-06-20 10:00:00+00', 's1', 's1'),
      ('o6', '3', 'refunded', 900, '2024-06-20 10:00:00+00', '2024-06-20 10:00:00+00', 's1', 's1'),
      ('o7', '3', 'paid', 700, '2024-07-02 10:00:00+00', '2024-07-02 10:00:00+00', 's1', 's1'),
      ('o8', 'x', 'paid', 999, '2024-06-15 10:00:00+00', '2024-06-15 10:00:00+00', 's2', 's2');`);
});

afterAll(() => {
  con?.closeSync();
  instance?.closeSync();
});

const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();

describe('同期群模板：参数', () => {
  it('只给 asOf 时取默认参数；注册表登记了 cohort 模板与任务类型，带通用表单', () => {
    expect(parseCohortParams({ asOf: '2024-07-01' })).toEqual({ asOf: '2024-07-01', ...COHORT_DEFAULTS, statuses: ['completed', 'paid', 'shipped'] });
    expect(parseCohortDefinition({ granularity: 'week', periods: 8 })).toEqual({ granularity: 'week', periods: 8, statuses: ['completed', 'paid', 'shipped'] });
    expect(TEMPLATES.cohort.parse).toBe(parseCohortParams);
    expect(TASK_KINDS.cohort).toBe('gold.cohort');
    expect(templateOfKind('gold.cohort')).toBe('cohort');
    expect(TEMPLATES.cohort.form.map(f => f.key)).toEqual(['granularity', 'periods', 'statuses']);
  });

  it.each([
    [{}, /asOf/],
    [{ asOf: '2024-07-01', granularity: 'day' }, /granularity/],
    [{ asOf: '2024-07-01', periods: 0 }, /periods/],
    [{ asOf: '2024-07-01', periods: 61 }, /periods/],
    [{ asOf: '2024-07-01', statuses: ['lost'] }, /statuses/],
    [{ asOf: '2024-07-01', lookbackDays: 30 }, /lookbackDays/],
  ])('不合法的参数 %j 报出原因', (params, message) => {
    expect(() => parseCohortParams(params)).toThrow(message);
  });

  it('asOf 不属于定义', () => {
    expect(() => parseCohortDefinition({ asOf: '2024-07-01' })).toThrow(/asOf/);
  });

  it('同样的参数编译出同样的 SQL，不依赖当前时间', () => {
    const sql = compileCohort(parseCohortParams({ asOf: '2024-07-01' }));
    expect(compileCohort(parseCohortParams({ asOf: '2024-07-01' }))).toBe(sql);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
  });
});

describe('同期群模板：编译出的 SQL', () => {
  it('按月：多源订单合到同一消费者，首单取全部历史，只收首单在最近 12 个月里的；偏移按月起点算，去重升序', async () => {
    const rows = await run(compileCohort(parseCohortParams({ asOf: '2024-07-01' })));
    // c1：12-31 → 1-31 相隔一个月、1-31 → 3-01 只隔 30 天但跨两个月；c2 首单 2023-06 在 12 个月以前；c3 没有计入的订单
    expect(rows).toEqual([{ consumer_id: 'c1', cohort_start: '2023-12-01', orders: 3, active_periods: [0, 1, 3] }]);
  });

  it('periods 放宽到 14 个月（2023-06 到 2024-07）时收进 c2；o5 在首单 12 个月后', async () => {
    const rows = await run(compileCohort(parseCohortParams({ asOf: '2024-07-01', periods: 14 })));
    expect(rows).toEqual([
      { consumer_id: 'c1', cohort_start: '2023-12-01', orders: 3, active_periods: [0, 1, 3] },
      { consumer_id: 'c2', cohort_start: '2023-06-01', orders: 2, active_periods: [0, 12] },
    ]);
  });

  it('按周：周期起点是周一，偏移按周起点算', async () => {
    const rows = await run(compileCohort(parseCohortParams({ asOf: '2024-07-01', granularity: 'week', periods: 30 })));
    // c2 首单在 55 周以前；2023-12-31 是周日，所在周从 12-25 起；1-31 在 1-29 那周（第 5 周）；3-01 在 2-26 那周（第 9 周）
    expect(rows).toEqual([{ consumer_id: 'c1', cohort_start: '2023-12-25', orders: 3, active_periods: [0, 5, 9] }]);
  });
});
