import { build } from 'esbuild';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

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

const COMPRESSIBLE = /\.(js|css|html|json|svg|webmanifest)$/;

for (const entry of await readdir('dist/client', { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const source = await readFile(path);
  const variants = {
    '.br': brotliCompressSync(source, {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: source.length },
    }),
    '.gz': gzipSync(source, { level: constants.Z_BEST_COMPRESSION }),
  };
  for (const [ext, data] of Object.entries(variants)) {
    if (data.length < source.length) await writeFile(path + ext, data);
  }
}
