// test/http/dsl-definitions.test.ts —— 指标定义的 HTTP 接缝：分析师在新建页填写键与 YAML 保存草稿 → 跳到定义页看到编译出的 SQL 与版本；在定义页再次保存改同一份草稿；
// 校验不通过时按行列列出问题；分析页「新建标签」进到标签种类的新建页；查看者看不到「新建指标」、打不开新建页、提交 403；分析页里 metric: 快照链接到定义页；
// 定义页点「预览」展示前 50 行与总行数（查看者也能预览），标准层缺表时给出说明，不存在的定义 404；有草稿且已发布过时点「预览影响」展示指标与下游标签的变化人数；
// 版本表里发布不了的成员看到原因，另一位数据工程师发布后入队 gold.dsl；丢弃草稿回到已发布版本，从没发布过时回到分析页；
// 数据工程师看到「删除」按钮（分析师看不到、提交 403），被已发布标签引用的指标删不了，删除后回到分析页；
// 有早于生效版本的快照时数据工程师点「回刷」入队按旧统计日的计算，分析师在按钮处看到原因、提交 403；
// 数据工程师点「重新计算」按生效版本以今天入队（连同下游标签，来源 manual），定义页显示最近一次刷新的时间与来源，分析页快照列表显示来源；
// 最近一次计算因断言失败且比最新快照新时，定义页显示红色失败提示（#839）：断言名与不合格行数人人可看，不合格的键、来源映射与「查看样本」链接只给有 sources:read 的角色，再算成功提示消失；还没有快照时（发布后第一次计算就失败）不说「继续使用上一版」；
// 新建页写需求「用模型生成草稿」填进编辑框、不保存，不过校验时 422 保持原内容，未配置模型服务时 400，查看者 403；标签同样能生成，没有可引用的已发布指标时 400；
// 指标草稿在编辑框上方逐项说明，编辑框已有内容时先给只读草稿、确认覆盖（applyDraft，重新 checkMetric）后才替换（#1163）；
// 指标新建页默认是条件构建器（?mode=builder|yaml）：「检查」只编译给出摘要与编译出的 SQL、不保存（YAML 模式也能检查），
// 不合法按行列 400（行列号指向生成的 YAML，一并显示；fieldsFor 里没有的字段服务端兜底拦下），保存得到与手写 YAML 一样的草稿；
// 词表外的聚合也回显进构建器（下拉多一个当前值选项、标出「不支持」）；时间窗口天数 0 / 负数按 window.days 400（客户端不再静默丢掉窗口）；
// 构建器不接模型（#1164）：intent=parse / applyParse 按未知操作 400、不调模型、不落库
// 构建器与 YAML 的切换带上内容（intent=to-yaml / to-builder(-confirmed)，#797，切换改成本页表单的 POST、应答的 mode 覆盖 URL）：
// YAML → 构建器把表单回显进隐藏字段（有构建器表达不了的维度 / 只读项先列出、确认后才切，YAML 不合法 400 不切换），构建器 → YAML 给 formToYaml
// 的结果（空构建器给示例），切换都不落库；种类切换仍是链接，有未保存内容时客户端先确认（app/lib/unsaved-changes.ts，纯函数另测）
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { dslVersions, snapshots, tasks } from '../../app/.server/db/schema';
import { createDefinition, getDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { syncSource } from '../../app/.server/source-sync';
import { todayUtc } from '../../app/.server/templates';
import { entityOf } from '../../app/lib/canonical-model';
import { formToYaml, type MetricForm } from '../../app/lib/metric-form';
import { formToYaml as tagFormToYaml, type TagForm } from '../../app/lib/tag-form';
import { drain, memberOf, newTenant } from '../pipeline/fixtures';
import { fakeLlm, json, platformDefault } from '../pipeline/llm-fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { grantOnSource } from '../pipeline/source-fixtures';
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

  it('英文界面下构建器「检查」的摘要句子是英文（字段名走 CANONICAL_NAMES 词典），摘要里没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    analyst.store('crm_locale=en; Path=/');
    const form: MetricForm = { base: 'order', agg: 'sum', field: 'amount', filter: [{ field: 'status', op: 'eq', value: 'paid' }], window: { field: 'paid_at', days: 30 }, dimensions: [], readonly: [] };
    const check = await analyst.post('/analytics/definitions/new', { kind: 'metric', key: 'paid_amount_30d', form: JSON.stringify(form), intent: 'check' });
    expect(check.status).toBe(200);
    // 只断言摘要块：句子按界面语言（summarize 收 t），实体 / 字段名走 builtinName 的英文词典
    const summary = (await check.text()).match(/<ul data-summary[^>]*>([\s\S]*?)<\/ul>/)![1];
    expect(summary).toContain('<li>Calculates the sum of Amount Paid.</li>');
    expect(summary).toContain('<li>Counts only records where Order Status equals paid.</li>');
    expect(summary).toContain('<li>In the last 30 days, by Paid At.</li>');
    expect(summary).not.toMatch(/[一-鿿]/);
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

  it('新建页的构建器与 YAML 切换带上内容：YAML → 构建器回显表单（有会丢的项先列出、确认后才切）、不合法不切换，构建器 → YAML 是 formToYaml 的结果；都不落库', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    // 表单提交到当前 URL（带 ?kind=），loader 的种类从 URL 读，与真实页面一致
    // 切换的 POST 来自哪个模式的页面，就带哪个隐藏字段 mode（页面上的表单就有这个隐藏字段）
    const post = (body: Record<string, string>) => analyst.post(`/analytics/definitions/new?kind=${body.kind}`, body);

    // 指标：无维度的 YAML → to-builder：进构建器、隐藏字段 form 回显 base / agg，URL 里的 mode 还是 yaml 但应答的 mode 已覆盖
    const plain = 'base: order\nmeasure: { agg: sum, field: amount }\n';
    const toBuilder = await post({ kind: 'metric', intent: 'to-builder', yaml: plain, key: 'paid_amount', mode: 'yaml' });
    expect(toBuilder.status).toBe(200);
    const builderPage = await toBuilder.text();
    expect(builderPage).toMatch(/data-tab="builder"[^>]*aria-current="page"/);
    expect(builderPage).toMatch(/name="form" value="[^"]*&quot;base&quot;:&quot;order&quot;[^"]*&quot;agg&quot;:&quot;sum&quot;/);
    // 模式切换不再是链接，是提交本页表单的按钮（当前模式那项不提交）
    expect(builderPage).toMatch(/<button[^>]*type="submit"[^>]*form="definition-form"[^>]*>/);
    expect(builderPage).toContain('value="to-yaml"');
    expect(builderPage).not.toMatch(/href="\/analytics\/definitions\/new\?kind=metric&amp;mode=/);
    expect(builderPage).not.toMatch(/<textarea[^>]*name="yaml"/);
    expect(builderPage).toContain('value="paid_amount"');
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    // 带维度的 YAML → to-builder：不切换，仍在 YAML 模式列出会丢掉的维度（名字取自维度的 name），编辑框保持原内容
    const dimYaml = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n';
    const warned = await post({ kind: 'metric', intent: 'to-builder', yaml: dimYaml, mode: 'yaml' });
    expect(warned.status).toBe(200);
    const warnedPage = await warned.text();
    expect(warnedPage).toContain('data-switch-dropped');
    expect(warnedPage).toContain('切到构建器会丢掉这些项');
    expect(warnedPage).toContain('city');
    expect(warnedPage).toContain('仍然切换');
    expect(warnedPage).toMatch(/data-tab="yaml"[^>]*aria-current="page"/);
    expect(editorYaml(warnedPage)).toBe(dimYaml);
    // 确认后才进构建器（维度不再提示）
    const confirmed = await post({ kind: 'metric', intent: 'to-builder-confirmed', yaml: dimYaml, mode: 'yaml' });
    expect(confirmed.status).toBe(200);
    const confirmedPage = await confirmed.text();
    expect(confirmedPage).toMatch(/name="form" value="[^"]*&quot;base&quot;:&quot;order&quot;/);
    expect(confirmedPage).not.toContain('data-switch-dropped');

    // 不合法 YAML：不切换、400 报出原因、编辑框保持原内容
    const bad = await post({ kind: 'metric', intent: 'to-builder', yaml: 'base: [', mode: 'yaml' });
    expect(bad.status).toBe(400);
    const badPage = await bad.text();
    expect(badPage).toMatch(/YAML 语法错误/);
    expect(editorYaml(badPage)).toBe('base: [');

    // 构建器 → to-yaml：编辑框里是 formToYaml 的结果（不是示例）
    const form: MetricForm = { base: 'order', agg: 'sum', field: 'amount', filter: [{ field: 'status', op: 'eq', value: 'paid' }], window: { field: 'paid_at', days: 30 }, dimensions: [], readonly: [] };
    const toYaml = await post({ kind: 'metric', intent: 'to-yaml', form: JSON.stringify(form), key: 'paid_amount', mode: 'builder' });
    expect(toYaml.status).toBe(200);
    const yamlPage = await toYaml.text();
    expect(yamlPage).toMatch(/data-tab="yaml"[^>]*aria-current="page"/);
    const fields = entityOf('order')!.fields.map(f => ({ name: f.name, type: f.type }));
    expect(editorYaml(yamlPage)).toBe(formToYaml(form, fields));
    // 空构建器（没选基础实体）→ to-yaml：不报错，直接给示例 YAML
    const empty = await post({ kind: 'metric', intent: 'to-yaml', form: JSON.stringify({ base: '', agg: 'count', filter: [], dimensions: [], readonly: [] }), mode: 'builder' });
    expect(empty.status).toBe(200);
    const emptyPage = await empty.text();
    expect(editorYaml(emptyPage)).toContain('- { field: status, op: in, value: [paid, completed] }');
    expect(emptyPage).not.toContain('读不出来');

    // 标签同样：YAML → 构建器回显（隐藏字段 form 带上指标与规则），构建器 → YAML 是 tagFormToYaml 的结果
    const tagYaml = 'metric: revenue_30d\nrules:\n  - value: high\n    when: { gte: 1000 }\ndefault: low\n';
    const tagToBuilder = await post({ kind: 'tag', intent: 'to-builder', yaml: tagYaml, key: 'value_tier', mode: 'yaml' });
    expect(tagToBuilder.status).toBe(200);
    const tagBuilderPage = await tagToBuilder.text();
    expect(tagBuilderPage).toContain('data-tag-builder');
    expect(tagBuilderPage).toMatch(/name="form" value="[^"]*&quot;single&quot;:true[^"]*&quot;metric&quot;:&quot;revenue_30d&quot;/);
    const tagForm: TagForm = { single: true, metric: 'revenue_30d', rules: [{ value: 'high', combinator: 'all', items: [{ metric: 'revenue_30d', cmp: [{ op: 'gte', value: 1000 }] }] }], missing: {}, default: 'low', readonly: [] };
    const tagToYaml = await post({ kind: 'tag', intent: 'to-yaml', form: JSON.stringify(tagForm), key: 'value_tier', mode: 'builder' });
    expect(tagToYaml.status).toBe(200);
    expect(editorYaml(await tagToYaml.text())).toBe(tagFormToYaml(tagForm));
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
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

  it('定义页「最近一次刷新」按统计日选最新快照：登记更晚的回刷快照不算最新，同一统计日取登记较晚的那张', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com', 'data_engineer');
    const reviewer = await memberOf(acme, 'de2@acme.com', 'data_engineer');
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(reviewer, 'metric', 'revenue', 1);
    await getDb().update(tasks).set({ status: 'succeeded' });
    const path = '/analytics/definitions/metric/revenue';
    const engineer = await loginAs(app, 'de@acme.com');
    /** 直接登记一张快照（不真算），统计日、来源与登记时间可控 */
    const register = async (asOf: string, trigger: 'manual' | 'backfill' | 'scheduled', createdAt: Date) => {
      const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind: 'gold.dsl', status: 'succeeded', createdAt }).returning();
      await getDb().insert(snapshots).values({
        tenantId: acme, template: 'metric:revenue', definitionVersion: 1, trigger, taskId: task!.id, table: `gold.dsl__${task!.id}`,
        params: { kind: 'metric', key: 'revenue', asOf, definitionVersion: 1 }, rowCount: 1, createdAt, expiresAt: new Date(Date.now() + 86_400_000),
      });
    };
    // 先登记统计日 D 的快照，再登记统计日 D-1、但登记更晚的回刷快照：「最近一次刷新」仍取 D 那张（来源 manual）
    await register('2024-08-01', 'manual', new Date(Date.now() - 7_200_000));
    await register('2024-07-31', 'backfill', new Date(Date.now() - 3_600_000));
    expect(await (await engineer.get(path)).text()).toMatch(/data-last-refresh[^>]*>[^<]*，来源 手动/);
    // 同一统计日 D 再登记一张（登记最晚）：取它
    await register('2024-08-01', 'scheduled', new Date());
    expect(await (await engineer.get(path)).text()).toMatch(/data-last-refresh[^>]*>[^<]*，来源 定时刷新/);
  });

  it('最近一次计算因断言失败时定义页显示失败提示：断言名、不合格行数与任务时间；有 sources:read 的成员还看到不合格的键、来源映射与「查看样本」链接，查看者只看到断言与行数；再算一次成功提示消失', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    const author = await memberOf(acme, 'de@acme.com');
    await memberOf(acme, 'an@acme.com', 'analyst');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(await memberOf(acme, 'de2@acme.com'), 'metric', 'revenue', 1);
    await drain(); // 发布入队的第一次计算成功，登记快照
    const path = '/analytics/definitions/metric/revenue';
    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.get(path)).text()).not.toContain('data-last-failure');

    // 注入负金额订单 A7 并合并：重新计算因金额非负断言失败，不登记新快照
    await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
    await syncSource(author, sources.crm);
    await drain();
    expect((await engineer.post(path, { intent: 'recompute' })).status).toBe(302);
    await drain();
    const [failed] = await getDb().select({ id: tasks.id }).from(tasks).where(and(eq(tasks.kind, 'gold.dsl'), eq(tasks.status, 'failed')));

    // 分析师（有 sources:read）：断言名、行数、任务时间，加上不合格的键、来源映射与「查看样本」
    const html = await (await (await loginAs(app, 'an@acme.com')).get(path)).text();
    expect(html).toMatch(/data-last-failure/);
    expect(html).toMatch(/最近一次计算未通过（[^）]+）/);
    expect(html).toContain('金额非负（silver.order，1 行不合格）');
    expect(html).toContain('不合格的键：A7；来源映射：CRM · orders → order');
    expect(html).toContain('本次没有产出新快照，分析页继续使用上一版');
    expect(html).toContain(`href="/quality?task=${failed!.id}"`);
    expect(html).toMatch(/data-failure-samples/);

    // 查看者（没有 sources:read）：只看到断言名与行数，看不到键、映射与链接
    const viewer = await (await (await loginAs(app, 'viewer@acme.com')).get(path)).text();
    expect(viewer).toMatch(/data-last-failure/);
    expect(viewer).toContain('金额非负（silver.order，1 行不合格）');
    expect(viewer).not.toContain('A7');
    expect(viewer).not.toContain('CRM · orders → order');
    expect(viewer).not.toContain('data-failure-samples');
    expect(viewer).not.toContain('/quality?task=');

    // 改回正金额再算一次：成功登记新快照，提示消失
    await grantOnSource(`UPDATE crm.orders SET amount = 10, updated_at = now() WHERE order_no = 'A7'`);
    await syncSource(author, sources.crm);
    await drain();
    expect((await engineer.post(path, { intent: 'recompute' })).status).toBe(302);
    await drain();
    expect(await (await engineer.get(path)).text()).not.toContain('data-last-failure');
  });

  it('发布后的第一次计算就因断言失败（还没有任何快照）时，失败提示照常显示，但不说「继续使用上一版」', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    const author = await memberOf(acme, 'de@acme.com');
    // 先注入负金额订单 A7 并合并，再发布：发布入队的第一次计算就失败
    await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
    await syncSource(author, sources.crm);
    await drain();
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(await memberOf(acme, 'de2@acme.com'), 'metric', 'revenue', 1);
    await drain();
    expect(await getDb().select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.template, 'metric:revenue'))).toEqual([]);

    const html = await (await (await loginAs(app, 'de@acme.com')).get('/analytics/definitions/metric/revenue')).text();
    expect(html).toMatch(/data-last-failure/);
    expect(html).toContain('金额非负（silver.order，1 行不合格）');
    expect(html).toContain('还没有可用的快照');
    expect(html).not.toContain('继续使用上一版');
  });
});

/** 页面上编辑框里的 YAML */
const editorYaml = (html: string) => html.match(/<textarea[^>]*name="yaml"[^>]*>([\s\S]*?)<\/textarea>/)![1]
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 页面上只读草稿框（待确认覆盖）里的 YAML */
const draftYaml = (html: string) => html.match(/<textarea[^>]*name="draft"[^>]*>([\s\S]*?)<\/textarea>/)![1]
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** 模型起草指标的答复（#1162 的形状）：spec 带条件与时间窗口，加逐项说明、认不出的词与不支持的说法 */
const DRAFT_REPLY = {
  spec: { base: 'order', measure: { agg: 'sum', field: 'amount' }, filter: [{ field: 'status', op: 'eq', value: 'paid' }], window: { field: 'created_at', days: 30 } },
  items: [
    { path: 'measure.field', reason: '金额合计用 order.amount' },
    { path: 'filter.0', reason: '成功订单是 status 等于 paid' },
    { path: 'window', reason: '近 30 天按下单时间 created_at' },
  ],
  unknowns: ['不扣退款'],
  unsupported: ['「按付款时间」取数'],
};

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

    // 模型答复带逐项说明（#1162）：spec 加 items / unknowns / unsupported；编辑框是示例，直接填入（#1163）
    modelReplies({ spec: { base: 'order', measure: { agg: 'sum', field: 'amount' }, filter: [{ field: 'status', op: 'eq', value: 'paid' }], window: { field: 'created_at', days: 30 } }, items: [], unknowns: [], unsupported: [] });
    const generated = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: '', request, yaml: editorYaml(page) });
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

    modelReplies({ spec: { base: 'order', measure: { agg: 'sum', field: 'channel' } }, items: [], unknowns: [], unsupported: [] });
    const bad = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: 'x', request, yaml: REVENUE });
    expect(bad.status).toBe(422);
    const badHtml = await bad.text();
    expect(badHtml).toContain('未采用，编辑框保持原内容');
    expect(editorYaml(badHtml)).toBe(REVENUE);
  });

  it('需求里的词挂两个同别名指标时：草稿照常生成，页面上出现「这些词有多种理解」与指向业务知识页的候选链接', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const reviewer = await memberOf(acme, 'de@acme.com', 'data_engineer');
    // 两个窗口时间字段不同的指标挂同一个别名「营收」：检索判出歧义
    const windowed = (field: string) => `base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: ${field}, days: 30 }\n`;
    for (const [key, field] of [['revenue_365d', 'created_at'], ['gmv_365d', 'paid_at']] as const) {
      await createDefinition(analyst, 'metric', key, windowed(field));
      await publishDefinition(reviewer, 'metric', key, 1);
      await addAlias(analyst, { targetId: `metric:${key}`, alias: '营收' });
    }

    modelReplies({ spec: { base: 'order', measure: { agg: 'sum', field: 'amount' } }, items: [], unknowns: [], unsupported: [] });
    const res = await (await loginAs(app, 'analyst@acme.com'))
      .post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: '', request: '营收', yaml: '' });
    expect(res.status).toBe(200);
    const html = await res.text();
    // 草稿照常生成，编辑框上方出现歧义提示：词、两个候选链接与说明
    expect(editorYaml(html)).toContain('# 模型根据需求生成，请核对');
    expect(html).toMatch(/data-ambiguity[^>]*>.*?这些词有多种理解/s);
    expect(html).toMatch(/<a[^>]*href="\/knowledge\?item=metric%3Arevenue_365d"[^>]*>revenue_365d<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/knowledge\?item=metric%3Agmv_365d"[^>]*>gmv_365d<\/a>/);
    expect(html).toContain('请确认模型选的是否是你要的口径，或在需求里写明');
  });

  it('编辑框为空时直接填入完整 YAML，上方逐项说明、认不出的词与不支持的说法（固定原因），没有「没有填入」的提示', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    modelReplies(DRAFT_REPLY);
    const res = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: '', request: '近 30 天成功订单的金额', yaml: '  \n' });
    expect(res.status).toBe(200);
    const html = await res.text();
    const yaml = editorYaml(html);
    expect(yaml).toContain('# 模型根据需求生成，请核对');
    expect(yaml).toMatch(/filter:[\s\S]*status/);
    expect(yaml).toMatch(/window:[\s\S]*days: 30/);
    expect(html).toContain('data-generated');
    // 说明在编辑框上方：pathText 把位置转成「条件第 N 行」「时间窗口」
    expect(html.indexOf('data-metric-parse-panel')).toBeLessThan(html.indexOf('name="yaml"'));
    expect(html).toContain('计算什么：金额合计用 order.amount');
    expect(html).toContain('条件第 1 行：成功订单是 status 等于 paid');
    expect(html).toContain('时间窗口：近 30 天按下单时间 created_at');
    expect(html).toContain('data-parse-unknowns');
    expect(html).toContain('不扣退款');
    expect(html).toContain('data-parse-unsupported');
    expect(html).toContain('为什么不能做');
    expect(html).not.toContain('data-parse-dropped');
    expect(html).not.toContain('没有填入');
    expect(html).not.toContain('value="applyDraft"');
  });

  it('编辑框已有不同内容时先不覆盖：给出只读草稿与说明，确认覆盖（applyDraft）后才替换；草稿不过 checkMetric 时 400、编辑框保持原内容', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    modelReplies(DRAFT_REPLY);
    const res = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: '', request: '近 30 天成功订单的金额', yaml: REVENUE });
    expect(res.status).toBe(200);
    const html = await res.text();
    // 编辑框还是原内容，没有「已用模型生成草稿」；草稿只读、说明照常展示
    expect(editorYaml(html)).toBe(REVENUE);
    expect(html).not.toContain('data-generated');
    expect(html).toContain('data-draft-confirm');
    expect(html).toMatch(/<textarea[^>]*name="draft"[^>]*readOnly=""|<textarea[^>]*readOnly=""[^>]*name="draft"/);
    const draft = draftYaml(html);
    expect(draft).toContain('# 模型根据需求生成，请核对');
    expect(draft).toContain('days: 30');
    expect(html).toContain('条件第 1 行：成功订单是 status 等于 paid');
    expect(html).toMatch(/<button[^>]*formNoValidate=""[^>]*value="applyDraft"|<button[^>]*value="applyDraft"[^>]*formNoValidate=""/);

    const applied = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'applyDraft', kind: 'metric', key: '', yaml: REVENUE, draft });
    expect(applied.status).toBe(200);
    const appliedHtml = await applied.text();
    expect(editorYaml(appliedHtml)).toBe(draft);
    expect(appliedHtml).toContain('data-generated');
    expect(appliedHtml).not.toContain('data-draft-confirm');
    expect(appliedHtml).not.toContain('data-metric-parse-panel');

    // 不信客户端：回传的草稿重新 checkMetric，不合法 400、编辑框保持原内容
    const bad = await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'applyDraft', kind: 'metric', key: '', yaml: REVENUE, draft: 'base: order\nmeasure: { agg: sum, field: channel }\n' });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain('sum 只能用整数或小数字段');
    expect(editorYaml(badHtml)).toBe(REVENUE);
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });

  it('英文界面下确认覆盖的提示、按钮与说明面板的标题没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    analyst.store('crm_locale=en; Path=/');

    modelReplies({ ...DRAFT_REPLY, items: [{ path: 'filter.0', reason: 'paid orders' }], unknowns: ['refunds'], unsupported: ['by pay time'] });
    const html = await (await analyst.post('/analytics/definitions/new?kind=metric&mode=yaml', { intent: 'model-draft', kind: 'metric', key: '', request: 'paid amount', yaml: REVENUE })).text();
    // 只读草稿里是生成的 YAML（带中文注释），去掉再看
    const confirm = html.match(/<div[^>]*data-draft-confirm[\s\S]*?value="applyDraft"[\s\S]*?<\/button>/)![0].replace(/<textarea[\s\S]*?<\/textarea>/g, '');
    expect(confirm).not.toMatch(/[一-鿿]/);
    const panel = html.match(/<div[^>]*data-metric-parse-panel[\s\S]*?data-parse-unsupported[\s\S]*?<\/div>/)![0];
    expect(panel).toContain('Condition row 1');
    expect(panel).not.toMatch(/[一-鿿]/);
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
  it('构建器的一句话解析已删除（#1164）：intent=parse / applyParse 按未知操作 400、不调模型、不写 dsl_versions；构建器页不再有一句话框', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    platformDefault();
    const { f } = fakeLlm(g => app.setLlmFetch(g), () => json({ spec: { base: 'order', measure: { agg: 'count' } }, items: [], unknowns: [], unsupported: [] }));

    const page = await (await analyst.get('/analytics/definitions/new?kind=metric')).text();
    expect(page).not.toMatch(/name="sentence"/);
    expect(page).not.toContain('value="parse"');
    expect(page).not.toContain('解析一句话');

    const current = JSON.stringify({ base: 'order', agg: 'count', filter: [], dimensions: [], readonly: [] });
    for (const intent of ['parse', 'applyParse']) {
      const res = await analyst.post('/analytics/definitions/new?kind=metric', { intent, kind: 'metric', key: 'order_count', sentence: '订单数', form: current, parsed: current });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('未知操作');
    }
    expect(f).not.toHaveBeenCalled();
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });
});

describe('用模型生成标签草稿', () => {
  it('标签新建页生成草稿填进编辑框、不保存；没有可引用的已发布指标时 400 提示、模型判断做不到时 422 显示原因，编辑框保持原内容', async () => {
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

    // 模型判断做不到（#1165）：422，页面显示模型给的原因、不显示 Schema 报错，编辑框保持原内容
    modelReplies({ unsupported: ['按小时的峰值需要按小时分桶的指标'] });
    const unsupported = await analyst.post('/analytics/definitions/new?kind=tag&mode=yaml', { intent: 'model-draft', kind: 'tag', key: '', request: '按小时的峰值', yaml: tag });
    expect(unsupported.status).toBe(422);
    const unsupportedHtml = await unsupported.text();
    expect(unsupportedHtml).toContain('模型判断做不到：按小时的峰值需要按小时分桶的指标');
    expect(unsupportedHtml).not.toContain('must NOT');
    expect(editorYaml(unsupportedHtml)).toBe(tag);
  });
});
