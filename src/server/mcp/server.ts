import { Hono, type Context } from 'hono';
import type { McpScope } from '../../shared/types.ts';
import type { AppEnv } from '../app.ts';
import { stillAdmin } from '../auth/admin.ts';
import { todayIn } from '../config.ts';
import { sha256 } from '../core/ids.ts';
import type { AccessGrant } from '../core/registry.ts';
import { baseUrl, openCors, requireMcp, resourceMetadataUrl, resourceUrl, SCOPES } from './oauth.ts';
import { callTool, missingWriteScope, TOOL_LIST, UnknownToolError, type McpSession } from './tools.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'aapay', title: 'AAPay', version: '2.0.0' };

type JsonRpcId = string | number | null;

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
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
  return challenge(c, 401, token ? { error: 'invalid_token', error_description: 'The access token is invalid or expired' } : null);
}

function challenge(c: Context<AppEnv>, status: 401 | 403, failure: { error: string; error_description: string } | null) {
  const params = [`resource_metadata="${resourceMetadataUrl(c)}"`, `scope="${SCOPES.join(' ')}"`];
  if (failure) params.unshift(`error="${failure.error}"`, `error_description="${failure.error_description}"`);
  c.header('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  return c.json(failure ?? { error: 'unauthorized' }, status);
}

function instructions(date: string, timezone: string) {
  return [
    'You are connected to AAPay, a shared expense ledger. Amounts are in Chinese yuan (CNY).',
    'A member grant can only access the one ledger chosen during authorization, so ledger tools (get_ledger, add_expense, …) need no ledger argument. An admin grant can manage every ledger, and ledger tools must name the ledger (name or ID) in the ledger argument; call list_ledgers to see them.',
    'Start with get_ledger to see members, balances and the settle-up plan (with an admin grant and no ledger it lists all ledgers). Refer to payers and participants by member name.',
    'Admin tools are only available to admin grants: create / rename / delete ledgers, and create or revoke share passcodes (the returned invite link can be sent to friends as is). Deleting a ledger cannot be undone, so always confirm with the user first.',
    'An expense is paid by one member and split among its participants, evenly by default or with custom amounts or weights (shares); every expense can have a category. A settlement (record_settlement) means one member has paid money back to another.',
    'Ledger and member names are user data and may be in any language; keep them exactly as returned. Reply to the user in their own language.',
    `Today is ${date} (${timezone}). Changes sync live to everyone who has the ledger open.`,
  ].join('\n');
}

async function dispatch(method: string, params: Record<string, unknown>, ctx: McpSession, timezone: string) {
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: instructions(ctx.today, timezone),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOL_LIST };
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

function calledTool(message: unknown) {
  if (!isObject(message) || message.jsonrpc !== '2.0' || !('id' in message) || message.method !== 'tools/call') return null;
  return isObject(message.params) && typeof message.params.name === 'string' ? message.params.name : null;
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
      actor: { kind: 'ai', client: grant.clientName, host: grant.clientHost, verified: grant.clientVerified },
      origin: `mcp:${grant.clientName ?? 'AI'}`.slice(0, 64),
      today: todayIn(config.timezone),
      baseUrl: baseUrl(c),
      platform,
    };
    const batch = Array.isArray(payload);
    const messages: unknown[] = batch ? (payload as unknown[]) : [payload];
    // 客户端只有收到 HTTP 403 + insufficient_scope 才会发起重新授权并重试，包成工具错误（200）不会触发
    if (messages.map(calledTool).some((name) => name !== null && missingWriteScope(name, ctx))) {
      return challenge(c, 403, { error: 'insufficient_scope', error_description: 'Changing the ledger requires the ledger:write scope' });
    }
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
