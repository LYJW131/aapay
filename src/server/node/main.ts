import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { Platform } from '../platform.ts';
import { createNodePlatform } from './platform.ts';

const config = loadConfig(process.env);
const port = Number(process.env.PORT) || 8787;
const dataDir = resolve(process.env.DATA_DIR || 'data');
const clientDir = resolve(process.env.CLIENT_DIR || fileURLToPath(new URL('../client', import.meta.url)));

let platform: Platform;
const app = createApp(async (c, next) => {
  c.set('config', config);
  c.set('platform', platform);
  await next();
});
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
platform = createNodePlatform(dataDir, upgradeWebSocket);

// 前端静态资源：带哈希的文件长期缓存，其余路径回退到 index.html（SPA）。
// 开发模式（npm run dev:node）下前端由 Vite 提供，这里不存在构建产物。
if (existsSync(clientDir)) {
  // 页面不允许被嵌入，防止授权页被点击劫持（Cloudflare 上由 public/_headers 设置）
  app.use('/*', async (c, next) => {
    await next();
    if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      c.header('X-Frame-Options', 'DENY');
      c.header('Content-Security-Policy', "frame-ancestors 'none'");
    }
  });
  app.use(
    '/*',
    serveStatic({
      root: clientDir,
      onFound: (path, c) => {
        c.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  app.get('*', serveStatic({ root: clientDir, path: 'index.html', onFound: (_, c) => c.header('Cache-Control', 'no-cache') }));
}

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`AAPay 已启动 → http://localhost:${info.port}`);
  console.log(`  模式 ${config.mode} · 管理员认证 ${config.adminAuth} · 数据目录 ${dataDir}`);
});
injectWebSocket(server);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
