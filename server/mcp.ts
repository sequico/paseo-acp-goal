import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ToolSignal } from "./guard";

/**
 * The goal tool, served over the only channel that exists.
 *
 * A completion *tool* beats a completion *string*: a sentinel is text an agent
 * can emit by accident while explaining the protocol, inside a diff, or in a
 * quoted log, whereas a tool call is a deliberate, typed act.
 *
 * It is reached over HTTP rather than stdio because Paseo evaluates a plugin's
 * server bundle with `globalThis.eval(bundle)`, so the bundle has no
 * `import.meta.url`, no `__dirname`, and no path back to its own directory — a
 * helper script shipped in this repository cannot be located at runtime. A
 * loopback listener has no such problem: the plugin binds it, and the address it
 * hands the agent is plain data.
 *
 * This implements the subset of MCP Streamable HTTP a tool-only server needs:
 * `initialize`, `ping`, `tools/list`, `tools/call`. It answers with
 * `application/json` rather than opening an SSE stream, which the specification
 * permits, and it holds no session state, so `Mcp-Session-Id` is accepted and
 * ignored.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const MAX_BODY_BYTES = 256 * 1024;

/** The tool names are owned here, and imported by the prompt that tells an agent to use them. */
export const GOAL_TOOL_COMPLETE = "goal_complete";
export const GOAL_TOOL_BLOCKED = "goal_blocked";

export const MCP_SERVER_NAME = "paseo-acp-goal";

export interface ToolCallEvent extends ToolSignal {
  /** The per-session token the call arrived on, which maps to one agent. */
  token: string;
}

export interface GoalMcpOptions {
  onSignal: (event: ToolCallEvent) => void;
  version: string;
}

export interface GoalMcp {
  /** Base origin, for example `http://127.0.0.1:41234`. */
  readonly origin: string;
  urlFor: (token: string) => string;
  close: () => Promise<void>;
}

export function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

const completeArgs = z.object({ summary: z.string().optional() }).loose();
const blockedArgs = z.object({ reason: z.string().min(1) }).loose();

const TOOL_DEFINITIONS = [
  {
    name: GOAL_TOOL_COMPLETE,
    title: "Declare the goal met",
    description:
      "Call this when the goal for this session is fully met. It ends the automated " +
      "continuation loop. Do not call it to report partial progress or to say you are " +
      "about to finish.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One line describing what was achieved. Optional.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: GOAL_TOOL_BLOCKED,
    title: "Report a blockage",
    description:
      "Call this when you cannot make progress without a human decision. It pauses the " +
      "loop instead of pushing you on, so a real blocker is never papered over.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "What you are blocked on, and what you need from the human.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface RpcContext {
  token: string;
  version: string;
  onSignal: (event: ToolCallEvent) => void;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function textResult(text: string): unknown {
  return { content: [{ type: "text", text }], isError: false };
}

function selectProtocolVersion(requested: unknown): string {
  const match = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested);
  return match ?? LATEST_PROTOCOL_VERSION;
}

/** One `tools/call`, split from the transport switch so the dispatch stays readable. */
function handleToolCall(
  id: unknown,
  params: { name?: unknown; arguments?: unknown } | undefined,
  context: RpcContext,
): string {
  const name = typeof params?.name === "string" ? params.name : "";

  if (name === GOAL_TOOL_COMPLETE) {
    const parsed = completeArgs.safeParse(params?.arguments ?? {});
    if (!parsed.success) {
      return rpcError(id, -32602, "Invalid arguments for goal_complete");
    }
    const summary = parsed.data.summary?.trim();
    context.onSignal({
      token: context.token,
      kind: "complete",
      detail: summary === undefined || summary.length === 0 ? null : summary,
    });
    return rpcResult(
      id,
      textResult(
        "Recorded: the goal is met. The continuation loop will stop at the end of this turn.",
      ),
    );
  }

  if (name === GOAL_TOOL_BLOCKED) {
    const parsed = blockedArgs.safeParse(params?.arguments ?? {});
    if (!parsed.success) {
      return rpcError(id, -32602, "Invalid arguments for goal_blocked: `reason` is required");
    }
    context.onSignal({ token: context.token, kind: "blocked", detail: parsed.data.reason.trim() });
    return rpcResult(
      id,
      textResult("Recorded: blocked. The loop is paused for a human to answer."),
    );
  }

  return rpcError(id, -32602, `Unknown tool: ${name}`);
}

/**
 * Handle one JSON-RPC message. Returns the response body, or `null` for a
 * notification, which has no reply.
 */
export function handleRpcMessage(message: JsonRpcRequest, context: RpcContext): string | null {
  const method = typeof message.method === "string" ? message.method : "";
  const isNotification = message.id === undefined || message.id === null;

  switch (method) {
    case "initialize": {
      const params = message.params as { protocolVersion?: unknown } | undefined;
      return rpcResult(message.id, {
        protocolVersion: selectProtocolVersion(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: context.version },
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: TOOL_DEFINITIONS });
    case "tools/call":
      return handleToolCall(
        message.id,
        message.params as { name?: unknown; arguments?: unknown } | undefined,
        context,
      );
    default:
      if (isNotification) {
        return null;
      }
      return rpcError(message.id, -32601, `Method not found: ${method}`);
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The goal tool listener did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startGoalMcp(options: GoalMcpOptions): Promise<GoalMcp> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, options);
  });

  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    urlFor: (token: string) => `${origin}/mcp/${token}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: GoalMcpOptions,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const token = /^\/mcp\/([A-Za-z0-9_-]{8,})$/.exec(path)?.[1];

  if (token === undefined) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  if (req.method === "GET") {
    res
      .writeHead(405, { "content-type": "text/plain", allow: "POST, DELETE" })
      .end("This server offers no SSE stream. POST JSON-RPC instead.");
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "text/plain", allow: "POST" }).end("Method not allowed");
    return;
  }

  const raw = await readBody(req);
  if (raw === null) {
    res.writeHead(413, { "content-type": "text/plain" }).end("Request body too large");
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(rpcError(null, -32700, "Parse error"));
    return;
  }

  if (Array.isArray(payload)) {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(rpcError(null, -32600, "Batch requests are not supported"));
    return;
  }

  const message = payload as JsonRpcRequest;
  const body = handleRpcMessage(message, {
    token,
    version: options.version,
    onSignal: options.onSignal,
  });

  if (body === null) {
    res.writeHead(202).end();
    return;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (message.method === "initialize") {
    headers["mcp-session-id"] = token;
  }
  res.writeHead(200, headers).end(body);
}
