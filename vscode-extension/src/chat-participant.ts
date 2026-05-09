import * as vscode from "vscode";
import {
  getIssue,
  listIssues,
  formatIssueAsMarkdown,
  getBaseUrl,
  Issue,
} from "./redmine-client";

const PARTICIPANT_ID = "redmine";

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  // VS Code chat participant API — available in VS Code 1.90+, Cursor, possibly Windsurf
  const chatApi = vscode.chat as typeof vscode.chat | undefined;
  if (!chatApi?.createChatParticipant) return;

  const participant = chatApi.createChatParticipant(
    PARTICIPANT_ID,
    async (
      request: vscode.ChatRequest,
      _context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      const prompt = request.prompt.trim();

      if (!prompt || prompt === "help") {
        stream.markdown(helpText());
        return;
      }

      // @redmine #123  or  @redmine 123
      const idMatch = prompt.match(/^#?(\d+)$/);
      if (idMatch) {
        await handleGetIssue(parseInt(idMatch[1], 10), stream, token);
        return;
      }

      // @redmine list [project] [status]
      if (prompt.startsWith("list")) {
        await handleList(prompt.slice(4).trim(), stream, token);
        return;
      }

      // @redmine search <keyword>
      if (prompt.startsWith("search ")) {
        await handleSearch(prompt.slice(7).trim(), stream, token);
        return;
      }

      // fallback: treat whole prompt as keyword search
      await handleSearch(prompt, stream, token);
    }
  );

  participant.iconPath = new vscode.ThemeIcon("issues");
  participant.followupProvider = {
    provideFollowups(result, _ctx, _token) {
      return [
        { prompt: "list", label: "List open issues", command: "list" },
        { prompt: "help", label: "Show help", command: "help" },
      ];
    },
  };

  context.subscriptions.push(participant);
}

async function handleGetIssue(
  id: number,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  stream.progress(`Fetching issue #${id}...`);
  if (token.isCancellationRequested) return;

  try {
    const issue = await getIssue(id);
    const md = formatIssueAsMarkdown(issue, getBaseUrl());
    stream.markdown(md);
    stream.button({ command: "redmine.openIssue", title: "Open in sidebar", arguments: [{ issue }] });
  } catch (err) {
    stream.markdown(`**Error**: Could not fetch issue #${id}. ${err}`);
  }
}

async function handleList(
  args: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  stream.progress("Loading issues...");
  if (token.isCancellationRequested) return;

  try {
    const result = await listIssues({ statusId: "open", limit: 20 });
    if (result.issues.length === 0) {
      stream.markdown("No open issues found.");
      return;
    }
    stream.markdown(`### Open Issues (${result.total_count} total)\n`);
    for (const issue of result.issues) {
      const url = getBaseUrl() ? `${getBaseUrl()}/issues/${issue.id}` : "";
      stream.markdown(
        `- **[#${issue.id}](${url})** ${issue.subject} — \`${issue.status.name}\` · ${issue.assigned_to?.name ?? "Unassigned"}\n`
      );
    }
    stream.markdown(`\n_Type \`@redmine #ID\` to get full details of any issue._`);
  } catch (err) {
    stream.markdown(`**Error**: ${err}`);
  }
}

async function handleSearch(
  keyword: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  stream.progress(`Searching for "${keyword}"...`);
  if (token.isCancellationRequested) return;

  try {
    const result = await listIssues({ subject: keyword, statusId: "*", limit: 10 });
    if (result.issues.length === 0) {
      stream.markdown(`No issues found matching **"${keyword}"**.`);
      return;
    }
    stream.markdown(`### Results for "${keyword}" (${result.issues.length} found)\n`);
    for (const issue of result.issues) {
      const url = getBaseUrl() ? `${getBaseUrl()}/issues/${issue.id}` : "";
      stream.markdown(
        `- **[#${issue.id}](${url})** ${issue.subject} — \`${issue.status.name}\`\n`
      );
    }
    stream.markdown(`\n_Type \`@redmine #ID\` to get full details._`);
  } catch (err) {
    stream.markdown(`**Error**: ${err}`);
  }
}

function helpText(): string {
  return `### @redmine — Redmine in your AI chat

| Command | Description |
|---------|-------------|
| \`@redmine #123\` | Get full details of issue #123 |
| \`@redmine list\` | List open issues |
| \`@redmine search bug login\` | Search issues by keyword |

**Tip**: After fetching an issue, you can ask the AI follow-up questions like:
> _"Summarize this bug and suggest a fix"_
> _"What files might be related to this issue?"_
`;
}

/**
 * Try to open the IDE chat panel with pre-filled text.
 * Falls back gracefully if the command doesn't exist.
 */
export async function openChatWithText(text: string): Promise<boolean> {
  // Commands to try in order — covers VS Code Copilot, Cursor, Windsurf
  const chatCommands = [
    // VS Code Copilot Chat
    { cmd: "workbench.action.chat.open", arg: { query: text } },
    // Cursor
    { cmd: "aichat.newchataction", arg: text },
    { cmd: "workbench.action.chat.open", arg: text },
    // Windsurf Cascade
    { cmd: "windsurf.openCascade", arg: text },
    { cmd: "codeium.openCascade", arg: text },
  ];

  for (const { cmd, arg } of chatCommands) {
    try {
      await vscode.commands.executeCommand(cmd, arg);
      return true;
    } catch {
      // command not available in this IDE, try next
    }
  }
  return false;
}
