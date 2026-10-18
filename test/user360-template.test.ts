// test/user360-template.test.ts —— 用户 360 模板：参数校验与默认值、编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileUser360, parseUser360Definition, parseUser360Params, USER360_DEFAULTS } from '../app/.server/pipeline/templates/user360';
import { TASK_KINDS, TEMPLATES, templateOfKind } from '../app/.server/pipeline/templates';
import { CHANNELS } from '../app/lib/canonical-model';

let instance: DuckDBInstance;
let con: DuckDBConnection;

// 两个数据源 s1、s2；c1 在两个源里各有一个 customer_id。窗口外、状态不计入、晚于 as_of 的订单各一笔，s2:x 打通不到消费者；
// c3 没有订单；同意：c1 短信同意、邮件撤回，c2 只有 push 同意，c3 没有记录
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  con = await instance.connect();
  await con.run(`SET TimeZone = 'UTC';
    CREATE SCHEMA silver;
    CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
    INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3');
    CREATE TABLE silver._consumer (consumer_id VARCHAR, name VARCHAR, name__source VARCHAR);
    INSERT INTO silver._consumer VALUES ('c1', '张三', 's1'), ('c2', '李四', 's1'), ('c3', '王五', 's1');
    CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, _source VARCHAR, _customer_source VARCHAR);
    INSERT INTO silver."order" VALUES
      ('o1', '1', 'paid', 100, '2024-06-29 10:00:00+00', '2024-06-30 10:00:00+00', 's1', 's1'),
      ('o2', '10', 'completed', 200, '2024-03-01 10:00:00+00', NULL, 's2', 's2'),
      ('o3', '1', 'refunded', 900, '2024-06-20 10:00:00+00', '2024-06-20 10:00:00+00', 's1', 's1'),
      ('o4', '1', 'paid', 800, '2023-06-01 10:00:00+00', '2023-06-01 10:00:00+00', 's1', 's1'),
      ('o5', '2', 'shipped', 50, '2024-05-01 10:00:00+00', '2024-05-01 23:30:00+00', 's1', 's1'),
      ('o6', '2', 'paid', 700, '2024-07-02 10:00:00+00', '2024-07-02 10:00:00+00', 's1', 's1'),
      ('o7', 'x', 'paid', 999, '2024-06-15 10:00:00+00', '2024-06-15 10:00:00+00', 's2', 's2');
    CREATE TABLE silver._consumer_consent (consumer_id VARCHAR, channel VARCHAR, status VARCHAR, updated_at TIMESTAMPTZ, _source VARCHAR);
    INSERT INTO silver._consumer_consent VALUES
      ('c1', 'sms', 'granted', '2024-06-01', 's1'), ('c1', 'email', 'revoked', '2024-06-01', 's1'), ('c2', 'push', 'granted', '2024-06-01', 's1');`);
});

afterAll(() => {
  con?.closeSync();
  instance?.closeSync();
});

const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();
const consents = (granted: string[]) => Object.fromEntries(CHANNELS.map(ch => [`consent_${ch}`, granted.includes(ch)]));

describe('用户 360 模板：参数', () => {
  it('只给 asOf 时取默认参数；注册表登记了 user360 模板与任务类型，带通用表单', () => {
    expect(parseUser360Params({ asOf: '2024-07-01' })).toEqual({ asOf: '2024-07-01', ...USER360_DEFAULTS, statuses: ['completed', 'paid', 'shipped'] });
    expect(parseUser360Definition({ lookbackDays: 30 })).toEqual({ lookbackDays: 30, statuses: ['completed', 'paid', 'shipped'] });
    expect(TEMPLATES.user360.parse).toBe(parseUser360Params);
    expect(TASK_KINDS.user360).toBe('gold.user360');
    expect(templateOfKind('gold.user360')).toBe('user360');
    expect(templateOfKind('gold.rfm')).toBe('rfm');
    expect(templateOfKind('gold.dsl')).toBeUndefined();
    expect(TEMPLATES.user360.form.map(f => f.key)).toEqual(['lookbackDays', 'statuses']);
  });

  it('模板 ID 以小写字母开头、只含小写字母与数字，任务类型都是 gold.<模板 ID>（快照表名要匹配 [a-z][a-z0-9]*__）', () => {
    for (const id of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
      expect(id).toMatch(/^[a-z][a-z0-9]*$/);
      expect(TASK_KINDS[id]).toBe(`gold.${id}`);
    }
  });

  it.each([
    [{}, /asOf/],
    [{ asOf: '2024-02-30' }, /asOf/],
    [{ asOf: '2024-07-01', lookbackDays: 3651 }, /lookbackDays/],
    [{ asOf: '2024-07-01', statuses: [] }, /statuses/],
    [{ asOf: '2024-07-01', binning: { method: 'quintile' } }, /binning/],
  ])('不合法的参数 %j 报出原因', (params, message) => {
    expect(() => parseUser360Params(params)).toThrow(message);
  });

  it('asOf 不属于定义', () => {
    expect(() => parseUser360Definition({ asOf: '2024-07-01' })).toThrow(/asOf/);
  });

  it('同样的参数编译出同样的 SQL，不依赖当前时间', () => {
    const sql = compileUser360(parseUser360Params({ asOf: '2024-07-01' }), { consent: true });
    expect(compileUser360(parseUser360Params({ asOf: '2024-07-01' }), { consent: true })).toBe(sql);
    expect(sql).not.toMatch(/now\(\)|current_date|current_timestamp/i);
  });
});

describe('用户 360 模板：编译出的 SQL', () => {
  it('多源订单合到同一消费者，只计窗口内、状态计入、as_of 之前的订单；没下过单的也在；同意按渠道展开；不带属性列', async () => {
    const rows = await run(compileUser360(parseUser360Params({ asOf: '2024-07-01' }), { consent: true }));
    expect(rows).toEqual([
      // o1 6-30 ¥100 + o2 3-01 ¥200（没有支付时间，按下单时间）；o3 已退款、o4 窗口外
      { consumer_id: 'c1', orders: 2, monetary: '300.00', avg_order_value: 150, first_order_date: '2024-03-01', last_order_date: '2024-06-30',
        recency_days: 1, tenure_days: 122, ...consents(['sms']) },
      // o5 支付于 5-01 23:30 UTC；o6 晚于 as_of
      { consumer_id: 'c2', orders: 1, monetary: '50.00', avg_order_value: 50, first_order_date: '2024-05-01', last_order_date: '2024-05-01',
        recency_days: 61, tenure_days: 61, ...consents(['push']) },
      { consumer_id: 'c3', orders: 0, monetary: '0.00', avg_order_value: null, first_order_date: null, last_order_date: null,
        recency_days: null, tenure_days: null, ...consents([]) },
    ]);
  });

  it('没有 _consumer_consent 时同意列全为 false', async () => {
    const sql = compileUser360(parseUser360Params({ asOf: '2024-07-01' }), { consent: false });
    expect(sql).not.toContain('_consumer_consent');
    const rows = await run(sql);
    expect(rows.map(r => Object.entries(r).filter(([k]) => k.startsWith('consent_')).every(([, v]) => v === false))).toEqual([true, true, true]);
  });

  it('回看天数与状态参数生效：只看近 30 天的 paid 订单', async () => {
    const rows = await run(compileUser360(parseUser360Params({ asOf: '2024-07-01', lookbackDays: 30, statuses: ['paid'] }), { consent: true }));
    expect(rows.map(({ consumer_id, orders, monetary }) => ({ consumer_id, orders, monetary }))).toEqual([
      { consumer_id: 'c1', orders: 1, monetary: '100.00' },
      { consumer_id: 'c2', orders: 0, monetary: '0.00' },
      { consumer_id: 'c3', orders: 0, monetary: '0.00' },
    ]);
  });
});
