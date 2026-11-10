import { describe, expect, it } from 'vitest';
import { blockersOf, changedFiles, flakyFailures, flakySignature, flakyTickets, splitChildren } from '../.sandcastle/guide';

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

describe('Sandcastle 的 blocker 与子票 blockersOf / splitChildren', () => {
  it('Blocked by：括号里的票号是说明不算，括号外一行几个都算', () => {
    const body = [
      '## What to build', '', '见 #1。', '',
      '## Blocked by', '',
      '- #487（原为 #472，已拆票）',
      '- #548 (原为 #489，已拆票)',
      '- #275、#276（#267 已拆分）',
      '- #305, #306',
      '- 无（#280 已关闭）',
      '- #548',
      '', '## Implementation guide', '', '- 等 #999 合并后再做。',
    ].join('\n');
    expect(blockersOf(body)).toEqual([487, 548, 275, 276, 305, 306]);
  });

  it('Blocked by：没有这一节时为空', () => {
    expect(blockersOf('## What to build\n\n依赖 #12。\n')).toEqual([]);
  });

  it('Split into：只认列表项开头的票号，同一行后面的票、不以票号开头的列表项和说明段落都不算', () => {
    const body = [
      '## Split into', '',
      '- [ ] #496 ①a：新建 publishing.ts（blocked by #495）',
      '- [x] #497 ①b：合并组接入，已拆成 #510、#511',
      '- #68 推断登记（blocked by #67）',
      '- 删除 `publish-rules.ts` 挪到 #500，排在 #468 之后。',
      '',
      '上面的检查点改为在 #496、#497 都合并后执行。#465–#468 改为被 #497 block。',
    ].join('\n');
    expect(splitChildren(body)).toEqual([496, 497, 68]);
  });
});

// #545 正文「第一次的失败」一节的原样摘要：两个文件、两种根因（源库连接超时 / TypeError）。
const flakySummary = [
  '重跑通过。第一次的失败：',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  test/http/mcp.test.ts > /mcp 工具 > 无权限或输入不对的工具调用是 isError 结果（403 的说明原样给出），不是 500',
  'Error: 无法连接数据源：IO Error: Unable to connect to Postgres at "connect_timeout=10": connection to server at "host.containers.internal" (192.168.127.254), port 5432 failed: timeout expired',
  '',
  ' ❯ app/.server/sources.ts:66:11',
  '     64| async function probe(spec: SourceSpec) {',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
  '',
  ' FAIL  test/http/sources.test.ts > 同步范围 > 登记后列出表与估算行数',
  'TypeError: Cannot read properties of null (reading \'match\')',
  ' ❯ sourceIdOf test/http/sources.test.ts:40:66',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯',
  '',
  '',
  ' Test Files  2 failed | 145 passed (147)',
  '      Tests  2 failed | 1541 passed | 2 expected fail (1545)',
].join('\n');

describe('Sandcastle 偶发失败的报错签名 flakyFailures / flakySignature', () => {
  it('每个 FAIL 行后面第一条非空行是报错：连接超时和 TypeError 各得一个签名，统计行不算', () => {
    expect(flakyFailures(flakySummary)).toEqual([
      {
        file: 'test/http/mcp.test.ts',
        signature:
          'Error: 无法连接数据源：IO Error: Unable to connect to Postgres at "connect_timeout=N": connection to server at "<host>" (<ip>), port N failed: timeout expired',
      },
      { file: 'test/http/sources.test.ts', signature: "TypeError: Cannot read properties of null (reading 'match')" },
    ]);
  });

  it('只有 IP、端口、行号不同的报错得到同一个签名；超长报错截到 160 字', () => {
    const first = flakySignature('Error: 连接超时 at "host.containers.internal" (192.168.127.254), port 5432 ❯ app/.server/sources.ts:66:11');
    expect(first).toBe('Error: 连接超时 at "<host>" (<ip>), port N ❯ app/.server/sources.ts:N:N');
    expect(
      flakySignature('Error: 连接超时 at "host.containers.internal" (192.168.100.1), port 5555 ❯ app/.server/sources.ts:99:1'),
    ).toBe(first);
    expect(flakySignature(`${'x'.repeat(200)} 12.34.56.78 12345678-1234-1234-1234-123456789012`)).toBe(
      'x'.repeat(200).slice(0, 160),
    );
  });

  it('同一个文件多条 FAIL 只取第一条报错；UUID 换占位；摘要被截断只剩 FAIL 行时签名为空串', () => {
    const twice = [
      ' FAIL  test/a.test.ts > 用例一',
      'AssertionError: expected 1 to be 2',
      ' FAIL  test/a.test.ts > 用例二',
      'Error: 第二条的报错不该取到',
      '',
      ' FAIL  test/trunc.test.ts > 只有 FAIL 行，摘要被 head 截断',
      '',
      ' Test Files  2 failed | 145 passed (147)',
    ].join('\n');
    expect(flakyFailures(twice)).toEqual([
      { file: 'test/a.test.ts', signature: 'AssertionError: expected N to be N' },
      { file: 'test/trunc.test.ts', signature: '' },
    ]);
    expect(flakySignature('upsert 冲突：7c9e6679-7425-40de-944b-e07fc1f90ae7 已存在')).toBe(
      'upsert 冲突：<uuid> 已存在',
    );
  });
});

describe('Sandcastle 偶发失败按签名分组开票 flakyTickets', () => {
  const timeout = 'Error: connect ETIMEDOUT 10.88.0.1:5432';
  const sig = flakySignature(timeout);
  const marker = `<!-- flaky-sig: ${sig} -->`;
  const summary = [' FAIL  test/a.test.ts > x', timeout, ' FAIL  test/b.test.ts > y', 'Error: connect ETIMEDOUT 10.88.0.2:6543'].join('\n');
  const ticket = (number: number, title: string, body = '') => ({ number, title, body });

  it('(a) 同签名的两个文件只出一组，标题带「等 2 个文件」，带签名标记', () => {
    expect(flakyTickets(['test/a.test.ts', 'test/b.test.ts'], summary, [])).toEqual([
      { files: ['test/a.test.ts', 'test/b.test.ts'], signature: sig, marker, title: '偶发失败：test/a.test.ts 等 2 个文件', existing: undefined },
    ]);
  });

  it('(b) 正文含签名标记的票优先于标题能匹配上的票', () => {
    const open = [ticket(10, '偶发失败：test/b.test.ts'), ticket(11, '偶发失败：test/z.test.ts', `正文\n${marker}`)];
    expect(flakyTickets(['test/a.test.ts', 'test/b.test.ts'], summary, open).map((t) => t.existing)).toEqual([11]);
  });

  it('(c) 没有标记时，老标题 `偶发失败：<文件>` 能匹配就用老票', () => {
    const open = [ticket(12, '偶发失败：test/b.test.ts', '老票没有标记')];
    expect(flakyTickets(['test/a.test.ts', 'test/b.test.ts'], summary, open)[0]!.existing).toBe(12);
  });

  it('(d) 签名为空（摘要截断）的文件各成一组、没有标记，只按标题匹配', () => {
    const cut = ' FAIL  test/a.test.ts > x\n FAIL  test/b.test.ts > y';
    const open = [ticket(13, '偶发失败：test/b.test.ts'), ticket(14, '别的', '<!-- flaky-sig:  -->')];
    expect(flakyTickets(['test/a.test.ts', 'test/b.test.ts'], cut, open)).toEqual([
      { files: ['test/a.test.ts'], signature: '', marker: undefined, title: '偶发失败：test/a.test.ts', existing: undefined },
      { files: ['test/b.test.ts'], signature: '', marker: undefined, title: '偶发失败：test/b.test.ts', existing: 13 },
    ]);
  });

  it('(e) 签名里的 `-->` 在标记里换成 `--›`，正文含该标记的票能认出来', () => {
    const arrow = ' FAIL  test/a.test.ts > x\nError: expected --> got';
    const [t] = flakyTickets(['test/a.test.ts'], arrow, [ticket(15, '无关', '<!-- flaky-sig: Error: expected --› got -->')]);
    expect(t!.signature).toBe('Error: expected --> got');
    expect(t!.marker).toBe('<!-- flaky-sig: Error: expected --› got -->');
    expect(t!.existing).toBe(15);
  });
});
