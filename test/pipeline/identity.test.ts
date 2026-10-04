// 身份打通的流水线接缝：CRM、会员、埋点三个数据源同步进原始层 → 发布映射 → 调度器派发合并（合并后整表重算打通）→
// silver._identities 里每条 (_source, customer_id) 对应一个统一消费者，silver._device_owner 里每台登录过的设备归属到
// 最近一次登录的统一消费者，任务结果带打通摘要，表里没有明文
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { mergeNow } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, silver } from './fixtures';
import { seedIdentitySources } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const CRM = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(id)
  name: name
  phone: mobile
  email: email
  external_id: unionid
`;

const LOYALTY = `model: 1
entity: customer
table: members
fields:
  customer_id: string(member_id)
  name: full_name
  phone: phone
  email: mail
  external_id: unionid
`;

const TRACKING_USERS = `model: 1
entity: customer
table: users
fields:
  customer_id: user_id
  phone: phone
  email: email
`;

const TRACKING_EVENTS = `model: 1
entity: event
table: events
fields:
  event_id: event_id
  customer_id: user_id
  device_id: device_id
  event_type: event_type
  occurred_at: from_timezone(ts, 'UTC')
`;

/** 种子里的明文：手机号（规范化前后）、邮箱、外部 ID 与姓名 */
const SEEDED = ['13800000001', '138 0000', '138-0000', '13800000002', '13900000005', '139 0000', 'zhang@crm', 'wang5@example', 'qian7@example',
  'li4@loyalty', 'wx_union_8', '13700000009', '张三', '李四', '王五', '钱七', '孙八'];

type Identity = { _source: string; customer_id: string; consumer_id: string };
type DeviceOwner = { device_id: string; consumer_id: string; login_at: string };

/** silver._identities 的全部行（按数据源与 customer_id 排序）与整表的 JSON 文本，以及 silver._device_owner 的全部行（按设备排序） */
async function identities(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const rows = await read<Identity>('SELECT * FROM silver._identities ORDER BY _source, customer_id');
    const devices = await read<DeviceOwner>(`SELECT * REPLACE (strftime(login_at AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M') AS login_at)
      FROM silver._device_owner ORDER BY device_id`);
    return { rows, text: JSON.stringify(rows), devices };
  } finally {
    session.close();
  }
}

/** 匿名事件（customer_id 为空）经设备归属到的统一消费者；设备没有归属时为 null */
async function anonymousEvents(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(`SELECT e.event_id, o.consumer_id FROM silver."event" e
      LEFT JOIN silver._device_owner o USING (device_id) WHERE e.customer_id IS NULL ORDER BY e.event_id`)).getRowObjectsJson();
  } finally {
    session.close();
  }
}

/** 按统一消费者分组，每组是「数据源名:customer_id」的列表；组按第一条排序，便于整体比较 */
const groupsOf = (rows: Identity[], names: Record<string, string>) => {
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.consumer_id, [...(groups.get(r.consumer_id) ?? []), `${names[r._source]}:${r.customer_id}`]);
  return [...groups.values()].map(g => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
};

async function published() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { crm, loyalty, tracking } = await seedIdentitySources(author);
  await publish(author, reviewer, crm, CRM);
  await publish(author, reviewer, loyalty, LOYALTY);
  await publish(author, reviewer, tracking, TRACKING_USERS);
  await publish(author, reviewer, tracking, TRACKING_EVENTS);
  return { acme, author, names: { [crm]: 'crm', [loyalty]: 'loyalty', [tracking]: 'tracking' } };
}

describe('身份打通：多源消费者确定性合并', () => {
  it('手机号写法不同、只有邮箱相同、外部 ID 相同、手机-邮箱链上的记录合并为同一个消费者；空手机与空邮箱不合并', async () => {
    const { acme, names } = await published();
    const { rows, text } = await identities(acme);
    expect(groupsOf(rows, names)).toEqual([
      ['crm:1', 'loyalty:1', 'tracking:u1'],
      ['crm:2', 'loyalty:2', 'tracking:u2'],
      ['crm:3', 'loyalty:3'],
      ['crm:4'],
      ['crm:5', 'crm:6', 'loyalty:5'],
      ['crm:7', 'loyalty:6'],
      ['loyalty:4'],
      ['tracking:u9'],
    ]);

    // 统一消费者 ID 不是任何敏感字段的哈希；表里没有明文
    const hashes = (await silver(acme, 'customer', '_source, customer_id')).flatMap(r => [r.name, r.phone, r.email, r.external_id]);
    expect(rows.filter(r => hashes.includes(r.consumer_id))).toEqual([]);
    expect(SEEDED.filter(s => text.toLowerCase().includes(s.toLowerCase()))).toEqual([]);

    // 最后一次合并的任务结果带打通摘要
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('succeeded');
    expect((merge.result as { identities: unknown }).identities).toMatchObject({ groups: 8, records: 16, devices: 2 });
  });

  it('登录过的设备归属到最近一次登录的统一消费者，同一时刻登录并列时取较小的 consumer_id；匿名事件经设备归属', async () => {
    const { acme, names } = await published();
    const { rows, devices } = await identities(acme);
    const consumerOf = (who: string) => rows.find(r => `${names[r._source]}:${r.customer_id}` === who)!.consumer_id;
    const [u1, u2, u9] = ['tracking:u1', 'tracking:u2', 'tracking:u9'].map(consumerOf);
    // u1 与 crm 1 是同一个人：设备归属到统一消费者，不是埋点源里的用户
    expect(u1).toBe(consumerOf('crm:1'));

    // d1 先被 u1 登录、后被 u2 登录；d2 同一时刻被 u9、u1 登录；d3 只有匿名事件、d4 没有 login，都不归属
    expect(devices).toEqual([
      { device_id: 'd1', consumer_id: u2, login_at: '2024-06-02 10:00' },
      { device_id: 'd2', consumer_id: [u1, u9].sort()[0], login_at: '2024-06-03 09:00' },
    ]);
    expect(await anonymousEvents(acme)).toEqual([
      { event_id: 'e2', consumer_id: u2 },
      { event_id: 'e4', consumer_id: u2 },
      { event_id: 'e7', consumer_id: [u1, u9].sort()[0] },
      { event_id: 'e8', consumer_id: null },
    ]);
  });

  it('同样的输入再合并一次，打通表与设备归属表的内容完全一致', async () => {
    const { acme, author } = await published();
    const before = await identities(acme);
    await mergeNow(author);
    await drain();
    const after = await identities(acme);
    expect(after.rows).toEqual(before.rows);
    expect(after.devices).toEqual(before.devices);
  });
});
