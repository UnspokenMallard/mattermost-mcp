import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientPool, RateLimiter, startHttpServer } from "./http.js";
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

test("ClientPool reuses a verified client per token, expires idle ones and caps its size", async () => {
  const made: string[] = [];
  const pool = new ClientPool((t) => (made.push(t), new Mattermost("https://mm.test", t, fake.fetchFn)), 1000, 2);
  async function use(token: string, now: number): Promise<Mattermost> {
    const client = pool.get(token, now);
    await client.currentUser();
    pool.remember(token, client, now);
    return client;
  }
  const a = await use("a", 0);
  assert.equal(pool.get("a", 500), a);
  assert.equal(made.length, 1);
  assert.notEqual(pool.get("a", 2000), a, "idle client expired");
  await use("b", 2000);
  await use("c", 2000);
  assert.equal(pool.size, 2);
});

test("ClientPool never stores a client Mattermost has not accepted", () => {
  const pool = new ClientPool((t) => new Mattermost("https://mm.test", t, fake.fetchFn), 1000, 2);
  for (let i = 0; i < 10; i++) pool.remember(`junk-${i}`, pool.get(`junk-${i}`));
  assert.equal(pool.size, 0);
});

test("made-up tokens do not evict a real user's cached client", async () => {
  const pool = new ClientPool((t) => new Mattermost("https://mm.test", t, fake.fetchFn), 1000, 2);
  const real = pool.get("real");
  await real.currentUser();
  pool.remember("real", real);
  for (let i = 0; i < 10; i++) pool.remember(`junk-${i}`, pool.get(`junk-${i}`));
  assert.equal(pool.get("real"), real);
});

test("RateLimiter allows the limit per window, then reports the wait, per key", () => {
  const limiter = new RateLimiter(2, 1000);
  assert.equal(limiter.check("ip1", 0), 0);
  assert.equal(limiter.check("ip1", 100), 0);
  assert.equal(limiter.check("ip1", 200), 800);
  assert.equal(limiter.check("ip2", 200), 0, "other IPs are not affected");
  assert.equal(limiter.check("ip1", 1000), 0, "window reset");
});

test("POST /mcp over the per-IP limit is 429 with Retry-After; healthz is not limited", async () => {
  const limited = await startHttpServer({ mattermostUrl: "https://mm.test", port: 0, host: "127.0.0.1", fetchFn: fake.fetchFn, rateLimitPerMin: 2 });
  const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
  try {
    const post = (): Promise<Response> => fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await post()).status, 401);
    assert.equal((await post()).status, 401);
    const res = await post();
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  } finally {
    limited.closeAllConnections();
    limited.close();
  }
});
