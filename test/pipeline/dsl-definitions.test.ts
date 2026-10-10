// test/pipeline/dsl-definitions.test.ts —— 指标与标签定义的流水线接缝：成员新建定义（createDefinition）→ 再次保存改同一份草稿（saveDslDraft）→ getDefinition 读出各版本、
// 作者与最后保存的人，以及编译出的 SQL；键不合规或重复、YAML 校验不通过、没有起草权限时拒绝且不写入
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { dslVersions } from '../../app/.server/db/schema';
import { createDefinition, DslError, getDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n';
const REVENUE_BY_CITY = `${REVENUE}dimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n`;

describe('指标定义', () => {
  it('新建后再次保存改的是同一份草稿，记下作者与最后保存的人；定义页给出编译出的 SQL', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com', 'data_engineer');

    expect(await createDefinition(analyst, 'metric', 'revenue_30d', REVENUE)).toEqual({ kind: 'metric', key: 'revenue_30d', version: 1 });
    expect(await saveDslDraft(engineer, 'metric', 'revenue_30d', REVENUE_BY_CITY)).toBe(1);

    const d = await getDefinition(analyst, 'metric', 'revenue_30d');
    expect(d).toMatchObject({
      kind: 'metric', key: 'revenue_30d', published: null,
      draft: { version: 1, yaml: REVENUE_BY_CITY, authors: ['analyst@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com' },
      compiled: { version: 1, issues: [] },
    });
    expect(d.versions).toHaveLength(1);
    expect(d.compiled.sql).toContain('silver._identities');
    expect(d.compiled.sql).toMatch(/LEFT JOIN silver\."customer"/);
    expect(d.compiled.sql).toContain('未关联');
  });

  it('键不合规或在租户内重复时拒绝；别的租户可以用同样的键', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await expect(createDefinition(analyst, 'metric', 'Revenue', REVENUE)).rejects.toThrow(/小写字母开头/);
    await expect(createDefinition(analyst, 'metric', '1st', REVENUE)).rejects.toBeInstanceOf(DslError);
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(createDefinition(analyst, 'metric', 'revenue', REVENUE)).rejects.toThrow(/已经有键为 revenue/);
    await expect(createDefinition(analyst, 'nope', 'revenue', REVENUE)).rejects.toMatchObject({ status: 404 });
    await expect(saveDslDraft(analyst, 'metric', 'missing', REVENUE)).rejects.toMatchObject({ status: 404 });

    const globex = await newTenant('globex');
    await createDefinition(await memberOf(globex, 'analyst@globex.com', 'analyst'), 'metric', 'revenue', REVENUE);
  });

  it('YAML 校验不通过时报出按行列的问题，不写入；未发布的自定义实体不能用', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const bad = createDefinition(analyst, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: channel }\n');
    await expect(bad).rejects.toMatchObject({ status: 400, issues: [{ line: 2, message: expect.stringMatching(/整数或小数/) }] });
    await expect(createDefinition(analyst, 'metric', 'stores', 'base: custom_store\nmeasure: { agg: count }\n'))
      .rejects.toMatchObject({ issues: [{ line: 1, message: expect.stringMatching(/custom_store.*发布/) }] });

    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(saveDslDraft(analyst, 'metric', 'revenue', 'base: order\n')).rejects.toMatchObject({ issues: [{ message: expect.stringMatching(/缺少 measure/) }] });
    expect((await getDefinition(analyst, 'metric', 'revenue')).draft).toMatchObject({ yaml: REVENUE });
    expect(await getDb().select().from(dslVersions)).toHaveLength(1);
  });

  it('没有起草权限的成员不能新建或保存，但可以查看', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(createDefinition(viewer, 'metric', 'revenue', REVENUE)).rejects.toMatchObject({ init: { status: 403 } });
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(saveDslDraft(viewer, 'metric', 'revenue', REVENUE_BY_CITY)).rejects.toMatchObject({ init: { status: 403 } });
    expect((await getDefinition(viewer, 'metric', 'revenue')).draft).toMatchObject({ yaml: REVENUE, authors: ['analyst@acme.com'] });
  });
});
