// app/.server/pipeline/templates/index.ts —— 分析模板注册表（ADR-0004）：模板 ID → 名称、默认参数、参数校验与编译函数。
// 编译函数是纯函数，同样的参数得到同样的 SQL；SQL 只读标准层，产出写进结果层由任务负责
import { compileRfm, parseRfmDefinition, parseRfmParams, RFM_DEFAULTS, type RfmParams } from './rfm';

export interface Template<P, D = Partial<P>> {
  label: string;
  /** 除必填参数以外的默认参数 */
  defaults: D;
  /** 校验任务参数并补上默认值，不合法时抛出说明原因的错误 */
  parse(params: Record<string, unknown>): P;
  /** 校验模板定义的参数（不含每次运行时给定的参数）并补上默认值，不合法时抛出说明原因的错误 */
  parseDefinition(params: Record<string, unknown>): D;
  /** 编译成一条 SELECT，每个统一消费者一行 */
  compile(params: P): string;
}

export const TEMPLATES = {
  rfm: { label: 'RFM 分层', defaults: RFM_DEFAULTS, parse: parseRfmParams, parseDefinition: parseRfmDefinition, compile: compileRfm } satisfies Template<RfmParams, Omit<RfmParams, 'asOf'>>,
};
