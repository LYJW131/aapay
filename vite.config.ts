import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// AAPAY_TARGET=node 时只构建前端，并在开发模式下把 /api 代理到本地 Node 服务
const target = process.env.AAPAY_TARGET === 'node' ? 'node' : 'cloudflare';
const nodeServer = `http://localhost:${process.env.PORT || 8787}`;

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(target === 'cloudflare' ? [cloudflare()] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) },
  },
  build: {
    outDir: target === 'node' ? 'dist/client' : undefined,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: target === 'node' ? { '/api': { target: nodeServer, ws: true } } : undefined,
  },
});
