// 把 Node 服务端打包成单个 ESM 文件，运行时镜像无需 node_modules
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/node/main.ts'],
  outfile: 'dist/node/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  // ws 的可选原生加速模块
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
