import * as vscode from "vscode";
import {
  configureClient,
  getIssue,
  listProjects,
  listStatuses,
  listProjectMembers,
  updateIssue,
  createIssue,
  IssueStatus,
  Project,
  Member,
} from "./redmine-client";
import { IssueProvider, IssueTreeItem } from "./issue-provider";
import { IssueWebview } from "./issue-webview";
import { SettingsWebview } from "./settings-webview";
import { pushIssueToAI, copyIssueMarkdown } from "./push-to-ai";
import { registerChatParticipant } from "./chat-participant";

export function activate(context: vscode.ExtensionContext) {
  initClient();

  const provider = new IssueProvider();
  const webview = new IssueWebview(context);
  const settingsWebview = new SettingsWebview(context);

  const treeView = vscode.window.createTreeView("redmine.issueList", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("redmine")) {
      initClient();
      provider.refresh();
    }
  });

  const cmds: [string, (...args: unknown[]) => unknown][] = [
    ["redmine.refresh", () => provider.refresh()],

    ["redmine.configure", async () => {
      await settingsWebview.show();
    }],

    ["redmine.openIssue", async (item: unknown) => {
      let issueId: number | undefined;
      if (item instanceof IssueTreeItem) {
        issueId = item.issue.id;
      } else if (typeof item === "object" && item !== null && "issue" in item) {
        issueId = (item as { issue: { id: number } }).issue.id;
      }
      if (!issueId) {
        const input = await vscode.window.showInputBox({ prompt: "Enter issue ID" });
        if (!input) return;
        issueId = parseInt(input, 10);
        if (isNaN(issueId)) return;
      }
      try {
        const issue = await getIssue(issueId);
        await webview.show(issue);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load issue: ${err}`);
      }
    }],

    ["redmine.pushToChat", async (item: unknown) => {
      let issue;
      if (item instanceof IssueTreeItem) {
        issue = item.issue;
      } else if (typeof item === "object" && item !== null && "issue" in item) {
        issue = (item as { issue: ReturnType<IssueProvider["getIssueById"]> }).issue;
      }
      if (!issue) {
        const input = await vscode.window.showInputBox({ prompt: "Enter issue ID to push" });
        if (!input) return;
        const id = parseInt(input, 10);
        if (isNaN(id)) return;
        try {
          issue = await getIssue(id);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to load issue: ${err}`);
          return;
        }
      }
      await pushIssueToAI(issue!);
    }],

    ["redmine.copyIssueMarkdown", async (item: unknown) => {
      if (!(item instanceof IssueTreeItem)) return;
      await copyIssueMarkdown(item.issue);
    }],

    ["redmine.updateStatus", async (item: unknown) => {
      if (!(item instanceof IssueTreeItem)) return;
      let statuses: IssueStatus[];
      try {
        statuses = await listStatuses();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load statuses: ${err}`);
        return;
      }
      const picks = statuses.map((s) => ({
        label: s.name,
        description: s.is_closed ? "(closed)" : undefined,
        id: s.id,
      }));
      const pick = await vscode.window.showQuickPick(picks, {
        title: `Update Status — #${item.issue.id}`,
        placeHolder: `Current: ${item.issue.status.name}`,
      });
      if (!pick) return;
      try {
        await updateIssue(item.issue.id, { statusId: pick.id });
        vscode.window.showInformationMessage(`Status updated to "${pick.label}".`);
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed: ${err}`);
      }
    }],

    ["redmine.assignIssue", async (item: unknown) => {
      if (!(item instanceof IssueTreeItem)) return;
      let members: Member[];
      try {
        members = await listProjectMembers(String(item.issue.project.id));
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load members: ${err}`);
        return;
      }
      const picks = members.map((m) => ({
        label: m.name,
        description: m.roles.join(", "),
        id: m.id,
      }));
      const pick = await vscode.window.showQuickPick(picks, {
        title: `Assign Issue #${item.issue.id}`,
        placeHolder: `Current: ${item.issue.assigned_to?.name ?? "Unassigned"}`,
      });
      if (!pick) return;
      try {
        await updateIssue(item.issue.id, { assignedToId: pick.id });
        vscode.window.showInformationMessage(`Issue assigned to ${pick.label}.`);
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed: ${err}`);
      }
    }],

    ["redmine.addComment", async (item: unknown) => {
      if (!(item instanceof IssueTreeItem)) return;
      const notes = await vscode.window.showInputBox({
        title: `Add Comment to #${item.issue.id}`,
        prompt: "Enter your comment",
        ignoreFocusOut: true,
      });
      if (!notes?.trim()) return;
      try {
        await updateIssue(item.issue.id, { notes });
        vscode.window.showInformationMessage("Comment added.");
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed: ${err}`);
      }
    }],

    ["redmine.createIssue", async () => {
      let projects: Project[];
      try {
        projects = await listProjects();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load projects: ${err}`);
        return;
      }
      const projectPick = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.name, id: p.identifier })),
        { title: "Create Issue — Select Project" }
      );
      if (!projectPick) return;

      const subject = await vscode.window.showInputBox({
        title: "Create Issue — Subject",
        prompt: "Issue title",
        ignoreFocusOut: true,
      });
      if (!subject?.trim()) return;

      const description = await vscode.window.showInputBox({
        title: "Create Issue — Description (optional)",
        prompt: "Issue description",
        ignoreFocusOut: true,
      });

      try {
        const issue = await createIssue({
          projectId: projectPick.id,
          subject,
          description: description || undefined,
        });
        vscode.window.showInformationMessage(
          `Issue #${issue.id} created: ${issue.subject}`,
          "Open"
        ).then((choice) => {
          if (choice === "Open") {
            vscode.commands.executeCommand("redmine.openIssue", { issue });
          }
        });
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to create issue: ${err}`);
      }
    }],

    ["redmine.filterByProject", () => vscode.commands.executeCommand("redmine.filter", "project")],
    ["redmine.filterByStatus", () => vscode.commands.executeCommand("redmine.filter", "status")],

    ["redmine.filter", async (...args: unknown[]) => {
      const focusOn = args[0] as string | undefined;
      // Load projects & statuses in parallel
      let projects: Project[] = [];
      let statuses: IssueStatus[] = [];
      try {
        [projects, statuses] = await Promise.all([listProjects(), listStatuses()]);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load filter options: ${err}`);
        return;
      }

      const cur = provider.getFilter();

      // Build filter option list
      const projectLabel = cur.projectName ? `Project: ${cur.projectName}` : "Project: All";
      const statusLabel = cur.statusName
        ? `Status: ${cur.statusName}`
        : cur.statusId === "*"
        ? "Status: All"
        : cur.statusId === "closed"
        ? "Status: Closed"
        : "Status: Open";
      const assignLabel = cur.assignedToMe ? "Assigned to: Me ✓" : "Assigned to: Everyone";
      const searchLabel = cur.subject ? `Search: "${cur.subject}"` : "Search: —";
      const hasFilter = cur.projectId || (cur.statusId && cur.statusId !== "open") || cur.assignedToMe || cur.subject;

      const options = [
        { label: `$(folder) ${projectLabel}`, id: "project" },
        { label: `$(circle-filled) ${statusLabel}`, id: "status" },
        { label: `$(person) ${assignLabel}`, id: "assign" },
        { label: `$(search) ${searchLabel}`, id: "search" },
        ...(hasFilter ? [{ label: "$(trash) Clear all filters", id: "clear" }] : []),
      ];

      const picked = await vscode.window.showQuickPick(options, {
        title: "Filter Issues",
        placeHolder: "Select a filter to change",
        // Pre-focus on the relevant section if called from specific command
        ...(focusOn === "project" ? { activeItems: [options[0]] } : {}),
        ...(focusOn === "status" ? { activeItems: [options[1]] } : {}),
      });
      if (!picked) return;

      if (picked.id === "clear") {
        provider.clearFilter();
        return;
      }

      if (picked.id === "project") {
        const projectPicks = [
          { label: "All Projects", id: "", name: "" },
          ...projects.map((p) => ({ label: p.name, id: p.identifier, name: p.name })),
        ];
        const p = await vscode.window.showQuickPick(projectPicks, {
          title: "Filter by Project",
          placeHolder: cur.projectName ? `Current: ${cur.projectName}` : "All projects",
        });
        if (!p) return;
        provider.setFilter({ ...cur, projectId: p.id || undefined, projectName: p.name || undefined });
      }

      if (picked.id === "status") {
        const statusPicks = [
          { label: "Open (default)", id: "open", name: "Open" },
          { label: "Closed", id: "closed", name: "Closed" },
          { label: "All statuses", id: "*", name: "" },
          { label: "──────────", id: "", name: "", kind: vscode.QuickPickItemKind.Separator },
          ...statuses.map((s) => ({ label: s.name, id: String(s.id), name: s.name })),
        ];
        const s = await vscode.window.showQuickPick(statusPicks, {
          title: "Filter by Status",
          placeHolder: statusLabel,
        });
        if (!s || !s.id) return;
        provider.setFilter({ ...cur, statusId: s.id, statusName: s.name || undefined });
      }

      if (picked.id === "assign") {
        const assignPicks = [
          { label: "Everyone", id: "all" },
          { label: "Assigned to me", id: "me" },
        ];
        const a = await vscode.window.showQuickPick(assignPicks, {
          title: "Filter by Assignee",
          placeHolder: assignLabel,
        });
        if (!a) return;
        provider.setFilter({ ...cur, assignedToMe: a.id === "me" });
      }

      if (picked.id === "search") {
        const keyword = await vscode.window.showInputBox({
          title: "Search in issue subjects",
          value: cur.subject ?? "",
          placeHolder: "Type a keyword...",
          prompt: "Leave empty to clear search",
        });
        if (keyword === undefined) return;
        provider.setFilter({ ...cur, subject: keyword.trim() || undefined });
      }
    }],

    ["redmine.clearFilters", () => provider.clearFilter()],
  ];

  for (const [cmd, handler] of cmds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, handler as Parameters<typeof vscode.commands.registerCommand>[1])
    );
  }

  context.subscriptions.push(treeView);
  registerChatParticipant(context);

  // Auto-open settings if not configured yet, otherwise load issues immediately
  const config = vscode.workspace.getConfiguration("redmine");
  if (!config.get<string>("baseUrl") || !config.get<string>("apiKey")) {
    settingsWebview.show();
  } else {
    provider.refresh();
  }
}

function initClient() {
  const config = vscode.workspace.getConfiguration("redmine");
  const baseUrl = config.get<string>("baseUrl") ?? "";
  const apiKey = config.get<string>("apiKey") ?? "";
  if (baseUrl && apiKey) {
    configureClient(baseUrl, apiKey);
  }
}


export function deactivate() {}
