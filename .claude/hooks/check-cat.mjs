// .claude/hooks/check-cat.mjs —— PreToolUse(Bash) 钩子：拦下一次 cat 多个文件、或 cat 超过 300 行的文件，守住上下文预算
// 被管道接走（cat f | grep）或写文件（cat > f <<EOF）的 cat 不算读。退出码 2 拒绝执行，stderr 回给 agent
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_LINES = 300;
const input = JSON.parse(readFileSync(0, 'utf8'));
const cwd = input.cwd ?? process.cwd();
// 去掉 heredoc 正文与引号里的字符串：里面的 python / SQL / 参数不是命令
const command = String(input.tool_input?.command ?? '')
  .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, '<<HEREDOC')
  .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'STR');

const files = [];
for (const stmt of command.split(/;|&&|\|\||\n/)) {
  const stages = stmt.split('|');
  // 最后一段的输出才进上下文；前面各段被管道接走
  const words = stages[stages.length - 1].trim().split(/\s+/);
  if (words[0] !== 'cat' || words.some(w => w.startsWith('>') || w.startsWith('<'))) continue;
  files.push(...words.slice(1).filter(w => w && !w.startsWith('-')));
}

const lines = f => {
  const p = resolve(cwd, f.replace(/^['"]|['"]$/g, ''));
  return existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8').split('\n').length : 0;
};
const long = files.filter(f => lines(f) > MAX_LINES);

let reason;
if (files.length > 1) reason = `this command cats ${files.length} files (${files.join(', ')})`;
else if (long.length) reason = `${long[0]} has ${lines(long[0])} lines`;
if (reason) {
  console.error(
    `Blocked: ${reason}. Read one file per command, and read a file over ${MAX_LINES} lines by range: ` +
      "`grep -n` to locate, then `sed -n 'a,bp'`. To understand a module you won't change, read its header comment and `grep -n '^export'`.",
  );
  process.exit(2);
}
