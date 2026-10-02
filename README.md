<div align="center">

# claude-code-discord

**Run Claude Code from Discord with full SDK integration, agents, rewind, mid-session controls and more.**

Found a bug or have an idea for improvement? Submit it via [GitHub Issues >⩊<](https://github.com/zebbern/claude-code-discord/issues)

<kbd>

| Feature | Details | Status |
|---------|---------|:------:|
| Use Claude Code Anywhere | Host locally (VM / Docker / cloud) and send commands via the Discord API | ✅ |
| Thread-per-session | Each `/claude-thread` conversation gets its own Discord thread with custom names | ✅ |
| Granular sandbox config | Full SDK sandbox with network rules, filesystem ACLs, and excluded commands | ✅ |
| Local hosting & security | Keep keys and code on your infra while exposing a controlled interface through Discord | ✅ |
| Centralized collaboration | Run commands and discuss results where your team already communicates | ✅ |
| Branch-aware organization | Maps Git branches to channels/categories so feature work stays separated | ✅ |
| Mid-session controls | Interrupt, change model, change permissions, stop tasks, and rewind without restarting | ✅ |
| MCP server management | View status, toggle, and reconnect MCP servers mid-session | ✅ |
| Hooks system | Passive SDK callbacks for tool use, notification, and task completion observability | ✅ |
| Full SDK Integration | Built on `@anthropic-ai/claude-agent-sdk` with native agent support | ✅ |
| AskUserQuestion | Claude can ask clarifying questions mid-session via Discord buttons | ✅ |
| Interactive permission prompts | Allow/Deny buttons when Claude wants to use unapproved tools | ✅ |
| Role-based access control | Restrict destructive commands (`/shell`, `/git`, worktree ops) to specific Discord roles | ✅ |
| Multi-project routing | Map each Discord channel to a project directory with `/project add` — sessions run per channel | ✅ |
| Channel monitoring | Watch a channel for bot/webhook messages and auto-investigate in a thread | ✅ |
| Audit trail & accountability | Channel history provides an easy-to-search record of who ran what and when | ✅ |

</kbd>

**v2.5.0** Security hardening, Discord UX (queue, Cancel, compact embeds), Docker SDK-only image. See [CHANGELOG](CHANGELOG.md).

<img width="350" height="350" alt="preview" src="https://github.com/user-attachments/assets/e8091420-d271-48a4-8e55-279f2093d3ae" />

</div>

<br>

## Quick Start

```bash
git clone https://github.com/zebbern/claude-code-discord.git
cd claude-code-discord
cp .env.example .env
# Edit .env: DISCORD_TOKEN, APPLICATION_ID, and ANTHROPIC_API_KEY (required in Docker)
docker compose up -d
```

Need a Discord bot token first? See [Discord Bot Setup](docs/setup-discord.md).

Installment options (`auto setup script` or `manual installation`), see [Installation Guide](docs/installation.md).

## Documentation

| Doc | Description |
| --- | --- |
| [Discord Bot Setup](docs/setup-discord.md) | Create a Discord app, get your token and application ID, invite the bot |
| [Installation](docs/installation.md) | Docker, one-command setup, manual setup, `.env` configuration |
| [Commands](docs/commands.md) | Full reference for all 45+ slash commands |
| [Features](docs/features.md) | Thinking modes, agents, MCP, rewind, structured output, mid-session controls |
| [Architecture](docs/architecture.md) | Project structure and SDK integration details |
| [Docker](docs/docker.md) | Docker Compose, GHCR images, Watchtower auto-updates |
| [Updating](docs/updating.md) | How to update (Docker pull, git pull, version check) |

## Select Newest Model Available

```
/settings category:claude action:set-model value:opus
/settings category:claude action:set-model value:sonnet
/quick-model model:haiku
```

## Multi-Project Routing

Run Claude in multiple repos from one bot. Each Discord channel (or thread) can be mapped to a project directory, and Claude sessions started in that channel run in the mapped directory instead of the default `WORK_DIR`.

```
/project new path:/workspace/frontend     # Create a channel for a project and map it
/project add path:/workspace/frontend     # Map the current channel to a project
/project list                             # Show channel → project mappings
/project remove                           # Unmap the current channel
/project remove path:/workspace/frontend  # Unmap every channel pointing at a path
```

### How it works

- **Per-channel sessions** — Claude sessions are keyed by working directory (`~/.claude/projects/`), so each project gets its own session history automatically. Use `/claude` in a mapped channel to continue that project's session.
- **Threads inherit their channel** — a thread with no mapping of its own uses its parent channel's project, so a session started in a thread never silently runs in the wrong directory.
- **Unmapped channels are refused** — `/claude` in a sibling channel with no mapping is rejected with a `/project add` hint instead of quietly running in the default `WORK_DIR`. The bot's own channel stays exempt, since it uses `WORK_DIR` by design.
- **Restricted commands** — `/project new`, `add` and `remove` require an admin role or `ADMIN_USER_IDS` (RBAC).
- **Path validation** — `/project add` and `/project new` require an existing directory that resolves (realpath) under the allowlist root, so symlink escapes are rejected. The allowlist root is `/workspace` by default; override with `PROJECTS_ROOT`. In Docker this must be a path **inside the container** (`/workspace`), never your host path — an explicit `PROJECTS_ROOT` that doesn't exist makes the bot fail at startup rather than reject every project.
- **Persistence** — Mappings are saved to `.bot-data/projects.json` and restored on startup.
- **Fallback** — The bot's own channel and threads directly inside it use the default `WORK_DIR`. `/git`, `/shell`, and `/fast` also run in the channel's mapped directory.
- **Scope** — Commands are handled in the bot's own channel, any channel inside its category, and threads inside either. Create sibling channels with `/project new`, or map an existing one with `/project add`.

## Configuration

Create a `.env` file (or copy `.env.example`):

```env
# Required
DISCORD_TOKEN=your_bot_token_here
APPLICATION_ID=your_application_id_here

# Optional
ANTHROPIC_API_KEY=sk-ant-...          # Enables dynamic model discovery & refresh
USER_ID=your_discord_user_id          # @mention when Claude finishes a task
CATEGORY_NAME=claude-code             # Discord category for bot channels
WORK_DIR=/path/to/project             # Working directory (default: current dir)

# Access Control (RBAC) — leave blank to keep all commands open
ADMIN_ROLE_IDS=123456789,987654321    # Comma-separated Discord role IDs
ADMIN_USER_IDS=111111111              # Comma-separated Discord user IDs

# Channel Monitoring (optional)
MONITOR_CHANNEL_ID=123456789012345678    # Channel to monitor for alerts from other bots/webhooks/users
MONITOR_BOT_IDS=987654321,111111111      # Comma-separated bot/webhook/user IDs to trigger auto-investigation

# Proxy (optional — respected automatically if set)
# HTTP_PROXY=http://proxy:8080
# HTTPS_PROXY=http://proxy:8080
# NO_PROXY=localhost,127.0.0.1
```

| Variable | Required | Description |
| --- | :---: | --- |
| `DISCORD_TOKEN` | **Yes** | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `APPLICATION_ID` | **Yes** | Application ID from the Developer Portal |
| `ANTHROPIC_API_KEY` | No | Enables dynamic model discovery; refreshes hourly |
| `USER_ID` | No | Your Discord user ID — bot @mentions you when tasks finish |
| `CATEGORY_NAME` | No | Discord category name for channels (default: `claude-code`) |
| `WORK_DIR` | No | Working directory for Claude operations (default: current dir) |
| `PROJECTS_ROOT` | No | Allowlist root for `/project add` paths (default: `/workspace`) |
| `ADMIN_ROLE_IDS` | No | Comma-separated role IDs for RBAC (shell, git, system, admin) |
| `ADMIN_USER_IDS` | No | Comma-separated user IDs for RBAC — grants access regardless of roles |
| `MONITOR_CHANNEL_ID` | No | Discord channel ID to watch for bot/webhook messages |
| `MONITOR_BOT_IDS` | No | Comma-separated bot/webhook user IDs that trigger auto-investigation |
| `HTTP_PROXY` | No | HTTP proxy URL (also reads `http_proxy`) |
| `HTTPS_PROXY` | No | HTTPS proxy URL (also reads `https_proxy`) |
| `NO_PROXY` | No | Comma-separated hosts to bypass proxy |

> CLI flags override environment variables. Environment variables override `.env` file values.

## Startup Options

```bash
# Standard start
deno task start

# Development mode (hot reload)
deno task dev

# Direct with environment variables
deno run --allow-all index.ts

# With optional flags
deno run --allow-all index.ts --category myproject --user-id YOUR_DISCORD_ID
```

| Flag | Env Variable | Description |
| --- | --- | --- |
| `--category <name>` | `CATEGORY_NAME` | Discord category name for channels (default: `claude-code`) |
| `--user-id <id>` | `USER_ID` | Your Discord user ID for mentions when tasks finish |

> CLI flags override environment variables. Environment variables override `.env` file values.

## Channel Monitoring

Automatically investigate alerts from other bots or webhooks. When a monitored bot posts in the configured channel, the bot batches messages over a 30-second debounce window, creates a thread on the alert message, and streams Claude's investigation there.

### Setup

1. **Enable the Message Content intent** — In the [Developer Portal](https://discord.com/developers/applications), go to your app → Bot → enable **Message Content Intent**. The bot needs this to read messages from other bots.

2. **Get the channel ID** — Right-click the channel in Discord (Developer Mode must be on) and copy the ID. Set `MONITOR_CHANNEL_ID` in `.env`.

3. **Get the bot/webhook user IDs** — The easiest way is to look at a message from the bot in the channel, right-click the author, and copy the ID. For webhooks, check the webhook's user ID in the channel's integration settings. Set `MONITOR_BOT_IDS` as a comma-separated list.

4. **Bot permissions** — Ensure the bot has these permissions in the monitored channel:
   - Read Messages
   - Create Public Threads
   - Send Messages in Threads
