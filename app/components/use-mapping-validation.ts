// app/components/use-mapping-validation.ts —— 映射 YAML 的实时校验：输入停顿约 600ms 后用 fetcher 提交 intent=validate（与保存同一套检查，不保存），
// 返回最新一次的结果。只在客户端改了内容后才提交，服务端渲染与没有脚本时始终是 idle
import { useEffect, useRef } from 'react';
import { useFetcher } from 'react-router';
import type { MappingIssueView } from '~/components/mapping-editor';

const DEBOUNCE_MS = 600;

export type MappingValidationState = 'idle' | 'checking' | 'ok' | 'issues';

export interface MappingValidationView {
  state: MappingValidationState;
  error: string | null;
  issues: MappingIssueView[];
  notices: MappingIssueView[];
}

interface ValidationData { ok: boolean; error: string | null; issues: MappingIssueView[]; notices?: MappingIssueView[] }

/**
 * action 是接口地址（新建页 /mappings、详情页 /mappings/:id），不给时不校验；extra 随 yaml 一起提交（新建页的 sourceId），变了也重新校验。
 * 首次渲染（还没改过）不提交。再次提交时 fetcher 取消在途的那次，只留最新一次的结果；防抖中与在途时 state 是 checking（不显示「校验通过」），问题仍是上一次的
 */
export function useMappingValidation(action: string | undefined, yaml: string, extra?: Record<string, string>): MappingValidationView {
  const fetcher = useFetcher<ValidationData>();
  const submit = useRef(fetcher.submit);
  submit.current = fetcher.submit;
  const extraKey = JSON.stringify(extra ?? {});
  const initial = useRef({ yaml, extraKey });
  const touched = useRef(false);
  // 最近一次提交的内容；与当前不同（防抖中）时上一次的结果已过时
  const submitted = useRef<string | null>(null);
  const key = `${extraKey}\n${yaml}`;
  useEffect(() => {
    if (!action) return;
    if (!touched.current && yaml === initial.current.yaml && extraKey === initial.current.extraKey) return;
    touched.current = true;
    const timer = setTimeout(() => {
      submitted.current = `${extraKey}\n${yaml}`;
      void submit.current({ intent: 'validate', yaml, ...JSON.parse(extraKey) }, { method: 'post', action });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [action, yaml, extraKey]);

  const data = action ? fetcher.data : undefined;
  const result = { error: data?.error ?? null, issues: data?.issues ?? [], notices: data?.notices ?? [] };
  if (action && (fetcher.state !== 'idle' || (touched.current && submitted.current !== key))) return { state: 'checking', ...result };
  if (!data) return { state: 'idle', ...result };
  return { state: data.ok ? 'ok' : 'issues', ...result };
}
