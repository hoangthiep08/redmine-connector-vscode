import * as vscode from "vscode";
import {
  configureClient,
  getIssue,
  listIssues,
  listProjects,
  listStatuses,
  listProjectMembers,
  listTrackers,
  updateIssue,
  IssueStatus,
  Project,
  Member,
  Tracker,
} from "./redmine-client";
import { IssueProvider, IssueTreeItem, GroupByMode } from "./issue-provider";
import { IssueWebview } from "./issue-webview";
import { SettingsWebview } from "./settings-webview";
import { FeedbackWebview } from "./feedback-webview";
import { CreateIssueWebview } from "./create-issue-webview";
import { TestCaseWebview } from "./testcase-webview";
import { IssueListWebview } from "./issue-list-webview";
import { pushIssueToAI, copyIssueMarkdown } from "./push-to-ai";
import { registerChatParticipant } from "./chat-participant";

export function activate(context: vscode.ExtensionContext) {
  initClient();

  const provider = new IssueProvider();
  const webview = new IssueWebview(context);
  const settingsWebview = new SettingsWebview(context);

  const feedbackWebview = new FeedbackWebview(context);
  const createIssueWebview = new CreateIssueWebview(context);
  const testCaseWebview = new TestCaseWebview(context, createIssueWebview);
  const issueListWebview = new IssueListWebview(context);

  const treeView = vscode.window.createTreeView("redmine.issueList", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("redmine")) {
      initClient();
      const cur = provider.getFilter();
      if (cur.subject) {
        provider.setFilter({ ...cur, subject: undefined });
      } else {
        provider.refresh();
      }
    }
  });

  const cmds: [string, (...args: unknown[]) => unknown][] = [
    ["redmine.refresh", () => provider.refresh()],

    ["redmine.configure", async () => {
      await settingsWebview.show();
    }],

    ["redmine.openIssueList", async () => {
      await issueListWebview.show();
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
      await createIssueWebview.show();
    }],

    ["redmine.openTestCase", async (...args: unknown[]) => {
      const uri = args[0] instanceof vscode.Uri ? args[0] : undefined;
      await testCaseWebview.show(uri);
    }],

    ["redmine.filterByProject", () => vscode.commands.executeCommand("redmine.filter", "project")],
    ["redmine.filterByStatus", () => vscode.commands.executeCommand("redmine.filter", "status")],

    ["redmine.filter", async (...args: unknown[]) => {
      const focusOn = args[0] as string | undefined;

      // Load projects, statuses & trackers once before the loop
      let projects: Project[] = [];
      let statuses: IssueStatus[] = [];
      let trackers: Tracker[] = [];
      try {
        [projects, statuses, trackers] = await Promise.all([listProjects(), listStatuses(), listTrackers()]);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load filter options: ${err}`);
        return;
      }

      let firstRun = true;

      // Loop: stay in filter menu until user presses Esc
      while (true) {
        // Use effective filter (session + config defaults) for display
        const cur = provider.getFilter();
        const eff = provider.getEffectiveFilter();

        const projectLabel = eff.projectName ? `Project: ${eff.projectName}` : "Project: All";
        const statusLabel = eff.statusName
          ? `Status: ${eff.statusName}`
          : eff.statusId === "*"
          ? "Status: All"
          : eff.statusId === "closed"
          ? "Status: Closed"
          : "Status: Open (default)";
        const assignLabel = eff.assignedToMe
          ? "Assignee: Me ✓"
          : eff.assignedToName
          ? `Assignee: ${eff.assignedToName}`
          : eff.assignedToId
          ? "Assignee: Custom user"
          : "Assignee: Everyone";
        const trackerLabel = cur.trackerName ? `Tracker: ${cur.trackerName}` : "Tracker: All";
        const searchLabel = cur.subject ? `Search: "${cur.subject}"` : "Search: —";
        // "Clear" only appears when there are session-level overrides
        const hasFilter = provider.hasSessionFilter();

        const options = [
          { label: `$(folder) ${projectLabel}`, id: "project" },
          { label: `$(circle-filled) ${statusLabel}`, id: "status" },
          { label: `$(person) ${assignLabel}`, id: "assign" },
          { label: `$(tag) ${trackerLabel}`, id: "tracker" },
          { label: `$(search) ${searchLabel}`, id: "search" },
          ...(hasFilter ? [{ label: "$(trash) Clear all filters", id: "clear" }] : []),
        ];

        const picked = await vscode.window.showQuickPick(options, {
          title: "Filter Issues  (Esc to close)",
          placeHolder: "Select a filter to change — Esc to close",
          ...(firstRun && focusOn === "project" ? { activeItems: [options[0]] } : {}),
          ...(firstRun && focusOn === "status" ? { activeItems: [options[1]] } : {}),
        });
        firstRun = false;

        if (!picked) break; // Esc → exit

        if (picked.id === "clear") {
          provider.clearFilter();
          break;
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
          if (p) {
            provider.setFilter({ ...cur, projectId: p.id || undefined, projectName: p.name || undefined, subject: undefined });
          }
          continue; // back to main menu
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
          if (s && s.id) {
            provider.setFilter({ ...cur, statusId: s.id, statusName: s.name || undefined, subject: undefined });
          }
          continue;
        }

        if (picked.id === "assign") {
          const projectId = eff.projectId; // use effective (session + config default)
          const memberPicks: { label: string; description?: string; id: string; name: string }[] = [
            { label: "$(globe) Everyone", id: "all", name: "" },
            { label: "$(person) Assigned to me", id: "me", name: "me" },
          ];

          if (projectId) {
            try {
              const members = await listProjectMembers(projectId);
              if (members.length > 0) {
                memberPicks.push({ label: "──────────", id: "_sep", name: "_sep", description: "" });
                for (const m of members) {
                  memberPicks.push({ label: m.name, description: m.roles.join(", "), id: String(m.id), name: m.name });
                }
              } else {
                memberPicks.push({ label: "$(info) No members found for this project", id: "_hint", name: "_hint" });
              }
            } catch (err) {
              memberPicks.push({ label: `$(warning) Failed to load members: ${err instanceof Error ? err.message : String(err)}`, id: "_hint", name: "_hint" });
            }
          } else {
            memberPicks.push({ label: "$(info) Set a default project in Settings to filter by user", id: "_hint", name: "_hint" });
          }

          const a = await vscode.window.showQuickPick(memberPicks, {
            title: "Filter by Assignee",
            placeHolder: assignLabel,
          });
          if (a && a.id !== "_sep" && a.id !== "_hint") {
            if (a.id === "all") {
              provider.setFilter({ ...cur, assignedToMe: false, assignedToId: undefined, assignedToName: undefined, subject: undefined });
            } else if (a.id === "me") {
              provider.setFilter({ ...cur, assignedToMe: true, assignedToId: undefined, assignedToName: undefined, subject: undefined });
            } else {
              provider.setFilter({ ...cur, assignedToMe: false, assignedToId: a.id, assignedToName: a.name, subject: undefined });
            }
          }
          continue;
        }

        if (picked.id === "tracker") {
          const trackerPicks = [
            { label: "All Trackers", id: "", name: "" },
            ...trackers.map((t) => ({ label: t.name, id: String(t.id), name: t.name })),
          ];
          const t = await vscode.window.showQuickPick(trackerPicks, {
            title: "Filter by Tracker",
            placeHolder: trackerLabel,
          });
          if (t) {
            provider.setFilter({ ...cur, trackerId: t.id || undefined, trackerName: t.name || undefined, subject: undefined });
          }
          continue;
        }

        if (picked.id === "search") {
          const keyword = await vscode.window.showInputBox({
            title: "Search in issue subjects",
            value: cur.subject ?? "",
            placeHolder: "Type a keyword...",
            prompt: "Leave empty to clear search",
          });
          if (keyword !== undefined) {
            provider.setFilter({ ...cur, subject: keyword.trim() || undefined });
          }
          continue;
        }
      }
    }],

    ["redmine.clearFilters", () => provider.clearFilter()],
    ["redmine.loadMore", () => provider.loadMore()],
    ["redmine.loadMoreProject", (...args: unknown[]) => provider.loadMoreProject(args[0] as number)],
    ["redmine.feedback", () => feedbackWebview.show()],

    ["redmine.groupBy", async () => {
      const current = provider.getGroupBy();
      const options: { label: string; description?: string; mode: GroupByMode }[] = [
        { label: "$(list-tree) Group by Project", mode: "project", description: current === "project" ? "✓ active" : undefined },
        { label: "$(circle-filled) Group by Status",  mode: "status",  description: current === "status"  ? "✓ active" : undefined },
        { label: "$(list-flat) No grouping (flat)",   mode: "none",    description: current === "none"    ? "✓ active" : undefined },
      ];
      const pick = await vscode.window.showQuickPick(options, {
        title: "Group Issues By",
        placeHolder: "Select grouping mode",
      });
      if (pick) provider.setGroupBy(pick.mode);
    }],

    ["redmine.search", async () => {
      const cur = provider.getFilter();
      const keyword = await vscode.window.showInputBox({
        title: "Search Issues",
        value: cur.subject ?? "",
        placeHolder: "Type a keyword to search in issue subjects…",
        prompt: "Leave empty to clear search filter",
      });
      if (keyword === undefined) return; // Esc
      provider.setFilter({ ...cur, subject: keyword.trim() || undefined });
    }],
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
    initTrackerCustomFieldCache(context).catch(() => {});
  }
}

export interface TrackerFieldCacheEntry {
  trackerId: number;
  trackerName: string;
  fields: { id: number; name: string }[];
  fetched: boolean;
}

async function initTrackerCustomFieldCache(context: vscode.ExtensionContext): Promise<void> {
  try {
    const trackers = await listTrackers();
    const cfg = vscode.workspace.getConfiguration("redmine");
    const projectId = cfg.get<string>("defaultProject") || undefined;

    const existing = context.globalState.get<TrackerFieldCacheEntry[]>("trackerFieldCache") ?? [];

    for (const tracker of trackers) {
      const cached = existing.find((e) => e.trackerId === tracker.id);
      if (cached?.fetched) continue; // already fetched, skip

      try {
        const result = await listIssues({ trackerId: String(tracker.id), projectId, limit: 1 });
        if (!result.issues.length) {
          const idx = existing.findIndex((e) => e.trackerId === tracker.id);
          const entry: TrackerFieldCacheEntry = { trackerId: tracker.id, trackerName: tracker.name, fields: [], fetched: true };
          if (idx >= 0) existing[idx] = entry; else existing.push(entry);
          continue;
        }
        const fullIssue = await getIssue(result.issues[0].id);
        const fields = (fullIssue.custom_fields ?? []).map((cf) => ({ id: cf.id, name: cf.name }));
        const idx = existing.findIndex((e) => e.trackerId === tracker.id);
        const entry: TrackerFieldCacheEntry = { trackerId: tracker.id, trackerName: tracker.name, fields, fetched: true };
        if (idx >= 0) existing[idx] = entry; else existing.push(entry);
      } catch { /* skip this tracker silently */ }
    }

    await context.globalState.update("trackerFieldCache", existing);

    // Backward-compat: keep bugCustomFieldDefs for existing create-issue-webview logic
    const bugEntry = existing.find((e) => /^bug$/i.test(e.trackerName));
    if (bugEntry) {
      await context.globalState.update("bugIssueExists", bugEntry.fields.length > 0);
      await context.globalState.update("bugCustomFieldDefs", bugEntry.fields);
    }
  } catch { /* silent, non-blocking */ }
}

function initClient() {
  const config = vscode.workspace.getConfiguration("redmine");
  const baseUrl = config.get<string>("baseUrl") ?? "";
  const apiKey = config.get<string>("apiKey") ?? "";
  const configured = !!(baseUrl && apiKey);
  vscode.commands.executeCommand("setContext", "redmine.isConfigured", configured);
  if (configured) {
    configureClient(baseUrl, apiKey);
  }
}


export function deactivate() {}
