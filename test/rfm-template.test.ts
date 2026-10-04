// RFM 模板：参数校验与默认值、编译出的 SQL 在内存 DuckDB 里对手算的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileRfm, compileRfmUnlinked, parseRfmParams, RFM_DEFAULTS } from '../app/.server/pipeline/templates/rfm';
import { TEMPLATES } from '../app/.server/pipeline/templates';

let instance: DuckDBInstance;
let con: DuckDBConnection;

// 两个数据源 s1、s2；c4 在两个源里各有一个 customer_id。窗口外、状态不计入、晚于 as_of 的订单各一笔，s2:x 打通不到消费者；
// c6、c7 各有一笔完全相同的已取消订单（默认不计入），用来看并列
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  con = await instance.connect();
  await con.run(`SET TimeZone = 'UTC';
    CREATE SCHEMA silver;
    CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
    INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s1','2','c2'), ('s1','3','c3'), ('s1','4','c4'), ('s2','40','c4'), ('s1','5','c5'), ('s1','6','c6'), ('s1','7','c7');
    CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, _source VARCHAR);
    INSERT INTO silver."order" VALUES
      ('o1', '1', 'paid', 500, '2024-06-29 10:00:00+00', '2024-06-30 10:00:00+00', 's1'),
      ('o2', '1', 'refunded', 900, '2024-06-20 10:00:00+00', '2024-06-20 10:00:00+00', 's1'),
      ('o3', '2', 'paid', 100, '2024-04-01 10:00:00+00', '2024-04-01 10:00:00+00', 's1'),
      ('o4', '2', 'shipped', 100, '2024-05-01 10:00:00+00', '2024-05-01 10:00:00+00', 's1'),
      ('o5', '2', 'completed', 100, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00', 's1'),
      ('o6', '2', 'paid', 700, '2024-07-02 10:00:00+00', '2024-07-02 10:00:00+00', 's1'),
      ('o7', '3', 'paid', 40, '2024-01-01 10:00:00+00', '2024-01-01 10:00:00+00', 's1'),
      ('o8', '3', 'paid', 60, '2024-03-01 10:00:00+00', '2024-03-01 10:00:00+00', 's1'),
      ('o9', '3', 'paid', 800, '2023-06-01 10:00:00+00', '2023-06-01 10:00:00+00', 's1'),
      ('o10', '4', 'paid', 250, '2024-05-01 10:00:00+00', '2024-05-01 10:00:00+00', 's1'),
      ('o11', '4', 'paid', 250, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00', 's1'),
      ('o12', '40', 'paid', 250, '2024-06-10 10:00:00+00', '2024-06-10 10:00:00+00', 's2'),
      ('o13', '40', 'paid', 250, '2024-06-25 10:00:00+00', '2024-06-25 23:30:00+00', 's2'),
      ('o14', '5', 'completed', 50, '2023-12-01 10:00:00+00', NULL, 's1'),
      ('o15', 'x', 'paid', 999, '2024-06-15 10:00:00+00', '2024-06-15 10:00:00+00', 's2'),
      ('o16', '7', 'cancelled', 80, '2024-06-05 10:00:00+00', NULL, 's1'),
      ('o17', '6', 'cancelled', 80, '2024-06-05 10:00:00+00', NULL, 's1');`);
});

afterAll(() => {
  con?.closeSync();
  instance?.closeSync();
});

const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();
const rfm = async (params: Record<string, unknown>) => (await run(compileRfm(parseRfmParams(params))))
  .map(r => ({ ...r, monetary: Number(r.monetary) }) as Record<string, unknown>);

describe('RFM 模板：参数', () => {
  it('只给 asOf 时取默认参数；注册表登记了 rfm 模板', () => {
    expect(parseRfmParams({ asOf: '2024-07-01' })).toEqual({ asOf: '2024-07-01', ...RFM_DEFAULTS, statuses: ['completed', 'paid', 'shipped'] });
    expect(TEMPLATES.rfm.parse).toBe(parseRfmParams);
    expect(TEMPLATES.rfm.compile).toBe(compileRfm);
  });

  it.each([
    [{}, /asOf/],
    [{ asOf: '2024-02-30' }, /asOf/],
    [{ asOf: '2024-07-01', lookbackDays: 0 }, /lookbackDays/],
    [{ asOf: '2024-07-01', statuses: ['paid', 'lost'] }, /statuses/],
    [{ asOf: '2024-07-01', binning: { method: 'deciles' } }, /binning\.method/],
    [{ asOf: '2024-07-01', binning: { method: 'thresholds', recency: [30, 7, 90, 180], frequency: [1, 2, 3, 4], monetary: [1, 2, 3, 4] } }, /binning\.recency/],
    [{ asOf: '2024-07-01', segments: [{ name: '高', r: { min: 4 } }] }, /最后一条/],
    [{ asOf: '2024-07-01', segments: [{ name: '高', r: { min: 6 } }, { name: '其他' }] }, /第 1 条/],
    [{ asOf: '2024-07-01', segments: [{ name: '其他' }, { name: '其他' }] }, /重复/],
    [{ asOf: '2024-07-01', since: '2024-01-01' }, /since/],
  ])('不合法的参数 %j 报出原因', (params, message) => {
    expect(() => parseRfmParams(params)).toThrow(message);
  });

  it('同样的参数编译出同样的 SQL，不依赖当前时间', () => {
    const sql = compileRfm(parseRfmParams({ asOf: '2024-07-01' }));
    expect(compileRfm(parseRfmParams({ asOf: '2024-07-01' }))).toBe(sql);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
  });
});

describe('RFM 模板：编译出的 SQL', () => {
  it('五分位：多源订单合到同一消费者，只计窗口内、状态计入、as_of 之前的订单，按 8 类人群归入', async () => {
    expect(await rfm({ asOf: '2024-07-01' })).toEqual([
      { consumer_id: 'c1', recency_days: 1, frequency: 1, monetary: 500, r: 5, f: 2, m: 4, segment: '重要发展' },
      { consumer_id: 'c2', recency_days: 30, frequency: 3, monetary: 300, r: 3, f: 4, m: 3, segment: '一般挽留' },
      { consumer_id: 'c3', recency_days: 122, frequency: 2, monetary: 100, r: 2, f: 3, m: 2, segment: '一般保持' },
      { consumer_id: 'c4', recency_days: 6, frequency: 4, monetary: 1000, r: 4, f: 5, m: 5, segment: '重要价值' },
      { consumer_id: 'c5', recency_days: 213, frequency: 1, monetary: 50, r: 1, f: 1, m: 1, segment: '一般挽留' },
    ]);
  });

  it('打通不到消费者的订单不进结果，单独计数', async () => {
    expect(await run(compileRfmUnlinked(parseRfmParams({ asOf: '2024-07-01' })))).toEqual([{ n: '1' }]);
  });

  it('按阈值分箱与自定义分群规则', async () => {
    const rows = await rfm({
      asOf: '2024-07-01',
      binning: { method: 'thresholds', recency: [7, 30, 90, 180], frequency: [2, 3, 4, 5], monetary: [100, 200, 500, 1000] },
      segments: [{ name: '高价值', m: { min: 4 } }, { name: '近期', r: { min: 4, max: 5 } }, { name: '其他' }],
    });
    expect(rows.map(({ consumer_id, r, f, m, segment }) => ({ consumer_id, r, f, m, segment }))).toEqual([
      { consumer_id: 'c1', r: 5, f: 1, m: 4, segment: '高价值' },
      { consumer_id: 'c2', r: 4, f: 3, m: 3, segment: '近期' },
      { consumer_id: 'c3', r: 2, f: 2, m: 2, segment: '其他' },
      { consumer_id: 'c4', r: 5, f: 4, m: 5, segment: '高价值' },
      { consumer_id: 'c5', r: 1, f: 1, m: 1, segment: '其他' },
    ]);
  });

  it('五分位时并列的消费者按 consumer_id 排序打分', async () => {
    const rows = await rfm({ asOf: '2024-07-01', statuses: ['cancelled'] });
    expect(rows).toEqual([
      { consumer_id: 'c6', recency_days: 26, frequency: 1, monetary: 80, r: 5, f: 1, m: 1, segment: '新客/潜力' },
      { consumer_id: 'c7', recency_days: 26, frequency: 1, monetary: 80, r: 4, f: 2, m: 2, segment: '新客/潜力' },
    ]);
  });
});
