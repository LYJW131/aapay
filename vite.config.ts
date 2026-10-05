import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
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

const build: BuildInfo = {
  commit: git('rev-parse', 'HEAD') || process.env.WORKERS_CI_COMMIT_SHA || '',
  message: git('log', '-1', '--format=%s'),
  builtAt: Date.now(),
};

function versionFile(): Plugin {
  return {
    name: 'aapay:version',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(build) });
    },
  };
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [react(), tailwindcss(), versionFile(), ...(target === 'cloudflare' ? [cloudflare()] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) },
  },
  build: {
    outDir: target === 'node' ? 'dist/client' : undefined,
    chunkSizeWarningLimit: 800,
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
});
