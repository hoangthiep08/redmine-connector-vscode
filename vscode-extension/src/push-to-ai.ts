import * as vscode from "vscode";
import { Issue, formatIssueAsMarkdown, getBaseUrl } from "./redmine-client";
import { openChatWithText } from "./chat-participant";

export async function pushIssueToAI(issue: Issue): Promise<void> {
  const markdown = formatIssueAsMarkdown(issue, getBaseUrl());
  const prompt = `Here is a Redmine issue I need help with:\n\n${markdown}`;

  const pick = await vscode.window.showQuickPick(
    [
      { label: "$(comment-discussion) Open in AI Chat", description: "Cursor / Windsurf / VS Code Copilot" },
      { label: "$(copy) Copy to Clipboard", description: "Paste manually into any chat" },
      { label: "$(terminal) Copy as Claude Code prompt", description: "For Claude Code CLI" },
    ],
    { title: `Push Issue #${issue.id} to AI`, placeHolder: "Choose how to send" }
  );
  if (!pick) return;

  if (pick.label.includes("Open in AI Chat")) {
    const opened = await openChatWithText(prompt);
    if (opened) {
      vscode.window.showInformationMessage(`Issue #${issue.id} sent to AI chat.`);
    } else {
      await vscode.env.clipboard.writeText(markdown);
      vscode.window.showInformationMessage("Chat panel not detected — copied to clipboard instead.");
    }
    return;
  }

  if (pick.label.includes("Copy to Clipboard")) {
    await vscode.env.clipboard.writeText(markdown);
    vscode.window.showInformationMessage(`Issue #${issue.id} copied. Paste into any AI chat.`);
    return;
  }

  if (pick.label.includes("Claude Code prompt")) {
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage("Copied. Paste in Claude Code chat or terminal.");
  }
}

export async function copyIssueMarkdown(issue: Issue): Promise<void> {
  const markdown = formatIssueAsMarkdown(issue, getBaseUrl());
  await vscode.env.clipboard.writeText(markdown);
  vscode.window.showInformationMessage(`#${issue.id} copied as markdown.`);
}
