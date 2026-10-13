import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientPool, startHttpServer } from "./http.js";
import { Mattermost, type FetchFn } from "./mattermost.js";

const ME = "u".repeat(26);
const TEAM = "t".repeat(26);

/** Fake Mattermost API that records the Authorization header of every call. */
function fakeMattermost(): { fetchFn: FetchFn; auth: string[] } {
  const auth: string[] = [];
  const routes: Record<string, unknown> = {
    "/users/me": { id: ME, username: "anze" },
    "/users/me/teams": [{ id: TEAM, name: "er", display_name: "Event Registry" }],
    [`/users/me/teams/${TEAM}/channels`]: [
      { id: "o".repeat(26), team_id: TEAM, type: "O", name: "ops", display_name: "Ops", last_post_at: 5, total_msg_count: 3 },
    ],
    [`/users/me/teams/${TEAM}/channels/members`]: [
      { channel_id: "o".repeat(26), msg_count: 1, mention_count: 0, last_viewed_at: 1 },
    ],
  };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    auth.push(String((init?.headers as Record<string, string>).Authorization));
    const path = String(url).replace("https://mm.test/api/v4", "");
    if (!(path in routes)) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as FetchFn;
  return { fetchFn, auth };
}

const fake = fakeMattermost();
const server = await startHttpServer({ mattermostUrl: "https://mm.test", port: 0, host: "127.0.0.1", fetchFn: fake.fetchFn });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

test("healthz answers without a token", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST /mcp without a bearer token is 401", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
});

test("GET /mcp is 405 and unknown paths are 404", async () => {
  assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer x" } })).status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("invalid JSON body is 400", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
    body: "{nope",
  });
  assert.equal(res.status, 400);
});

test("tools list and call work over HTTP and use the caller's own token", async () => {
  const a = await connect("token-a");
  const tools = (await a.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["list_channels", "read_channel", "read_thread", "read_unread", "search_posts"]);

  fake.auth.length = 0;
  const result = await a.callTool({ name: "list_channels", arguments: {} });
  const text = (result.content as { text: string }[])[0].text;
  assert.match(text, /Logged in as @anze/);
  assert.match(text, /er\/ops/);
  assert.deepEqual(new Set(fake.auth), new Set(["Bearer token-a"]));

  fake.auth.length = 0;
  const b = await connect("token-b");
  await b.callTool({ name: "list_channels", arguments: {} });
  assert.deepEqual(new Set(fake.auth), new Set(["Bearer token-b"]));
  await a.close();
  await b.close();
});

test("a Mattermost failure is a tool error, not a dead request", async () => {
  const c = await connect("token-c");
  const result = await c.callTool({ name: "read_thread", arguments: { post_id: "missing" } });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0].text, /Mattermost 404/);
  await c.close();
});

test("ClientPool reuses a client per token, expires idle ones and caps its size", () => {
  const made: string[] = [];
  const pool = new ClientPool((t) => (made.push(t), new Mattermost("https://mm.test", t)), 1000, 2);
  const a = pool.get("a", 0);
  assert.equal(pool.get("a", 500), a);
  assert.equal(made.length, 1);
  assert.notEqual(pool.get("a", 2000), a, "idle client expired");
  pool.get("b", 2000);
  pool.get("c", 2000);
  assert.equal(pool.size, 2);
});
