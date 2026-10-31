import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_CREDENTIAL = /(^|\/)(\.dev\.vars|\.env)(\.(?!example$)[^/]*)?$/;
const PREFIXES = new Set(['npx', 'bunx', 'exec', 'env', 'time', 'sudo', 'nohup', 'then', 'do', 'else', '!']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

// 提交信息、heredoc 和带空格的引号内容里提到 wrangler 不该被拦，只看真正会执行的命令
function strip(command: string) {
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of command.split('\n')) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const heredoc = line.match(/(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/);
    if (heredoc) delimiter = heredoc[2]!;
  }
  return kept.join('\n').replace(/'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_, single?: string, double?: string) => {
    const value = single ?? double ?? '';
    return /\s/.test(value) || value === '' ? 'Q' : value;
  });
}

function program(tokens: string[]): { name: string; args: string[] } {
  let i = 0;
  while (i < tokens.length && (/^\w+=/.test(tokens[i]!) || PREFIXES.has(tokens[i]!) || tokens[i]!.startsWith('-'))) i++;
  const name = basename(tokens[i] ?? '');
  const args = tokens.slice(i + 1);
  const positional = args.filter((a) => !a.startsWith('-'));
  if (RUNNERS.has(name) && ['exec', 'dlx', 'x'].includes(positional[0] ?? '')) return program(args.slice(args.indexOf(positional[0]!) + 1));
  return { name, args };
}

function gitSubcommand(args: string[]) {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += GIT_OPTIONS_WITH_VALUE.has(args[i]!) ? 2 : 1;
  return { sub: args[i], rest: args.slice(i + 1) };
}

export function violation(command: string): string | null {
  for (const segment of strip(command).split(/&&|\|\||[;&|\n()`{}]/)) {
    const { name, args } = program(segment.trim().split(/\s+/).filter(Boolean));
    const positional = args.filter((a) => !a.startsWith('-'));
    if (name === 'wrangler') return '本机不用 wrangler：Cloudflare 操作用 cf 命令行，生产只由 Workers Builds 从 main 部署';
    if (RUNNERS.has(name) && ((positional[0] === 'run' && positional[1] === 'deploy') || (name !== 'npm' && positional[0] === 'deploy'))) {
      return '不手跑生产部署：推 main 后由 Workers Builds 部署';
    }
    if (name === 'git') {
      const { sub, rest } = gitSubcommand(args);
      if (sub !== 'add') continue;
      if (rest.some((a) => a === '-A' || a === '--all' || a === '.' || a === ':/' || /^-[a-zA-Z]*A/.test(a))) {
        return '只 git add 自己改过的路径，不用 -A / --all / .';
      }
      if (rest.some((a) => LOCAL_CREDENTIAL.test(a))) return '不提交本地凭据文件（.dev.vars、.env）';
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
