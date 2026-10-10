# Abrahamnavig Claude Tools

PDF tools for Claude. One set of tool definitions is exposed two ways:

- **MCP server**: connect Claude Desktop, Claude Code or any MCP client. It runs locally over stdio, or online over HTTPS (see [Deploy online](#deploy-online-oracle-cloud)).
- **Claude API agent**: embed in your app's backend. It uses the Anthropic SDK tool runner, and your code approves each write.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `pdf_create` | write | Build a PDF from text with `#`/`##` headings, `-` bullets, paragraphs and `![alt](path)` images. Pages are added automatically |
| `pdf_read` | read | Extract text page by page, with an optional page range |
| `pdf_info` | read | Page count, page size, file size and metadata |
| `pdf_view` | read | Hand the PDF itself to Claude so it sees layout, tables and scanned pages |
| `pdf_merge` | write | Combine PDFs in order into a new file |
| `pdf_import_url` | write | Download a PDF from a public URL into the workspace (max 32 MB). It won't fetch from private or internal addresses |
| `upload_file` | write | Save a file (usually an image) into the workspace from base64 data, to reference from `pdf_create` |
| `files_list` | read | List the files in the workspace |
| `file_link` | read | Get a time-limited download link for a file (online only) |

When the server runs online, `pdf_create`, `pdf_merge`, `pdf_import_url` and `upload_file` include a download link in their result.

**Images in a created PDF:** `pdf_create` only renders PNG/JPEG images it can find in the workspace — it can't fetch or generate them. Upload the image first with `upload_file`, then reference that same path from `content` using standard Markdown image syntax on its own line:

```
upload_file(path: "assets/logo.png", data: "<base64>")
pdf_create(path: "report.pdf", content: "# Report\n\n![Company logo](assets/logo.png)\n\nBody text...")
```

An image is scaled down to fit the page (never upscaled) and starts a new page if it doesn't fit on the current one. A referenced image that wasn't uploaded fails the whole call with a clear error, before anything is written.

All paths are relative to a **workspace** directory (`CLAUDE_TOOLS_WORKSPACE`, default `./workspace`). Paths that escape it are rejected. Write tools never replace an existing file unless `overwrite: true` is passed.

**Write tools need approval.** Over MCP, they are marked non-read-only, so the client asks you before running them. In the agent, they call your `confirm` callback and only run if it returns `true`.

## Setup

```bash
npm install
npm run build
npm test
```

### MCP server

Claude Code:

```bash
claude mcp add claude-tools -e CLAUDE_TOOLS_WORKSPACE=$HOME/claude-workspace -- node /path/to/Abrahamnavig-claude-tools/dist/mcp/main.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "claude-tools": {
      "command": "node",
      "args": ["/path/to/Abrahamnavig-claude-tools/dist/mcp/main.js"],
      "env": { "CLAUDE_TOOLS_WORKSPACE": "/Users/you/claude-workspace" }
    }
  }
}
```

### Claude API agent

Set `ANTHROPIC_API_KEY`, then try it in the terminal:

```bash
npm run agent
> Make a one-page PDF called notes.pdf summarising what an ERC-4337 paymaster does
```

In your app's backend:

```ts
import { runAgentTurn, messageText } from "./src/agent/agent.js";

let history = [];
const turn = await runAgentTurn("Summarise invoices/march.pdf", history, {
  workspace: `/data/users/${userId}`,          // one workspace per account
  confirm: async (tool, input) => askUserInYourUi(tool, input),
});
history = turn.history;                        // store for the next turn
reply(messageText(turn.message));
```

The agent uses `claude-opus-5` with adaptive thinking (override with the `model` option or `CLAUDE_MODEL` for the CLI). If the model declines a request, the API automatically retries it on a fallback model (`fallbacks: "default"`).

## Deploy online (Oracle Cloud)

Online, the server runs in Docker behind [Caddy](https://caddyserver.com), which gets a free HTTPS certificate automatically. You don't need a domain: `<your-ip>.sslip.io` resolves to your VM's IP.

1. **Open ports 80 and 443 in Oracle Cloud.** Go to Networking → Virtual Cloud Networks → your VCN → Security Lists → Default. Add two ingress rules with source `0.0.0.0/0`, protocol TCP, and destination ports `80` and `443`.
2. **On the VM:**
   ```bash
   git clone https://github.com/16navigabraham/Abrahamnavig-claude-tools.git
   cd Abrahamnavig-claude-tools
   bash deploy/setup-oracle.sh               # or: bash deploy/setup-oracle.sh tools.yourdomain.com
   ```
   The script installs Docker and opens ports 80/443 in the VM's own firewall (Oracle's Ubuntu images block them by default). It also writes `.env` with a random `MCP_AUTH_TOKEN`, starts everything and prints your URLs.
3. **Check it:** `https://<DOMAIN>/health` should return `{"ok":true}`.

If you use your own domain, first point an `A` record at the VM's public IP.

### Your URLs

| What | URL |
|---|---|
| MCP endpoint (header auth) | `https://<DOMAIN>/mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>` |
| MCP endpoint (for claude.ai) | `https://<DOMAIN>/mcp/<MCP_AUTH_TOKEN>` |
| Health check | `https://<DOMAIN>/health` |

**Claude.ai / Claude app:** go to Settings → Connectors → Add custom connector, and paste the `/mcp/<token>` URL. Claude.ai can't send a custom auth header, so the token goes in the URL. Treat that URL like a password.

**Claude Code:**
```bash
claude mcp add --transport http claude-tools https://<DOMAIN>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### Operating it

```bash
docker compose logs -f app                      # logs
git pull && docker compose up -d --build        # update
docker compose down                             # stop (files are kept in the "workspace" volume)
```

- Everyone with the token shares one workspace. For per-user files, give each user their own token and workspace, or add OAuth.
- The endpoint is rate-limited to 120 requests per minute per IP.
- Download links expire after `FILE_LINK_TTL_SECONDS` (default 24 hours). Changing `MCP_AUTH_TOKEN` invalidates all existing links.

## Adding tools

Tools live in `src/tools/`. Each one is a `defineTool({ name, kind, inputSchema, run })` with a Zod schema. Add a file for a new family, for example `src/tools/image.ts` for image generation and editing, then spread it into `allTools` in `src/tools/index.ts`. The MCP server and the agent both pick it up.

## Limits

- `pdf_create` uses the standard PDF fonts, so it renders Latin text only. Other characters, such as ₦ or emoji, become `?`. Embedding a Unicode TTF would fix this.
- `pdf_view` accepts files up to 32 MB, which is the Claude API's request limit.
