# 参与贡献

感谢你愿意改进 AAPay！Issue 和 Pull Request 用中文或英文都可以。

## 开发环境

需要 Node.js ≥ 22.13（推荐 24）。

```bash
npm install
cp .dev.vars.example .dev.vars   # 取消注释 ADMIN_AUTH=none
npm run dev                      # http://localhost:5173
node scripts/seed.mjs            # 可选：演示账本，口令 demo2026
```

`npm run dev:node` 用 Node 运行时（node:sqlite）开发，两个平台共用同一套业务代码。

## 提交 PR 之前

```bash
npm run typecheck
npm test
```

- 一个 PR 只做一件事；改了行为就补上或更新测试（`tests/` 下用 `createNodePlatform` + `app.request()` 驱动整个应用）
- 新增界面文案或错误提示时，`zh-CN` 与 `en` 两种语言都要写（`src/web/i18n/`、`src/shared/errors.ts`），文案求短
- 新增服务端路径要同时更新 `src/server/app.ts` 的 `SERVER_PATHS` 与 `wrangler.jsonc` 的 `assets.run_worker_first`
- 数据库迁移（`MIGRATIONS`）只能在末尾追加，不能修改已发布的条目
- 新增配置变量时，同步 `src/server/config.ts`、README 的配置表与 `.env.example`；需要在 Cloudflare 构建时注入的普通变量加进 `vite.config.ts` 的 `RUNTIME_VARS`
- 提交信息用 `feat:` / `fix:` / `refactor:` / `docs:` 前缀

更详细的架构说明与约定见 [CLAUDE.md](CLAUDE.md)。
