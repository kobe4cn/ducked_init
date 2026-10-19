// app/.server/pipeline/handlers.ts —— 各类任务在工作进程里做什么。连接只挂载了本租户的数据湖（默认库），表名不带前缀。
// 新增任务类型只改这里；参数在工作进程里校验，不合法时任务记为失败
import type { DuckDBConnection } from '@duckdb/node-api';
import type { EngineLimits, TenantLakeSession } from './lake-engine';
import { profileSource, type SourceSpec } from './source-engine';
import { checkKeyColumns, syncOptionsFromEnv, syncSourceTables, type SyncTableParam } from './sync-engine';
import { verifySourceLake, type VerifyTableParam } from './verify-engine';
import { inspectLake, type InspectParams } from './inspect-engine';
import { runKeyCheck, type KeyCheckParams } from './key-check-engine';
import { lit, mergeToSilver, type MergeDrop, type MergeGroupParam, type MergeMappingParam, type RelationParam } from './merge-engine';
import { MERGE_RULE_KINDS, type MergeRuleKind } from '../../lib/merge-groups';
import { LAKE_COVERAGE, type NotInLakeReason } from '../../lib/sources';
import { CONSUMER, DEVICE_OWNER, IDENTITIES } from './identity-engine';
import { TASK_KINDS, templateAt, TEMPLATES, type TemplateId } from './templates';
import { assertOrThrow, runAssertions } from './assertions';
import { ensureCustomerSourceColumns } from './customer-source-columns';
import { PartialFailure } from './partial-failure';
import { buildServingStore, servingPath, SNAPSHOT_TABLE, type ServingParams } from './serving-engine';

type Params = Record<string, unknown>;
type Result = Record<string, unknown>;

/**
 * 任务的运行环境：任务 ID，配额，任务涉及数据源时（参数带 sourceId）派发时解密好的连接参数，合并到标准层时租户的敏感信息盐，
 * 本租户数据湖的会话（attachSource 的任务里数据源也挂在其中），以及抹掉错误信息中凭据的函数
 */
export interface TaskContext { taskId: string; limits: EngineLimits; source?: SourceSpec; piiSalt?: string; session: TenantLakeSession; redact(message: string): string }

/**
 * attachSource：数据源与数据湖挂在同一个 DuckDB 里（在两者之间搬数据或对照的任务）；
 * readOnlyLake：数据湖只读挂载（只出报告、不写湖的任务）；servingFile：另挂一个本机库 serving（生成服务库，ADR-0033）
 */
interface Handler { label: string; attachSource?: boolean; readOnlyLake?: boolean; servingFile?: boolean; run(con: DuckDBConnection, params: Params, ctx: TaskContext): Promise<Result> }


const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/** 本租户数据湖里的全部表与行数 */
export async function inventory(con: DuckDBConnection) {
  const tables = await rows<{ schema: string; name: string }>(con, `
    SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'lake' ORDER BY ALL`);
  return Promise.all(tables.map(async t => {
    const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM "${t.schema}"."${t.name}"`);
    return { name: t.schema === 'main' ? t.name : `${t.schema}.${t.name}`, rows: Number(n) };
  }));
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string');

/** 同步参数里的表：水位线字段与种类要么都有、要么都没有（全量比对）。业务主键在旧任务里是单个字段 */
function syncTables(params: Params): SyncTableParam[] {
  const tables = params.tables;
  const valid = Array.isArray(tables) && tables.length > 0 && tables.every(t =>
    typeof t?.name === 'string'
    && (t.column === undefined ? t.kind === undefined : typeof t.column === 'string' && (t.kind === 'updated_at' || t.kind === 'increment'))
    && (t.key === undefined || typeof t.key === 'string' || isStrings(t.key))
    && (t.softDelete === undefined || typeof t.softDelete === 'string'));
  if (!valid) throw new Error('参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表');
  return (tables as (SyncTableParam | (Omit<SyncTableParam, 'key'> & { key: string }))[])
    .map(t => (typeof t.key === 'string' ? { ...t, key: [t.key] } : t as SyncTableParam));
}

/** 平台判断的未进湖原因：账号读不了、源端已删除由工作进程实时判断，不在参数里 */
const NOT_IN_LAKE_REASONS = Object.keys(LAKE_COVERAGE).filter(c => !['in_lake', 'unreadable', 'gone'].includes(c)) as NotInLakeReason[];

/** 核对参数里的表：最近一次列出表得到的清单（可以为空），每张带是否在同步范围内、平台判断的未进湖原因与同步设置 */
function verifyTables(params: Params): VerifyTableParam[] {
  const tables = params.tables;
  const valid = Array.isArray(tables) && tables.every(t =>
    typeof t?.name === 'string' && typeof t.inScope === 'boolean' && NOT_IN_LAKE_REASONS.includes(t.reason)
    && (t.key === undefined || isStrings(t.key))
    && (t.softDelete === undefined || typeof t.softDelete === 'string')
    && (t.column === undefined ? t.kind === undefined : typeof t.column === 'string' && (t.kind === 'updated_at' || t.kind === 'increment')));
  if (!valid) throw new Error('参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表');
  return tables as VerifyTableParam[];
}

/**
 * 合并参数里的映射：已发布的版本及其合并计划（发布时已校验过，这里只核对形状）。
 * 带了要撤下的停用映射时可以为空（停用的是实体最后一个映射）
 */
function mergeMappings(params: Params, drop: MergeDrop[]): MergeMappingParam[] {
  const mappings = params.mappings;
  const valid = Array.isArray(mappings) && (mappings.length > 0 || drop.length > 0) && mappings.every(m =>
    typeof m?.mapping === 'string' && Number.isInteger(m.version) && typeof m.sourceId === 'string'
    && typeof m.entity === 'string' && typeof m.table === 'string'
    && Array.isArray(m.columns) && m.columns.length > 0 && Array.isArray(m.entityColumns) && isStrings(m.key)
    && (m.latest === null || typeof m.latest === 'string') && (m.rebuild === undefined || typeof m.rebuild === 'boolean')
    && (m.uniqueKey === undefined || isStrings(m.uniqueKey)) && (m.uniqueBySource === undefined || typeof m.uniqueBySource === 'boolean')
    && (m.group === undefined || isMergeGroup(m.group)));
  if (!valid) throw new Error('参数 mappings 必须是非空的已发布映射列表');
  return mappings as MergeMappingParam[];
}

/** 合并参数里映射所在的合并组（ADR-0032）：组 ID、规则是三种之一、主键与组员（映射 ID、数据源、版本、去重键、引用列的数据源与可选的敏感列）非空 */
function isMergeGroup(group: unknown) {
  const g = group as Partial<MergeGroupParam> | null;
  const rule = g?.rule;
  return typeof g?.id === 'string' && isStrings(g.key)
    && MERGE_RULE_KINDS.includes(rule?.kind as MergeRuleKind) && (rule?.kind !== 'latest' || typeof rule.field === 'string')
    && Array.isArray(g.members) && g.members.length > 0 && g.members.every(m =>
      typeof m?.mapping === 'string' && typeof m.sourceId === 'string' && Number.isInteger(m.version) && isStrings(m.key)
      && (m.latest === null || typeof m.latest === 'string') && (m.keySpace === undefined || typeof m.keySpace === 'string')
      && Array.isArray(m.refs) && m.refs.every(r => typeof r?.column === 'string' && typeof r.source === 'string')
      && (m.sensitive === undefined || (Array.isArray(m.sensitive) && m.sensitive.every(c => typeof c === 'string'))));
}

/** 合并参数里要撤下的停用映射（ADR-0031）；停用之前入队的合并没有这一项 */
function mergeDrops(params: Params): MergeDrop[] {
  const drop = params.drop;
  if (drop === undefined) return [];
  if (!Array.isArray(drop) || !drop.every(d => typeof d?.mapping === 'string' && typeof d.entity === 'string')) {
    throw new Error('参数 drop 必须是 { mapping, entity } 列表');
  }
  return drop as MergeDrop[];
}

/** 合并参数里身份打通的匹配规则（入队时由全部 customer 映射汇总）；早先入队的合并没有这一项，用默认规则 */
function identityMatch(params: Params) {
  const rules = params.identity;
  if (rules === undefined) return undefined;
  if (!isStrings(rules)) throw new Error('参数 identity 必须是非空的字段名列表');
  return rules;
}

/**
 * 合并参数里是否强制重算身份打通（入队时发现匹配规则变了或上次打通失败，工作进程不读平台库判断不出来）；
 * 早先入队的合并没有这一项，按不强制处理
 */
function identityForce(params: Params) {
  const force = params.identityForce;
  if (force !== undefined && typeof force !== 'boolean') throw new Error('参数 identityForce 必须是布尔值');
  return force ?? false;
}

/** 合并参数里属性取舍的名次：映射 ID → 正整数名次（入队时由全部 customer 映射汇总）；早先入队的合并没有这一项，只按 updated_at 取最新 */
function mergeSurvivorship(params: Params): Record<string, number> {
  const { survivorship } = params;
  if (survivorship === undefined) return {};
  const valid = typeof survivorship === 'object' && survivorship !== null && !Array.isArray(survivorship)
    && Object.values(survivorship).every(r => Number.isInteger(r) && (r as number) >= 1);
  if (!valid) throw new Error('参数 survivorship 必须是映射 ID 到正整数名次的对照');
  return survivorship as Record<string, number>;
}

/** 合并参数里不进 _consumer 的敏感字段（入队时由全部 customer 映射汇总）；早先入队的合并没有这一项，只看这次合并的映射 */
function mergeConsumerSensitive(params: Params): string[] {
  const { consumerSensitive } = params;
  if (consumerSensitive === undefined) return [];
  if (!Array.isArray(consumerSensitive) || !consumerSensitive.every(s => typeof s === 'string')) throw new Error('参数 consumerSensitive 必须是字段名列表');
  return consumerSensitive;
}

/** 合并参数里要统计孤儿的已发布关系（入队时带上全部关系与起点是否敏感）；早先入队的合并没有这一项，不统计 */
function mergeRelations(params: Params): RelationParam[] {
  const { relations } = params;
  if (relations === undefined) return [];
  const isEnd = (v: unknown) => typeof (v as { entity?: unknown })?.entity === 'string' && typeof (v as { field?: unknown }).field === 'string';
  if (!Array.isArray(relations) || !relations.every(r => isEnd(r?.from) && isEnd(r?.ref) && typeof r.sensitive === 'boolean')) {
    throw new Error('参数 relations 必须是关系列表（from、ref 与 sensitive）');
  }
  return relations as RelationParam[];
}

/** 漂移检查参数里的应有结构：表名 → 列名 → 类型（入队时由已发布映射算出） */
function inspectExpected(params: Params): InspectParams['expected'] {
  const { expected } = params;
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(expected) || !Object.values(expected).every(t => isObject(t) && Object.values(t).every(v => typeof v === 'string'))) {
    throw new Error('参数 expected 必须是 表名 → 列名 → 类型 的对象');
  }
  return expected as InspectParams['expected'];
}

/** 主键冲突体检参数里的实体：主键、是否按数据源比较、各映射与映射出来的列、所在的合并组（入队时由已发布映射算出） */
function keyCheckTargets(params: Params): KeyCheckParams['entities'] {
  const { entities } = params;
  const valid = Array.isArray(entities) && entities.every(e =>
    typeof e?.entity === 'string' && isStrings(e.key) && typeof e.bySource === 'boolean'
    && Array.isArray(e.mappings) && e.mappings.every((m: { mapping?: unknown; columns?: unknown; group?: unknown }) =>
      typeof m?.mapping === 'string' && isStrings(m.columns) && (m.group === undefined || typeof m.group === 'string')));
  if (!valid) throw new Error('参数 entities 必须是 { entity, key, bySource, mappings: { mapping, columns, group? }[] } 列表');
  return entities as KeyCheckParams['entities'];
}

/** 生成服务库的参数：版本、上传位置（必须是本租户存储前缀下这一版的位置）与要放进去的快照（调用方从平台库查出） */
function servingParams(params: Params, dataPath: string): ServingParams {
  const { version, target, snapshots } = params;
  if (!Number.isInteger(version) || (version as number) < 1) throw new Error('参数 version 必须是正整数');
  if (target !== servingPath(dataPath, version as number)) throw new Error(`参数 target 必须是 ${servingPath(dataPath, version as number)}`);
  const valid = Array.isArray(snapshots) && snapshots.every(s =>
    typeof s?.id === 'string' && typeof s.template === 'string' && typeof s.table === 'string' && SNAPSHOT_TABLE.test(s.table));
  if (!valid) throw new Error('参数 snapshots 必须是 { id, template, table } 列表，table 是结果层快照表名');
  return { version: version as number, target, snapshots: snapshots as ServingParams['snapshots'] };
}

function positiveInt(params: Params, key: string, max: number) {
  const v = params[key];
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new Error(`参数 ${key} 必须是 1 到 ${max} 之间的整数`);
  return v as number;
}

/** silver 下缺了某张表时的说明：先做什么才会有它 */
function missingTableHint(table: string) {
  if (table === '_identities') return `标准层还没有身份打通结果（${IDENTITIES}）：先发布 customer 映射并合并`;
  if (table === '_consumer') return `标准层还没有统一消费者属性（${CONSUMER}）：重新合并一次映射`;
  if (table.startsWith('_')) return `标准层还没有 silver.${table}：重新合并一次映射`;
  return `标准层还没有 silver.${table}：先发布 ${table} 映射并合并`;
}

/**
 * 分析模板任务（ADR-0004）：按参数（asOf 必填，其余取模板默认值）把标准层编译成模板的 SELECT，
 * 写进结果层的一张快照表 gold."<模板 ID>__<任务 ID>"，只有 consumer_id 与汇总值，没有明文。
 * 发布、重新计算或定时刷新入队的任务带上定义版本 definitionVersion 与来源 trigger（登记快照时记下），以及定义锁定的模板版本
 * templateVersion（按注册表里这个版本编译，没有这个版本时任务失败；不带时按第 1 版），其余参数是定义的参数加上 asOf；
 * 也可以直接给参数、不带版本。开头给没重新合并过的老湖补 _customer_source（订单按它关联消费者，ADR-0030），
 * 再查模板要求的表；计算前对读到的实体跑内置断言（ADR-0026），error 级失败时任务失败、不写快照表。
 * 结果带表名、行数、补全后的参数、全部断言 assertions，以及模板另报的计数（如 RFM 打通不到消费者的订单数 unlinkedOrders）
 */
function templateTask(id: TemplateId): Handler {
  return {
    label: TEMPLATES[id].label,
    async run(con, params, { taskId }) {
      // templateVersion 要在 parse 之前剥掉：parse 拒绝不认识的键
      const { definitionVersion: _, trigger: __, templateVersion, ...rest } = params;
      // 各模板的参数类型不同，这里只在 parse 与 compile 之间传递
      if (templateVersion !== undefined && !Number.isInteger(templateVersion)) throw new Error('参数 templateVersion 必须是整数');
      const template = templateAt(id, (templateVersion as number | undefined) ?? 1);
      const p = template.parse(rest);
      await ensureCustomerSourceColumns(con);
      const tables = [...template.requires, ...template.optional ?? []];
      const present = new Set((await rows<{ name: string }>(con, `
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${tables.map(lit).join(', ')})`)).map(t => t.name));
      const missing = template.requires.find(t => !present.has(t));
      if (missing) throw new Error(missingTableHint(missing));
      const assertions = await runAssertions(con, template.entities, taskId);
      assertOrThrow(assertions);
      const name = `${id}__${taskId}`;
      await con.run(`CREATE TABLE gold."${name}" AS ${template.compile(p, t => present.has(t))}`);
      const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM gold."${name}"`);
      const counts: Record<string, number> = {};
      for (const [key, sql] of Object.entries(template.counts?.(p) ?? {})) counts[key] = Number((await rows<{ n: string }>(con, sql))[0].n);
      return { table: `gold.${name}`, rows: Number(n), ...counts, params: p, assertions };
    },
  };
}

/** 每个模板的任务类型 → 它的任务 */
const TEMPLATE_HANDLERS = Object.fromEntries((Object.keys(TASK_KINDS) as TemplateId[]).map(id => [TASK_KINDS[id], templateTask(id)])) as
  { [K in TemplateId as (typeof TASK_KINDS)[K]]: Handler };

export const HANDLERS = {
  'lake.inventory': {
    label: '盘点数据湖',
    run: async con => ({ tables: await inventory(con) }),
  },
  // 造数夹具：与 src/01_seed.ts 相同，用 hash() 确定性生成消费者与订单，同样的参数每次得到同样的数据
  'demo.seed': {
    label: '生成演示数据',
    async run(con, params) {
      const customers = positiveInt(params, 'customers', 1_000_000);
      const u01 = (x: string, salt: number) => `((hash(${x}::BIGINT * 1000003 + ${salt}) % 10000000)::DOUBLE / 1e7)`;
      await con.run(`
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS customers;
        CREATE TABLE customers AS
        SELECT i AS customer_id,
               '消费者' || i AS name,
               ['北京','上海','广州','深圳','杭州','成都','武汉','西安'][1 + floor(${u01('i', 7)} * 8)::INT] AS city,
               TIMESTAMP '2024-01-01' + to_seconds((${u01('i', 4)} * 83000000)::BIGINT) AS created_at
        FROM range(1, ${customers} + 1) t(i);
        CREATE TABLE orders AS
        SELECT row_number() OVER (ORDER BY c.customer_id, k) AS order_id,
               c.customer_id,
               c.created_at + to_days((${u01('c.customer_id * 17 + k', 11)} * 600)::INT) AS order_ts,
               round(20 + ${u01('c.customer_id * 17 + k', 12)} * 980, 2) AS pay_amount
        FROM customers c, range(floor(${u01('c.customer_id', 10)} * 6)::BIGINT) r(k);`);
      return { tables: await inventory(con) };
    },
  },
  // 采集数据源：同步范围内的表（参数 tables）的行数、列统计与水位线候选，范围外的表不碰。
  // 数据源只读挂载在另一个 DuckDB 里，不碰本租户的数据湖
  'source.profile': {
    label: '采集数据源',
    async run(_con, params, { source, limits }) {
      if (!source) throw new Error('缺少数据源');
      if (!isStrings(params.tables)) throw new Error('参数 tables 必须是非空的表名列表');
      return profileSource(source, limits, { tables: params.tables });
    },
  },
  // 同步：每张表一个变更批次追加到原始层。有水位线的表增量读取，到了比对周期再比对一次主键全集（没有主键时整行全量比对）；
  // 没有水位线的表全量比对。参数 reconcile 为真时（成员在核对发现差异后触发）不等比对周期，增量之后都比对一次。
  // 有表失败时任务记为失败，结果里保留各表的批次与错误；源端已经没有的表跳过，不算失败
  'source.sync': {
    label: '同步数据源',
    attachSource: true,
    async run(_con, params, { source, session, limits, redact }) {
      if (!source) throw new Error('缺少数据源');
      if (typeof params.sourceId !== 'string') throw new Error('缺少参数 sourceId');
      const options = params.reconcile === true ? { ...syncOptionsFromEnv(), reconcileHours: 0 } : syncOptionsFromEnv();
      const tables = await syncSourceTables(session, source, params.sourceId, syncTables(params), limits, redact, options);
      const failed = tables.filter(t => 'error' in t && !t.gone);
      if (failed.length) {
        throw new PartialFailure(`${failed.length} 张表同步失败：${failed.map(t => `${t.table}（${'error' in t ? t.error : ''}）`).join('；')}`, { tables });
      }
      return { tables };
    },
  },
  // 校验业务主键：成员声明的组合在源表全表上是否非空且唯一，按租户配额分桶检查（源端只读，数据湖只给溢写目录）。
  // 有空值或重复时任务仍记为成功，ok 为假；通过时调度器写回声明（source-key-check.ts）。主键列像敏感信息时重复键不带取值（ADR-0005）
  'source.keycheck': {
    label: '校验业务主键',
    attachSource: true,
    readOnlyLake: true,
    async run(_con, params, { source, session, limits }) {
      if (!source || !session.source) throw new Error('缺少数据源');
      const { tableName, keyColumns } = params;
      if (typeof tableName !== 'string') throw new Error('缺少参数 tableName');
      if (!isStrings(keyColumns)) throw new Error('参数 keyColumns 必须是非空的字段列表');
      const table = (await session.source.tables()).find(t => t.name === tableName);
      if (!table) throw new Error(`数据源中已没有表 ${tableName}`);
      if (!table.readable) throw new Error(`账号没有表 ${tableName} 的读权限`);
      const { nullRows, duplicates } = await checkKeyColumns(session.con, source, table, keyColumns, limits);
      return {
        tableName, keyColumns, ok: nullRows === 0 && duplicates.length === 0, nullRows,
        duplicates: duplicates.map(d => ({ key: params.sensitive === true ? null : d.key, count: d.count })),
      };
    },
  },
  // 核对湖中数据：源端的全部表标出是否进湖与源端行数，已进湖的表再核对位置、文件、结构与数据量。
  // 数据湖只读挂载，只出报告不写湖；differences 是已进湖、四项有不一致的表数
  'source.verify': {
    label: '核对湖中数据',
    attachSource: true,
    readOnlyLake: true,
    async run(_con, params, { source, session, limits, redact }) {
      if (!source) throw new Error('缺少数据源');
      if (typeof params.sourceId !== 'string') throw new Error('缺少参数 sourceId');
      const tables = await verifySourceLake(session, source, params.sourceId, verifyTables(params), limits, redact);
      return { tables, differences: tables.filter(t => t.ok === false).length };
    },
  },
  // 漂移检查：对比标准层表的实际结构与参数里的应有结构（入队时由已发布映射算出），报告缺列、多列、类型不一致与孤表。
  // 数据湖只读挂载，只出报告不写湖；修复走合并
  'lake.inspect': {
    label: '漂移检查',
    readOnlyLake: true,
    run: (con, params) => inspectLake(con, { expected: inspectExpected(params) }),
  },
  // 主键冲突体检：对每个实体里主键撞上的每对映射，统计重叠的键数、样本键与字段一致的比例，给出建议（ADR-0024）。
  // 数据湖只读挂载，只出报告不改标准层
  'silver.keycheck': {
    label: '主键冲突体检',
    readOnlyLake: true,
    run: (con, params) => runKeyCheck(con, { entities: keyCheckTargets(params) }),
  },
  // 合并到标准层：按已发布的映射把原始层里新的变更批次合并进标准层，每个映射各自一个事务，之后按参数里的匹配规则重算身份打通
  // （没改到 customer / event、结果表都在且参数没要求强制时跳过打通，结果里写明原因）。
  // 有映射或打通失败时任务记为失败，结果里保留各映射的合并结果、打通摘要（组数、记录数与已归属设备数，不带哈希）与错误；
  // 源表还没同步进原始层的映射跳过，不算失败。结果另带各关系的孤儿统计，统计出错不算失败。
  // 参数带 drop 时先撤下这些停用的映射写进标准层的行（ADR-0031），结果里记在 dropped
  'silver.merge': {
    label: '合并到标准层',
    async run(_con, params, { taskId, session, piiSalt, redact }) {
      if (!piiSalt) throw new Error('缺少敏感信息盐');
      const drop = mergeDrops(params);
      const result = await mergeToSilver(
        session, mergeMappings(params, drop), piiSalt, redact, identityMatch(params), mergeRelations(params), identityForce(params),
        mergeConsumerSensitive(params), mergeSurvivorship(params), drop, taskId,
      );
      const failed = result.mappings.filter(m => 'error' in m);
      const problems = [
        ...(failed.length ? [`${failed.length} 个映射合并失败：${failed.map(m => `${m.entity} ← ${m.table}（${'error' in m ? m.error : ''}）`).join('；')}`] : []),
        ...(result.identities && 'error' in result.identities ? [`身份打通失败：${result.identities.error}`] : []),
      ];
      if (problems.length) throw new PartialFailure(problems.join('；'), result);
      return result;
    },
  },
  ...TEMPLATE_HANDLERS,
  // 指标或标签（ADR-0025）：发布定义时入队，参数里带上入队时按当天编译好的 SQL 与它用到的实体（不再访问平台库）。
  // 标准层有这些实体与身份打通结果（SQL 用到设备归属时还要有 _device_owner，用到 consumer 维度时还要有 _consumer）时，把 SQL 的结果写进结果层的一张快照表 gold."<种类>__<任务 ID>"，只有 consumer_id、维度与值。
  // 断言与开头补 _customer_source 同分析模板任务（templateTask）
  'gold.dsl': {
    label: '指标与标签',
    async run(con, params, { taskId }) {
      const { kind, key, asOf, definitionVersion, sql, entities } = params;
      if (typeof kind !== 'string' || !/^[a-z]+$/.test(kind)) throw new Error('参数 kind 不合法');
      if (typeof sql !== 'string' || !sql) throw new Error('缺少参数 sql');
      if (!isStrings(entities)) throw new Error('参数 entities 必须是非空的实体名列表');
      await ensureCustomerSourceColumns(con);
      const present = new Set((await rows<{ name: string }>(con, `
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${[...entities, '_identities', '_device_owner', '_consumer'].map(lit).join(', ')})`)).map(t => t.name));
      const missing = entities.filter(entity => !present.has(entity));
      if (missing.length) throw new Error(`标准层还没有 ${missing.map(entity => `silver.${entity}`).join('、')}：先发布 ${missing.join('、')} 的映射并合并`);
      if (!present.has('_identities')) throw new Error(`标准层还没有身份打通结果（${IDENTITIES}）：先发布 customer 映射并合并`);
      if (sql.includes(DEVICE_OWNER) && !present.has('_device_owner')) throw new Error(`标准层还没有设备归属结果（${DEVICE_OWNER}）：重新合并一次映射`);
      if (sql.includes(CONSUMER) && !present.has('_consumer')) throw new Error(`标准层还没有统一消费者属性（${CONSUMER}）：重新合并一次映射`);
      const assertions = await runAssertions(con, entities, taskId);
      assertOrThrow(assertions);
      const name = `${kind}__${taskId}`;
      await con.run(`CREATE TABLE gold."${name}" AS ${sql}`);
      const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM gold."${name}"`);
      return { table: `gold.${name}`, rows: Number(n), params: { kind, key, asOf, definitionVersion }, assertions };
    },
  },
  // 快照过期：删掉参数里到期快照的表（已删的跳过，重复执行不报错），再按 ADR-0020 擦除湖里的数据：
  // 删整张表后它的文件不再被当前的 DuckLake 快照引用，不用像删除请求那样重写数据文件；让此前的 DuckLake 快照全部过期，再从存储上删掉旧文件。
  // 过期的 DuckLake 快照是整个租户湖的，此后时间旅行只能回到这一刻；平台没有依赖更早版本的功能（镜像也只看当前版本，ADR-0010）
  'gold.expire': {
    label: '快照过期',
    async run(con, params) {
      const tables = params.tables;
      if (!isStrings(tables) || !tables.every(t => /^gold\.[a-z][a-z0-9]*__[0-9a-f-]{36}$/.test(t))) {
        throw new Error('参数 tables 必须是非空的结果层快照表名列表');
      }
      for (const t of tables) await con.run(`DROP TABLE IF EXISTS gold."${t.slice('gold.'.length)}"`);
      await con.run(`
        CALL ducklake_expire_snapshots('lake', older_than => now());
        CALL ducklake_cleanup_old_files('lake', cleanup_all => true);`);
      return { tables };
    },
  },
  // 生成服务库（ADR-0033）：把参数里的快照表（各已发布定义最新、未过期的快照，调用方从平台库查出）合成一个 DuckDB 文件，
  // 表都按 consumer_id 排序写入，再上传到本租户存储前缀下的 _serving/v<版本>.duckdb。数据湖只读挂载；表名不合规或表不在时失败、不上传
  'serving.build': {
    label: '生成服务库',
    readOnlyLake: true,
    servingFile: true,
    async run(_con, params, { session }) {
      const store = servingParams(params, session.lake.dataPath);
      return { version: store.version, path: store.target, rows: await buildServingStore(session, store) };
    },
  },
} satisfies Record<string, Handler>;

export type TaskKind = keyof typeof HANDLERS;

export const isTaskKind = (kind: string): kind is TaskKind => Object.hasOwn(HANDLERS, kind);
