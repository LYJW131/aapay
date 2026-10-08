import { cloudflare, type WorkerConfig } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { loadConfig } from './src/server/config.ts';
import type { BuildInfo } from './src/shared/types.ts';

const target = process.env.AAPAY_TARGET === 'node' ? 'node' : 'cloudflare';
const nodeServer = `http://localhost:${process.env.PORT || 8787}`;

function git(...args: string[]) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function repoUrl() {
  const remote = git('config', '--get', 'remote.origin.url')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '');
  return /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(remote) ? remote : 'https://github.com/LYJW131/aapay';
}

const build: BuildInfo = {
  runtime: target,
  repo: repoUrl(),
  commit: git('rev-parse', 'HEAD') || process.env.WORKERS_CI_COMMIT_SHA || '',
  message: git('log', '-1', '--format=%s'),
  builtAt: Date.now(),
};

const RUNTIME_VARS = [
  'MODE',
  'ADMIN_AUTH',
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'ADMIN_EMAILS',
  'ADMIN_EMAIL_HEADER',
  'MCP',
  'PUBLIC_URL',
  'TIMEZONE',
  'ASSISTANT',
  'ASSISTANT_PROVIDER',
  'GEMINI_MODEL',
  'DEEPSEEK_MODEL',
  'CLAUDE_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
];

function injectedVars() {
  return Object.fromEntries(RUNTIME_VARS.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))) as Record<string, string>;
}

// 部署者的域名与运行时变量不写进仓库：Workers Builds 的构建变量在 vite build 时并入产物里的 wrangler.json，
// 并按运行时同一套规则校验（ADMIN_PASSWORD 是密钥，构建时拿不到，只能跳过），配错时构建失败而不是发布一个处处报错的 Worker。
function deployConfig(worker: WorkerConfig): Partial<WorkerConfig> {
  const vars = { ...worker.vars, ...injectedVars() };
  const previewVars = worker.previews && { ...worker.previews.vars, ...injectedVars() };
  for (const v of [vars, previewVars]) if (v) loadConfig({ ADMIN_PASSWORD: 'placeholder', ...v });
  const domain = process.env.CUSTOM_DOMAIN?.trim();
  return {
    vars,
    ...(previewVars && { previews: { vars: previewVars } }),
    ...(domain && { routes: [{ pattern: domain, custom_domain: true }], workers_dev: false }),
  };
}

function versionFile(): Plugin {
  return {
    name: 'aapay:version',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(build) });
    },
  };
}

export default defineConfig(({ command }) => ({
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [
    react(),
    tailwindcss(),
    versionFile(),
    ...(target === 'cloudflare' ? [cloudflare(command === 'build' ? { config: deployConfig } : {})] : []),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) },
  },
  build: {
    outDir: target === 'node' ? 'dist/client' : undefined,
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              // lucide 按用到的图标摇树，内容随业务代码变化，留在业务块里，vendor 的哈希才能跨发布保持不变
              groups: [{ name: 'vendor', test: /[\\/]node_modules[\\/](?!lucide-react[\\/])/, tags: ['$initial'] }],
            },
          },
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy:
      target === 'node'
        ? {
            '/api': { target: nodeServer, ws: true },
            '^/(mcp|oauth/(token|register|revoke)|\\.well-known)(/|$)': { target: nodeServer },
          }
        : undefined,
  },
}));
