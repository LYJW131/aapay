# AGENTS.md

AAPay：多人记账与结算。一套 TypeScript 代码同时部署到 Cloudflare Workers（Durable Objects）和 Docker（Node + node:sqlite），内置 OAuth 2.1 保护的远程 MCP 端点；同一套服务端代码还能连同 sql.js 跑在浏览器里，作为 GitHub Pages 上的演示站。`CLAUDE.md` 只有一行 `@AGENTS.md`，规则只改本文件。

子目录的不变量写在各自的 `AGENTS.md`（同目录 `CLAUDE.md` 引用它），改那个目录前先读：

- `src/server/AGENTS.md`：服务、变更集、审计、管理员认证、AI 助手、MCP 与 OAuth、迁移
- `src/web/AGENTS.md`：前端、文案与 i18n、触屏输入
- `src/demo/AGENTS.md`：浏览器内的服务端、演示站与截图

## 工作方式

- 动手改代码前，先把改动要求理解清楚，整理成条目复述一遍再实现。要求有歧义或会影响已有行为时，复述时一并指出并给出你的理解。
- 不保留兼容行为：改了接口、数据结构、路由或交互，就直接替换旧实现并删除旧路径，不加兼容分支、旧格式解析、废弃别名或 fallback。线上数据的迁移不属于兼容行为，见 `src/server/AGENTS.md`「数据迁移」。
- 用中文和 lyjw 交流；提交信息用中文，前缀 `feat:` / `fix:` / `refactor:` / `docs:`。
- 修 bug 时补一条能复现它的测试：先看它红，修完看它绿。
- 协作约定（什么要等 lyjw 点头、怎么汇报）见 `HUMAN.md`。

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

## 禁区

- 仓库里不放任何部署者的信息（域名、Access 团队与 AUD、管理员邮箱、镜像仓库地址），`wrangler.jsonc` 只是一键部署的模板，部署者的值来自构建变量和仓库变量（见「部署流程」）。演示站地址 `aapay.lyjw.me` 是项目自己的演示，可以出现在 README。
- 不手跑生产部署（`wrangler deploy`、`npm run deploy`）：生产只由 Workers Builds 从 `main` 部署。本机的 Cloudflare 操作用 `cf` 命令行，不用 wrangler。
- 不提交本地凭据文件（`.dev.vars`、`.env`）。`.dev.vars.example` 是一键部署按钮读取密钥的来源，只能放密钥，不能有未注释的 `ADMIN_AUTH=none` 或默认密码；`.env.example`（Docker）同理，只保留空的 `ADMIN_PASSWORD=`，其余全部注释。
- `git add` 只加自己改过的路径，不用 `git add -A` / `git add .`。

## 项目入口与验证

```bash
npm run dev                 # Vite + Cloudflare 插件，在本地 workerd 里跑 Worker 与 Durable Objects（端口 5173）
npm run dev:node            # Node 服务（8787）+ Vite 前端，Vite 代理 /api、/mcp、/oauth/*、/.well-known
npm run dev:demo            # 演示站：服务端连同 sql.js 跑在浏览器里（端口 5175）
npm run check               # 提交前跑：类型检查、测试、三种构建
npm run typecheck           # tsc -b：web / worker / node / demo 四个工程
npm test                    # vitest，含文档检查 tests/docs.test.ts
npx vitest run tests/mcp.test.ts -t "rotates refresh tokens"   # 单个文件 / 单个用例
npm run build               # Cloudflare 构建（dist/client + dist/aapay）
npm run build:node          # 前端 + esbuild 打成单文件 dist/node/server.mjs
npm run build:demo          # 纯静态演示站 dist/demo
npm run seed                # 往运行中的开发服务器写中英两套演示账本（口令见 src/demo/seed.ts），默认 http://127.0.0.1:5173
npm run screenshots         # 对 vite preview 起的 dist/demo 截 README 用图，步骤见 src/demo/AGENTS.md
```

- 本地开发把 `.dev.vars.example` 复制为 `.dev.vars` 并取消注释 `ADMIN_AUTH=none`，`/admin` 打开即以管理员登录。`npm run dev` 不做构建变量注入。
- `.claude/launch.json` 里有三个预览配置：`cloudflare`（5173）、`demo`（5175）、`demo-dist`（5176，预览构建产物）。agent 用这些端口，不占 lyjw 在跑的服务。
- 按改动选验证：逻辑改动跑相关测试；接口或类型改动跑 `npm run typecheck` 并搜调用方；构建、路由、静态资源改动跑对应构建；UI 改动在浏览器里看桌面和 375px、深浅两色，截图给 lyjw。推送前跑 `npm run check`。
- 测试通过 `createNodePlatform` + `app.request()` 直接驱动整个应用；限流按实例计数（每分钟 10 次加入 / 注册），需要大量授权的用例各自新建 `setup()`。
- CI 门禁以 `.github/workflows/ci.yml` 为准。

## 架构总览

- `src/server/app.ts` 是平台无关的 Hono 应用，`createApp(inject)` 由平台入口注入 `platform` 与 `config`：`src/server/cloudflare/worker.ts`（Durable Objects）、`src/server/node/main.ts`（node:sqlite + ws）和 `src/demo/server.ts`（浏览器里的 sql.js）。三边实现同一个 `Platform` 接口（`src/server/platform.ts`）。
- 业务逻辑在 `src/server/core/` 的同步服务里，只依赖同步的 `SqlDriver`，所以 DO 的 SQLite、node:sqlite 和 sql.js 共用同一份代码。
- `src/shared/` 前后端共用：zod 校验（`schema.ts`）、金额（以「分」为整数，`money.ts`）、结算算法、事件 reducer、支出分类（`categories.ts`）。`limits.ts` 不依赖 zod，前端只从这里取限制，避免把 zod 打进前端包。
- 前端在 `src/web/`，用 `hono/client` 拿到 `ApiType` 的端到端类型。

## 跨目录须成对修改

- 新增服务端路径：同时更新 `src/server/app.ts` 的 `SERVER_PATHS` 与 `wrangler.jsonc` 的 `assets.run_worker_first`，否则 Cloudflare 上该路径会被静态资源（SPA 回退）接走。演示站按 `SERVER_PATHS` 决定哪些请求交给浏览器内的服务端，不用另改。
- 新增配置变量：在 `src/server/config.ts` 统一解析（Cloudflare 与 Docker 共用同一套变量名），同步 README（中英）的配置表与 `.env.example`；普通变量还要加进 `vite.config.ts` 的 `RUNTIME_VARS`。
- 新增界面文案或错误：`zh-CN` 与 `en` 两种语言都要写（`src/web/i18n/`、`src/shared/errors.ts`）。
- 改了演示数据（`src/demo/seed.ts`）或截图脚本：README 引用的截图文件名要对得上 `scripts/screenshots.mjs` 的 `SCENES`。

## 部署流程

- 推送 `main` 即发布生产：连接了 Workers Builds 时会对 `main` 自动执行 `npm run typecheck && npm test && npm run build`，通过后 `npx wrangler deploy`（只改 `*.md`、`docs/` 不触发）。所以推送前必须在本地跑通 `npm run check`。
- 部署者的值来自 Workers Builds 的构建变量：`vite.config.ts` 的 `deployConfig` 在 `vite build` 时把 `RUNTIME_VARS` 里的同名环境变量并入产物 `dist/aapay/wrangler.json` 的 `vars` 与 `previews.vars`，`CUSTOM_DOMAIN` 生成自定义域名路由并关闭 `workers.dev`，再用 `loadConfig` 校验（配错时构建失败）。生产与 Preview 的构建变量在 Workers Builds 里分开设置。GitHub Actions 用仓库变量：`PRODUCTION_URL` / `PREVIEW_HOST`（`deployments.yml`）、`ALIYUN_ACR_IMAGE`（`image.yml`）、`DEMO_URL` / `DEMO_BRANCH`（`demo.yml`），没设置时对应工作流跳过。
- 推送其他分支会构建 Worker Preview（`npx wrangler preview`），地址 `<分支名>-<Worker>.<子域>.workers.dev`。Preview 的绑定写在 `wrangler.jsonc` 的 `previews` 块（不继承顶层），变量由 Preview 自己的构建变量注入。`wrangler preview` 每次部署只带配置里的变量，不会沿用之前设置的密钥，所以 Preview 的部署命令用 `--secrets-file` 从构建密钥注入（如 `PREVIEW_AUDIT_SIGNING_KEY` → `AUDIT_SIGNING_KEY`、`PREVIEW_GEMINI_API_KEY` → `GEMINI_API_KEY`）。每个 Preview 的 DO 存储独立、与生产数据隔离。
- 推送 `main` 或 `v*` 标签还会触发 `.github/workflows/image.yml`：类型检查与测试通过后构建 `linux/amd64` + `linux/arm64` 镜像，推到 `ghcr.io/<仓库>`，设置了 `ALIYUN_ACR_IMAGE` 时同时推到阿里云 ACR（`main` 为 `latest`，标签为语义化版本）。ACR 登录用仓库密钥 `ALIYUN_ACR_USERNAME`、`ALIYUN_ACR_PASSWORD`，密码是控制台「访问凭证」里的 Registry 密码。构建关掉 provenance：ACR 个人版拒绝 attestation 的 `application/vnd.oci.empty.v1+json`。构建阶段用 `--platform=$BUILDPLATFORM` 在原生架构上跑，产物是纯 JS，只有运行阶段按目标架构打包。
- 设置了 `DEMO_URL` 时，推送任意分支（只改 `*.md` 的除外）会触发 `.github/workflows/demo.yml`：构建演示站、在 Chromium 里生成截图；只有 `DEMO_BRANCH`（默认 `main`）上的提交会发布到 GitHub Pages，README 的截图也随之更新。
- 分支流转：功能在分支上开发，用该分支的 Worker Preview 和演示站自查，经 PR 以合并提交进 `main`；lyjw 明确说「推 main」「合入 main」时可以直接推。
- 「已部署」的判据：生产看站点 `/version.json` 的 `commit`，演示站看 `https://aapay.lyjw.me/version.json`，都要等于期望的提交。

## 文档与注释

- 注释按上面的 Comments 规则：默认不写，只写意外行为和设计意图。
- 文档只写现状，不写时间线（什么时候改过、改之前是什么）；不抄易变的值，写路径加符号；一个事实只在一处写，其他地方放指针。
- 改代码、规则或流程的同一个提交里，更新受影响的文档：提交前 `rg` 改动的符号和关键词。

## 规则 → 由什么强制

| 规则 | 由什么强制 |
| --- | --- |
| 类型检查、测试、三种构建全绿 | CI（`.github/workflows/ci.yml` 跑 `npm run check`） |
| 文档里的相对链接、反引号路径、`路径#符号` 都存在；`CLAUDE.md` 只引用 `AGENTS.md`；根 `AGENTS.md` 不超过字节上限 | `tests/docs.test.ts`（`npm test`） |
| 不手跑 wrangler、`npm run deploy`，不 `git add -A`，不暂存 `.dev.vars` / `.env` | PreToolUse 钩子 `scripts/guard-commands.ts`（`.claude/settings.json`）；防手滑，不是安全边界，`bash -c` 之类绕得过 |
| 演示站能构建、能跑通截图场景 | `.github/workflows/demo.yml` |
