# Redmine Connector

Connect your company's Redmine to VS Code, Cursor, Windsurf, and Claude Code.

## Features

- **Sidebar**: Browse and filter issues by project/status
- **Issue Detail**: Full issue view with comments and history
- **Push to AI Chat**: Send issue content to Claude Code, Copilot, or any AI chat
- **Quick Actions**: Update status, assign, add comment directly from IDE
- **Create Issues**: Create new issues without leaving the IDE
- **MCP Server**: Gives Claude Code, Cursor, Cline direct Redmine access via tools

---

## Setup — VS Code Extension

### 1. Install dependencies and build

```bash
cd vscode-extension
npm install
npm run build
```

### 2. Install the extension

```bash
npm install -g @vscode/vsce
vsce package
# Install the generated .vsix:
code --install-extension redmine-connector-1.0.0.vsix
```

### 3. Configure

Open VS Code settings (`Cmd+,`) and search for "Redmine":

| Setting | Description |
|---------|-------------|
| `redmine.baseUrl` | Your Redmine URL, e.g. `https://redmine.company.com` |
| `redmine.apiKey` | Your API key — find it in **My Account → API access key** |
| `redmine.defaultProject` | Default project identifier (optional) |
| `redmine.showOnlyAssignedToMe` | Show only issues assigned to you |

Or run the command: **Redmine: Configure Redmine Connection**

---

## Setup — MCP Server (Claude Code / Cursor / Cline / Windsurf)

The MCP server lets AI assistants query and update Redmine directly using tools.

### 1. Build

```bash
cd mcp-server
npm install
npm run build
```

### 2. Configure Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "node",
      "args": ["/path/to/extension-redmine/mcp-server/dist/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.company.com",
        "REDMINE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### 3. Configure Cursor

Add to `.cursor/mcp.json` (or global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "redmine": {
      "command": "node",
      "args": ["/path/to/extension-redmine/mcp-server/dist/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.company.com",
        "REDMINE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### 4. Configure Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "node",
      "args": ["/path/to/extension-redmine/mcp-server/dist/index.js"],
      "env": {
        "REDMINE_URL": "https://redmine.company.com",
        "REDMINE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

---

## MCP Tools Available

Once configured, Claude/Cursor/Cline can use these tools:

| Tool | Description |
|------|-------------|
| `redmine_list_issues` | List issues with filters (project, status, assignee, keyword) |
| `redmine_get_issue` | Get full issue details with comments and history |
| `redmine_update_issue` | Update status, assignee, description, progress |
| `redmine_add_comment` | Add a comment/note to an issue |
| `redmine_list_projects` | List all accessible projects |
| `redmine_list_statuses` | List all issue statuses |
| `redmine_list_members` | List project members (for assigning) |
| `redmine_create_issue` | Create a new issue |

### Example Claude Code prompts

```
List all open bugs in project "backend" assigned to me

Get details of issue #1234 including all comments

Update issue #1234 status to "In Progress" and assign it to John

Add a comment to issue #1234: "Fixed in commit abc123, please review"
```

---

## Push to AI Chat — How It Works

From the sidebar, right-click any issue and select **Push Issue to AI Chat**. Three options:

1. **Insert into Chat / Editor** — inserts formatted markdown at cursor position in active editor
2. **Copy to Clipboard** — copies full issue as markdown; paste into any AI chat window
3. **Copy as Claude Code prompt** — ready-to-use prompt, paste in terminal: `claude` or Claude Code chat

---

## Getting Your Redmine API Key

1. Log in to your Redmine instance
2. Click your username (top-right) → **My Account**
3. On the right sidebar, find **API access key**
4. Click **Show** and copy the key

---

## Project Structure

```
extension-redmine/
├── mcp-server/              # MCP server for AI assistants
│   ├── src/
│   │   ├── index.ts         # MCP server entry (8 tools)
│   │   └── redmine-client.ts # Redmine REST API client
│   └── package.json
└── vscode-extension/        # VS Code extension
    ├── src/
    │   ├── extension.ts      # Entry point, commands
    │   ├── redmine-client.ts # Redmine API client
    │   ├── issue-provider.ts # Sidebar TreeView
    │   ├── issue-webview.ts  # Issue detail panel
    │   └── push-to-ai.ts     # Push to AI chat logic
    └── package.json
```
