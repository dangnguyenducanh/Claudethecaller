/**
 * The `/mcp` adapter: serves the `McpTool` objects of the earlier tasks as a stateless Streamable HTTP MCP server on top of the official SDK.
 * Called from: ./app.ts (the `POST /mcp` route). Why it exists: spec:63 names the SDK, and the tool factories return plain objects (name, description,
 * Zod `inputSchema`, `call`) so that nothing before this task needed a transport.
 * Deliberately NOT done: sessions (every POST builds its own server and transport, `Mcp-Session-Id` is neither issued nor required), SSE streams
 * (`enableJsonResponse` answers `application/json`), resources and prompts, auth (local mode serves `userId` `local` to every caller), argument validation
 * (each tool parses its own arguments and answers `isError` itself).
 * Untrusted: every request byte and every tool argument. A tool that throws becomes `isError: true` with the class name only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpResult, McpTool } from '../library/http.ts';

/** The name the Python install registered with `claude mcp add`, so a user's existing registration keeps working. */
export const MCP_SERVER_NAME = 'claudethecaller';

const EMPTY_OBJECT = { type: 'object', properties: {} } as const;

/** The JSON Schema of a tool's Zod schema; a schema the converter cannot express (a transform, say) is listed as an open object, and the tool still validates. */
function schemaOf(tool: McpTool): Record<string, unknown> {
  try {
    const out = toJsonSchemaCompat(tool.inputSchema as Parameters<typeof toJsonSchemaCompat>[0]);
    return out['type'] === 'object' ? out : { ...EMPTY_OBJECT };
  } catch {
    return { ...EMPTY_OBJECT };
  }
}

const errClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

/** Returns the request handler for `POST /mcp`; `listed` is computed once. `body` is the parsed JSON (or undefined when the bytes were not JSON). */
export function createMcpHandler(tools: readonly McpTool[], log?: (message: string, fields?: Record<string, unknown>) => void) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaOf(t) }));

  const call = async (name: string, args: unknown): Promise<McpResult> => {
    const tool = byName.get(name);
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name.slice(0, 80)}`);
    try {
      return await tool.call({ userId: 'local' }, args ?? {});
    } catch (e) {
      log?.('mcp tool failed', { tool: name, error: errClass(e) });
      return { content: [{ type: 'text', text: errClass(e) }], isError: true };
    }
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = new Server({ name: MCP_SERVER_NAME, version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => call(r.params.name, r.params.arguments));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    // the SDK's own class declares `onclose?` loosely; it is the Transport the Server expects
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  };
}
