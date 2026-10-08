# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AAPay：多人记账与结算。一套 TypeScript 代码同时部署到 Cloudflare Workers（Durable Objects）和 Docker（Node + node:sqlite），并内置 OAuth 2.1 保护的远程 MCP 端点。`AGENTS.md` 是本文件的软链接，只改 `CLAUDE.md`。

## 协作约定

- 动手改代码前，先把用户的改动要求理解清楚，整理成条目复述一遍，再开始实现。要求有歧义或会影响已有行为时，复述时一并指出并给出你的理解。
- 不保留兼容行为：改了接口、数据结构、路由或交互，就直接替换旧实现并删除旧路径，不加兼容分支、旧格式解析、废弃别名或 fallback。线上数据的迁移不属于兼容行为，见下文「数据迁移」。
- 用中文和用户交流；提交信息用中文，前缀 `feat:` / `fix:` / `refactor:` / `docs:`。
- 仓库里不放任何部署者的信息（域名、Access 团队与 AUD、管理员邮箱、镜像仓库地址），`wrangler.jsonc` 只是一键部署的模板。Cloudflare 上这些值来自 Workers Builds 的构建变量：`vite.config.ts` 的 `deployConfig` 在 `vite build` 时把 `RUNTIME_VARS` 里的同名环境变量并入产物 `dist/aapay/wrangler.json` 的 `vars` 与 `previews.vars`，`CUSTOM_DOMAIN` 生成自定义域名路由并关闭 `workers.dev`，再用 `loadConfig` 校验（配错时构建失败）。生产与 Preview 的构建变量在 Workers Builds 里分开设置。GitHub Actions 用仓库变量：`PRODUCTION_URL` / `PREVIEW_HOST`（`deployments.yml`，没设置时跳过）、`ALIYUN_ACR_IMAGE`（`image.yml`，没设置时只推 GHCR）。
- 推送 `main` 即发布生产：连接了 Workers Builds 时会对 `main` 自动执行 `npm run typecheck && npm test && npm run build`，通过后 `npx wrangler deploy`（只改 `*.md`、`docs/` 不触发）。所以推送前必须在本地跑通类型检查和测试。
- 推送 `main` 或 `v*` 标签还会触发 `.github/workflows/image.yml`：类型检查与测试通过后构建 `linux/amd64` + `linux/arm64` 镜像，推到 `ghcr.io/<仓库>`，设置了 `ALIYUN_ACR_IMAGE` 时同时推到阿里云 ACR（`main` 为 `latest`，标签为语义化版本）。ACR 登录用仓库密钥 `ALIYUN_ACR_USERNAME`、`ALIYUN_ACR_PASSWORD`，密码是控制台「访问凭证」里的 Registry 密码。构建关掉 provenance：ACR 个人版拒绝 attestation 的 `application/vnd.oci.empty.v1+json`。构建阶段用 `--platform=$BUILDPLATFORM` 在原生架构上跑，产物是纯 JS，只有运行阶段按目标架构打包。
- 推送其他分支会构建 Worker Preview（`npx wrangler preview`），地址 `<分支名>-<Worker>.<子域>.workers.dev`。Preview 的绑定写在 `wrangler.jsonc` 的 `previews` 块（不继承顶层），变量由 Preview 自己的构建变量注入。`wrangler preview` 每次部署只带配置里的变量，不会沿用之前设置的密钥，所以 Preview 的部署命令用 `--secrets-file` 从构建密钥注入（如 `PREVIEW_AUDIT_SIGNING_KEY` → `AUDIT_SIGNING_KEY`、`PREVIEW_GEMINI_API_KEY` → `GEMINI_API_KEY`）。每个 Preview 的 DO 存储独立、与生产数据隔离。

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

本地开发把 `.dev.vars.example` 复制为 `.dev.vars` 并取消注释 `ADMIN_AUTH=none`，`/admin` 打开即以管理员登录。`.dev.vars.example` 同时是一键部署按钮读取密钥的来源，只能放密钥，不能有未注释的 `ADMIN_AUTH=none` 或默认密码；`.env.example`（Docker）同理，只保留空的 `ADMIN_PASSWORD=`，其余全部注释。`npm run dev` 不做构建变量注入。

## 架构

- `src/server/app.ts` 是平台无关的 Hono 应用，`createApp(inject)` 由平台入口注入 `platform` 与 `config`：`src/server/cloudflare/worker.ts`（Durable Objects）与 `src/server/node/main.ts`（node:sqlite + ws）。两边实现同一个 `Platform` 接口（`src/server/platform.ts`）。
- 业务逻辑在 `src/server/core/` 的同步服务里：`RegistryService`（账本、口令、会话、OAuth 客户端与授权）和 `LedgerService`（单个账本的成员、支出、还款）。它们只依赖同步的 `SqlDriver`，因此 DO 的 SQLite 与 node:sqlite 共用同一份代码。
- Cloudflare 上每个账本一个 `LedgerRoom` DO，全局一个 `RegistryRoom` DO；Node 上对应 `data/ledgers/<id>.db` 与 `data/registry.db`。服务通过 `remote()` / `dispatch()`（`core/remote.ts`）调用：`AppError` 不能原样穿过 DO RPC，先装进信封再在调用方还原，所以服务方法里只抛 `AppError`。
- 账目变更只有一个入口：`LedgerService.applyChanges(changes, ctx)`（HTTP 为 `POST /api/ledger/changes`），变更集类型在 `shared/changes.ts`、zod 在 `schema.ts` 的 `changeSchema`。一组变更在一个事务里执行，每条有实际变化的变更各自递增版本号、追加审计，提交后才按顺序广播 `LiveMessage`（同批共享 `batch`）；任一条失败整体回滚。返回的 `undo` 可原样再交给 `applyChanges` 撤销。`previewChanges` 用同一套 mutator 在事务里预演后回滚，AI 的提议都在它上面预演。新记录的 id 由调用方用 `shared/ids.ts` 的 `newId()` 预分配。前端 `LedgerStore` 按版本号应用增量，发现缺口就重新拉快照。`origin` 为发起方的客户端 ID；MCP 写入时为 `mcp:<客户端名>`，网页据此提示是哪个 AI 应用改的。
- 操作动态（审计日志）：`MutationContext`（操作者 + origin + 可选 `via: 'assistant'`）随变更集传入，`applyChanges` 在同一个事务里递增版本号并追加 `audit_log`；不经过 `applyChanges` 的操作（管理端重命名、口令、AI 连接）用 `LedgerService.record()` 补记。操作者只能来自服务端验证过的身份（`actorOf(session)`、管理员、OAuth 授权），不能取自请求内容；`via` 例外，它是 `/api/ledger/changes` 请求体里客户端自报的来源标签，服务端无法验证，只用于展示，不代表身份。记录是 `{seq, at, actor, action, via?}` 的 JSON 原文，`hash = sha256(prev + "\n" + payload)`，有 `AUDIT_SIGNING_KEY` 时对哈希做 Ed25519 签名；SQLite 触发器禁止 UPDATE / DELETE。前端 `features/ledger/activity.ts` 从 localStorage 的检查点继续校验整条链，展示的旧记录必须能沿 `prev` 接到已校验的最新记录。
- `src/shared/` 前后端共用：zod 校验（`schema.ts`）、金额（以「分」为整数，`money.ts`）、结算算法、事件 reducer。MCP 工具复用同一套 zod 校验以保证错误信息一致。`limits.ts` 不依赖 zod，前端只从这里取限制，避免把 zod 打进前端包。
- 前端用 `hono/client` 拿到 `ApiType` 的端到端类型；新增接口时把路由链在 `buildApi()` 里，前端就能类型安全地调用。
- 管理功能是账本页顶部的「管理员卡片」（`src/web/features/admin/AdminCard.tsx`，按需加载）；`/admin` 只是登录入口页。
- 管理员认证：外部身份（Access JWT / 代理头 / none）只在 `GET /api/admin/login` 校验一次，password 模式用 `POST /api/admin/login`，都换成本站的 console 会话（`aapay_console`，24 小时）。其余 `/api/admin/*` 只认 console 会话并每次用 `stillAdmin` 重新确认白名单，过期返回 401；Access 应用只能保护 `/api/admin/login`，不能覆盖其他 API（Access 会把过期的 fetch 重定向成网络错误）。管理员进入账本的会话（`role: 'admin'`）绑定签发它的 console 会话，随之失效。前端从 `/api/session` 的 `admin` 字段得知管理员身份，管理接口返回 401 时由 `onAdminExpired`（`lib/api.ts`）统一清掉管理员状态。
- 国际化（`zh-CN` / `en`）：前端文案在 `src/web/i18n/`，按功能分文件，用 `messages({ 'zh-CN': {...}, en: {...} })` 定义（en 的结构由类型约束与 zh 一致），带参数或复数的文案写成函数。语言在页面加载时确定（localStorage `aapay:locale`，否则按浏览器语言），切换语言直接刷新页面，所以模块顶层可以直接取文案。前端请求带 `Accept-Language`，服务端据此翻译错误：`AppError` 只携带 `src/shared/errors.ts` 里的错误键和参数，zod 的 message 也写错误键（`schema.ts` 的 `msg()`），在 HTTP 出口（`app.ts` 的 `onError`、`validate.ts`）按请求语言翻译。`describeAudit` / `actorLabel` 需要传语言。MCP 面向模型，工具描述、instructions、工具错误与 `list_activity` 的文本固定英文（`tools.ts` 的 `LOCALE`）。新增界面文案或错误时两种语言都要写。
- 管理端的组合操作（重命名后通知在线成员、删除时销毁账本数据、撤销口令时断开连接）集中在 `src/server/admin.ts`，HTTP 接口与 MCP 工具共用。
- AI 助手：`POST /api/ledger/assistant` 以 SSE 返回事件，请求与事件类型在 `src/shared/assistant.ts`。服务端在 `src/server/ai/`：模型调用经服务商无关的 `model.ts`（`ModelRequest` / `Part` / `ModelError`，`sseStream` 负责 fetch、SSE 解析与空闲超时）与 `providers.ts` 的 `streamModel` / `checkModel` 分派到各服务商（`gemini.ts`；`claude.ts` 用官方 SDK `@anthropic-ai/sdk`；`chat.ts` 是 Chat Completions 客户端，服务 DeepSeek 与 OpenAI 兼容兜底），各自只做请求与流的格式转换；`assistant.ts` 不感知服务商。`assistant.ts` 跑函数调用循环（最多 `MAX_ROUNDS` 轮），读工具只查已入账数据（待确认提议单独附在 `pendingChanges`），写工具只调用 `plan` 生成 `Change`，经 `pending.ts` 的 `fold` 并入待确认变更集并用 `previewChanges` 预演，从不写库；用户在前端确认后才走 `/api/ledger/changes`（带 `via: 'assistant'`）。模型返回的 `Part` 原样放回本轮历史（Gemini 的 `thoughtSignature`、DeepSeek 的 `reasoning_content`、Claude 的 thinking / redacted_thinking 块都要回传）。Claude 的工具调用在 `content_block_stop` 时执行，空闲超时用 `model.ts` 的 `withIdleTimeout` 包住 SDK 的事件流；结构化输出的 schema 去掉 `maxItems`、对象补 `additionalProperties: false`，不传 `temperature`。OpenAI 兼容兜底只发通用字段（不发思考参数、`response_format`、`temperature`），识图靠提示词里的 schema，没有结束标记也照常收尾；用户自带的 Base URL 经 `base-url.ts` 的 `publicBaseUrl` 只放行公网 https（服务器会代为请求）。DeepSeek 默认开思考；工具调用参数分片到达，后一个调用开始且前一个参数已是完整 JSON 时先放行（卡片逐张出现），参数解析失败的调用 `args` 为 null，作为工具错误回给模型。图片先单独请求结构化 JSON（Gemini 用 `responseJsonSchema`，DeepSeek 用 `json_object` 并把 schema 写进提示词），由 `item-stream.ts` 增量解析成草稿卡片再逐条转成提议。`prompts.ts` 放系统提示词，提示词与工具描述面向模型，固定英文，不走 i18n。`sseStream` 只在等上游时计时，只有数据事件才续期（`: keep-alive` 不算），超时报 504 并与客户端断开区分。每个账本每分钟最多 30 次（Cloudflare 用 `ASSISTANT_LIMITER`，Node 用内置限流）。`ASSISTANT=disabled` 时 `/api/config` 的 `assistant` 为 null，前端隐藏入口；站点用 `ASSISTANT_PROVIDER` 那家的 Key（`GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `CLAUDE_API_KEY` / `OPENAI_API_KEY`，都可选；`openai` 还需 `OPENAI_BASE_URL` 与 `OPENAI_MODEL`）。用户自带 Key（BYOK）存在浏览器 localStorage（`own-key.ts`），每次请求以 `X-AI-Provider` / `X-AI-Key` / `X-AI-Model`（OpenAI 兼容另加 `X-AI-Base-URL`）头透传，服务端 `modelKey()`（`app.ts`）优先用它、只在本次请求里使用，不落库、不进日志与审计；只有自带 Key 时才允许换服务商和模型。站点没有 Key 且请求不带 Key 时返回 `assistantNeedsKey`。上游错误经 `upstreamError` 按是否自带 Key 区分（Key 无效、余额或额度不足、模型不存在）。前端在 `src/web/features/assistant/`：`store.ts` 管对话、变更集状态、确认与撤销，`AssistantDock` 是底部输入条与面板，`Conversation` / `ChangeCards` / `Views` 分别渲染对话、待确认卡片与查账图表（数字由前端用实时账本计算，模型只选 `AssistantView` 的种类与参数），`Composer` 与 `speech.ts` 处理输入、拍照与语音，`KeySheet` 是自带 Key 面板；文案在 `i18n/assistant.ts`。SSE 解析在 `src/shared/sse.ts`，前端与服务端共用。SSE 路由放在 `/api/*` 下，不需要新增 `SERVER_PATHS`（响应带 `X-Accel-Buffering: no`，反向代理不要缓冲）。
- 支出分类定义在 `src/shared/categories.ts`（键、emoji 与双语名称），前端、校验与 AI 助手共用。

## MCP 与 OAuth

- `src/server/mcp/oauth.ts`：授权服务器（RFC 9728 / 8414 发现、7591 动态注册、Client ID Metadata Document、PKCE S256、8707 资源绑定、刷新令牌轮换、7009 撤销、`private_key_jwt`）。Claude 与 ChatGPT 都用 CIMD（`client_id` 是元数据 URL），ChatGPT 还会用 `private_key_jwt`。
- `src/server/mcp/server.ts`：无状态 Streamable HTTP，`POST /mcp` 直接返回 JSON-RPC。账本工具在 `src/server/tools/ledger.ts`：读工具 `read(args, ctx)`，写工具是纯函数 `plan(args, { data, today }) => Change` 加 `describe(change, before, after)`，MCP 执行器（`src/server/mcp/tools.ts`）做 plan → `applyChanges` → describe，AI 助手复用同一批 plan 生成提议。金额对外以「元」为单位，成员与账本可用名字指代。
- 授权分两种角色：成员授权绑定一个账本（口令撤销、账本删除时级联失效）；管理员授权不绑定账本，可用管理员工具，账本工具必须用 `ledger` 参数指定账本。管理员授权走 `/api/admin/oauth/authorize`，与 `/admin` 用同一套管理员认证；每次请求都会按当前配置重新确认此人仍是管理员。
- `tools/list` 与 `initialize` 的 instructions 对所有授权都相同（客户端会缓存，换授权后不一定重新拉取），不要按角色或作用域过滤；权限在 `tools/call` 时检查：成员调用管理工具、`ledger` 参数与授权不符返回工具错误；只读令牌调用写入工具在 `POST /mcp` 入口返回 403 `insufficient_scope`，客户端据此重新授权（step-up），不能改成工具错误。
- `/oauth/authorize` 是前端页面（`src/web/features/oauth/AuthorizePage.tsx`），服务端只处理 `/api/oauth/authorize`。

## 改动时的注意点

- 新增服务端路径时，同时更新 `src/server/app.ts` 的 `SERVER_PATHS` 与 `wrangler.jsonc` 的 `assets.run_worker_first`，否则 Cloudflare 上该路径会被静态资源（SPA 回退）接走。`/oauth/*` 上的中间件必须按具体路径挂载，不能覆盖 `/oauth/authorize`。
- 数据迁移：`registry.ts` 与 `ledger.ts` 的 `MIGRATIONS` 只能在末尾追加，已发布的条目不能修改或删除；生产环境的 DO 里有真实数据，迁移需保留现有行（参考迁移 4 的建新表、拷贝、重命名，`tests/mcp.test.ts` 里有对应的迁移测试）。
- Cloudflare Workers 的 `fetch` 不支持 `redirect: 'error'`（会直接抛错），需要不跟随跳转时用 `redirect: 'manual'` 并检查状态码。vitest 跑在 Node 平台上，测试里模拟 `fetch` 时要让模拟行为与 Workers 一致。
- 测试通过 `createNodePlatform` + `app.request()` 直接驱动整个应用；限流按实例计数（每分钟 10 次加入 / 注册），需要大量授权的用例各自新建 `setup()`。
- 界面文案求短：页面上直接显示的说明、提示、空状态、toast 都只写一句短话，第一眼能看完，不写成段的长句。放不下但仍有用的细节收进 `components/Hint.tsx`（问号图标，桌面悬停、触屏点击展开）；不重要的细节直接删掉。中英两种语言都按此要求，新增或修改文案时检查。
- iOS Safari 聚焦字号小于 16px 的输入框时会自动放大页面，且不会缩回。所有 `input` / `textarea` / `select` 在触屏上都必须至少 16px：优先用 `index.css` 的 `.field`（已带 `pointer-coarse:text-base`），不要再给它加 `text-sm` / `text-[13px]` 等更小字号；不用 `.field` 的自定义输入框（如 `assistant/Composer.tsx` 的输入框、`ExpenseForm.tsx` 按金额分摊的金额输入）必须自己加 `pointer-coarse:text-base`。桌面端可以保留小字号。
- 配置变量在 `src/server/config.ts` 统一解析，Cloudflare（构建变量注入的 vars / secrets）与 Docker（`.env`）共用同一套变量名；新增变量时同步 README（中英）的配置表与 `.env.example`，普通变量还要加进 `vite.config.ts` 的 `RUNTIME_VARS`。
