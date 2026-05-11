import * as vscode from "vscode";
import { Issue, listIssues, getIssue } from "./redmine-client";

export interface IssueFilter {
  projectId?: string;
  projectName?: string;
  statusId?: string;
  statusName?: string;
  assignedToMe?: boolean;
  assignedToId?: string;
  assignedToName?: string;
  trackerId?: string;
  trackerName?: string;
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

export type GroupByMode = "none" | "project" | "status";

export class ProjectGroupItem extends vscode.TreeItem {
  constructor(
    public readonly projectName: string,
    public readonly projectId: number,
    count: number,
  ) {
    super(projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count} issue${count !== 1 ? "s" : ""}`;
    this.iconPath = new vscode.ThemeIcon("folder-opened", new vscode.ThemeColor("notificationsInfoIcon.foreground"));
    this.contextValue = "projectGroup";
  }
}

export class StatusGroupItem extends vscode.TreeItem {
  constructor(
    public readonly statusName: string,
    public readonly statusId: number,
    count: number,
  ) {
    super(statusName, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count} issue${count !== 1 ? "s" : ""}`;
    this.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.blue"));
    this.contextValue = "statusGroup";
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

class LoadMoreItem extends vscode.TreeItem {
  constructor(loaded: number) {
    super(`Load more issues (showing ${loaded})`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("chevron-down");
    this.command = { command: "redmine.loadMore", title: "Load More" };
  }
}

export class IssueProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private issues: Issue[] = [];
  private loading = false;
  private loadingMore = false;
  private error: string | null = null;
  private filter: IssueFilter = {};
  private groupBy: GroupByMode = "project";
  private offset = 0;
  private hasMore = false;
  private readonly PAGE_SIZE = 20;

  setGroupBy(mode: GroupByMode) {
    this.groupBy = mode;
    this._onDidChangeTreeData.fire(null);
  }

  getGroupBy(): GroupByMode {
    return this.groupBy;
  }

  setFilter(filter: IssueFilter) {
    this.filter = filter;
    this.offset = 0;
    this.issues = [];
    this.load();
  }

  getFilter(): IssueFilter {
    return this.filter;
  }

  /** Merges session filter with config defaults — reflects what is actually applied. */
  getEffectiveFilter(): IssueFilter {
    const config = vscode.workspace.getConfiguration("redmine");
    const eff: IssueFilter = { ...this.filter };

    // Project: session → config
    if (!eff.projectId) {
      const def = config.get<string>("defaultProject") ?? "";
      if (def) {
        eff.projectId = def;
        eff.projectName = config.get<string>("defaultProjectName") || def;
      }
    }

    // Status: session → config
    if (!eff.statusId) {
      const mode = config.get<string>("defaultStatusMode") ?? "open";
      if (mode === "closed")       { eff.statusId = "closed"; eff.statusName = "Closed"; }
      else if (mode === "*")       { eff.statusId = "*";      eff.statusName = "All statuses"; }
      else if (mode === "custom")  {
        const ids = config.get<string[]>("defaultStatusIds") ?? [];
        eff.statusId = ids.length ? "*" : "open";
        eff.statusName = ids.length ? `Custom (${ids.length})` : undefined;
      }
      // "open" = default, leave unset so label stays clean
    }

    // Assignee: session → config
    if (!eff.assignedToMe && !eff.assignedToId) {
      const mode = config.get<string>("defaultAssigneeMode") ?? "all";
      if (mode === "me") {
        eff.assignedToMe = true;
      } else if (mode === "custom") {
        const id = config.get<string>("defaultAssigneeId") ?? "";
        if (id) {
          eff.assignedToId = id;
          eff.assignedToName = config.get<string>("defaultAssigneeName") || undefined;
        }
      }
    }

    // Tracker: session → config
    if (!eff.trackerId) {
      const tid = config.get<string>("defaultTrackerId") ?? "";
      if (tid) {
        eff.trackerId = tid;
        eff.trackerName = config.get<string>("defaultTrackerName") || undefined;
      }
    }

    return eff;
  }

  /** True when there are session-level overrides (not just config defaults). */
  hasSessionFilter(): boolean {
    const f = this.filter;
    return !!(f.projectId || f.statusId || f.assignedToMe || f.assignedToId || f.trackerId || f.subject);
  }

  clearFilter() {
    this.filter = {};
    this.offset = 0;
    this.issues = [];
    this.load();
  }

  refresh() {
    this.offset = 0;
    this.issues = [];
    this.load();
  }

  async loadMore() {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    this._onDidChangeTreeData.fire(null);
    await this.load(true);
  }

  private async load(append = false) {
    if (append) {
      this.loadingMore = true;
    } else {
      this.loading = true;
      this.error = null;
    }
    this._onDidChangeTreeData.fire(null);

    try {
      const config = vscode.workspace.getConfiguration("redmine");
      const defaultProject = config.get<string>("defaultProject") ?? "";
      const onlyMe = config.get<boolean>("showOnlyAssignedToMe") ?? false;

      let assignedToId: string | undefined;
      if (this.filter.assignedToMe) {
        assignedToId = "me";
      } else if (this.filter.assignedToId) {
        assignedToId = this.filter.assignedToId;
      } else {
        // No active session filter — apply config defaults
        const assigneeMode = config.get<string>("defaultAssigneeMode") ?? "all";
        if (assigneeMode === "me" || onlyMe) {
          assignedToId = "me";
        } else if (assigneeMode === "custom") {
          const cid = config.get<string>("defaultAssigneeId") ?? "";
          if (cid) assignedToId = cid;
        }
      }

      // Resolve status filter: active filter > config defaults
      let statusId: string;
      let customStatusIds: string[] = [];
      if (this.filter.statusId) {
        statusId = this.filter.statusId;
      } else {
        const mode = config.get<string>("defaultStatusMode") ?? "open";
        if (mode === "custom") {
          customStatusIds = config.get<string[]>("defaultStatusIds") ?? [];
          statusId = customStatusIds.length ? "*" : "open";
        } else {
          statusId = mode || "open";
        }
      }

      // If search term is a number or #number, fetch that issue directly by ID
      const subjectTerm = this.filter.subject?.trim() ?? "";
      const idMatch = /^#?(\d+)$/.exec(subjectTerm);

      if (idMatch) {
        try {
          const issue = await getIssue(parseInt(idMatch[1], 10));
          this.issues = [issue];
          this.hasMore = false;
        } catch {
          this.issues = [];
          this.hasMore = false;
        }
      } else {
        const defaultTrackerId = config.get<string>("defaultTrackerId") ?? "";
        const trackerId = this.filter.trackerId || defaultTrackerId || undefined;

        const result = await listIssues({
          projectId: this.filter.projectId || defaultProject || undefined,
          statusId,
          assignedToId,
          trackerId,
          subject: this.filter.subject,
          limit: this.PAGE_SIZE,
          offset: append ? this.offset : 0,
        });

        const fetched = customStatusIds.length
          ? result.issues.filter((i) => customStatusIds.includes(String(i.status.id)))
          : result.issues;

        if (append) {
          this.issues = [...this.issues, ...fetched];
        } else {
          this.issues = fetched;
        }

        this.offset = this.issues.length;
        this.hasMore = result.total_count > this.issues.length;
      }
    } catch (err) {
      if (!append) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.loadingMore = false;
      vscode.commands.executeCommand("setContext", "redmine.hasActiveFilter", this.hasSessionFilter());
      this._onDidChangeTreeData.fire(null);
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    // Children of a project group
    if (element instanceof ProjectGroupItem) {
      return this.issues
        .filter((i) => i.project.id === element.projectId)
        .map((i) => new IssueTreeItem(i));
    }
    // Children of a status group
    if (element instanceof StatusGroupItem) {
      return this.issues
        .filter((i) => i.status.id === element.statusId)
        .map((i) => new IssueTreeItem(i));
    }

    // Root level
    if (this.loading) return [new LoadingItem()];
    if (this.loadingMore) {
      const items: vscode.TreeItem[] = [];
      items.push(...this.issues.map((i) => new IssueTreeItem(i)));
      items.push(new LoadingItem());
      return items;
    }

    if (this.error) {
      const configItem = new vscode.TreeItem("Click to configure Redmine");
      configItem.command = { command: "redmine.configure", title: "Configure" };
      configItem.iconPath = new vscode.ThemeIcon("settings-gear");
      return [new ErrorItem(`Error: ${this.error}`), configItem];
    }

    const items: vscode.TreeItem[] = [];
    const filterLabel = this.buildFilterLabel();
    if (filterLabel) items.push(new ActiveFilterItem(filterLabel));

    if (this.issues.length === 0) {
      items.push(new EmptyItem("No issues found"));
      return items;
    }

    if (this.groupBy === "project") {
      const map = new Map<number, { name: string; issues: Issue[] }>();
      for (const issue of this.issues) {
        if (!map.has(issue.project.id))
          map.set(issue.project.id, { name: issue.project.name, issues: [] });
        map.get(issue.project.id)!.issues.push(issue);
      }
      if (map.size > 1) {
        for (const [projectId, { name, issues }] of map)
          items.push(new ProjectGroupItem(name, projectId, issues.length));
        return items;
      }
    } else if (this.groupBy === "status") {
      const map = new Map<number, { name: string; issues: Issue[] }>();
      for (const issue of this.issues) {
        if (!map.has(issue.status.id))
          map.set(issue.status.id, { name: issue.status.name, issues: [] });
        map.get(issue.status.id)!.issues.push(issue);
      }
      if (map.size > 1) {
        for (const [statusId, { name, issues }] of map)
          items.push(new StatusGroupItem(name, statusId, issues.length));
        return items;
      }
    }

    // Flat (groupBy === "none" or single group)
    items.push(...this.issues.map((i) => new IssueTreeItem(i)));
    if (this.hasMore) items.push(new LoadMoreItem(this.issues.length));
    return items;
  }

  private buildFilterLabel(): string {
    const eff = this.getEffectiveFilter();
    const parts: string[] = [];
    if (eff.projectName)    parts.push(`📁 ${eff.projectName}`);
    if (eff.statusName)     parts.push(`🔵 ${eff.statusName}`);
    else if (eff.statusId === "*")      parts.push("🔵 All statuses");
    else if (eff.statusId === "closed") parts.push("🔵 Closed");
    if (eff.assignedToMe)        parts.push("👤 Assigned to me");
    else if (eff.assignedToName) parts.push(`👤 ${eff.assignedToName}`);
    else if (eff.assignedToId)   parts.push("👤 Custom user");
    if (eff.trackerName) parts.push(`🏷 ${eff.trackerName}`);
    if (eff.subject) parts.push(`🔍 "${eff.subject}"`);
    return parts.join("  ");
  }

  getIssueById(id: number): Issue | undefined {
    return this.issues.find((i) => i.id === id);
  }
}
