# mattermost-mcp

Read-only MCP server for Mattermost. It lets an agent list channels, read channels, threads and
unread messages, and search posts. It never posts, reacts, or marks anything as read: the client
refuses every POST except the two read endpoints (`/users/ids`, `/teams/{id}/posts/search`).

It runs two ways: as a local **stdio** server, or as a **hosted HTTP** server that many users share,
each with their own Mattermost token.

## Tools

| Tool | What it does |
|---|---|
| `list_channels` | Channels, DMs and group DMs you belong to, newest activity first, with unread and mention counts. Each line starts with the ref the other tools accept. |
| `read_channel` | Recent messages in one channel, oldest first. Paging with `before`, time window with `since` (`24h`, `7d`, ISO date). |
| `read_unread` | Messages after your last-viewed mark, grouped by channel, for all channels or one. |
| `read_thread` | A whole thread from the ID of any post in it. |
| `search_posts` | Mattermost search syntax: `from:`, `in:`, `after:`, `before:`, `on:`, `"phrase"`, `-exclude`, `word*`. |

Channel refs: `team/channel`, `@username` (DM), a channel ID, or a channel name that is unique across your teams.

## Hosted server (HTTP)

Set `MCP_TRANSPORT=http` (the Docker image does) and the server speaks stateless Streamable HTTP.

- `POST /mcp`: the MCP endpoint.
- `GET /healthz`: liveness check, no auth.

Each caller sends their own Mattermost personal access token as `Authorization: Bearer <token>`.
The server holds no token and stores nothing, so one deployment serves a whole team and every user
sees only what their token can see. The server only needs to know where Mattermost is.

```sh
docker build -t mattermost-mcp .
docker run -d -p 8787:8787 -e MATTERMOST_URL=https://mattermost.eventregistry.org mattermost-mcp
```

Or without Docker: `npm install && npm run build && MATTERMOST_URL=... npm run start:http`.

Deploy the image to any host that runs containers (Fly.io, Render, Railway, Cloud Run, a VM). Such
platforms set `PORT` themselves. **Put it behind HTTPS**: the bearer token is a credential, and the
platform's TLS or a reverse proxy (Caddy, nginx) must terminate it.

Register it in a client:

```sh
claude mcp add --transport http mattermost https://mcp.example.com/mcp \
  --header "Authorization: Bearer <personal access token>"
```

For clients configured through JSON: `{"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer <token>"}}`.

Clients that only support OAuth sign-in (some hosted chat apps) cannot send a static header and are
not supported yet.

## Local setup (stdio)

1. Create a personal access token in Mattermost: **Profile > Security > Personal Access Tokens**.
   If that section is missing, a system admin must turn on
   **System Console > Integrations > Integration Management > Enable Personal Access Tokens**
   and give your account the permission to create tokens.
2. Save it (the directory is already mode 700):

   ```sh
   printf '{"token": "%s"}\n' '<token>' > ~/.jarvis/secrets/mattermost.json
   chmod 600 ~/.jarvis/secrets/mattermost.json
   ```

3. Build and register:

   ```sh
   npm install && npm run build
   claude mcp add --scope user mattermost \
     -e MATTERMOST_URL=https://mattermost.eventregistry.org \
     -e MATTERMOST_TOKEN_FILE=/Users/anzes/.jarvis/secrets/mattermost.json \
     -- node /Users/anzes/code/personal/mattermost-mcp/dist/index.js
   ```

## Configuration

| Variable | Meaning |
|---|---|
| `MATTERMOST_URL` | Server base URL, required in both modes. |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `PORT` | HTTP mode only. Port to listen on (default `8787`). |
| `HOST` | HTTP mode only. Address to bind (default `0.0.0.0`). |
| `RATE_LIMIT_PER_MIN` | HTTP mode only. Requests per minute allowed from one IP on `/mcp` (default `120`). |
| `TRUST_PROXY` | HTTP mode only. `true` takes the caller IP from the last `X-Forwarded-For` entry. Set it behind a reverse proxy you control, else every caller shares the proxy's IP and its limit. Leave it off when the server is reachable directly, since the header is then spoofable. |
| `MATTERMOST_TOKEN` | stdio only. Token itself. Wins over the file. |
| `MATTERMOST_TOKEN_FILE` | stdio only. File with the raw token or `{"token": "..."}`. `~/` is expanded. |

In stdio mode the token is read on the first tool call, so a missing or wrong token shows up as a tool
error, not a dead server. In HTTP mode `MATTERMOST_TOKEN*` are ignored: a server-side token would let
anyone who can reach the server read as that user.

## Development

```sh
npm test   # builds, then runs the node:test suite against a fake API
```
