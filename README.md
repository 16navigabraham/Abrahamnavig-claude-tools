# Abrahamnavig Claude Tools

PDF tools for Claude. One set of tool definitions is exposed two ways:

- **MCP server**: connect Claude Desktop, Claude Code or any MCP client.
- **Claude API agent**: embed in your app's backend. It uses the Anthropic SDK tool runner, and your code approves each write.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `pdf_create` | write | Build a PDF from text with `#`/`##` headings, `-` bullets and paragraphs. Pages are added automatically |
| `pdf_read` | read | Extract text page by page, with an optional page range |
| `pdf_info` | read | Page count, page size, file size and metadata |
| `pdf_view` | read | Hand the PDF itself to Claude so it sees layout, tables and scanned pages |
| `pdf_merge` | write | Combine PDFs in order into a new file |

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

## Adding tools

Tools live in `src/tools/`. Each one is a `defineTool({ name, kind, inputSchema, run })` with a Zod schema. Add a file for a new family, for example `src/tools/image.ts` for image generation and editing, then spread it into `allTools` in `src/tools/index.ts`. The MCP server and the agent both pick it up.

## Limits

- `pdf_create` uses the standard PDF fonts, so it renders Latin text only. Other characters, such as ₦ or emoji, become `?`. Embedding a Unicode TTF would fix this.
- `pdf_view` accepts files up to 32 MB, which is the Claude API's request limit.
