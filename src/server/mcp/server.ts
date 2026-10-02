import { Hono, type Context } from 'hono';
import type { McpScope } from '../../shared/types.ts';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config.ts';
import { sha256 } from '../core/ids.ts';
import type { AccessGrant } from '../core/registry.ts';
import { baseUrl, openCors, requireMcp, resourceMetadataUrl, resourceUrl, SCOPES } from './oauth.ts';
import { callTool, listTools, UnknownToolError, type McpSession } from './tools.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'aapay', title: 'AAPay', version: '2.0.0' };

type JsonRpcId = string | number | null;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function authenticate(c: Context<AppEnv>): Promise<AccessGrant | Response> {
  const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  const grant = token ? await c.var.platform.registry.resolveAccessToken(await sha256(token)) : null;
  // 令牌必须签发给本资源（RFC 8707）；管理员授权还要确认此人现在仍是管理员
  if (grant && grant.resource === resourceUrl(c) && (grant.role !== 'admin' || stillAdmin(c.var.config, grant.subject))) {
    return grant;
  }

  const params = [`resource_metadata="${resourceMetadataUrl(c)}"`, `scope="${SCOPES.join(' ')}"`];
  if (token) params.unshift('error="invalid_token"', 'error_description="The access token is invalid or expired"');
  c.header('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  return c.json(
    token ? { error: 'invalid_token', error_description: 'The access token is invalid or expired' } : { error: 'unauthorized' },
    401,
  );
}

function today(timezone: string) {
  // en-CA 的日期格式恰好是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

// 与 authenticateAdmin 一致：白名单只在 access / proxy 模式下生效
function stillAdmin(config: Config, subject: string | null) {
  if (config.adminAuth === 'disabled' || !subject) return false;
  if (config.adminAuth !== 'access' && config.adminAuth !== 'proxy') return true;
  return config.adminEmails.length === 0 || config.adminEmails.includes(subject.toLowerCase());
}

function instructions(session: McpSession, timezone: string) {
  const lines =
    session.role === 'admin'
      ? [
          '你以管理员身份连接到 AAPay 多人记账，可以管理全部账本。金额单位为人民币元。',
          '先调用 list_ledgers 查看有哪些账本；账本内的工具（get_ledger、add_expense 等）都需要用 ledger 参数指定账本名称或 ID。',
          '管理工具可以创建 / 重命名 / 删除账本，生成或撤销分享口令（返回的邀请链接可直接发给朋友）。删除账本不可恢复，执行前务必向用户确认。',
        ]
      : [
          `你已连接到 AAPay 多人记账账本「${session.ledger!.name}」。金额单位为人民币元。`,
          '建议先调用 get_ledger 查看成员、余额与结清方案；记账时付款人和参与者直接使用成员名字。',
        ];
  lines.push(
    '支出由一人垫付、参与者平均分摊；还款（record_settlement）表示某人已把钱转给另一人。',
    `今天是 ${session.today}（${timezone}）。修改会实时同步到所有打开账本的人。`,
  );
  if (!session.scopes.has('ledger:write')) lines.push('当前授权为只读，只能查询，不能修改。');
  return lines.join('\n');
}

async function dispatch(method: string, params: Record<string, unknown>, ctx: McpSession, timezone: string) {
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: instructions(ctx, timezone),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listTools(ctx) };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'Missing tool name');
      try {
        return await callTool(params.name, params.arguments, ctx);
      } catch (err) {
        if (err instanceof UnknownToolError) throw new RpcError(-32602, err.message);
        throw err;
      }
    }
    // 未声明这些能力，但有的客户端仍会探测，回空列表比报错更友好
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handle(message: unknown, ctx: McpSession, timezone: string) {
  if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid Request');
  const id = (message.id ?? null) as JsonRpcId;
  if (typeof message.method !== 'string') return null;
  if (!('id' in message)) return null;
  try {
    const params = isObject(message.params) ? message.params : {};
    return { jsonrpc: '2.0', id, result: await dispatch(message.method, params, ctx, timezone) };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message);
    console.error(err);
    return rpcError(id, -32603, 'Internal error');
  }
}

export const mcpRoutes = new Hono<AppEnv>()
  .use(openCors, requireMcp)
  .use(async (c, next) => {
    const version = c.req.header('mcp-protocol-version');
    if (version && !PROTOCOL_VERSIONS.includes(version)) {
      return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version}`), 400);
    }
    await next();
  })
  .post('/', async (c) => {
    const grant = await authenticate(c);
    if (grant instanceof Response) return grant;

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }

    const { config, platform } = c.var;
    const ctx: McpSession = {
      role: grant.role,
      ledger: grant.ledger,
      scopes: new Set(grant.scope.split(' ') as McpScope[]),
      origin: `mcp:${grant.clientName ?? 'AI'}`.slice(0, 64),
      today: today(config.timezone),
      baseUrl: baseUrl(c),
      platform,
    };
    const batch = Array.isArray(payload);
    const messages: unknown[] = batch ? (payload as unknown[]) : [payload];
    const replies = (await Promise.all(messages.map((m) => handle(m, ctx, config.timezone)))).filter((r) => r !== null);
    if (!replies.length) return c.body(null, 202);
    return c.json(batch ? replies : replies[0]);
  })
  // 无状态模式没有推送流和会话；先校验令牌，让客户端能从 401 发现授权方式
  .on(['GET', 'DELETE'], '/', async (c) => {
    const grant = await authenticate(c);
    if (grant instanceof Response) return grant;
    c.header('Allow', 'POST');
    return c.json(rpcError(null, -32000, 'Method not allowed'), 405);
  });
