#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatPost, formatTime, isSystemPost, orderedPosts, parseSince, type MmPost } from "./format.js";
import { Mattermost, type ChannelInfo } from "./mattermost.js";

let client: Mattermost | undefined;
// Created on first use, so a missing token shows up as a tool error instead of a dead server.
function mm(): Mattermost {
  client ??= Mattermost.fromEnv();
  return client;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

async function renderPosts(posts: MmPost[], channelLabels?: Map<string, string>): Promise<string> {
  const api = mm();
  await api.resolveUsernames(posts.map((p) => p.user_id));
  return posts.map((p) => formatPost(p, api.username(p.user_id), channelLabels?.get(p.channel_id))).join("\n\n");
}

function channelLine(c: ChannelInfo): string {
  const counts = c.unread || c.mentions ? `  [unread ${c.unread}${c.mentions ? `, mentions ${c.mentions}` : ""}]` : "";
  const last = c.channel.last_post_at ? `  last ${formatTime(c.channel.last_post_at)}` : "";
  return `${c.ref}  (${c.label})${counts}${last}`;
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const includeSystem = z
  .boolean()
  .optional()
  .describe("Include system posts such as joins, leaves and header changes (default false)");

const server = new McpServer({ name: "mattermost", version: "0.1.0" });

server.registerTool(
  "list_channels",
  {
    title: "List Mattermost channels",
    description:
      "List channels, DMs and group DMs the user belongs to, newest activity first, with unread and mention counts. " +
      "Each line starts with the ref to pass to read_channel.",
    inputSchema: {
      team: z.string().optional().describe("Only this team (team name). DMs and group DMs are always included."),
      unread_only: z.boolean().optional().describe("Only channels with unread messages (default false)"),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum channels to return (default 100)"),
    },
    annotations: readOnly,
  },
  ({ team, unread_only, limit }) =>
    run(async () => {
      const api = mm();
      const me = await api.currentUser();
      const teams = await api.teams();
      const teamId = team ? (await api.findTeam(team)).id : undefined;
      const all = (await api.channels(true)).filter(
        (c) => (!teamId || c.channel.team_id === teamId || !c.channel.team_id) && (!unread_only || c.unread > 0),
      );
      const shown = all.slice(0, limit ?? 100);
      const header = `Logged in as @${me.username}. Teams: ${teams.map((t) => `${t.name} (${t.display_name})`).join(", ")}.`;
      const more = all.length > shown.length ? `\n… ${all.length - shown.length} more, raise limit to see them.` : "";
      if (!shown.length) return `${header}\nNo ${unread_only ? "unread " : ""}channels.`;
      return `${header}\n\n${shown.map(channelLine).join("\n")}${more}`;
    }),
);

server.registerTool(
  "read_channel",
  {
    title: "Read Mattermost channel",
    description:
      "Read recent messages in a channel, oldest first. Thread replies are included inline and marked with their thread root ID. " +
      "Does not mark the channel as read.",
    inputSchema: {
      channel: z
        .string()
        .describe('Channel ref from list_channels: "team/channel", "@username" for a DM, a channel ID, or a unique channel name'),
      limit: z.number().int().min(1).max(200).optional().describe("Number of messages (default 30)"),
      before: z.string().optional().describe("Post ID: return messages older than this one (paging backwards)"),
      since: z
        .string()
        .optional()
        .describe('Only messages created after this time: "24h", "7d", or an ISO date. Returns the newest `limit` of them.'),
      include_system: includeSystem,
    },
    annotations: readOnly,
  },
  ({ channel, limit, before, since, include_system }) =>
    run(async () => {
      const api = mm();
      const info = await api.resolveChannel(channel);
      const count = limit ?? 30;
      const sinceMs = since ? parseSince(since) : undefined;
      const list = await api.channelPosts(info.channel.id, { perPage: count, before, since: sinceMs });
      // since filters on update time, so edited old posts come back too; keep only ones created after it.
      const posts = orderedPosts(list, include_system).filter((p) => sinceMs === undefined || p.create_at >= sinceMs);
      const shown = posts.slice(-count);
      const header = `${info.ref} (${info.label}): ${shown.length} messages, oldest first`;
      if (!shown.length) return `${header}\nNo messages.`;
      const older =
        sinceMs === undefined && Object.keys(list.posts).length >= count
          ? `\n\nOlder messages: call again with before="${shown[0].id}".`
          : "";
      return `${header}\n\n${await renderPosts(shown)}${older}`;
    }),
);

server.registerTool(
  "read_unread",
  {
    title: "Read unread Mattermost messages",
    description:
      "Return messages the user has not seen yet, grouped by channel, for every channel with unread messages or for one channel. " +
      "Does not mark anything as read.",
    inputSchema: {
      channel: z.string().optional().describe("Only this channel (same ref formats as read_channel)"),
      team: z.string().optional().describe("Only this team (team name). DMs and group DMs are always included."),
      limit_per_channel: z.number().int().min(1).max(200).optional().describe("Maximum messages per channel (default 30)"),
      max_channels: z.number().int().min(1).max(50).optional().describe("Maximum channels to read (default 15)"),
      include_system: includeSystem,
    },
    annotations: readOnly,
  },
  ({ channel, team, limit_per_channel, max_channels, include_system }) =>
    run(async () => {
      const api = mm();
      const perChannel = limit_per_channel ?? 30;
      let targets: ChannelInfo[];
      if (channel) {
        targets = [await api.resolveChannel(channel)];
      } else {
        const teamId = team ? (await api.findTeam(team)).id : undefined;
        targets = (await api.channels(true)).filter(
          (c) => c.unread > 0 && (!teamId || c.channel.team_id === teamId || !c.channel.team_id),
        );
      }
      if (!targets.length) return "No unread messages.";

      const maxChannels = max_channels ?? 15;
      const sections: string[] = [];
      for (const info of targets.slice(0, maxChannels)) {
        const posts = (await api.unreadPosts(info, perChannel))
          .filter((p) => p.delete_at === 0 && (include_system || !isSystemPost(p)))
          .sort((a, b) => a.create_at - b.create_at);
        if (!posts.length) continue;
        const truncated = info.unread > posts.length ? ` (showing ${posts.length} of ${info.unread})` : "";
        sections.push(`## ${info.ref} (${info.label})${truncated}\n\n${await renderPosts(posts)}`);
      }
      const skipped = targets.length > maxChannels ? `\n\n${targets.length - maxChannels} more channels with unread messages not shown.` : "";
      return sections.length ? sections.join("\n\n") + skipped : "No unread messages.";
    }),
);

server.registerTool(
  "read_thread",
  {
    title: "Read Mattermost thread",
    description: "Read a whole thread, root post first. Accepts the ID of the root post or of any reply in it.",
    inputSchema: {
      post_id: z.string().describe("ID of any post in the thread"),
    },
    annotations: readOnly,
  },
  ({ post_id }) =>
    run(async () => {
      const api = mm();
      const posts = orderedPosts(await api.thread(post_id), true);
      if (!posts.length) return "Thread is empty or deleted.";
      const channels = await api.channels();
      const label = channels.find((c) => c.channel.id === posts[0].channel_id);
      const where = label ? `${label.ref} (${label.label})` : `channel ${posts[0].channel_id}`;
      return `Thread in ${where}: ${posts.length} posts\n\n${await renderPosts(posts)}`;
    }),
);

server.registerTool(
  "search_posts",
  {
    title: "Search Mattermost messages",
    description:
      "Search messages with Mattermost search syntax, newest first. Supports from:username, in:channel-name, " +
      'after:YYYY-MM-DD, before:YYYY-MM-DD, on:YYYY-MM-DD, "exact phrase", -excluded and trailing * wildcards.',
    inputSchema: {
      terms: z.string().describe('Search query, e.g. "deploy from:anze after:2026-09-01"'),
      team: z.string().optional().describe("Only this team (team name). Default: all teams."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum results (default 20)"),
    },
    annotations: readOnly,
  },
  ({ terms, team, limit }) =>
    run(async () => {
      const api = mm();
      const count = limit ?? 20;
      const teams = team ? [await api.findTeam(team)] : await api.teams();
      const results = await Promise.all(teams.map((t) => api.search(t.id, terms, count)));
      // DM and group DM hits can come back from every team; dedupe by post ID.
      const byId = new Map<string, MmPost>();
      for (const r of results) for (const p of Object.values(r.posts ?? {})) byId.set(p.id, p);
      const posts = [...byId.values()].sort((a, b) => b.create_at - a.create_at).slice(0, count);
      if (!posts.length) return `No results for ${JSON.stringify(terms)}.`;
      const labels = new Map((await api.channels()).map((c) => [c.channel.id, c.ref]));
      return `${posts.length} results for ${JSON.stringify(terms)}, newest first\n\n${await renderPosts(posts, labels)}`;
    }),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mattermost MCP failed: ${message}\n`);
  process.exit(1);
});
