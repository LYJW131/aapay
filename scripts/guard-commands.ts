import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_CREDENTIAL = /(^|\/)(\.dev\.vars|\.env)(\.(?!example$)[^/]*)?$/;
const WRAPPERS = new Set(['npx', 'exec', 'env', 'command', 'time', 'sudo']);

// 提交信息、heredoc 和引号里提到 wrangler 不该被拦，只看真正会执行的命令
function strip(command: string) {
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of command.split('\n')) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const heredoc = line.match(/<<-?\s*(['"]?)([\w.-]+)\1/);
    if (heredoc) delimiter = heredoc[2]!;
  }
  return kept.join('\n').replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q');
}

function program(tokens: string[]) {
  let i = 0;
  while (i < tokens.length && (/^\w+=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!) || tokens[i]!.startsWith('-'))) i++;
  return { name: basename(tokens[i] ?? ''), args: tokens.slice(i + 1) };
}

export function violation(command: string): string | null {
  for (const segment of strip(command).split(/&&|\|\||[;|\n()`]/)) {
    const { name, args } = program(segment.trim().split(/\s+/).filter(Boolean));
    if (name === 'wrangler') return '本机不用 wrangler：Cloudflare 操作用 cf 命令行，生产只由 Workers Builds 从 main 部署';
    if (name === 'npm' && args[0] === 'run' && args[1] === 'deploy') return '不手跑生产部署：推 main 后由 Workers Builds 部署';
    if (name === 'git' && args[0] === 'add') {
      const paths = args.slice(1);
      if (paths.some((a) => a === '-A' || a === '--all' || a === '.' || a === ':/' || /^-\w*A/.test(a))) {
        return '只 git add 自己改过的路径，不用 -A / --all / .';
      }
      if (paths.some((a) => LOCAL_CREDENTIAL.test(a))) return '不提交本地凭据文件（.dev.vars、.env）';
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as { tool_input?: { command?: unknown } };
  const reason = violation(String(input.tool_input?.command ?? ''));
  if (reason) {
    process.stderr.write(`${reason}（见 AGENTS.md「禁区」）\n`);
    process.exit(2);
  }
}
