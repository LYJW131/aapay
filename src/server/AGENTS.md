# src/server

平台无关的服务端。跨目录的规则见根 `AGENTS.md`。

## 服务与变更集

- 业务逻辑在 `core/` 的同步服务里：`RegistryService`（账本、口令、会话、OAuth 客户端与授权）和 `LedgerService`（单个账本的成员、支出、还款）。
- Cloudflare 上每个账本一个 `LedgerRoom` DO，全局一个 `RegistryRoom` DO；Node 上对应 `data/ledgers/<id>.db` 与 `data/registry.db`；演示站上对应浏览器里的 sql.js 数据库。服务通过 `remote()` / `dispatch()`（`core/remote.ts`）调用：`AppError` 不能原样穿过 DO RPC，先装进信封再在调用方还原，所以服务方法里只抛 `AppError`。
- 账目变更只有一个入口：`LedgerService.applyChanges(changes, ctx)`（HTTP 为 `POST /api/ledger/changes`），变更集类型在 `src/shared/changes.ts`、zod 在 `src/shared/schema.ts` 的 `changeSchema`。一组变更在一个事务里执行，每条有实际变化的变更各自递增版本号、追加审计，提交后才按顺序广播 `LiveMessage`（同批共享 `batch`）；任一条失败整体回滚。返回的 `undo` 可原样再交给 `applyChanges` 撤销。`previewChanges` 用同一套 mutator 在事务里预演后回滚，AI 的提议都在它上面预演。新记录的 id 由调用方用 `src/shared/ids.ts` 的 `newId()` 预分配。前端 `LedgerStore` 按版本号应用增量，发现缺口就重新拉快照。`origin` 为发起方的客户端 ID；MCP 写入时为 `mcp:<客户端名>`，网页据此提示是哪个 AI 应用改的。
- 管理端的组合操作（重命名后通知在线成员、删除时销毁账本数据、撤销口令时断开连接）集中在 `admin.ts`，HTTP 接口与 MCP 工具共用。

## 操作动态（审计日志）

- `MutationContext`（操作者 + origin + 可选 `via: 'assistant'`）随变更集传入，`applyChanges` 在同一个事务里递增版本号并追加 `audit_log`；不经过 `applyChanges` 的操作（管理端重命名、口令、AI 连接）用 `LedgerService.record()` 补记。
- 操作者只能来自服务端验证过的身份（`actorOf(session)`、管理员、OAuth 授权），不能取自请求内容；`via` 例外，它是 `/api/ledger/changes` 请求体里客户端自报的来源标签，服务端无法验证，只用于展示，不代表身份。
- 记录是 `{seq, at, actor, action, via?}` 的 JSON 原文，`hash = sha256(prev + "\n" + payload)`，有 `AUDIT_SIGNING_KEY` 时对哈希做 Ed25519 签名；SQLite 触发器禁止 UPDATE / DELETE。前端 `src/web/features/ledger/activity.ts` 从 localStorage 的检查点继续校验整条链，展示的旧记录必须能沿 `prev` 接到已校验的最新记录。

## 管理员认证

- 外部身份（Access JWT / 代理头 / none）只在 `GET /api/admin/login` 校验一次，password 模式用 `POST /api/admin/login`，都换成本站的 console 会话（`aapay_console`，24 小时）。
- 其余 `/api/admin/*` 只认 console 会话并每次用 `stillAdmin` 重新确认白名单，过期返回 401；Access 应用只能保护 `/api/admin/login`，不能覆盖其他 API（Access 会把过期的 fetch 重定向成网络错误）。
- 管理员进入账本的会话（`role: 'admin'`）绑定签发它的 console 会话，随之失效。

## 错误与语言

- `AppError` 只携带 `src/shared/errors.ts` 里的错误键和参数，zod 的 message 也写错误键（`src/shared/schema.ts` 的 `msg()`），在 HTTP 出口（`app.ts` 的 `onError`、`validate.ts`）按请求的 `Accept-Language` 翻译。`describeAudit` / `actorLabel` 需要传语言。
- MCP 面向模型，工具描述、instructions、工具错误与 `list_activity` 的文本固定英文（`tools/ledger.ts` 的 `TOOL_LOCALE`）。

## AI 助手

- `POST /api/ledger/assistant` 以 SSE 返回事件，请求与事件类型在 `src/shared/assistant.ts`。SSE 解析在 `src/shared/sse.ts`，前端与服务端共用。SSE 路由放在 `/api/*` 下，不需要新增 `SERVER_PATHS`（响应带 `X-Accel-Buffering: no`，反向代理不要缓冲）。
- 模型调用经服务商无关的 `ai/model.ts`（`ModelRequest` / `Part` / `ModelError`，`sseStream` 负责 fetch、SSE 解析与空闲超时）与 `ai/providers.ts` 的 `streamModel` / `checkModel` 分派到各服务商（`ai/gemini.ts`；`ai/claude.ts` 用官方 SDK `@anthropic-ai/sdk`；`ai/chat.ts` 是 Chat Completions 客户端，服务 DeepSeek 与 OpenAI 兼容兜底），各自只做请求与流的格式转换；`ai/assistant.ts` 不感知服务商。
- `ai/assistant.ts` 跑函数调用循环（最多 `MAX_ROUNDS` 轮），读工具只查已入账数据（待确认提议单独附在 `pendingChanges`），写工具只调用 `plan` 生成 `Change`，经 `ai/pending.ts` 的 `fold` 并入待确认变更集并用 `previewChanges` 预演，从不写库；用户在前端确认后才走 `/api/ledger/changes`（带 `via: 'assistant'`）。
- 模型返回的 `Part` 原样放回本轮历史（Gemini 的 `thoughtSignature`、DeepSeek 的 `reasoning_content`、Claude 的 thinking / redacted_thinking 块都要回传）。
- Claude 的工具调用在 `content_block_stop` 时执行，空闲超时用 `ai/model.ts` 的 `withIdleTimeout` 包住 SDK 的事件流；结构化输出的 schema 去掉 `maxItems`、对象补 `additionalProperties: false`，不传 `temperature`。SDK 只在浏览器里（演示站）开启 `dangerouslyAllowBrowser`。
- OpenAI 兼容兜底只发通用字段（不发思考参数、`response_format`、`temperature`），识图靠提示词里的 schema，没有结束标记也照常收尾；用户自带的 Base URL 经 `ai/base-url.ts` 的 `publicBaseUrl` 只放行公网 https（服务器会代为请求）。
- DeepSeek 默认开思考；工具调用参数分片到达，后一个调用开始且前一个参数已是完整 JSON 时先放行（卡片逐张出现），参数解析失败的调用 `args` 为 null，作为工具错误回给模型。
- 图片先单独请求结构化 JSON（Gemini 用 `responseJsonSchema`，DeepSeek 用 `json_object` 并把 schema 写进提示词），由 `ai/item-stream.ts` 增量解析成草稿卡片再逐条转成提议。
- `ai/prompts.ts` 放系统提示词，提示词与工具描述面向模型，固定英文，不走 i18n。
- `sseStream` 只在等上游时计时，只有数据事件才续期（`: keep-alive` 不算），超时报 504 并与客户端断开区分。
- 每个账本每分钟最多 30 次（Cloudflare 用 `ASSISTANT_LIMITER`，Node 用内置限流）。
- `ASSISTANT=disabled` 时 `/api/config` 的 `assistant` 为 null，前端隐藏入口；站点用 `ASSISTANT_PROVIDER` 那家的 Key（`GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `CLAUDE_API_KEY` / `OPENAI_API_KEY`，都可选；`openai` 还需 `OPENAI_BASE_URL` 与 `OPENAI_MODEL`）。
- 用户自带 Key（BYOK）以 `X-AI-Provider` / `X-AI-Key` / `X-AI-Model`（OpenAI 兼容另加 `X-AI-Base-URL`）头透传，服务端 `modelKey()`（`app.ts`）优先用它、只在本次请求里使用，不落库、不进日志与审计；只有自带 Key 时才允许换服务商和模型。站点没有 Key 且请求不带 Key 时返回 `assistantNeedsKey`。上游错误经 `upstreamError` 按是否自带 Key 区分（Key 无效、余额或额度不足、模型不存在）。

## MCP 与 OAuth

- `mcp/oauth.ts`：授权服务器（RFC 9728 / 8414 发现、7591 动态注册、Client ID Metadata Document、PKCE S256、8707 资源绑定、刷新令牌轮换、7009 撤销、`private_key_jwt`）。Claude 与 ChatGPT 都用 CIMD（`client_id` 是元数据 URL），ChatGPT 还会用 `private_key_jwt`。
- `mcp/server.ts`：无状态 Streamable HTTP，`POST /mcp` 直接返回 JSON-RPC。账本工具在 `tools/ledger.ts`：读工具 `read(args, ctx)`，写工具是纯函数 `plan(args, { data, today }) => Change` 加 `describe(change, before, after)`，MCP 执行器（`mcp/tools.ts`）做 plan → `applyChanges` → describe，AI 助手复用同一批 plan 生成提议。金额对外以「元」为单位，成员与账本可用名字指代。
- 授权分两种角色：成员授权绑定一个账本（口令撤销、账本删除时级联失效）；管理员授权不绑定账本，可用管理员工具，账本工具必须用 `ledger` 参数指定账本。管理员授权走 `/api/admin/oauth/authorize`，与 `/admin` 用同一套管理员认证；每次请求都会按当前配置重新确认此人仍是管理员。
- `tools/list` 与 `initialize` 的 instructions 对所有授权都相同（客户端会缓存，换授权后不一定重新拉取），不要按角色或作用域过滤；权限在 `tools/call` 时检查：成员调用管理工具、`ledger` 参数与授权不符返回工具错误；只读令牌调用写入工具在 `POST /mcp` 入口返回 403 `insufficient_scope`，客户端据此重新授权（step-up），不能改成工具错误。
- `/oauth/authorize` 是前端页面（`src/web/features/oauth/AuthorizePage.tsx`），服务端只处理 `/api/oauth/authorize`。`/oauth/*` 上的中间件必须按具体路径挂载，不能覆盖 `/oauth/authorize`。

## 数据迁移

- `core/registry.ts` 与 `core/ledger.ts` 的 `MIGRATIONS` 只能在末尾追加，已发布的条目不能修改或删除；生产环境的 DO 里有真实数据，迁移需保留现有行（参考迁移 4 的建新表、拷贝、重命名，`tests/mcp.test.ts` 里有对应的迁移测试）。

## 运行时的坑

- Cloudflare Workers 的 `fetch` 不支持 `redirect: 'error'`（会直接抛错），需要不跟随跳转时用 `redirect: 'manual'` 并检查状态码。vitest 跑在 Node 平台上，测试里模拟 `fetch` 时要让模拟行为与 Workers 一致。
- 服务端代码也会在浏览器里运行（演示站）：不要在 `cloudflare/` 与 `node/` 之外引入 `node:*` 模块、`Buffer`、`process`。
