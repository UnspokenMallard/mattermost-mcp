// Hosted transport: stateless Streamable HTTP. Each caller sends its own Mattermost personal
// access token as the Bearer token, so one deployment serves many users and stores no secrets.
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Mattermost, type FetchFn } from "./mattermost.js";
import { createServer } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;
const CLIENT_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 200;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 120;

export interface HttpOptions {
  mattermostUrl: string;
  port: number;
  host?: string;
  fetchFn?: FetchFn;
  clientTtlMs?: number;
  /** Requests per minute allowed from one IP on /mcp. */
  rateLimitPerMin?: number;
  /** Take the caller IP from the last X-Forwarded-For entry. Only enable behind a proxy you control. */
  trustProxy?: boolean;
}

/** Fixed-window request counter per key, so one IP cannot drive unlimited Mattermost calls. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private nextSweep = 0;

  constructor(
    private readonly limit = RATE_LIMIT_PER_WINDOW,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  /** Returns 0 when the request is allowed, else the milliseconds until the window resets. */
  check(key: string, now = Date.now()): number {
    if (now >= this.nextSweep) {
      for (const [k, w] of this.windows) if (now >= w.resetAt) this.windows.delete(k);
      this.nextSweep = now + this.windowMs;
    }
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return w.count > this.limit ? w.resetAt - now : 0;
  }
}

/**
 * Keeps one Mattermost client per token for a while, so the channel, team and username caches
 * survive between the requests of a conversation. Entries are dropped after they sit idle.
 * A client is only stored once Mattermost has accepted its token (`remember`), so callers with
 * made-up tokens cannot push real users' clients out.
 */
export class ClientPool {
  private readonly entries = new Map<string, { client: Mattermost; seen: number }>();

  constructor(
    private readonly create: (token: string) => Mattermost,
    private readonly ttlMs = CLIENT_TTL_MS,
    private readonly maxSize = MAX_CLIENTS,
  ) {}

  /** The cached client for this token, or a fresh one that is not cached yet. */
  get(token: string, now = Date.now()): Mattermost {
    this.expire(now);
    const entry = this.entries.get(token);
    if (!entry) return this.create(token);
    entry.seen = now;
    // Re-insert to keep the map ordered by last use.
    this.entries.delete(token);
    this.entries.set(token, entry);
    return entry.client;
  }

  /** Stores a client whose token Mattermost accepted. Unverified clients are ignored. */
  remember(token: string, client: Mattermost, now = Date.now()): void {
    if (!client.verified || this.entries.has(token)) return;
    this.expire(now);
    // Map iterates in insertion order, so the first key is the one touched longest ago.
    if (this.entries.size >= this.maxSize) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(token, { client, seen: now });
  }

  private expire(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.seen > this.ttlMs) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function callerIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createHttpServer(
  opts: Pick<HttpOptions, "mattermostUrl" | "fetchFn" | "clientTtlMs" | "rateLimitPerMin" | "trustProxy">,
): Server {
  const pool = new ClientPool((token) => new Mattermost(opts.mattermostUrl, token, opts.fetchFn), opts.clientTtlMs);
  const limiter = new RateLimiter(opts.rateLimitPerMin);

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      // Stateless: no sessions, so there is no stream to resume (GET) or session to end (DELETE).
      return rpcError(res, 405, "Method not allowed. POST JSON-RPC messages to /mcp.", { Allow: "POST" });
    }
    const retryAfterMs = limiter.check(callerIp(req, opts.trustProxy ?? false));
    if (retryAfterMs > 0) {
      return rpcError(res, 429, "Too many requests. Slow down.", { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
    }
    const token = bearerToken(req);
    if (!token) {
      return rpcError(res, 401, "Send your Mattermost personal access token as 'Authorization: Bearer <token>'.", {
        "WWW-Authenticate": 'Bearer realm="mattermost-mcp"',
      });
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "body too large";
      return rpcError(res, tooLarge ? 413 : 400, tooLarge ? "Request body too large." : "Request body is not valid JSON.");
    }

    // One client per request, so a batch of calls shares it. It enters the pool only after Mattermost accepts the token.
    let client: Mattermost | undefined;
    const server = createServer(() => (client ??= pool.get(token)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      if (client) pool.remember(token, client);
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return createNodeServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const done =
      path === "/healthz" && req.method === "GET"
        ? Promise.resolve(sendJson(res, 200, { status: "ok" }))
        : path === "/mcp"
          ? handleMcp(req, res)
          : Promise.resolve(sendJson(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." }));
    done.catch((err: unknown) => {
      process.stderr.write(`mattermost MCP request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) rpcError(res, 500, "Internal server error.");
      else res.end();
    });
  });
}

export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const server = createHttpServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve(server));
  });
}
