import { describe, expect, it } from 'vitest';
import { changedFiles } from '../.sandcastle/guide';

const guide = (lines: string) => `## What to build\n\n改 \`app/x.ts:1\`。\n\n## Implementation guide\n\n${lines}\n\n## Blocked by\n\n- #1\n`;

describe('Sandcastle 指引里要改的文件 changedFiles', () => {
  it('一行一个 **Change**：去掉行号，括号说明与全角冒号也认，New / Reuse 不算', () => {
    const body = guide([
      '- **Change**: `app/.server/a.ts:10-20` `fn`：改这里。',
      '- **Change**（只改 import）：`app/.server/b.ts:3`',
      '- **New**: `app/.server/c.ts`：新模块。',
      '- **Reuse**: `lit(s: string)` 在 `app/lib/mapping-expr.ts:79`。',
    ].join('\n'));
    expect(changedFiles(body)).toEqual({ files: ['app/.server/a.ts', 'app/.server/b.ts'], fallback: false });
  });

  it('**Change** 下面缩进的子条目各算一个文件，回到顶层条目后不再算', () => {
    const body = guide([
      '- **Change**: `app/.server/pipeline/merge-engine.ts:140-157`：删六个导出。',
      '- **Change**（每个文件只改一行 import）：',
      '  - `app/.server/source-views.ts:14` `ident` → `../lib/mapping-expr`',
      '  - `test/pipeline/assertions.test.ts:12` `lit` → `../../app/lib/mapping-expr`',
      '- **Watch out**: 别动 `app/.server/pipeline/handlers.ts:12` 的其余 import。',
      '  - `app/.server/other.ts:1` 只是提一下',
    ].join('\n'));
    expect(changedFiles(body).files).toEqual([
      'app/.server/pipeline/merge-engine.ts',
      'app/.server/source-views.ts',
      'test/pipeline/assertions.test.ts',
    ]);
  });

  it('一条 Change 都没有时兜底取 `path:行号` 引用（跳过 New / Reuse / ADRs / Tests），并标记 fallback', () => {
    const body = guide([
      '- `vitest.config.ts:55-57`：两项超时乘倍数。',
      '- `.sandcastle/main.ts:122-137` `testEnv()`：加一个环境变量。',
      '- **Tests**: 照 `test/pipeline/knowledge-aliases.test.ts:82` 跑一次。',
      '- **Reuse**: `app/lib/x.ts:9`',
      '- 验证：`npm run typecheck`；`CRM_TEST_TIMEOUT_SCALE=2 npx vitest run` 能跑。',
    ].join('\n'));
    expect(changedFiles(body)).toEqual({ files: ['vitest.config.ts', '.sandcastle/main.ts'], fallback: true });
  });

  it('没有指引、或指引里没有文件引用时为空；正文别处的路径不算', () => {
    expect(changedFiles('## What to build\n\n改 `app/x.ts:1`。\n')).toEqual({ files: [], fallback: false });
    expect(changedFiles(guide('- 照着做就行。'))).toEqual({ files: [], fallback: false });
  });
});
