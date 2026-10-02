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
  // ws 的可选原生加速模块，不打包
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
