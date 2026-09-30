// Thin read-only client for the Mattermost REST API v4.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTokenFile, type MmPost, type MmPostList } from "./format.js";

export interface MmUser {
  id: string;
  username: string;
}

export interface MmTeam {
  id: string;
  name: string;
  display_name: string;
}

export interface MmChannel {
  id: string;
  team_id: string;
  type: "O" | "P" | "D" | "G";
  name: string;
  display_name: string;
  last_post_at: number;
  total_msg_count: number;
}

export interface MmChannelMember {
  channel_id: string;
  msg_count: number;
  mention_count: number;
  last_viewed_at: number;
}

export interface ChannelInfo {
  channel: MmChannel;
  /** Stable reference read_channel accepts: "team/channel", "@username" for a DM, or the channel ID for a group DM. */
  ref: string;
  label: string;
  member?: MmChannelMember;
  unread: number;
  mentions: number;
}

export type FetchFn = typeof fetch;

const CHANNEL_ID = /^[a-z0-9]{26}$/;
const CHANNEL_CACHE_MS = 60_000;

// The API does some reads over POST. Only these are allowed, so the client can never write.
const READ_ONLY_POSTS = [/^\/users\/ids$/, /^\/teams\/[a-z0-9]+\/posts\/search$/];

export class Mattermost {
  private me?: MmUser;
  private teamList?: MmTeam[];
  private readonly usernames = new Map<string, string>();
  private channelCache?: { at: number; list: ChannelInfo[] };

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Mattermost {
    const url = env.MATTERMOST_URL?.trim();
    if (!url) throw new Error("MATTERMOST_URL is not set");
    return new Mattermost(url, readToken(env));
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const method = body === undefined ? "GET" : "POST";
    if (method === "POST" && !READ_ONLY_POSTS.some((re) => re.test(path.split("?")[0]))) {
      throw new Error(`Refusing POST ${path}: this server is read-only`);
    }
    const res = await this.fetchFn(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        detail = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // not JSON, keep raw text
      }
      throw new Error(`Mattermost ${res.status} on ${method} ${path}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  async currentUser(): Promise<MmUser> {
    if (!this.me) {
      this.me = await this.request<MmUser>("/users/me");
      this.usernames.set(this.me.id, this.me.username);
    }
    return this.me;
  }

  async teams(): Promise<MmTeam[]> {
    this.teamList ??= await this.request<MmTeam[]>("/users/me/teams");
    return this.teamList;
  }

  async findTeam(name: string): Promise<MmTeam> {
    const teams = await this.teams();
    const team = teams.find((t) => t.name === name || t.display_name.toLowerCase() === name.toLowerCase());
    if (!team) throw new Error(`No team "${name}". Teams: ${teams.map((t) => t.name).join(", ")}`);
    return team;
  }

  /** Resolves user IDs to usernames, one batched request for the ones not cached yet. */
  async resolveUsernames(ids: Iterable<string>): Promise<Map<string, string>> {
    const missing = [...new Set(ids)].filter((id) => id && !this.usernames.has(id));
    if (missing.length) {
      const users = await this.request<MmUser[]>("/users/ids", missing);
      for (const u of users) this.usernames.set(u.id, u.username);
    }
    return this.usernames;
  }

  username(id: string): string {
    return this.usernames.get(id) ?? id;
  }

  /** Every channel the user is a member of, across all teams, newest activity first. */
  async channels(force = false): Promise<ChannelInfo[]> {
    if (!force && this.channelCache && Date.now() - this.channelCache.at < CHANNEL_CACHE_MS) {
      return this.channelCache.list;
    }
    const me = await this.currentUser();
    const teams = await this.teams();
    const channels = new Map<string, MmChannel>();
    const members = new Map<string, MmChannelMember>();
    // DMs and group DMs come back once per team; the maps dedupe them.
    await Promise.all(
      teams.map(async (team) => {
        const [chs, mems] = await Promise.all([
          this.request<MmChannel[]>(`/users/me/teams/${team.id}/channels`),
          this.request<MmChannelMember[]>(`/users/me/teams/${team.id}/channels/members`),
        ]);
        for (const c of chs) channels.set(c.id, c);
        for (const m of mems) members.set(m.channel_id, m);
      }),
    );

    const dmPartners = [...channels.values()].filter((c) => c.type === "D").map((c) => dmPartnerId(c, me.id));
    await this.resolveUsernames(dmPartners);

    const teamById = new Map(teams.map((t) => [t.id, t]));
    const list = [...channels.values()]
      .map((c) => this.describe(c, teamById.get(c.team_id), members.get(c.id), me.id))
      .sort((a, b) => b.channel.last_post_at - a.channel.last_post_at);
    this.channelCache = { at: Date.now(), list };
    return list;
  }

  private describe(channel: MmChannel, team: MmTeam | undefined, member: MmChannelMember | undefined, meId: string): ChannelInfo {
    let ref: string;
    let label: string;
    if (channel.type === "D") {
      const partner = this.username(dmPartnerId(channel, meId));
      ref = `@${partner}`;
      label = `DM with @${partner}`;
    } else if (channel.type === "G") {
      ref = channel.id;
      label = `group DM: ${channel.display_name}`;
    } else {
      ref = team ? `${team.name}/${channel.name}` : channel.id;
      label = `${channel.display_name}${channel.type === "P" ? " (private)" : ""}`;
    }
    return {
      channel,
      ref,
      label,
      member,
      unread: member ? Math.max(0, channel.total_msg_count - member.msg_count) : 0,
      mentions: member?.mention_count ?? 0,
    };
  }

  /**
   * Accepts a channel ID, "team/channel", "@username" (DM), or a bare channel name / display name
   * (optionally prefixed with "~"), which must be unique across the user's teams.
   */
  async resolveChannel(input: string): Promise<ChannelInfo> {
    const ref = input.trim();
    const list = await this.channels();
    const lower = ref.toLowerCase();

    const exact = list.find((c) => c.channel.id === ref || c.ref.toLowerCase() === lower);
    if (exact) return exact;

    if (ref.startsWith("@")) throw new Error(`No DM channel with ${ref}. The DM must already exist.`);

    const me = await this.currentUser();
    const teamById = new Map((await this.teams()).map((t) => [t.id, t]));

    if (CHANNEL_ID.test(ref)) {
      const channel = await this.request<MmChannel>(`/channels/${ref}`);
      return this.describe(channel, teamById.get(channel.team_id), undefined, me.id);
    }

    const slash = ref.indexOf("/");
    if (slash > 0) {
      // Public channel the user has not joined: readable, but not in the membership list.
      const team = await this.findTeam(ref.slice(0, slash));
      const name = ref.slice(slash + 1).replace(/^~/, "");
      const channel = await this.request<MmChannel>(
        `/teams/name/${encodeURIComponent(team.name)}/channels/name/${encodeURIComponent(name)}`,
      );
      return this.describe(channel, team, undefined, me.id);
    }

    const name = lower.replace(/^~/, "");
    const matches = list.filter(
      (c) => c.channel.type !== "D" && (c.channel.name === name || c.channel.display_name.toLowerCase() === name),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`"${ref}" is ambiguous: ${matches.map((c) => c.ref).join(", ")}. Use one of those.`);
    }
    throw new Error(`No channel "${ref}" among your channels. Call list_channels to see refs.`);
  }

  async channelPosts(channelId: string, opts: { perPage: number; before?: string; since?: number }): Promise<MmPostList> {
    const q = new URLSearchParams();
    // The API forbids combining since with paging parameters.
    if (opts.since !== undefined) q.set("since", String(opts.since));
    else {
      q.set("per_page", String(opts.perPage));
      if (opts.before) q.set("before", opts.before);
    }
    return this.request<MmPostList>(`/channels/${channelId}/posts?${q}`);
  }

  /** Posts after the user's last-viewed mark. Reading does not mark the channel as read. */
  async unreadPosts(info: ChannelInfo, limit: number): Promise<MmPost[]> {
    const list = await this.request<MmPostList>(
      `/users/me/channels/${info.channel.id}/posts/unread?limit_before=0&limit_after=${limit}`,
    );
    const lastViewed = info.member?.last_viewed_at ?? 0;
    return Object.values(list.posts).filter((p) => p.create_at > lastViewed);
  }

  async thread(postId: string): Promise<MmPostList> {
    return this.request<MmPostList>(`/posts/${postId}/thread`);
  }

  async search(teamId: string, terms: string, perPage: number): Promise<MmPostList> {
    return this.request<MmPostList>(`/teams/${teamId}/posts/search`, {
      terms,
      is_or_search: false,
      time_zone_offset: -new Date().getTimezoneOffset() * 60,
      page: 0,
      per_page: perPage,
    });
  }
}

/** DM channel names are "<userId>__<userId>"; a self-DM repeats the same ID. */
export function dmPartnerId(channel: MmChannel, meId: string): string {
  const ids = channel.name.split("__");
  return ids.find((id) => id !== meId) ?? meId;
}

function readToken(env: NodeJS.ProcessEnv): string {
  const direct = env.MATTERMOST_TOKEN?.trim();
  if (direct) return direct;
  const file = env.MATTERMOST_TOKEN_FILE?.trim();
  if (!file) throw new Error("Set MATTERMOST_TOKEN or MATTERMOST_TOKEN_FILE");
  const path = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read MATTERMOST_TOKEN_FILE ${path}. Create it with {"token": "<personal access token>"}.`);
  }
  return parseTokenFile(raw);
}
