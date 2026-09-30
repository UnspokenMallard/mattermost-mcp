# mattermost-mcp

Read-only MCP server for Mattermost. It lets an agent list channels, read channels, threads and
unread messages, and search posts. It never posts, reacts, or marks anything as read: the client
refuses every POST except the two read endpoints (`/users/ids`, `/teams/{id}/posts/search`).

## Tools

| Tool | What it does |
|---|---|
| `list_channels` | Channels, DMs and group DMs you belong to, newest activity first, with unread and mention counts. Each line starts with the ref the other tools accept. |
| `read_channel` | Recent messages in one channel, oldest first. Paging with `before`, time window with `since` (`24h`, `7d`, ISO date). |
| `read_unread` | Messages after your last-viewed mark, grouped by channel, for all channels or one. |
| `read_thread` | A whole thread from the ID of any post in it. |
| `search_posts` | Mattermost search syntax: `from:`, `in:`, `after:`, `before:`, `on:`, `"phrase"`, `-exclude`, `word*`. |

Channel refs: `team/channel`, `@username` (DM), a channel ID, or a channel name that is unique across your teams.

## Setup

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
| `MATTERMOST_URL` | Server base URL, required. |
| `MATTERMOST_TOKEN` | Token itself. Wins over the file. |
| `MATTERMOST_TOKEN_FILE` | File with the raw token or `{"token": "..."}`. `~/` is expanded. |

The token is read on the first tool call, so a missing or wrong token shows up as a tool error, not a dead server.

## Development

```sh
npm test   # builds, then runs the node:test suite against a fake API
```
