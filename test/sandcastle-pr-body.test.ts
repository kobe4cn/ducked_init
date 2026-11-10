// test/sandcastle-pr-body.test.ts —— Sandcastle PR 正文的验收说明（`.sandcastle/pr-body.ts`，纯函数、不连库）：
// 格式检查（三个小标题、编号步骤、不出现二级标题）、准备段落的两种形态、正文各节顺序与折叠、只替换一节。
import { describe, expect, it } from 'vitest';
import { acceptanceSection, checkAcceptanceNotes, replaceSection, restSections } from '../.sandcastle/pr-body';

const notes = [
  '### 做了什么', '',
  '登录页的邮箱框失焦时不再清掉已填的内容。', '',
  '### 怎么验证', '',
  '1. 打开 `/login`，填 `admin@crmlab-smoke.test`，点表单外：邮箱内容还在（验收标准 1）', '',
  '### 最终效果', '',
  '邮箱框行为如上，其余页面不变。', '',
].join('\n');

describe('Sandcastle 验收说明格式检查 checkAcceptanceNotes', () => {
  it('三个小标题齐全且「怎么验证」有编号步骤：无问题', () => {
    expect(checkAcceptanceNotes(notes)).toEqual([]);
  });

  it('缺哪个小标题报哪个', () => {
    const md = notes.replace('### 怎么验证\n\n1. 打开 `/login`，填 `admin@crmlab-smoke.test`，点表单外：邮箱内容还在（验收标准 1）\n\n', '');
    expect(checkAcceptanceNotes(md)).toEqual(['缺 `### 怎么验证` 小标题']);
  });

  it('「怎么验证」下面没有编号步骤时报出来', () => {
    const md = notes.replace('1. 打开', '- 打开');
    expect(checkAcceptanceNotes(md)).toEqual(['「怎么验证」下面没有编号步骤']);
  });

  it('文件不存在：报「文件不存在」', () => {
    expect(checkAcceptanceNotes(undefined)).toEqual(['文件不存在']);
  });

  it('出现 `## ` 二级标题时报出来（它会让替换这一节时切错）', () => {
    expect(checkAcceptanceNotes(`${notes}\n## 附注\n\n不该出现。\n`)).toEqual(['文件里出现了 `## ` 二级标题（只能写 `###` 小标题，二级标题会让替换这一节时切错）']);
  });
});

describe('Sandcastle 验收说明一节 acceptanceSection', () => {
  it('改了页面的票：四步准备（checkout / dev server / browser-lab / 登录）拼在文件内容前面', () => {
    const section = acceptanceSection('sandcastle/issue-1', notes, { pageChanged: true });
    expect(section.startsWith('### 准备')).toBe(true);
    for (const part of [
      'git checkout sandcastle/issue-1',
      'npm run dev',
      'scripts/browser-lab.ts',
      'crmlab-smoke',
      'admin@', 'eng@', 'an@crmlab-smoke.test',
    ]) expect(section).toContain(part);
    expect(section.endsWith(notes)).toBe(true);
    expect(section.indexOf('### 准备')).toBeLessThan(section.indexOf('### 做了什么'));
  });

  it('没改页面的票：准备只有 checkout，不用起 dev server', () => {
    const section = acceptanceSection('sandcastle/issue-2', notes, { pageChanged: false });
    expect(section.startsWith('### 准备')).toBe(true);
    expect(section).toContain('git checkout sandcastle/issue-2');
    expect(section).not.toContain('npm run dev');
    expect(section.endsWith(notes)).toBe(true);
  });

  it('文件不存在：警告文字', () => {
    expect(acceptanceSection('b', undefined, { pageChanged: false })).toBe('⚠️ implementer 没有写验收说明');
  });

  it('格式不对：警告带问题列表，后面跟原文让人看见', () => {
    const bad = '### 做了什么\n\n没有小标题了。\n';
    const section = acceptanceSection('b', bad, { pageChanged: false });
    expect(section.startsWith('⚠️ 验收说明格式不对：')).toBe(true);
    expect(section).toContain('### 怎么验证');
    expect(section.endsWith(bad)).toBe(true);
  });
});

describe('Sandcastle PR 正文其余各节 restSections', () => {
  it('顺序 Review → Browser check，Gate / Budget / Usage 各折一个 details', () => {
    const body = restSections({ review: '摘要', browser: 'RESULT 内容', gate: 'gateNote', budget: 'budgetNote', usage: 'usageTable' });
    expect(body).toBe([
      '## Review', '', '摘要', '',
      '## Browser check', '', 'RESULT 内容', '',
      '<details><summary>Gate</summary>', '', 'gateNote', '', '</details>', '',
      '<details><summary>Budget</summary>', '', 'budgetNote', '', '</details>', '',
      '<details><summary>Usage</summary>', '', 'usageTable', '', '</details>',
    ].join('\n'));
  });

  it('没做浏览器验收时没有 Browser check 一节', () => {
    const body = restSections({ review: '摘要', gate: 'g', budget: 'b', usage: 'u' });
    expect(body).not.toContain('Browser check');
    expect(body.indexOf('## Review')).toBeLessThan(body.indexOf('<details>'));
  });
});

describe('Sandcastle 只替换正文一节 replaceSection', () => {
  const body = [
    'Closes #7', '',
    '## 验收说明', '',
    '旧的验收说明。', '',
    '## Review', '',
    '旧的摘要。', '',
    '## Gate', '',
    '旧的门槛。',
  ].join('\n');

  it('只换这一节，其余逐字不变（前后各有别的节）', () => {
    const replaced = replaceSection(body, '验收说明', '## 验收说明\n\n新的验收说明。');
    expect(replaced).toBe([
      'Closes #7', '',
      '## 验收说明', '', '新的验收说明。', '',
      '## Review', '', '旧的摘要。', '',
      '## Gate', '', '旧的门槛。',
    ].join('\n'));
  });

  it('正文里没有这一节时加在 Closes #n 后面（空一行）', () => {
    const without = body.replace('## 验收说明\n\n旧的验收说明。\n\n', '');
    expect(replaceSection(without, '验收说明', '## 验收说明\n\n新的验收说明。')).toBe(body.replace('旧的验收说明。', '新的验收说明。'));
  });

  it('正文只有 Closes #n 时也能插入；`###` 小标题不会被当成节边界', () => {
    expect(replaceSection('Closes #7', '验收说明', '## 验收说明\n\n内容\n\n### 做了什么\n\n…')).toBe(
      'Closes #7\n\n## 验收说明\n\n内容\n\n### 做了什么\n\n…',
    );
  });
});
