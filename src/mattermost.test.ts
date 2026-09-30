import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPost, orderedPosts, parseSince, parseTokenFile, type MmPost } from "./format.js";
import { Mattermost, type FetchFn } from "./mattermost.js";

const ME = "u".repeat(26);
const BOB = "b".repeat(26);
const TEAM = "t".repeat(26);

function id(prefix: string): string {
  return prefix.padEnd(26, "0");
}

function post(over: Partial<MmPost>): MmPost {
  return { id: id("p"), create_at: 0, edit_at: 0, delete_at: 0, user_id: BOB, channel_id: id("c"), root_id: "", message: "", type: "", ...over };
}

const channels = [
  { id: id("town"), team_id: TEAM, type: "O", name: "town-square", display_name: "Town Square", last_post_at: 300, total_msg_count: 10 },
  { id: id("ops"), team_id: TEAM, type: "P", name: "ops", display_name: "Ops", last_post_at: 500, total_msg_count: 4 },
  { id: id("dm"), team_id: "", type: "D", name: `${BOB}__${ME}`, display_name: "", last_post_at: 400, total_msg_count: 7 },
];
const members = [
  { channel_id: id("town"), msg_count: 10, mention_count: 0, last_viewed_at: 300 },
  { channel_id: id("ops"), msg_count: 1, mention_count: 2, last_viewed_at: 100 },
  { channel_id: id("dm"), msg_count: 5, mention_count: 0, last_viewed_at: 350 },
];

/** Fake API: returns canned JSON per "METHOD path" and records every call. */
function fakeApi(extra: Record<string, unknown> = {}): { fetchFn: FetchFn; calls: string[] } {
  const routes: Record<string, unknown> = {
    "GET /users/me": { id: ME, username: "anze" },
    "GET /users/me/teams": [{ id: TEAM, name: "er", display_name: "Event Registry" }],
    [`GET /users/me/teams/${TEAM}/channels`]: channels,
    [`GET /users/me/teams/${TEAM}/channels/members`]: members,
    "POST /users/ids": [{ id: BOB, username: "bob" }],
    ...extra,
  };
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://mm.test/api/v4", "");
    const key = `${init?.method ?? "GET"} ${path}`;
    calls.push(key);
    if (!(key in routes)) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as FetchFn;
  return { fetchFn, calls };
}

test("channels builds refs, labels and unread counts, newest first", async () => {
  const api = new Mattermost("https://mm.test/", "tok", fakeApi().fetchFn);
  const list = await api.channels();
  assert.deepEqual(
    list.map((c) => [c.ref, c.label, c.unread, c.mentions]),
    [
      ["er/ops", "Ops (private)", 3, 2],
      ["@bob", "DM with @bob", 2, 0],
      ["er/town-square", "Town Square", 0, 0],
    ],
  );
});

test("resolveChannel accepts ref, ID, bare name, display name and @user", async () => {
  const api = new Mattermost("https://mm.test", "tok", fakeApi().fetchFn);
  assert.equal((await api.resolveChannel("er/ops")).channel.id, id("ops"));
  assert.equal((await api.resolveChannel(id("town"))).channel.id, id("town"));
  assert.equal((await api.resolveChannel("~town-square")).channel.id, id("town"));
  assert.equal((await api.resolveChannel("Town Square")).channel.id, id("town"));
  assert.equal((await api.resolveChannel("@bob")).channel.id, id("dm"));
  await assert.rejects(api.resolveChannel("@carol"), /No DM channel with @carol/);
  await assert.rejects(api.resolveChannel("nope"), /No channel "nope"/);
});

test("resolveChannel falls back to the API for a public channel the user has not joined", async () => {
  const open = { id: id("open"), team_id: TEAM, type: "O", name: "random", display_name: "Random", last_post_at: 1, total_msg_count: 1 };
  const { fetchFn } = fakeApi({ "GET /teams/name/er/channels/name/random": open });
  const info = await new Mattermost("https://mm.test", "tok", fetchFn).resolveChannel("er/random");
  assert.equal(info.channel.id, id("open"));
  assert.equal(info.unread, 0);
});

test("unreadPosts keeps only posts newer than last_viewed_at", async () => {
  const dmId = id("dm");
  const { fetchFn, calls } = fakeApi({
    [`GET /users/me/channels/${dmId}/posts/unread?limit_before=0&limit_after=30`]: {
      order: [],
      posts: { a: post({ id: "a", create_at: 350 }), b: post({ id: "b", create_at: 360 }) },
    },
  });
  const api = new Mattermost("https://mm.test", "tok", fetchFn);
  const posts = await api.unreadPosts(await api.resolveChannel("@bob"), 30);
  assert.deepEqual(posts.map((p) => p.id), ["b"]);
  assert.ok(calls.every((c) => c.startsWith("GET ") || c === "POST /users/ids"), "no writes");
});

test("request refuses POST outside the read-only allowlist", async () => {
  const api = new Mattermost("https://mm.test", "tok", fakeApi().fetchFn);
  // search() is the only public POST besides /users/ids; a bad team ID must still hit the allowlist check first.
  await assert.rejects(api.search("../channels/x", "hi", 5), /read-only/);
});

test("API errors carry status and server message", async () => {
  const api = new Mattermost("https://mm.test", "tok", fakeApi().fetchFn);
  await assert.rejects(api.thread("missing"), /Mattermost 404 on GET \/posts\/missing\/thread: not found/);
});

test("parseTokenFile reads raw and JSON tokens", () => {
  assert.equal(parseTokenFile("  abc\n"), "abc");
  assert.equal(parseTokenFile('{"token": "xyz"}'), "xyz");
  assert.throws(() => parseTokenFile("{}"), /no "token"/);
});

test("parseSince handles relative and absolute times", () => {
  assert.equal(parseSince("2h", 10_000_000), 10_000_000 - 7_200_000);
  assert.equal(parseSince("2026-09-30T00:00:00Z"), Date.UTC(2026, 8, 30));
  assert.throws(() => parseSince("yesterday"), /Cannot parse/);
});

test("orderedPosts sorts oldest first and drops deleted and system posts", () => {
  const list = {
    order: [],
    posts: {
      x: post({ id: "x", create_at: 3 }),
      y: post({ id: "y", create_at: 1 }),
      z: post({ id: "z", create_at: 2, delete_at: 5 }),
      s: post({ id: "s", create_at: 0, type: "system_join_channel" }),
    },
  };
  assert.deepEqual(orderedPosts(list).map((p) => p.id), ["y", "x"]);
  assert.deepEqual(orderedPosts(list, true).map((p) => p.id), ["s", "y", "x"]);
});

test("formatPost shows thread, files and indented message", () => {
  const text = formatPost(
    post({ id: "r1", root_id: "root1", message: "line one\nline two", edit_at: 1, metadata: { files: [{ name: "a.png" }] } }),
    "bob",
    "er/ops",
  );
  const lines = text.split("\n");
  assert.match(lines[0], /@bob in er\/ops \(id r1, reply in thread root1, edited\)$/);
  assert.deepEqual(lines.slice(1), ["  line one", "  line two", "  [files: a.png]"]);
});
