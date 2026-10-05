# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AAPay：多人记账与结算。一套 TypeScript 代码同时部署到 Cloudflare Workers（Durable Objects）和 Docker（Node + node:sqlite），并内置 OAuth 2.1 保护的远程 MCP 端点。`AGENTS.md` 是本文件的软链接，只改 `CLAUDE.md`。

## 协作约定

- 动手改代码前，先把用户的改动要求理解清楚，整理成条目复述一遍，再开始实现。要求有歧义或会影响已有行为时，复述时一并指出并给出你的理解。
- 不保留兼容行为：改了接口、数据结构、路由或交互，就直接替换旧实现并删除旧路径，不加兼容分支、旧格式解析、废弃别名或 fallback。线上数据的迁移不属于兼容行为，见下文「数据迁移」。
- 用中文和用户交流；提交信息用中文，前缀 `feat:` / `fix:` / `refactor:` / `docs:`。
- 推送 `v2` 分支即发布生产：Cloudflare Workers Builds 会对 `v2` 自动执行 `npm run typecheck && npm test && npm run build`，通过后 `npx wrangler deploy` 到 https://aapay.lyjw.dev（只改 `*.md`、`docs/` 不触发）。所以推送前必须在本地跑通类型检查和测试。
- 推送其他分支会构建 Worker Preview（`npx wrangler preview`），地址 `<分支名>-aapay.lyjw.workers.dev`，整个域名由 Access 应用「AAPay Previews」保护。Preview 的配置写在 `wrangler.jsonc` 的 `previews` 块（不继承顶层 vars，密钥需单独设置），DO 存储每个 Preview 独立、与生产数据隔离。

<EXTREMELY-IMPORTANT>

## Comments / JSDoc (MUST)

**Default: write ZERO comments. Write ZERO JSDoc.** This overrides any training instinct to "explain" code. Good identifiers carry meaning; comments are a last resort, not a habit.

Add a comment ONLY when one of:
- (a) **UNEXPECTED behavior** — workaround for a specific bug, browser quirk, race condition, library footgun
- (b) **SPECIAL design intent** — hidden invariant, non-obvious constraint, decision a future reader would otherwise reverse

**Forbidden categories (always violations — delete on sight, including comments you "felt like adding"):**
- JSDoc `/** ... */` blocks in business code. JSDoc is for framework/library exposed APIs only — never on internal functions, components, hooks, route handlers, services, utils.
- Describing WHAT the code does (`// loop over users`, `// set loading to true`)
- Referencing current task/fix/issue/PR/caller (`// added for X`, `// used by Y`, `// fixes #123`, `// per request`)
- Section headers / dividers (`// === helpers ===`, `// ---- types ----`, `// region: state`)
- Restating obvious logic, type info, or parameter purpose
- Docstrings on internal/business functions, hooks, components, handlers
- TODO/FIXME without a tracked ticket reference
- Translating identifier names into prose (`// userId: the user's id`)

**Self-audit before every Write/Edit:** scan the new content for `//`, `/*`, `/**`. For each one ask: *"would removing this confuse a future reader who can read the code?"* — if **no**, delete it. The default answer is **no**.

</EXTREMELY-IMPORTANT>

## 常用命令

```bash
npm run dev                 # Vite + Cloudflare 插件，在本地 workerd 里跑 Worker 与 Durable Objects（端口 5173）
npm run dev:node            # Node 服务（8787）+ Vite 前端，Vite 代理 /api、/mcp、/oauth/*、/.well-known
npm run typecheck           # tsc -b，web / worker / node 三个工程
npm test                    # vitest
npx vitest run tests/mcp.test.ts -t "rotates refresh tokens"   # 单个文件 / 单个用例
npm run build               # Cloudflare 构建（dist/client + dist/aapay）
npm run build:node          # 前端 + esbuild 打成单文件 dist/node/server.mjs
node scripts/seed.mjs http://127.0.0.1:5173                     # 写入演示账本（口令 demo2026）
```

本地开发把 `.dev.vars.example` 复制为 `.dev.vars`（`ADMIN_AUTH=none`），`/admin` 打开即以管理员登录。`.dev.vars` 只覆盖其中的变量，`wrangler.jsonc` 里的其他 `vars`（如 `ADMIN_EMAILS`）在本地同样生效。

## 架构

- `src/server/app.ts` 是平台无关的 Hono 应用，`createApp(inject)` 由平台入口注入 `platform` 与 `config`：`src/server/cloudflare/worker.ts`（Durable Objects）与 `src/server/node/main.ts`（node:sqlite + ws）。两边实现同一个 `Platform` 接口（`src/server/platform.ts`）。
- 业务逻辑在 `src/server/core/` 的同步服务里：`RegistryService`（账本、口令、会话、OAuth 客户端与授权）和 `LedgerService`（单个账本的成员、支出、还款）。它们只依赖同步的 `SqlDriver`，因此 DO 的 SQLite 与 node:sqlite 共用同一份代码。
- Cloudflare 上每个账本一个 `LedgerRoom` DO，全局一个 `RegistryRoom` DO；Node 上对应 `data/ledgers/<id>.db` 与 `data/registry.db`。服务通过 `remote()` / `dispatch()`（`core/remote.ts`）调用：`AppError` 不能原样穿过 DO RPC，先装进信封再在调用方还原，所以服务方法里只抛 `AppError`。
- 账目变更走 `LedgerService.commit()`：递增版本号并通过 WebSocket 广播 `LiveMessage`。前端 `LedgerStore` 按版本号应用增量，发现缺口就重新拉快照。`origin` 为发起方的客户端 ID；MCP 写入时为 `mcp:<客户端名>`，网页据此提示是哪个 AI 应用改的。
- 操作动态（审计日志）：每个变更方法都带 `MutationContext`（操作者 + origin），`commit()` 在同一个事务里递增版本号并追加 `audit_log`；不经过 `commit` 的操作（管理端重命名、口令、AI 连接）用 `LedgerService.record()` 补记。操作者只能来自服务端验证过的身份（`actorOf(session)`、管理员、OAuth 授权），不能取自请求内容。记录是 `{seq, at, actor, action}` 的 JSON 原文，`hash = sha256(prev + "\n" + payload)`，有 `AUDIT_SIGNING_KEY` 时对哈希做 Ed25519 签名；SQLite 触发器禁止 UPDATE / DELETE。前端 `features/ledger/activity.ts` 从 localStorage 的检查点继续校验整条链，展示的旧记录必须能沿 `prev` 接到已校验的最新记录。
- `src/shared/` 前后端共用：zod 校验（`schema.ts`）、金额（以「分」为整数，`money.ts`）、结算算法、事件 reducer。MCP 工具复用同一套 zod 校验以保证错误信息一致。`limits.ts` 不依赖 zod，前端只从这里取限制，避免把 zod 打进前端包。
- 前端用 `hono/client` 拿到 `ApiType` 的端到端类型；新增接口时把路由链在 `buildApi()` 里，前端就能类型安全地调用。
- 管理功能是账本页顶部的「管理员卡片」（`src/web/features/admin/AdminCard.tsx`，按需加载）；`/admin` 只是登录入口页。
- 管理员认证：外部身份（Access JWT / 代理头 / none）只在 `GET /api/admin/login` 校验一次，password 模式用 `POST /api/admin/login`，都换成本站的 console 会话（`aapay_console`，24 小时）。其余 `/api/admin/*` 只认 console 会话并每次用 `stillAdmin` 重新确认白名单，过期返回 401；Access 应用只能保护 `/api/admin/login`，不能覆盖其他 API（Access 会把过期的 fetch 重定向成网络错误）。管理员进入账本的会话（`role: 'admin'`）绑定签发它的 console 会话，随之失效。前端从 `/api/session` 的 `admin` 字段得知管理员身份，管理接口返回 401 时由 `onAdminExpired`（`lib/api.ts`）统一清掉管理员状态。
- 管理端的组合操作（重命名后通知在线成员、删除时销毁账本数据、撤销口令时断开连接）集中在 `src/server/admin.ts`，HTTP 接口与 MCP 工具共用。

## MCP 与 OAuth

- `src/server/mcp/oauth.ts`：授权服务器（RFC 9728 / 8414 发现、7591 动态注册、Client ID Metadata Document、PKCE S256、8707 资源绑定、刷新令牌轮换、7009 撤销、`private_key_jwt`）。Claude 与 ChatGPT 都用 CIMD（`client_id` 是元数据 URL），ChatGPT 还会用 `private_key_jwt`。
- `src/server/mcp/server.ts`：无状态 Streamable HTTP，`POST /mcp` 直接返回 JSON-RPC。`src/server/mcp/tools.ts`：工具定义，金额对外以「元」为单位，成员与账本可用名字指代。
- 授权分两种角色：成员授权绑定一个账本（口令撤销、账本删除时级联失效）；管理员授权不绑定账本，可用管理员工具，账本工具必须用 `ledger` 参数指定账本。管理员授权走 `/api/admin/oauth/authorize`，与 `/admin` 用同一套管理员认证；每次请求都会按当前配置重新确认此人仍是管理员。
- `tools/list` 与 `initialize` 的 instructions 对所有授权都相同（客户端会缓存，换授权后不一定重新拉取），不要按角色或作用域过滤；权限在 `tools/call` 时检查：成员调用管理工具、`ledger` 参数与授权不符返回工具错误；只读令牌调用写入工具在 `POST /mcp` 入口返回 403 `insufficient_scope`，客户端据此重新授权（step-up），不能改成工具错误。
- `/oauth/authorize` 是前端页面（`src/web/features/oauth/AuthorizePage.tsx`），服务端只处理 `/api/oauth/authorize`。

## 改动时的注意点

- 新增服务端路径时，同时更新 `src/server/app.ts` 的 `SERVER_PATHS` 与 `wrangler.jsonc` 的 `assets.run_worker_first`，否则 Cloudflare 上该路径会被静态资源（SPA 回退）接走。`/oauth/*` 上的中间件必须按具体路径挂载，不能覆盖 `/oauth/authorize`。
- 数据迁移：`registry.ts` 与 `ledger.ts` 的 `MIGRATIONS` 只能在末尾追加，已发布的条目不能修改或删除；生产环境的 DO 里有真实数据，迁移需保留现有行（参考迁移 4 的建新表、拷贝、重命名，`tests/mcp.test.ts` 里有对应的迁移测试）。
- Cloudflare Workers 的 `fetch` 不支持 `redirect: 'error'`（会直接抛错），需要不跟随跳转时用 `redirect: 'manual'` 并检查状态码。vitest 跑在 Node 平台上，测试里模拟 `fetch` 时要让模拟行为与 Workers 一致。
- 测试通过 `createNodePlatform` + `app.request()` 直接驱动整个应用；限流按实例计数（每分钟 10 次加入 / 注册），需要大量授权的用例各自新建 `setup()`。
- 界面文案求短：页面上直接显示的说明、提示、空状态、toast 都只写一句短话，第一眼能看完，不写成段的长句。放不下但仍有用的细节收进 `components/Hint.tsx`（问号图标，桌面悬停、触屏点击展开）；不重要的细节直接删掉。新增或修改文案时按此检查。
- iOS Safari 聚焦字号小于 16px 的输入框时会自动放大页面，且不会缩回。所有 `input` / `textarea` / `select` 在触屏上都必须至少 16px：优先用 `index.css` 的 `.field`（已带 `pointer-coarse:text-base`），不要再给它加 `text-sm` / `text-[13px]` 等更小字号；不用 `.field` 的自定义输入框（如 `BillBatch.tsx` 的行内编辑）必须自己加 `pointer-coarse:text-base`。桌面端可以保留小字号。
- 配置变量在 `src/server/config.ts` 统一解析，Cloudflare（`wrangler.jsonc` vars / secrets）与 Docker（`.env`）共用同一套变量名；新增变量时同步 README 的配置表与 `.env.example`。
