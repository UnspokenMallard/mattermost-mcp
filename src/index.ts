#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.js";
import { Mattermost } from "./mattermost.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (transport === "http") {
    const url = process.env.MATTERMOST_URL?.trim();
    if (!url) throw new Error("MATTERMOST_URL is not set");
    const port = Number(process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${process.env.PORT}"`);
    const server = await startHttpServer({ mattermostUrl: url, port, host: process.env.HOST?.trim() || "0.0.0.0" });
    process.stderr.write(`mattermost MCP listening on :${port} (POST /mcp, GET /healthz) for ${url}\n`);
    const stop = (): void => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }
  if (transport !== "stdio") throw new Error(`Unknown MCP_TRANSPORT "${transport}", use "stdio" or "http"`);

  // Created on first use, so a missing token shows up as a tool error instead of a dead server.
  let client: Mattermost | undefined;
  const server = createServer(() => (client ??= Mattermost.fromEnv()));
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mattermost MCP failed: ${message}\n`);
  process.exit(1);
});
