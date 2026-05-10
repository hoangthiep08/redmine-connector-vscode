import * as vscode from "vscode";
import { Issue, listIssues } from "./redmine-client";

export interface IssueFilter {
  projectId?: string;
  projectName?: string;
  statusId?: string;
  statusName?: string;
  assignedToMe?: boolean;
  assignedToId?: string;
  assignedToName?: string;
  subject?: string;
}

export class IssueTreeItem extends vscode.TreeItem {
  constructor(public readonly issue: Issue) {
    super(`#${issue.id} ${issue.subject}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "issue";
    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.statusIcon(issue.status.name);
    this.command = {
      command: "redmine.openIssue",
      title: "Open Issue",
      arguments: [this],
    };
  }

  private buildTooltip(): string {
    return [
      `#${this.issue.id}: ${this.issue.subject}`,
      `Status: ${this.issue.status.name}`,
      `Priority: ${this.issue.priority.name}`,
      `Assignee: ${this.issue.assigned_to?.name ?? "Unassigned"}`,
      this.issue.due_date ? `Due: ${this.issue.due_date}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildDescription(): string {
    const parts = [`[${this.issue.status.name}]`];
    if (this.issue.assigned_to) parts.push(this.issue.assigned_to.name);
    if (this.issue.due_date) parts.push(`due ${this.issue.due_date}`);
    return parts.join(" · ");
  }

  private statusIcon(status: string): vscode.ThemeIcon {
    const lower = status.toLowerCase();
    if (lower.includes("close") || lower.includes("done") || lower.includes("resolved"))
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    if (lower.includes("progress") || lower.includes("doing"))
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("progressBar.background"));
    if (lower.includes("review") || lower.includes("testing"))
      return new vscode.ThemeIcon("eye", new vscode.ThemeColor("editorWarning.foreground"));
    return new vscode.ThemeIcon("issues", new vscode.ThemeColor("list.warningForeground"));
  }
}

class ActiveFilterItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "filterHeader";
    this.iconPath = new vscode.ThemeIcon("filter-filled", new vscode.ThemeColor("notificationsInfoIcon.foreground"));
    this.command = { command: "redmine.filter", title: "Edit Filters" };
    this.tooltip = "Click to change filters";
  }
}

class LoadingItem extends vscode.TreeItem {
  constructor() {
    super("Loading issues...", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("sync~spin");
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

class ErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("error");
    this.tooltip = message;
  }
}

export class IssueProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private issues: Issue[] = [];
  private loading = false;
  private error: string | null = null;
  private filter: IssueFilter = {};

  setFilter(filter: IssueFilter) {
    this.filter = filter;
    this.load();
  }

  getFilter(): IssueFilter {
    return this.filter;
  }

  clearFilter() {
    this.filter = {};
    this.load();
  }

  refresh() {
    this.load();
  }

  private async load() {
    this.loading = true;
    this.error = null;
    this._onDidChangeTreeData.fire(null);

    try {
      const config = vscode.workspace.getConfiguration("redmine");
      const defaultProject = config.get<string>("defaultProject") ?? "";
      const onlyMe = config.get<boolean>("showOnlyAssignedToMe") ?? false;

      let assignedToId: string | undefined;
      if (this.filter.assignedToMe ?? onlyMe) {
        assignedToId = "me";
      } else if (this.filter.assignedToId) {
        assignedToId = this.filter.assignedToId;
      }

      const result = await listIssues({
        projectId: this.filter.projectId || defaultProject || undefined,
        statusId: this.filter.statusId ?? "open",
        assignedToId,
        subject: this.filter.subject,
        limit: 100,
      });
      this.issues = result.issues;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire(null);
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.loading) return [new LoadingItem()];

    if (this.error) {
      const configItem = new vscode.TreeItem("Click to configure Redmine");
      configItem.command = { command: "redmine.configure", title: "Configure" };
      configItem.iconPath = new vscode.ThemeIcon("settings-gear");
      return [new ErrorItem(`Error: ${this.error}`), configItem];
    }

    const items: vscode.TreeItem[] = [];

    const filterLabel = this.buildFilterLabel();
    if (filterLabel) {
      items.push(new ActiveFilterItem(filterLabel));
    }

    if (this.issues.length === 0) {
      items.push(new EmptyItem("No issues found"));
    } else {
      items.push(...this.issues.map((i) => new IssueTreeItem(i)));
    }

    return items;
  }

  private buildFilterLabel(): string {
    const parts: string[] = [];
    if (this.filter.projectName) parts.push(`📁 ${this.filter.projectName}`);
    if (this.filter.statusName) parts.push(`🔵 ${this.filter.statusName}`);
    else if (this.filter.statusId === "*") parts.push("🔵 All statuses");
    else if (this.filter.statusId === "closed") parts.push("🔵 Closed");
    if (this.filter.assignedToMe) parts.push("👤 Assigned to me");
    else if (this.filter.assignedToName) parts.push(`👤 ${this.filter.assignedToName}`);
    if (this.filter.subject) parts.push(`🔍 "${this.filter.subject}"`);
    return parts.join("  ");
  }

  getIssueById(id: number): Issue | undefined {
    return this.issues.find((i) => i.id === id);
  }
}
