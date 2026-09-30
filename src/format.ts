// Pure helpers: token parsing, time parsing and post formatting. No network access.

export interface MmPost {
  id: string;
  create_at: number;
  edit_at: number;
  delete_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  reply_count?: number;
  metadata?: { files?: { name: string }[] };
}

export interface MmPostList {
  order: string[];
  posts: Record<string, MmPost>;
}

/** Token file holds either the raw token or JSON like {"token": "..."} (same shape as ~/.jarvis/secrets/notion.json). */
export function parseTokenFile(raw: string): string {
  const text = raw.trim();
  const token = text.startsWith("{") ? (JSON.parse(text) as { token?: string }).token?.trim() : text;
  if (!token) throw new Error("token file is empty or has no \"token\" field");
  return token;
}

const RELATIVE = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Accepts "30m", "24h", "7d", "2w", or anything Date.parse understands. Returns epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
  const rel = RELATIVE.exec(value.trim());
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()];
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`Cannot parse since="${value}". Use 24h, 7d, or an ISO date.`);
  return at;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function isSystemPost(post: MmPost): boolean {
  return post.type.startsWith("system_");
}

/** Posts oldest first, without deleted posts and (unless asked) without join/leave style system posts. */
export function orderedPosts(list: MmPostList, includeSystem = false): MmPost[] {
  return Object.values(list.posts)
    .filter((p) => p.delete_at === 0 && (includeSystem || !isSystemPost(p)))
    .sort((a, b) => a.create_at - b.create_at);
}

export function formatPost(post: MmPost, username: string, channelLabel?: string): string {
  const meta = [`id ${post.id}`];
  if (post.root_id) meta.push(`reply in thread ${post.root_id}`);
  else if (post.reply_count) meta.push(`${post.reply_count} ${post.reply_count === 1 ? "reply" : "replies"}`);
  if (post.edit_at) meta.push("edited");
  const where = channelLabel ? ` in ${channelLabel}` : "";
  const who = isSystemPost(post) ? "[system]" : `@${username}`;
  const lines = [`${formatTime(post.create_at)} ${who}${where} (${meta.join(", ")})`];
  if (post.message) lines.push(...post.message.split("\n").map((l) => `  ${l}`));
  const files = post.metadata?.files?.map((f) => f.name) ?? [];
  if (files.length) lines.push(`  [files: ${files.join(", ")}]`);
  return lines.join("\n");
}
