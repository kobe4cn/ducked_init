// test/i18n-mapping-form.test.ts —— 映射表单的转换名称与校验提示接入双语（#1043，ADR-0060，纯函数，不连库）：
// mapping-form lib 返回的中文（各 reader 的 reason、formUnavailable、extensionNameProblem）与抛的错（expressionOf、write*）
// 改为 Msg / MsgError：message 固定中文（服务端报错与 toThrow 断言读它），msgText 按界面语言出文字——英文是英文；
// 中文界面回退中文原文，逐字与改造前一致。嵌套参数（{transform}要选一个源列 的转换名、{name}：{reason} 的 reason、
// 表达式有误（{error}）里 ExprError 的 detail）由 translate 递归翻译，中文逐字不变、英文是英文。
// TRANSFORMS 的中文 label / hint 是数据（提交值用 tr.id、单位用代码值 seconds / millis，不接翻译），
// 页面展示经 transformText 按转换 id 查字面量对照表（照 functionText，#1042）；表单行的英文渲染见 mapping-form-render.test.ts
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { makeT, MsgError, msgText, type Msg } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';
import { entityOf } from '../app/lib/canonical-model';
import {
  extensionNameProblem, formUnavailable, expressionOf, newExtension, readExtensions, readForm, readIdentity, readSurvivorship, TRANSFORMS,
  writeExtension, writeField, writeIdentity, writeSurvivorship, type TransformId,
} from '../app/lib/mapping-form';
import { transformText } from '../app/lib/mapping-transforms-text';

const HAN = /[一-鿿]/;
const en = makeT('en', enClient);
const zh = makeT('zh-CN', null);
/** 中文界面下 reason / 抛错说明的文字（改造前的中文原文） */
const zhText = (m: Msg | undefined) => (m === undefined ? undefined : msgText(zh, m));
const ORDER = entityOf('order')!;

/** 调用必然抛 MsgError，返回它的中文 message 与英文界面的文字 */
const throws = (fn: () => unknown): { message: string; en: string } => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MsgError);
    const err = e as MsgError;
    return { message: err.message, en: msgText(en, err.detail) };
  }
  throw new Error('没有抛错');
};

describe('reader 的 reason 带句式：中文逐字不变，英文是英文', () => {
  it('readForm：表单不认识的写法、非枚举字段的值字典、解析不了的表达式、fields 不是字段表', () => {
    const doc = parseDocument(`model: 1
entity: order
table: orders
fields:
  order_id: { expr: order_no, foo: 1 }
  status: { expr: status, dictionary: { paid: [a] } }
  amount: { expr: amount, dictionary: { a: b } }
  channel: "'abc"
`);
    const reason = Object.fromEntries(readForm(doc, ORDER).map(f => [f.field, f.reason]));
    expect(zhText(reason.order_id)).toBe('这种写法表单不认识，请在 YAML 里修改');
    expect(zhText(reason.status)).toBe('这种写法表单不认识，请在 YAML 里修改');
    expect(zhText(reason.amount)).toBe('非枚举字段带值字典或兜底值（dictionary / otherwise），请在 YAML 里修改');
    expect(zhText(reason.channel)).toBe(`表达式有误（字符串没有结束的 '），请在 YAML 里修改`);
    for (const key of ['order_id', 'status', 'amount', 'channel']) expect(msgText(en, reason[key]!), key).not.toMatch(HAN);
    // 嵌套的 ExprError 在英文下也是英文
    expect(msgText(en, reason.channel!)).toBe("The expression is invalid (Unterminated string: no closing '); edit it in the YAML");
    // fields 下不是字段表
    const notMap = readForm(parseDocument('fields: [a]\n'), ORDER)[0].reason;
    expect(zhText(notMap)).toBe('fields 下不是字段表，请在 YAML 里修改');
    expect(msgText(en, notMap!)).toBe('fields is not a field map; edit it in the YAML');
  });

  it('readExtensions：extensions 不是字段表、认不出的写法、类型不是标准层的类型', () => {
    const notMap = readExtensions(parseDocument('extensions: [a]\n')).reason!;
    expect(zhText(notMap)).toBe('extensions 下不是字段表，请在 YAML 里修改');
    expect(msgText(en, notMap)).toBe('extensions is not a field map; edit it in the YAML');
    const { extensions } = readExtensions(parseDocument(`extensions:
  x_odd: { type: string, expr: odd, key_space: [a] }
  x_money: { type: money, expr: money }
`));
    const byName = Object.fromEntries(extensions.map(e => [e.name, e.reason]));
    expect(zhText(byName.x_odd)).toBe('这种写法表单不认识，请在 YAML 里修改');
    expect(zhText(byName.x_money)).toBe('类型 money 不是标准层的类型，请在 YAML 里修改');
    expect(msgText(en, byName.x_money!)).toBe('Type money is not a Silver-layer type; edit it in the YAML');
  });

  it('readIdentity / readSurvivorship：写法表单不认识', () => {
    const identity = readIdentity(parseDocument('identity: [phone]\n')).reason!;
    expect(zhText(identity)).toBe('identity 的写法表单不认识，请在 YAML 里修改');
    expect(msgText(en, identity)).not.toMatch(HAN);
    const survivorship = readSurvivorship(parseDocument('survivorship: { priority: 0 }\n')).reason!;
    expect(zhText(survivorship)).toBe('survivorship 的写法表单不认识，请在 YAML 里修改');
    expect(msgText(en, survivorship)).not.toMatch(HAN);
  });
});

describe('formUnavailable 带句式：中文逐字不变，英文是英文', () => {
  const HAND = 'model: 1\nentity: order\ntable: orders\nfields:\n  order_id: order_no\n';

  it('目标实体不是标准实体', () => {
    const m = formUnavailable(parseDocument(HAND), 'custom_store')!;
    expect(zhText(m)).toBe('custom_store 不是标准实体，表单只列标准实体的字段，请在 YAML 里编写。');
    expect(msgText(en, m)).not.toMatch(HAN);
  });

  it('YAML 有语法错误：有行号与无行号两条完整句', () => {
    const doc = parseDocument('fields: [\n');
    const m = formUnavailable(doc, 'order')!;
    const e = doc.errors[0];
    expect(zhText(m)).toBe(`YAML 有语法错误（第 ${e.linePos![0].line} 行：${e.message.split('\n')[0]}），改好之前表单无法显示。`);
    expect(msgText(en, m)).toMatch(/^The YAML has a syntax error \(line \d+: /);
    expect(msgText(en, m)).not.toMatch(HAN);
    // linePos 为空（无行号）时是不带行号的另一条句式
    (doc.errors[0] as { linePos?: unknown }).linePos = undefined;
    const m2 = formUnavailable(doc, 'order')!;
    expect(zhText(m2)).toBe(`YAML 有语法错误（${e.message.split('\n')[0]}），改好之前表单无法显示。`);
    expect(msgText(en, m2)).toMatch(/^The YAML has a syntax error \(/);
    expect(msgText(en, m2)).not.toMatch(HAN);
  });

  it('YAML 里写的实体与目标实体不一致', () => {
    const m = formUnavailable(parseDocument(HAND), 'customer')!;
    expect(zhText(m)).toBe('YAML 里写的实体是 order，与目标实体 customer 不一致；请改成一致或按规则重新生成草稿。');
    expect(msgText(en, m)).not.toMatch(HAN);
  });

  it('能显示时为 null', () => {
    expect(formUnavailable(parseDocument(HAND), 'order')).toBeNull();
  });
});

describe('extensionNameProblem 带句式：中文逐字不变，英文是英文', () => {
  it('名字不合格、与已有的重名、合格时为 null', () => {
    const bad = extensionNameProblem('nope', [])!;
    expect(zhText(bad)).toBe('名字要以 x_ 开头，只用小写字母、数字与下划线');
    expect(msgText(en, bad)).not.toMatch(HAN);
    const taken = extensionNameProblem('x_a', ['x_a'])!;
    expect(zhText(taken)).toBe('扩展字段 x_a 已有，换一个名字');
    expect(msgText(en, taken)).toBe('Extension field x_a already exists; pick another name');
    expect(extensionNameProblem('x_a', ['x_b'])).toBeNull();
  });
});

describe('expressionOf / write* / newExtension 抛 MsgError：message 中文逐字不变，英文是英文', () => {
  it('expressionOf：不认识的转换、要选源列（转换名是嵌套参数）、自定义表达式为空', () => {
    expect(throws(() => expressionOf({ transform: 'nope' as TransformId }))).toMatchObject({ message: '不认识的转换：nope' });
    const column = throws(() => expressionOf({ transform: 'direct' }));
    expect(column.message).toBe('直接取值要选一个源列');
    expect(column.en).toBe('Direct value needs a source column');
    const empty = throws(() => expressionOf({ transform: 'custom' }));
    expect(empty.message).toBe('自定义表达式不能为空');
    expect(empty.en).not.toMatch(HAN);
  });

  it('writeField / writeExtension：只读字段与重名的说明（{name}：{reason} 的 reason 是嵌套参数）', () => {
    const field = throws(() => writeField(parseDocument('fields:\n  order_id: { expr: order_no, foo: 1 }\n'), ORDER, 'order_id', { transform: 'direct', column: 'x' }));
    expect(field.message).toBe('order_id：这种写法表单不认识，请在 YAML 里修改');
    expect(field.en).toBe('order_id: The form does not recognize this notation; edit it in the YAML');
    const ext = throws(() => writeExtension(parseDocument('extensions:\n  x_odd: { type: string, expr: odd, key_space: [a] }\n'), 'x_odd', null));
    expect(ext.message).toBe('x_odd：这种写法表单不认识，请在 YAML 里修改');
    expect(ext.en).not.toMatch(HAN);
    const taken = throws(() => writeExtension(parseDocument('extensions:\n  x_a: { type: string, expr: a }\n  x_b: { type: string, expr: b }\n'), 'x_a', { name: 'x_b', type: 'string', expr: 'a' }));
    expect(taken.message).toBe('扩展字段 x_b 已有，换一个名字');
    expect(taken.en).not.toMatch(HAN);
  });

  it('writeIdentity / writeSurvivorship / newExtension', () => {
    const identity = throws(() => writeIdentity(parseDocument('identity: [phone]\n'), ['phone']));
    expect(identity.message).toBe('identity 的写法表单不认识，请在 YAML 里修改');
    expect(identity.en).not.toMatch(HAN);
    const survivorship = throws(() => writeSurvivorship(parseDocument('survivorship: { priority: 0 }\n'), 2));
    expect(survivorship.message).toBe('survivorship 的写法表单不认识，请在 YAML 里修改');
    expect(survivorship.en).not.toMatch(HAN);
    const column = throws(() => newExtension({ columns: [{ name: 'a', type: 'text' }] }, 'nope', []));
    expect(column.message).toBe('源表里没有列 nope');
    expect(column.en).toBe('The source table has no column nope');
  });
});

describe('常用转换的名称与参数说明（transformText）：中文逐字等于 TRANSFORMS，英文没有汉字', () => {
  it('TRANSFORMS 里每个转换都对得上：label、参数 label / hint、单位选项名；tr.id 与单位 value 不变', () => {
    for (const tr of TRANSFORMS) {
      const zh_ = transformText(zh, tr);
      const en_ = transformText(en, tr);
      expect(zh_.label, tr.id).toBe(tr.label);
      expect(en_.label, tr.id).not.toMatch(HAN);
      expect(zh_.args, tr.id).toHaveLength(tr.args.length);
      tr.args.forEach((a, i) => {
        expect(zh_.args[i].label, tr.id).toBe(a.label);
        expect(zh_.args[i].hint, tr.id).toBe(a.hint);
        expect(en_.args[i].label, tr.id).not.toMatch(HAN);
        if (a.hint) expect(en_.args[i].hint, tr.id).not.toMatch(HAN);
        a.options?.forEach((o, j) => {
          expect(zh_.args[i].options?.[j], tr.id).toEqual(o);
          expect(en_.args[i].options?.[j], tr.id).toMatchObject({ value: o.value });
          expect(en_.args[i].options?.[j].label, tr.id).not.toMatch(HAN);
        });
      });
    }
  });

  it('英文译文抽查：转换名、参数提示与单位选项', () => {
    const of = (id: TransformId) => transformText(en, TRANSFORMS.find(tr => tr.id === id)!);
    expect(of('direct').label).toBe('Direct value');
    expect(of('timezone').args[0].label).toBe('Source time zone');
    expect(of('epoch').args[0].options).toEqual([{ value: 'seconds', label: 'Seconds' }, { value: 'millis', label: 'Milliseconds' }]);
    expect(of('fixed').args[0].label).toBe('Value');
  });

  it('不认识的转换 id 回退传入的原文', () => {
    const tr = { id: 'nope' as TransformId, label: '直接取值', column: true, args: [{ label: '源端时区', hint: 'IANA 时区名，如 Asia/Shanghai' }] };
    expect(transformText(zh, tr)).toEqual({ label: '直接取值', args: tr.args });
    expect(transformText(en, tr)).toEqual({ label: '直接取值', args: tr.args });
  });
});
