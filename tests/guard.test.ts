import { describe, expect, it } from 'vitest';
import { violation } from '../scripts/guard-commands.ts';

describe('guard-commands', () => {
  it.each([
    'npx wrangler deploy',
    'cd dist && wrangler deploy',
    'CLOUDFLARE_API_TOKEN=x npx wrangler secret put KEY',
    'npm run deploy',
    'git add -A',
    'git add --all',
    'git add .',
    'git add src/a.ts && git add -A',
    'git add .dev.vars',
    'git add apps/x/.env.local',
  ])('拦下 %s', (command) => {
    expect(violation(command)).not.toBeNull();
  });

  it.each([
    'git add src/demo/main.ts README.md',
    'git add .dev.vars.example .env.example',
    'git commit -m "docs: 不手跑 wrangler deploy"',
    "git commit -F - <<'EOF'\nfeat: x\n\nnpx wrangler deploy\nEOF",
    'npm run dev',
    'npm run build:demo',
    'cf dns records list',
    'rg wrangler src',
  ])('放行 %s', (command) => {
    expect(violation(command)).toBeNull();
  });
});
