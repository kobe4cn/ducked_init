// test/http/dsl-definitions.test.ts —— 指标定义的 HTTP 接缝：分析师在新建页填写键与 YAML 保存草稿 → 跳到定义页看到编译出的 SQL 与版本；在定义页再次保存改同一份草稿；
// 校验不通过时按行列列出问题；分析页「新建标签」进到标签种类的新建页；查看者看不到「新建指标」、打不开新建页、提交 403；分析页里 metric: 快照链接到定义页；
// 定义页点「预览」展示前 50 行与总行数（查看者也能预览），标准层缺表时给出说明，不存在的定义 404；有草稿且已发布过时点「预览影响」展示指标与下游标签的变化人数；
// 版本表里发布不了的成员看到原因，另一位数据工程师发布后入队 gold.dsl；丢弃草稿回到已发布版本，从没发布过时回到分析页；
// 数据工程师看到「删除」按钮（分析师看不到、提交 403），被已发布标签引用的指标删不了，删除后回到分析页；
// 有早于生效版本的快照时数据工程师点「回刷」入队按旧统计日的计算，分析师在按钮处看到原因、提交 403；
// 数据工程师点「重新计算」按生效版本以今天入队（连同下游标签，来源 manual），定义页显示最近一次刷新的时间与来源，分析页快照列表显示来源；
// 新建页写需求「用模型生成草稿」填进编辑框、不保存，不过校验时 422 保持原内容，未配置模型服务时 400，查看者 403；标签同样能生成，没有可引用的已发布指标时 400；
// 指标新建页默认是条件构建器（?mode=builder|yaml）：「检查」只编译给出摘要与编译出的 SQL、不保存（YAML 模式也能检查），
// 不合法按行列 400（行列号指向生成的 YAML，一并显示；fieldsFor 里没有的字段服务端兜底拦下），保存得到与手写 YAML 一样的草稿；
// 词表外的聚合也回显进构建器（下拉多一个当前值选项、标出「不支持」）；时间窗口天数 0 / 负数按 window.days 400（客户端不再静默丢掉窗口）；
// 构建器模式还有一句话解析（intent=parse，#517）：解析结果填进构建器（隐藏字段 form 回显）并逐项说明、未知项与不支持的说法（固定原因说明）、
// 构建器装不下的维度名显式提示；已有内容时先列差异（intent=applyParse 确认后才覆盖、parsed 不信客户端），失败（422 / 409）表单保持原内容
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { dslVersions, snapshots, tasks } from '../../app/.server/db/schema';
import { createDefinition, getDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { todayUtc } from '../../app/.server/templates';
import { entityOf } from '../../app/lib/canonical-model';
import { formToYaml, type MetricForm } from '../../app/lib/metric-form';
import { formToYaml as tagFormToYaml, type TagForm } from '../../app/lib/tag-form';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { fakeLlm, json, platformDefault } from '../pipeline/llm-fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n';

describe('指标与标签定义页', () => {
  it('分析师新建指标、再次保存改同一份草稿，定义页展示编译出的 SQL；校验不通过时按行列列出问题', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');

    expect(await (await analyst.get('/analytics')).text()).toContain('href="/analytics/definitions/new?kind=metric"');
    expect((await analyst.get('/analytics/definitions/new')).status).toBe(200);

    const bad = await analyst.post('/analytics/definitions/new', { key: 'revenue', yaml: 'base: order\nmeasure: { agg: sum, field: channel }\n' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/data-issue-line="2"[^>]*>第 2 行第 \d+ 列（measure\.field）：sum 只能用整数或小数字段/);
    expect((await analyst.post('/analytics/definitions/new', { key: 'Revenue', yaml: REVENUE })).status).toBe(400);

    const created = await analyst.post('/analytics/definitions/new', { key: 'revenue', yaml: REVENUE });
    expect(created.status).toBe(302);
    expect(created.headers.get('location')).toBe('/analytics/definitions/metric/revenue');
    const duplicate = await analyst.post('/analytics/definitions/new', { key: 'revenue', yaml: REVENUE });
    expect(await duplicate.text()).toContain('已经有键为 revenue 的指标');

    const page = await (await analyst.get('/analytics/definitions/metric/revenue')).text();
    expect(page).toMatch(/data-compiled-sql[^>]*>[^<]*未关联[^<]*silver\._identities[^<]*LEFT JOIN silver\.&quot;customer&quot;/);
    expect(page).toContain('analyst@acme.com');

    const engineer = await loginAs(app, 'de@acme.com');
    const saved = await engineer.post('/analytics/definitions/metric/revenue', { intent: 'save', yaml: REVENUE.replace('sum', 'avg') });
    expect(saved.headers.get('location')).toBe('/analytics/definitions/metric/revenue?saved=1');
    const after = await (await engineer.get('/analytics/definitions/metric/revenue?saved=1')).text();
    expect(after).toContain('第 1 版草稿已保存');
    expect(after).toContain('analyst@acme.com、de@acme.com');
    expect(after).toContain('AVG(b.&quot;amount&quot;)');
    expect(after.match(/data-version="/g)).toHaveLength(1);

    expect((await engineer.get('/analytics/definitions/metric/missing')).status).toBe(404);
    expect((await engineer.get('/analytics/definitions/nope/revenue')).status).toBe(404);
  });

  it('新建页的条件构建器：检查给出三 / 四句摘要（ratio 四句）与编译出的 SQL、不保存；不合法按行列返回 400；保存得到与手写 YAML 一样的草稿', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    // 指标默认进构建器：有模式切换、实体下拉、「添加一行」与隐藏字段 form
    const page = await (await analyst.get('/analytics/definitions/new?kind=metric')).text();
    expect(page).toContain('data-tab="builder"');
    expect(page).toContain('订单（order）');
    expect(page).toContain('添加一行');
    expect(page).toContain('name="form"');

    // 字段列表只来自 fieldsFor：customer 能选作基础实体、它的普通字段随页面下发，敏感字段一个都不出现
    expect(page).toContain('消费者（customer）');
    expect(page).toContain('生日');
    for (const f of entityOf('customer')!.fields.filter(f => f.pii)) expect(page).not.toContain(`${f.label}（${f.name}）`);
    expect(page).not.toContain('手机号');
    expect(page).not.toContain('邮箱');

    const form: MetricForm = { base: 'order', agg: 'sum', field: 'amount', filter: [{ field: 'status', op: 'eq', value: 'paid' }], window: { field: 'paid_at', days: 30 }, dimensions: [], readonly: [] };
    const post = (body: Record<string, string>) => analyst.post('/analytics/definitions/new', { kind: 'metric', key: 'paid_amount_30d', form: JSON.stringify(form), ...body });

    // 检查：三句摘要（非 ratio）与编译出的 SQL，只编译不保存
    const check = await post({ intent: 'check' });
    expect(check.status).toBe(200);
    const checked = await check.text();
    expect(checked).toContain('data-summary');
    expect(checked).toContain('<li>计算实付金额求和。</li>');
    expect(checked).toContain('<li>只算 订单状态 等于 paid 的记录。</li>');
    expect(checked).toContain('<li>近 30 天，按支付时间。</li>');
    expect(checked).toMatch(/data-compiled-sql[^>]*>[^<]*SUM\(b\.\D*quot;amount/);
    expect(checked).toContain('data-generated-yaml');
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    // ratio：分子、分母各带一条过滤，四句摘要（第二句写各自的过滤范围）
    const ratio: MetricForm = {
      base: 'order', agg: 'ratio',
      numerator: { agg: 'count', filter: [{ field: 'status', op: 'eq', value: 'refunded' }] },
      denominator: { agg: 'count', filter: [{ field: 'status', op: 'in', value: ['paid', 'refunded'] }] },
      filter: [], dimensions: [], readonly: [],
    };
    const ratioCheck = await post({ intent: 'check', form: JSON.stringify(ratio) });
    expect(ratioCheck.status).toBe(200);
    const ratioSummary = (await ratioCheck.text()).match(/<ul data-summary[^>]*>([\s\S]*?)<\/ul>/)![1];
    expect(ratioSummary.match(/<li>/g)).toHaveLength(4);
    expect(ratioSummary).toContain('refunded');

    // sum 用了文本字段：400 与按行列的问题（行列号指向生成的 YAML），同时把它显示出来
    const bad = await post({ intent: 'check', form: JSON.stringify({ ...form, field: 'channel' }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/data-issue-line="4"[^>]*>第 4 行第 \d+ 列（measure\.field）：sum 只能用整数或小数字段/);

    // fieldsFor 里没有的字段：服务端兜底拦下
    expect((await post({ intent: 'check', form: JSON.stringify({ ...form, field: 'not_a_field' }) })).status).toBe(400);
    // 敏感字段不在 fieldsFor 里，手工提交也被拦下
    expect((await post({ intent: 'check', form: JSON.stringify({ base: 'customer', agg: 'count_distinct', field: 'phone', filter: [], dimensions: [], readonly: [] }) })).status).toBe(400);

    // 不信客户端：ratio 没有分母按读不出来的内容 400（不是 500）；缺 op 或取值是对象的条件行丢掉，其余照常检查
    expect((await post({ intent: 'check', form: JSON.stringify({ base: 'order', agg: 'ratio', numerator: { agg: 'count' } }) })).status).toBe(400);
    expect((await post({ intent: 'check', form: JSON.stringify({ ...form, filter: [{ field: 'status' }, { field: 'status', op: 'eq', value: { x: 1 } }] }) })).status).toBe(200);

    // 聚合在词表外（手工提交才有）：词表外的聚合仍进生成的 YAML、由检查按 measure.agg 报出；也回显进构建器（下拉多一个当前值的选项、标出「不支持」），整页照常 400 而不是 500
    const badAgg = await post({ intent: 'check', form: JSON.stringify({ ...form, agg: 'median' }) });
    expect(badAgg.status).toBe(400);
    const badAggPage = await badAgg.text();
    expect(badAggPage).toMatch(/第 \d+ 行第 \d+ 列（measure\.agg）：应为以下之一：/);
    expect(badAggPage).toContain('data-metric-builder');
    expect(badAggPage).toMatch(/<option[^>]*value="median"[^>]*>median（不支持，请改选）</);
    // 字段下拉不按类型过滤：列出全部字段、当前字段 amount 仍选中，与生成的 YAML（field: amount）一致
    const fieldSelect = badAggPage.match(/id="builder-field"[\s\S]*?<\/select>/)![0];
    expect(fieldSelect).toMatch(/<option[^>]*value="amount"[^>]*selected/);
    expect(badAggPage).not.toContain('出错了');
    // ratio 分子的聚合在词表外也一样：measure.numerator.agg 按行列报出，回显进构建器，不落库；分子字段下拉同样不按类型过滤
    const badPart = await post({ intent: 'check', form: JSON.stringify({ ...ratio, numerator: { agg: 'median', field: 'amount', filter: [] } }) });
    expect(badPart.status).toBe(400);
    const badPartPage = await badPart.text();
    expect(badPartPage).toMatch(/（measure\.numerator\.agg）：应为以下之一：/);
    expect(badPartPage).toMatch(/<option[^>]*value="median"[^>]*>median（不支持，请改选）</);
    const numeratorPart = badPartPage.match(/data-ratio-part="numerator"[\s\S]*?data-ratio-part="denominator"/)![0];
    expect(numeratorPart).toMatch(/<option[^>]*value="amount"[^>]*selected/);
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    // 天数 0 / 负数：客户端不再静默丢掉时间窗口（与直接 POST 同样的值一致），检查与保存都按 window.days 400、不落库
    for (const days of [0, -1]) {
      for (const intent of ['check', 'save'] as const) {
        const badDays = await post({ intent, form: JSON.stringify({ ...form, window: { field: 'paid_at', days } }) });
        expect(badDays.status).toBe(400);
        expect(await badDays.text()).toMatch(/（window\.days）：应不小于 1/);
      }
    }
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    // YAML 模式也能只检查不保存
    const yamlCheck = await analyst.post('/analytics/definitions/new', { kind: 'metric', intent: 'check', yaml: 'base: order\nmeasure: { agg: count }\n' });
    expect(yamlCheck.status).toBe(200);
    expect(await yamlCheck.text()).toContain('<li>计算行数。</li>');
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    // 保存：第 1 版草稿，YAML 与手写保存的一致（同一个 formToYaml 结果）
    const saved = await post({ intent: 'save' });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/analytics/definitions/metric/paid_amount_30d');
    const detail = await (await analyst.get('/analytics/definitions/metric/paid_amount_30d')).text();
    const fields = entityOf('order')!.fields.map(f => ({ name: f.name, type: f.type }));
    expect(detail).toContain(formToYaml(form, fields));
    expect(detail).toContain('第 1 版草稿');
    expect(detail).toContain('SUM(b.&quot;amount&quot;)');
    expect((await getDefinition(await memberOf(acme, 'analyst@acme.com', 'analyst'), 'metric', 'paid_amount_30d')).draft).toMatchObject({ version: 1, yaml: formToYaml(form, fields) });
  });

  it('新建标签页的条件构建器：可选指标只有本租户已发布的数值指标；保存得到与手写 YAML 一样的草稿；default 为空 400', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    // 可选指标只来自本租户已发布的数值指标：带维度的、只有草稿的、别的租户的都不出现
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(reviewer, 'metric', 'revenue', 1);
    await createDefinition(author, 'metric', 'order_count', 'base: order\nmeasure: { agg: count }\n');
    await publishDefinition(reviewer, 'metric', 'order_count', 1);
    await createDefinition(author, 'metric', 'revenue_by_city', 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n');
    await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
    await createDefinition(author, 'metric', 'orders_draft', 'base: order\nmeasure: { agg: count }\n'); // 只有草稿
    const globex = await newTenant('globex');
    const gAuthor = await memberOf(globex, 'de@globex.com');
    const gReviewer = await memberOf(globex, 'de2@globex.com');
    await createDefinition(gAuthor, 'metric', 'other_tenant_metric', 'base: order\nmeasure: { agg: count }\n');
    await publishDefinition(gReviewer, 'metric', 'other_tenant_metric', 1);

    // 标签默认进构建器：有模式切换、单指标 / 多指标切换与隐藏字段 form；需求框只在 YAML 模式
    const page = await (await analyst.get('/analytics/definitions/new?kind=tag')).text();
    expect(page).toContain('data-tag-builder');
    expect(page).toContain('data-tab="builder"');
    expect(page).toContain('单指标 / 多指标');
    expect(page).toContain('name="form"');
    expect(page).not.toMatch(/<textarea[^>]*name="request"/);
    expect(page).toMatch(/<option[^>]*value="revenue">/);
    expect(page).toMatch(/<option[^>]*value="order_count">/);
    for (const absent of ['revenue_by_city', 'orders_draft', 'other_tenant_metric']) expect(page).not.toContain(absent);
    const yamlMode = await (await analyst.get('/analytics/definitions/new?kind=tag&mode=yaml')).text();
    expect(yamlMode).toMatch(/<textarea[^>]*name="request"/);
    expect(yamlMode).not.toContain('data-tag-builder');

    // 保存：隐藏字段 form 规整成 YAML 后走同一套校验，第 1 版草稿与手写 YAML 的结果一致
    const form: TagForm = {
      single: false,
      rules: [{ value: 'high', combinator: 'all', items: [
        { metric: 'revenue', cmp: [{ op: 'gte', value: 1000 }] },
        { metric: 'order_count', cmp: [{ op: 'gte', value: 3 }] },
      ] }],
      missing: { order_count: 0 }, default: 'normal', readonly: [],
    };
    const post = (body: Record<string, string>) => analyst.post('/analytics/definitions/new', { kind: 'tag', ...body });
    const saved = await post({ key: 'value_tier', form: JSON.stringify(form) });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/analytics/definitions/tag/value_tier');
    const detail = await (await analyst.get('/analytics/definitions/tag/value_tier')).text();
    expect(detail).toContain('第 1 版草稿');
    expect(detail).toContain(tagFormToYaml(form));
    expect((await getDefinition(await memberOf(acme, 'analyst@acme.com', 'analyst'), 'tag', 'value_tier')).draft)
      .toMatchObject({ version: 1, yaml: tagFormToYaml(form) });

    // default 为空：生成的 YAML 过不了校验，按行列返回 400（取值不能为空），不落库
    const bad = await post({ key: 'bad_tier', form: JSON.stringify({ ...form, default: '' }) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/（default）：取值不能为空/);
    // 本租户 4 个指标定义 + 1 个标签 + globex 的 1 个指标
    expect(await getDb().select().from(dslVersions)).toHaveLength(6);
  });

  it('分析页「新建标签」进到标签种类的新建页；引用未发布的指标时按行列列出问题，种类不存在时 404', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    expect(await (await analyst.get('/analytics')).text()).toContain('href="/analytics/definitions/new?kind=tag"');
    const page = await (await analyst.get('/analytics/definitions/new?kind=tag')).text();
    expect(page).toContain('新建标签');
    expect(page).toContain('name="kind" value="tag"');
    expect((await analyst.get('/analytics/definitions/new?kind=nope')).status).toBe(404);

    const bad = await analyst.post('/analytics/definitions/new', { kind: 'tag', key: 'value_tier', yaml: 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/data-issue-line="1"[^>]*>第 1 行第 9 列（metric）：没有已发布的指标 revenue/);
  });

  it('查看者看不到「新建指标」、打不开新建页、不能保存，但能查看定义；其他租户 404', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    await (await loginAs(app, 'analyst@acme.com')).post('/analytics/definitions/new', { key: 'revenue', yaml: REVENUE });

    const viewer = await loginAs(app, 'viewer@acme.com');
    expect(await (await viewer.get('/analytics')).text()).not.toContain('/analytics/definitions/new');
    expect((await viewer.get('/analytics/definitions/new')).status).toBe(403);
    expect((await viewer.post('/analytics/definitions/new', { key: 'other', yaml: REVENUE })).status).toBe(403);
    const page = await viewer.get('/analytics/definitions/metric/revenue');
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('校验并保存草稿');
    expect((await viewer.post('/analytics/definitions/metric/revenue', { intent: 'save', yaml: REVENUE })).status).toBe(403);

    const globex = await newTenant('globex');
    await memberOf(globex, 'analyst@globex.com', 'analyst');
    expect((await (await loginAs(app, 'analyst@globex.com')).get('/analytics/definitions/metric/revenue')).status).toBe(404);
  });

  it('分析页里指标快照显示键，链接到定义页而不是快照页', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind: 'gold.metric', status: 'succeeded' }).returning();
    const [snapshot] = await getDb().insert(snapshots).values({
      tenantId: acme, template: 'metric:revenue', taskId: task!.id, table: `gold.metric__${task!.id}`, params: { asOf: '2024-07-01' }, rowCount: 3,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();

    const html = await (await (await loginAs(app, 'viewer@acme.com')).get('/analytics')).text();
    expect(html).toMatch(/href="\/analytics\/definitions\/metric\/revenue"[^>]*>revenue</);
    expect(html).not.toContain(`/analytics/snapshots/${snapshot!.id}`);
  });

  it('定义页点「预览」展示结果与总行数，关联不到的维度显示「未关联」、没有明文；查看者也能预览；标准层缺表时给出说明；不存在的定义 404', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await createDefinition(await memberOf(acme, 'analyst@acme.com', 'analyst'), 'metric', 'revenue', REVENUE);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    expect(await (await viewer.get('/analytics/definitions/metric/revenue')).text()).toContain('预览第 1 版');

    // 5 个打通后的消费者有订单；CRM 的 customer 映射没有 city，全部「未关联」
    const res = await viewer.post('/analytics/definitions/metric/revenue', { intent: 'preview', version: '1' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-preview-total[^>]*>第 1 版，统计日 \d{4}-\d{2}-\d{2}：共 5 行</);
    expect(html).toContain('<th');
    expect(html.match(/>未关联</g)).toHaveLength(5);
    expect(html).not.toMatch(/zhang@crm\.test|13800000001/);

    const globex = await newTenant('globex');
    await createDefinition(await memberOf(globex, 'analyst@globex.com', 'analyst'), 'metric', 'revenue', REVENUE);
    const outsider = await loginAs(app, 'analyst@globex.com');
    const missing = await outsider.post('/analytics/definitions/metric/revenue', { intent: 'preview', version: '1' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('标准层还没有 silver.customer、silver.order：先发布 customer、order 的映射并合并');
    expect((await outsider.post('/analytics/definitions/metric/missing', { intent: 'preview' })).status).toBe(404);
  });

  it('有草稿且已发布过时定义页点「预览影响」：指标给出变化人数，下游标签按草稿不再通过校验时说明原因；标签草稿列出「原取值 → 新取值」；没有明文', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: count }\n');
    await publishDefinition(reviewer, 'metric', 'revenue', 1);
    await createDefinition(author, 'tag', 'buyer', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n');
    await publishDefinition(reviewer, 'tag', 'buyer', 1);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const metric = '/analytics/definitions/metric/revenue';
    // 没有草稿时不显示
    expect(await (await viewer.get(metric)).text()).not.toContain('预览影响');

    // 加了维度：5 个有订单的消费者行都变了；标签引用不了带维度的指标
    await saveDslDraft(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n');
    expect(await (await viewer.get(metric)).text()).toContain('预览影响');
    const res = await viewer.post(metric, { intent: 'impact' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-impact-metric[^>]*>指标 revenue：取值变化 5 人，新增 0 人，移出 0 人</);
    expect(html).toMatch(/data-impact-tag="buyer".*?带维度/s);
    expect(html).not.toMatch(/zhang@crm\.test|13800000001/);

    // 标签草稿换了取值的名字：有订单的 5 个消费者从 high 换成 vip
    await saveDslDraft(author, 'tag', 'buyer', 'metric: revenue\nrules:\n  - { value: vip, when: { gte: 1 } }\ndefault: low\n');
    const tag = await (await viewer.post('/analytics/definitions/tag/buyer', { intent: 'impact' })).text();
    expect(tag).toMatch(/data-impact-tag="buyer".*?high → vip：5 人/s);
    expect((await viewer.post('/analytics/definitions/metric/missing', { intent: 'impact' })).status).toBe(404);
  });

  it('发布不了的成员在版本表里看到原因；另一位数据工程师发布后入队 gold.dsl；丢弃草稿回到已发布版本，从没发布过时删除定义回到分析页', async () => {
    const acme = await newTenant('acme');
    const analystMember = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    await memberOf(acme, 'de2@acme.com', 'data_engineer');
    await createDefinition(analystMember, 'metric', 'revenue', REVENUE);
    const path = '/analytics/definitions/metric/revenue';

    const analyst = await loginAs(app, 'analyst@acme.com');
    expect(await (await analyst.get(path)).text()).toMatch(/data-publish-blocker[^>]*>.*?仅管理员、数据工程师可以发布映射与定义/s);
    expect((await analyst.post(path, { intent: 'publish', version: '1' })).status).toBe(403);

    const engineer = await loginAs(app, 'de@acme.com');
    await engineer.post(path, { intent: 'save', yaml: REVENUE.replace('sum', 'avg') });
    expect(await (await engineer.get(path)).text()).toMatch(/data-publish-blocker[^>]*>.*?你最后改了这一版草稿/s);
    expect((await engineer.post(path, { intent: 'publish', version: '1' })).status).toBe(403);

    const reviewer = await loginAs(app, 'de2@acme.com');
    expect(await (await reviewer.get(path)).text()).toContain('发布 v1');
    const published = await reviewer.post(path, { intent: 'publish', version: '1' });
    expect(published.headers.get('location')).toBe(`${path}?published=1`);
    expect(await (await reviewer.get(`${path}?published=1`)).text()).toContain('第 1 版已发布');
    expect(await getDb().select({ kind: tasks.kind }).from(tasks)).toContainEqual({ kind: 'gold.dsl' });

    await analyst.post(path, { intent: 'save', yaml: REVENUE });
    expect((await analyst.post(path, { intent: 'discard' })).headers.get('location')).toBe(path);
    expect(await getDefinition(analystMember, 'metric', 'revenue')).toMatchObject({ draft: null, published: { version: 1 } });
    expect((await analyst.post(path, { intent: 'discard' })).status).toBe(400);

    await createDefinition(analystMember, 'metric', 'orders', REVENUE);
    expect((await analyst.post('/analytics/definitions/metric/orders', { intent: 'discard' })).headers.get('location')).toBe('/analytics');
    expect((await analyst.get('/analytics/definitions/metric/orders')).status).toBe(404);
  });

  it('数据工程师看到删除按钮，分析师看不到且提交 403；被已发布标签引用的指标在按钮处说明原因、提交 400 并列出标签，删掉标签后能删，回到分析页', async () => {
    const acme = await newTenant('acme');
    const analystMember = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineerMember = await memberOf(acme, 'de@acme.com', 'data_engineer');
    await createDefinition(analystMember, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(engineerMember, 'metric', 'revenue', 1);
    await createDefinition(analystMember, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
    await publishDefinition(engineerMember, 'tag', 'value_tier', 1);
    const metric = '/analytics/definitions/metric/revenue';

    const analyst = await loginAs(app, 'analyst@acme.com');
    expect(await (await analyst.get(metric)).text()).not.toContain('删除指标');
    expect((await analyst.post(metric, { intent: 'delete' })).status).toBe(403);

    const engineer = await loginAs(app, 'de@acme.com');
    const page = await (await engineer.get(metric)).text();
    expect(page).toMatch(/data-delete-blocker[^>]*>.*?被已发布的标签引用，不能删除：value_tier/s);
    expect(page).not.toContain('删除指标');
    // 绕过页面直接提交也被拒
    const blocked = await engineer.post(metric, { intent: 'delete' });
    expect(blocked.status).toBe(400);
    expect(await blocked.text()).toContain('指标 revenue 被已发布的标签引用，不能删除：value_tier');

    expect((await engineer.post('/analytics/definitions/tag/value_tier', { intent: 'delete' })).headers.get('location')).toBe('/analytics');
    expect(await (await engineer.get(metric)).text()).toContain('删除指标');
    expect((await engineer.post(metric, { intent: 'delete' })).headers.get('location')).toBe('/analytics');
    expect((await engineer.get(metric)).status).toBe(404);
  });

  it('有早于生效版本的快照时显示可回刷的张数，数据工程师点「回刷」按旧统计日入队；分析师在按钮处看到原因、提交 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const author = await memberOf(acme, 'de@acme.com', 'data_engineer');
    const reviewer = await memberOf(acme, 'de2@acme.com', 'data_engineer');
    await createDefinition(author, 'metric', 'revenue', REVENUE);
    const first = await publishDefinition(reviewer, 'metric', 'revenue', 1);
    // 第 1 版在 2024-07-15 算过一张快照
    await getDb().insert(snapshots).values({
      tenantId: acme, template: 'metric:revenue', definitionVersion: 1, taskId: first.id, table: `gold.metric__${first.id}`,
      params: { kind: 'metric', key: 'revenue', asOf: '2024-07-15', definitionVersion: 1 }, rowCount: 1, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const path = '/analytics/definitions/metric/revenue';
    expect(await (await loginAs(app, 'de@acme.com').then(b => b.get(path))).text()).toMatch(/data-backfill-count[^>]*>没有需要回刷的快照/);
    await saveDslDraft(author, 'metric', 'revenue', REVENUE.replace('sum', 'avg'));
    await publishDefinition(reviewer, 'metric', 'revenue', 2);
    await getDb().update(tasks).set({ status: 'succeeded' });

    const analyst = await loginAs(app, 'analyst@acme.com');
    expect(await (await analyst.get(path)).text()).toMatch(/data-backfill-denied[^>]*>.*?仅管理员、数据工程师可以发布映射与定义/s);
    expect((await analyst.post(path, { intent: 'backfill' })).status).toBe(403);

    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.get(path)).text()).toMatch(/data-backfill-count[^>]*>1 张未过期的快照早于生效的第 2 版（统计日 2024-07-15）/);
    const backfilled = await engineer.post(path, { intent: 'backfill' });
    expect(backfilled.headers.get('location')).toBe(`${path}?backfilled=1`);
    expect(await (await engineer.get(`${path}?backfilled=1`)).text()).toContain('已按 1 个统计日入队回刷');
    const queued = await getDb().select({ params: tasks.params }).from(tasks).where(eq(tasks.status, 'queued'));
    expect(queued.map(t => [t.params.key, t.params.definitionVersion, t.params.asOf])).toEqual([['revenue', 2, '2024-07-15']]);
    // 已在排队：再点给出原因
    expect(await (await engineer.post(path, { intent: 'backfill' })).text()).toContain('已有计算在排队或运行中');
  });

  it('分析页快照列表显示每张快照的来源，没有记来源的老快照显示「—」', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const snapshot = async (trigger: 'backfill' | null, asOf: string) => ({
      tenantId: acme, template: 'metric:revenue', trigger,
      taskId: (await getDb().insert(tasks).values({ tenantId: acme, kind: 'gold.dsl', status: 'succeeded' }).returning())[0]!.id, table: `gold.dsl__${asOf}`, params: { asOf }, rowCount: 3,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [backfilled, old] = await getDb().insert(snapshots).values([await snapshot('backfill', '2024-07-01'), await snapshot(null, '2024-06-01')]).returning();

    const html = await (await (await loginAs(app, 'viewer@acme.com')).get('/analytics')).text();
    expect(html).toContain('来源');
    expect(html).toMatch(new RegExp(`data-snapshot="${backfilled!.id}".*?data-snapshot-trigger[^>]*>回刷<`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${old!.id}".*?data-snapshot-trigger[^>]*>—<`, 's'));
  });

  it('数据工程师点「重新计算」按生效版本以今天入队（连同下游标签，来源 manual），已在排队时拒绝；定义页显示最近一次刷新；分析师看不到按钮、提交 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const author = await memberOf(acme, 'de@acme.com', 'data_engineer');
    const reviewer = await memberOf(acme, 'de2@acme.com', 'data_engineer');
    // 标签引用的指标不能带维度
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    const path = '/analytics/definitions/metric/revenue';
    const engineer = await loginAs(app, 'de@acme.com');
    // 还没发布：没有按钮，提交说明原因
    expect(await (await engineer.get(path)).text()).not.toContain('data-recompute');
    expect(await (await engineer.post(path, { intent: 'recompute' })).text()).toContain('还没有发布过');

    const first = await publishDefinition(reviewer, 'metric', 'revenue', 1);
    await createDefinition(author, 'tag', 'buyer', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n');
    await publishDefinition(reviewer, 'tag', 'buyer', 1);
    expect(await (await engineer.get(path)).text()).toMatch(/data-last-refresh[^>]*>还没有刷新过/);
    // 发布入队的计算还在排队：拒绝
    const busy = await engineer.post(path, { intent: 'recompute' });
    expect(busy.status).toBe(400);
    expect(await busy.text()).toContain('已有计算在排队或运行中');
    await getDb().update(tasks).set({ status: 'succeeded' });
    await getDb().insert(snapshots).values({
      tenantId: acme, template: 'metric:revenue', definitionVersion: 1, trigger: 'scheduled', taskId: first.id, table: `gold.dsl__${first.id}`,
      params: { kind: 'metric', key: 'revenue', asOf: '2024-07-15', definitionVersion: 1 }, rowCount: 1, expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(await (await engineer.get(path)).text()).toMatch(/data-last-refresh[^>]*>.*?定时刷新/s);

    const analyst = await loginAs(app, 'analyst@acme.com');
    const analystPage = await (await analyst.get(path)).text();
    expect(analystPage).toMatch(/data-recompute-denied[^>]*>.*?仅管理员、数据工程师可以发布映射与定义/s);
    expect(analystPage).not.toContain('value="recompute"');
    expect((await analyst.post(path, { intent: 'recompute' })).status).toBe(403);

    const recomputed = await engineer.post(path, { intent: 'recompute' });
    expect(recomputed.headers.get('location')).toBe(`${path}?recomputed=1`);
    expect(await (await engineer.get(`${path}?recomputed=1`)).text()).toContain('已按生效的第 1 版入队今天的计算');
    const queued = await getDb().select({ params: tasks.params }).from(tasks).where(eq(tasks.status, 'queued'));
    expect(queued.map(t => [t.params.key, t.params.definitionVersion, t.params.asOf, t.params.trigger]).sort())
      .toEqual([['buyer', 1, todayUtc(), 'manual'], ['revenue', 1, todayUtc(), 'manual']]);
    expect(await (await engineer.post(path, { intent: 'recompute' })).text()).toContain('已有计算在排队或运行中');
  });
});

/** 页面上编辑框里的 YAML */
const editorYaml = (html: string) => html.match(/<textarea[^>]*name="yaml"[^>]*>([\s\S]*?)<\/textarea>/)![1]
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 配上平台默认模型服务，替身每次都返回 content */
function modelReplies(content: unknown) {
  platformDefault();
  fakeLlm(f => app.setLlmFetch(f), () => json(content));
}

describe('用模型生成指标草稿', () => {
  it('分析师写需求生成草稿填进编辑框、不保存，填键后保存为第 1 版草稿；不过校验时 422 保持原内容', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const request = '近 30 天已支付订单的金额合计';

    // 用模型生成草稿在 YAML 模式（构建器是指标的默认模式）
    const page = await (await analyst.get('/analytics/definitions/new?kind=metric&mode=yaml')).text();
    expect(page).toMatch(/<textarea[^>]*name="request"/);
    expect(page).toMatch(/<button[^>]*formNoValidate=""[^>]*value="model-draft"|<button[^>]*value="model-draft"[^>]*formNoValidate=""/);

    modelReplies({ base: 'order', measure: { agg: 'sum', field: 'amount' }, filter: [{ field: 'status', op: 'eq', value: 'paid' }], window: { field: 'created_at', days: 30 } });
    const generated = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: '', request, yaml: REVENUE });
    expect(generated.status).toBe(200);
    const html = await generated.text();
    const yaml = editorYaml(html);
    expect(yaml).toContain('# 模型根据需求生成，请核对');
    expect(yaml).toContain('days: 30');
    expect(html).toContain('data-generated');
    expect(html).toContain(request);
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    const saved = await analyst.post('/analytics/definitions/new', { key: 'paid_revenue_30d', yaml });
    expect(saved.headers.get('location')).toBe('/analytics/definitions/metric/paid_revenue_30d');
    expect((await getDefinition(await memberOf(acme, 'analyst@acme.com', 'analyst'), 'metric', 'paid_revenue_30d')).draft).toMatchObject({ version: 1, yaml });

    modelReplies({ base: 'order', measure: { agg: 'sum', field: 'channel' } });
    const bad = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: 'x', request, yaml: REVENUE });
    expect(bad.status).toBe(422);
    const badHtml = await bad.text();
    expect(badHtml).toContain('未采用，编辑框保持原内容');
    expect(editorYaml(badHtml)).toBe(REVENUE);
  });

  it('未配置模型服务时 400 提示；查看者提交 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');

    const res = await (await loginAs(app, 'analyst@acme.com')).post('/analytics/definitions/new', { intent: 'model-draft', kind: 'metric', key: '', request: '订单数', yaml: REVENUE });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('未配置模型服务');
    const viewer = await loginAs(app, 'viewer@acme.com');
    expect((await viewer.post('/analytics/definitions/new', { intent: 'model-draft', kind: 'metric', request: '订单数', yaml: REVENUE })).status).toBe(403);
  });
});

/** 构建器隐藏字段 form 里回显的表单 JSON */
const builderFormOfHtml = (html: string) => JSON.parse(
  html.match(/<input[^>]*name="form"[^>]*value="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
);

/** 一句话解析应答里隐藏字段 parsed 的 JSON（确认覆盖时原样提交回去） */
const parsedOfHtml = (html: string) => html.match(/<input[^>]*name="parsed"[^>]*value="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** 模型对一句话的解析答复：spec（MetricSpec）加逐项说明、未知项与不支持的说法（形状照 test/pipeline/metric-parse.test.ts 的 MODEL_PARSE） */
const PARSE_REPLY = {
  spec: {
    base: 'order',
    measure: { agg: 'sum', field: 'amount' },
    filter: [{ field: 'status', op: 'eq', value: 'paid' }],
    window: { field: 'created_at', days: 30 },
    // 两种维度：单段路径的进表单 dimensions，多跳的进 readonly（key = dimensions.N），构建器都装不下
    dimensions: [{ name: 'city', path: 'order.customer_id -> customer.city' }, { name: 'channel', path: 'order.channel' }],
  },
  items: [
    { path: 'measure.field', reason: '金额合计用 order.amount' },
    { path: 'filter.0', reason: '成功订单是 status 等于 paid' },
    { path: 'window', reason: '近 30 天按下单时间 created_at' },
  ],
  unknowns: ['不扣退款'],
  unsupported: ['「按付款时间」取数'],
};

describe('一句话解析', () => {
  it('分析师输入一句话：空构建器直接填入，逐项说明、未知项、不支持的说法与原因、没填入的维度一并显示；不写 dsl_versions', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const sentence = '近 30 天成功订单的消费金额，不扣退款';

    // 一句话框与「解析一句话」在构建器模式，和隐藏字段 form 在同一个表单（一起提交才能算差异）
    const page = await (await analyst.get('/analytics/definitions/new?kind=metric')).text();
    expect(page).toMatch(/<textarea[^>]*name="sentence"/);
    expect(page).toMatch(/<button[^>]*formNoValidate=""[^>]*value="parse"|<button[^>]*value="parse"[^>]*formNoValidate=""/);

    modelReplies(PARSE_REPLY);
    const parsed = await analyst.post('/analytics/definitions/new?kind=metric', { intent: 'parse', kind: 'metric', key: '', sentence });
    expect(parsed.status).toBe(200);
    const html = await parsed.text();
    // 回显的 form（构建器隐藏字段）是解析结果
    expect(builderFormOfHtml(html)).toMatchObject({
      base: 'order', agg: 'sum', field: 'amount',
      filter: [{ field: 'status', op: 'eq', value: 'paid' }],
      window: { field: 'created_at', days: 30 },
    });
    // 逐项说明（位置转中文）、未知项、不支持的说法与固定原因说明
    expect(html).toContain('data-parse-items');
    expect(html).toContain('计算什么：金额合计用 order.amount');
    expect(html).toContain('条件第 1 行：成功订单是 status 等于 paid');
    expect(html).toContain('时间窗口：近 30 天按下单时间 created_at');
    expect(html).toContain('data-parse-unknowns');
    expect(html).toContain('不扣退款');
    expect(html).toContain('data-parse-unsupported');
    expect(html).toContain('「按付款时间」取数');
    expect(html).toContain('为什么不能做');
    expect(html).toContain('「或」只能是同一个字段的多个取值');
    // 构建器没有维度控件：两种维度的名字都显式提示没填入（单段路径的在前），句子回显
    expect(html).toContain('data-parse-dropped');
    expect(html).toContain('以下维度构建器不支持，没有填入：channel、city');
    expect(html).toContain(sentence);
    // 构建器是空的：没有差异、没有确认覆盖
    expect(html).not.toContain('data-parse-diff');
    expect(html).not.toContain('value="applyParse"');
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });

  it('构建器已有不同内容时先列差异、表单不变，确认覆盖（applyParse）后才换成解析结果；parsed 读不出来 400', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const current = JSON.stringify({ base: 'order', agg: 'count', filter: [], dimensions: [], readonly: [] });

    modelReplies(PARSE_REPLY);
    const parsed = await analyst.post('/analytics/definitions/new?kind=metric', { intent: 'parse', kind: 'metric', key: '', sentence: '近 30 天成功订单的消费金额', form: current });
    expect(parsed.status).toBe(200);
    const html = await parsed.text();
    // 表单还是当前内容（行数），差异列出会被替换的句子（原来 → 解析后）
    expect(builderFormOfHtml(html)).toMatchObject({ base: 'order', agg: 'count' });
    expect(builderFormOfHtml(html)).not.toHaveProperty('field');
    expect(html).toContain('data-parse-diff');
    expect(html).toContain('计算行数。 → 计算实付金额求和。');
    expect(html).toContain('不排除任何记录。 → 只算 订单状态 等于 paid 的记录。');
    expect(html).toContain('不限时间。 → 近 30 天，按下单时间。');
    expect(html).toMatch(/<input[^>]*name="parsed"/);
    expect(html).toMatch(/<button[^>]*formNoValidate=""[^>]*value="applyParse"|<button[^>]*value="applyParse"[^>]*formNoValidate=""/);

    // 把应答里的 parsed 原样提交，确认覆盖后 form 才变成解析结果（不再有差异与确认按钮）
    const applied = await analyst.post('/analytics/definitions/new?kind=metric', { intent: 'applyParse', kind: 'metric', key: '', form: current, parsed: parsedOfHtml(html) });
    expect(applied.status).toBe(200);
    const appliedHtml = await applied.text();
    expect(builderFormOfHtml(appliedHtml)).toMatchObject({ base: 'order', agg: 'sum', field: 'amount', window: { field: 'created_at', days: 30 } });
    expect(appliedHtml).not.toContain('data-parse-diff');
    expect(appliedHtml).not.toContain('value="applyParse"');

    // 不信客户端：parsed 读不出来（不是那一份 JSON）按 400，不落库
    const bad = await analyst.post('/analytics/definitions/new?kind=metric', { intent: 'applyParse', kind: 'metric', key: '', form: current, parsed: '不是 JSON' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('解析结果读不出来');
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });

  it('模型答复不过校验时 422、未配置模型服务时 409，构建器都保持原内容', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const current = JSON.stringify({ base: 'order', agg: 'count', filter: [], dimensions: [], readonly: [] });

    modelReplies({ ...PARSE_REPLY, spec: { base: 'order', measure: { agg: 'sum', field: 'channel' } } });
    const bad = await analyst.post('/analytics/definitions/new?kind=metric', { intent: 'parse', kind: 'metric', key: '', sentence: '近 30 天成功订单的消费金额', form: current });
    expect(bad.status).toBe(422);
    const badHtml = await bad.text();
    expect(badHtml).toContain('解析出的指标定义有');
    expect(builderFormOfHtml(badHtml)).toMatchObject({ base: 'order', agg: 'count' });
    expect(badHtml).not.toContain('data-parse-items');

    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');
    const none = await analyst.post('/analytics/definitions/new?kind=metric', { intent: 'parse', kind: 'metric', key: '', sentence: '近 30 天成功订单的消费金额', form: current });
    expect(none.status).toBe(409);
    const noneHtml = await none.text();
    expect(noneHtml).toContain('未配置模型服务');
    expect(builderFormOfHtml(noneHtml)).toMatchObject({ base: 'order', agg: 'count' });
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });
});

describe('用模型生成标签草稿', () => {
  it('标签新建页生成草稿填进编辑框、不保存；没有可引用的已发布指标时 400 提示，编辑框保持原内容', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const request = '消费满 1000 的是高价值客户';
    const tag = 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n';
    modelReplies({ metric: 'revenue', rules: [{ value: 'high', when: { gte: 1000 } }], default: 'normal' });

    expect(await (await analyst.get('/analytics/definitions/new?kind=tag&mode=yaml')).text()).toMatch(/<textarea[^>]*name="request"/);
    const none = await analyst.post('/analytics/definitions/new?kind=tag&mode=yaml', { intent: 'model-draft', kind: 'tag', key: '', request, yaml: tag });
    expect(none.status).toBe(400);
    const noneHtml = await none.text();
    expect(noneHtml).toContain('先发布一个数值型指标');
    expect(editorYaml(noneHtml)).toBe(tag);

    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(reviewer, 'metric', 'revenue', 1);
    const generated = await analyst.post('/analytics/definitions/new?kind=tag&mode=yaml', { intent: 'model-draft', kind: 'tag', key: '', request, yaml: tag });
    expect(generated.status).toBe(200);
    const html = await generated.text();
    expect(editorYaml(html)).toContain('# 模型根据需求生成，请核对');
    expect(editorYaml(html)).toContain('gte: 1000');
    expect(html).toContain('data-generated');
    expect(await getDb().select().from(dslVersions)).toHaveLength(1);
  });
});
