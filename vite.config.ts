import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const target = process.env.AAPAY_TARGET === 'node' ? 'node' : 'cloudflare';
const nodeServer = `http://localhost:${process.env.PORT || 8787}`;

// Workers AI 只有远程绑定，本地开发默认去掉，避免未登录 Cloudflare 时起不来；AAPAY_DEV_AI=1 时保留
const devWorker = (command: string) =>
  cloudflare({
    config: (worker) => {
      if (command === 'serve' && !process.env.AAPAY_DEV_AI) delete worker.ai;
    },
  });

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), ...(target === 'cloudflare' ? [devWorker(command)] : [])],
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
}));
