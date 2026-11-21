// test/i18n-source-entity-forms-render.test.ts —— 数据源连接参数表单与自定义实体表单的静态渲染（#1020，纯函数，不连库）：
// 英文界面下两个组件写死的界面文字没有汉字，字段类型 / 实体类型按 #1011 的词典（builtinName + ENUM_LABELS）显示英文，租户填的名称原样；
// 表单提交的值（option value、控件 name）不随界面语言变化；中文界面（词典未下发）的输出与改造前的中文一致。
// CustomEntityForm 用了 react-router 的 Form，静态渲染里没有路由上下文，照 knowledge-route-render.test.ts mock 成原生 form
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Form: (props: { children?: ReactNode }) => createElement('form', { method: 'post' }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { CustomEntityForm, EntityFieldsTable, EntityRelationsTable, type EntityFormValues, type RelationTarget } from '../app/components/custom-entity-form';
import { SourceFields } from '../app/components/source-fields';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

/** props 里不带中文数据（实体中文名、字段说明、submitLabel 都算路由传的数据，本票不翻），输出里的汉字就只剩组件写死的界面文字 */
const TARGETS: RelationTarget[] = [
  { name: 'customer', label: 'Customer', primaryKey: ['customer_id'] },
  { name: 'custom_store', label: 'Store', primaryKey: ['store_id'] },
];

const VALUES: EntityFormValues = {
  name: 'custom_visit', label: 'Visit', kind: 'dimension',
  fields: [
    { name: 'visit_id', type: 'string', description: '', sensitive: false },
    { name: 'visited_at', type: 'timestamp', description: 'when', sensitive: true },
  ],
  primaryKey: ['visit_id'],
  relations: [{ from: { entity: 'custom_visit', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }],
};

/** 按界面语言静态渲染；中文界面词典传 null（词典未下发），与真实中文界面一致 */
const render = (locale: 'en' | 'zh-CN', node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { t: makeT(locale, locale === 'en' ? enClient : null), locale, children: node }));

describe('英文界面：数据源连接参数表单', () => {
  it('四种数据源的标签、提示与选项文字都是英文，没有汉字（postgres 空表单、mongodb、s3 编辑态、upload）', () => {
    const pg = render('en', createElement(SourceFields, { kind: 'postgres', values: {} }));
    expect(pg).not.toMatch(/[一-鿿]/);
    expect(pg).toContain('Host');
    expect(pg).toContain('Must be a read-only account');

    const mongo = render('en', createElement(SourceFields, { kind: 'mongodb', values: {} }));
    expect(mongo).not.toMatch(/[一-鿿]/);
    expect(mongo).toContain('Host and port');
    expect(mongo).toContain('SRV record (MongoDB Atlas; TLS is used automatically)');

    const s3 = render('en', createElement(SourceFields, { kind: 's3', values: {}, editing: true }));
    expect(s3).not.toMatch(/[一-鿿]/);
    expect(s3).toContain('Object storage endpoint');
    expect(s3).toContain('path (/bucket/key)');
    expect(s3).toContain('Stored encrypted; leave blank to keep it unchanged');

    const upload = render('en', createElement(SourceFields, { kind: 'upload', values: { table: 'signups' }, editing: true }));
    expect(upload).not.toMatch(/[一-鿿]/);
    expect(upload).toContain('Table name');
    expect(upload).toContain('Cannot be changed after upload');
    const uploadNew = render('en', createElement(SourceFields, { kind: 'upload', values: {} }));
    expect(uploadNew).not.toMatch(/[一-鿿]/);
    expect(uploadNew).toContain('CSV file');
  });
});

describe('英文界面：自定义实体表单与只读表', () => {
  it('新建空表单的标签、表头、按钮与说明是英文，类型下拉的维度 / 事实与字段类型显示英文，终点实体下拉没有全角括号', () => {
    const html = render('en', createElement(CustomEntityForm, { intent: 'create', targets: TARGETS, submitting: false, submitLabel: 'Create' }));
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Display name');
    expect(html).toContain('Add field');
    expect(html).toContain('This entity');
    // 实体类型与字段类型走 builtinName（#1011 的词典），实体类型 / 字段类型的 option value 仍是代码名
    expect(html).toContain('Fact</option>');
    expect(html).toContain('Dimension</option>');
    expect(html).toContain('string (Text)</option>');
    expect(html).toContain('decimal (Decimal (2 places))</option>');
    // 终点实体下拉：名称（中文名）是路由传的数据，括号随界面语言
    expect(html).toContain('custom_store (Store)');
    expect(html).not.toContain('（');
  });

  it('编辑态（带回显值）、保存中、没有可选终点时同样没有汉字；只读字段表与关系表的表头、徽标是英文', () => {
    const saving = render('en', createElement(CustomEntityForm, {
      intent: 'save', entity: 'custom_visit', values: VALUES, targets: TARGETS, submitting: true, submitLabel: 'Save draft',
    }));
    expect(saving).not.toMatch(/[一-鿿]/);
    expect(saving).toContain('Saving…');
    expect(saving).toContain('Primary key of the target');

    const noTargets = render('en', createElement(CustomEntityForm, { intent: 'create', targets: [], submitting: false, submitLabel: 'Create' }));
    expect(noTargets).not.toMatch(/[一-鿿]/);
    expect(noTargets).toContain('None yet');

    const fields = render('en', createElement(EntityFieldsTable, { fields: VALUES.fields, primaryKey: VALUES.primaryKey }));
    expect(fields).not.toMatch(/[一-鿿]/);
    expect(fields).toContain('Field name');
    expect(fields).toContain('Primary key');
    expect(fields).toContain('Sensitive');

    const relations = render('en', createElement(EntityRelationsTable, { relations: VALUES.relations ?? [] }));
    expect(relations).not.toMatch(/[一-鿿]/);
    expect(relations).toContain('Relation: origin');
    expect(relations).toContain('Target');
  });
});

describe('表单提交的值不因界面语言改变', () => {
  it('实体类型、字段类型、寻址方式的 option value 仍是代码名，选中值相同，控件 name 不变', () => {
    const en = render('en', createElement(CustomEntityForm, { intent: 'save', entity: 'custom_visit', values: VALUES, targets: TARGETS, submitting: false, submitLabel: 'x' }));
    const zh = render('zh-CN', createElement(CustomEntityForm, { intent: 'save', entity: 'custom_visit', values: VALUES, targets: TARGETS, submitting: false, submitLabel: 'x' }));
    for (const html of [en, zh]) {
      expect(html).toContain('value="dimension"');
      expect(html).toContain('value="fact"');
      expect(html).toContain('value="string"');
      expect(html).toContain('value="timestamp"');
      expect(html).toContain('name="kind"');
      expect(html).toContain('name="fieldType"');
      // 回显值：kind=dimension、第二个字段 timestamp 选中态一致
      expect(html).toMatch(/value="dimension" selected(="")?/);
      expect(html).toMatch(/value="timestamp" selected(="")?/);
    }
    expect(render('en', createElement(SourceFields, { kind: 's3', values: {} }))).toContain('value="path"');
    expect(render('zh-CN', createElement(SourceFields, { kind: 's3', values: {} }))).toContain('value="path"');
  });
});

describe('中文界面输出与改造前一致', () => {
  it('数据源连接参数表单仍是原文：标签、提示、选项与凭据留空说明', () => {
    const pg = render('zh-CN', createElement(SourceFields, { kind: 'postgres', values: {} }));
    expect(pg).toContain('主机');
    expect(pg).toContain('数据库名');
    expect(pg).toContain('必须是只读账号：可写的账号会被拒绝');
    const s3 = render('zh-CN', createElement(SourceFields, { kind: 's3', values: {}, editing: true }));
    expect(s3).toContain('对象存储地址');
    expect(s3).toContain('path（/bucket/key）');
    expect(s3).toContain('已加密保存，留空表示不变');
    expect(render('zh-CN', createElement(SourceFields, { kind: 'upload', values: {}, editing: true }))).toContain('上传后不能修改');
  });

  it('自定义实体表单仍是原文：表头、行 aria-label、类型选项、关系说明与终点占位', () => {
    const html = render('zh-CN', createElement(CustomEntityForm, { intent: 'create', targets: TARGETS, submitting: true, submitLabel: '保存草稿' }));
    expect(html).toContain('中文名');
    expect(html).toContain('添加字段');
    expect(html).toContain('添加关系');
    expect(html).toContain('本实体');
    expect(html).toContain('第 1 行字段名');
    expect(html).toContain('第 1 条关系的起点实体');
    expect(html).toContain('string（文本）');
    expect(html).toContain('终点的主键');
    expect(html).toContain('正在保存…');
    expect(html).toContain('关系把一个字段指向另一个实体的主键，两端类型要相同。');
    expect(html).toContain('customer.customer_id、custom_store.store_id');
    expect(render('zh-CN', createElement(CustomEntityForm, { intent: 'create', targets: [], submitting: false, submitLabel: '保存草稿' }))).toContain('：暂无。');
    const fields = render('zh-CN', createElement(EntityFieldsTable, { fields: VALUES.fields, primaryKey: VALUES.primaryKey }));
    expect(fields).toContain('字段名');
    expect(fields).toContain('主键');
    expect(fields).toContain('敏感');
    const relations = render('zh-CN', createElement(EntityRelationsTable, { relations: VALUES.relations ?? [] }));
    expect(relations).toContain('关系：起点');
    expect(relations).toContain('终点');
  });
});
