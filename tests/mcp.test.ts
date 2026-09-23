import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GOAL_TOOL_BLOCKED,
  GOAL_TOOL_COMPLETE,
  handleRpcMessage,
  startGoalMcp,
  type GoalMcp,
  type ToolCallEvent,
} from "../server/mcp";

/**
 * The MCP surface is exercised over a real HTTP listener rather than by calling the
 * handler directly, because the part most likely to be wrong is the transport: a
 * wrong status code, a missing header, or a body the client cannot parse. The
 * protocol handler itself is covered by the same requests.
 *
 * The cases live in module-scope functions rather than inline closures so the file
 * stays inside the linter's nesting limits; a test that is too deep to read is a
 * test nobody re-reads.
 */

interface Rpc {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

const rpcContext = {
  token: "tok",
  version: "9.9.9",
  onSignal: () => {},
};

function parseBody(body: string | null): Record<string, unknown> {
  return JSON.parse(body ?? "{}") as Record<string, unknown>;
}

function errorCodeOf(body: string | null): number {
  const parsed = parseBody(body) as { error?: { code?: number } };
  return parsed.error?.code ?? 0;
}

function post(url: string, body: Rpc, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function callTool(url: string, name: string, args: Record<string, unknown>): Promise<Response> {
  return post(url, { id: 1, method: "tools/call", params: { name, arguments: args } });
}

interface ServerRun {
  server: GoalMcp;
  events: ToolCallEvent[];
}

async function withServer(run: (run: ServerRun) => Promise<void>): Promise<void> {
  const events: ToolCallEvent[] = [];
  const server = await startGoalMcp({ version: "9.9.9", onSignal: (event) => events.push(event) });
  try {
    await run({ server, events });
  } finally {
    await server.close();
  }
}

const TOKEN = "tokentokentoken";

async function caseHandshake({ server, events }: ServerRun): Promise<void> {
  const url = server.urlFor(TOKEN);

  const init = await post(url, { id: 1, method: "initialize", params: {} });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("mcp-session-id"), TOKEN);

  const listed = await post(url, { id: 2, method: "tools/list" });
  assert.equal(listed.status, 200);

  const called = await callTool(url, GOAL_TOOL_COMPLETE, { summary: "  all green  " });
  const payload = (await called.json()) as { result: { isError: boolean } };
  assert.equal(payload.result.isError, false);
  assert.deepEqual(events, [{ token: TOKEN, kind: "complete", detail: "all green" }]);
}

async function caseBlockage({ server, events }: ServerRun): Promise<void> {
  const response = await callTool(server.urlFor(TOKEN), GOAL_TOOL_BLOCKED, {
    reason: "no API key",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(events, [{ token: TOKEN, kind: "blocked", detail: "no API key" }]);
}

async function caseRefusals({ server }: ServerRun): Promise<void> {
  const notFound = await fetch(`${server.origin}/not-a-token`);
  assert.equal(notFound.status, 404);

  const badBody = await fetch(server.urlFor(TOKEN), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  });
  assert.equal(errorCodeOf(await badBody.text()), -32700);

  const wrongMethod = await fetch(server.urlFor(TOKEN), { method: "PUT" });
  assert.equal(wrongMethod.status, 405);

  const get = await fetch(server.urlFor(TOKEN));
  assert.equal(get.status, 405, "a GET must not open a stream this server does not offer");
}

async function caseBatch({ server }: ServerRun): Promise<void> {
  const response = await fetch(server.urlFor(TOKEN), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ id: 1, method: "ping" }]),
  });
  assert.equal(errorCodeOf(await response.text()), -32600);
}

describe("handleRpcMessage", () => {
  it("answers initialize with the protocol version the client asked for", () => {
    const body = handleRpcMessage(
      { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      rpcContext,
    );
    const parsed = parseBody(body) as { result: { protocolVersion: string } };
    assert.equal(parsed.result.protocolVersion, "2025-03-26");
  });

  it("falls back to the latest protocol version for an unknown request", () => {
    const body = handleRpcMessage(
      { id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      rpcContext,
    );
    const parsed = parseBody(body) as { result: { protocolVersion: string } };
    assert.equal(parsed.result.protocolVersion, "2025-06-18");
  });

  it("lists exactly the two goal tools", () => {
    const body = handleRpcMessage({ id: 2, method: "tools/list" }, rpcContext);
    const parsed = parseBody(body) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(
      parsed.result.tools.map((tool) => tool.name).sort(),
      [GOAL_TOOL_BLOCKED, GOAL_TOOL_COMPLETE].sort(),
    );
  });

  it("replies to nothing for a notification", () => {
    assert.equal(handleRpcMessage({ method: "notifications/initialized" }, rpcContext), null);
    assert.equal(handleRpcMessage({ method: "something/unknown" }, rpcContext), null);
  });

  it("rejects an unknown method and an unknown tool", () => {
    assert.equal(errorCodeOf(handleRpcMessage({ id: 3, method: "nope" }, rpcContext)), -32601);
    assert.equal(
      errorCodeOf(
        handleRpcMessage({ id: 4, method: "tools/call", params: { name: "nope" } }, rpcContext),
      ),
      -32602,
    );
  });
});

describe("the goal tool over HTTP", () => {
  it("binds to loopback on an ephemeral port and hands out a per-token URL", async () => {
    await withServer(async ({ server }) => {
      assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(server.urlFor("abc12345"), `${server.origin}/mcp/abc12345`);
    });
  });

  it("runs a full handshake and a completion call", () => withServer(caseHandshake));

  it("records a blockage with its reason", () => withServer(caseBlockage));

  it("refuses a blockage without a reason instead of recording an empty one", async () => {
    await withServer(async ({ server, events }) => {
      const response = await callTool(server.urlFor(TOKEN), GOAL_TOOL_BLOCKED, {});
      assert.equal(errorCodeOf(await response.text()), -32602);
      assert.deepEqual(events, []);
    });
  });

  it("answers a notification with 202 and no body", async () => {
    await withServer(async ({ server }) => {
      const response = await post(server.urlFor(TOKEN), { method: "notifications/initialized" });
      assert.equal(response.status, 202);
      assert.equal(await response.text(), "");
    });
  });

  it("keeps one agent's signal off another agent's token", async () => {
    await withServer(async ({ server }) => {
      await callTool(server.urlFor("tokenAAAAAAAA"), GOAL_TOOL_COMPLETE, {});
      const other = await post(server.urlFor("tokenBBBBBBBB"), { id: 1, method: "ping" });
      assert.equal(other.status, 200);
    });
  });

  it("rejects a request without a token, a bad body, and a wrong method", () =>
    withServer(caseRefusals));

  it("refuses a batch instead of silently answering half of it", () => withServer(caseBatch));
});
