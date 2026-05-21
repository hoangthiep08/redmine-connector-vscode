import * as vscode from "vscode";
import {
  listIssues,
  listProjects,
  listStatuses,
  listTrackers,
  listPriorities,
  listProjectMembers,
  getIssue,
  updateIssue,
  fetchAttachmentAsDataUrl,
  type Issue,
} from "./redmine-client";
import type { CustomFieldConfigEntry } from "./settings-webview";

interface FilterState {
  active: string[]; // names of active filter fields
  projectId?: string;
  trackerId?: string;
  statusId?: string; // "open" | "closed" | "*" | csv ids
  priorityId?: string;
  assignedToId?: string;
  authorId?: string;
  subject?: string;
  sort?: string;
  page: number;
  pageSize: number;
  /** map of custom field id → value */
  customFields?: Record<string, string>;
}

const LAST_FILTER_KEY = "issueListLastFilter";

/** Synthesise an initial filter from Settings → Default Filters. */
function computeDefaultFilter(): {
  projectId?: string; trackerId?: string; statusId?: string; assignedToId?: string;
  customFields?: Record<string, string>; active: string[];
} {
  const cfg = vscode.workspace.getConfiguration("redmine");
  const defaultProject = cfg.get<string>("defaultProject") ?? "";
  const defaultTracker = cfg.get<string>("defaultTrackerId") ?? "";
  const statusMode   = cfg.get<string>("defaultStatusMode") ?? "open";
  const statusIds    = cfg.get<string[]>("defaultStatusIds") ?? [];
  const assigneeMode = cfg.get<string>("defaultAssigneeMode") ?? "all";
  const assigneeId   = cfg.get<string>("defaultAssigneeId") ?? "";
  const defaultCfMap = cfg.get<Record<string, string>>("defaultCustomFields") ?? {};

  const f: {
    projectId?: string; trackerId?: string; statusId?: string; assignedToId?: string;
    customFields?: Record<string, string>; active: string[];
  } = { active: [] };

  f.active.push("status");
  if (statusMode === "custom" && statusIds.length) f.statusId = statusIds.join(",");
  else f.statusId = statusMode || "open";

  if (defaultProject) { f.active.push("project"); f.projectId = defaultProject; }
  if (defaultTracker) { f.active.push("tracker"); f.trackerId = defaultTracker; }
  if (assigneeMode === "me") { f.active.push("assignedTo"); f.assignedToId = "me"; }
  else if (assigneeMode === "custom" && assigneeId) { f.active.push("assignedTo"); f.assignedToId = assigneeId; }

  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(defaultCfMap)) {
    if (typeof v === "string" && v.trim() !== "") {
      cleaned[k] = v;
      f.active.push("cf:" + k);
    }
  }
  if (Object.keys(cleaned).length) f.customFields = cleaned;

  return f;
}

export class IssueListWebview {
  private panel: vscode.WebviewPanel | null = null;
  constructor(private readonly context: vscode.ExtensionContext) {}

  async show() {
    if (this.panel) { this.panel.reveal(); return; }

    // Pre-fetch lookups in parallel
    const [projects, trackers, statuses, priorities] = await Promise.all([
      listProjects().then((ps) => ps.map((p) => ({ id: p.identifier, name: p.name }))).catch(() => []),
      listTrackers().then((ts) => ts.map((t) => ({ id: String(t.id), name: t.name }))).catch(() => []),
      listStatuses().then((ss) => ss.map((s) => ({ id: String(s.id), name: s.name, is_closed: s.is_closed }))).catch(() => []),
      listPriorities().then((ps) => ps.map((p) => ({ id: String(p.id), name: p.name }))).catch(() => []),
    ]);

    // Flatten configured custom fields → list of filterable options
    const cfConfig = this.context.globalState.get<CustomFieldConfigEntry[]>("customFieldConfig") ?? [];
    const cfFilters: Array<{ id: number; name: string; trackerName: string; type: "text" | "select"; options: string[] }> = [];
    const seen = new Set<number>();
    cfConfig.forEach((entry) => {
      entry.fields.forEach((f) => {
        if (seen.has(f.id)) return; // dedupe by id across trackers (same CF often shared)
        seen.add(f.id);
        cfFilters.push({ id: f.id, name: f.name, trackerName: entry.trackerName, type: f.type, options: f.options ?? [] });
      });
    });

    // Resolve the filter to open the webview with. Priority:
    //   1) the last filter the user applied in a previous session (globalState)
    //   2) defaults synthesised from Settings → Default Filters
    // This way the view feels "sticky" — closing and reopening keeps your work.
    const saved = this.context.globalState.get<FilterState>(LAST_FILTER_KEY);
    const initFilter = (saved && Array.isArray(saved.active))
      ? {
          active: saved.active,
          projectId:    saved.projectId,
          trackerId:    saved.trackerId,
          statusId:     saved.statusId,
          assignedToId: saved.assignedToId,
          customFields: saved.customFields,
        }
      : computeDefaultFilter();

    this.panel = vscode.window.createWebviewPanel(
      "redmineIssueList",
      "Redmine — Issue List",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => { this.panel = null; });

    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "redmine.png"),
    );

    this.panel.webview.html = buildHtml({
      projects, trackers, statuses, priorities, cfFilters,
      initFilter,
      logoSrc: logoUri.toString(),
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      // ── Apply filter → fetch issues ──────────────────────────────────────
      if (msg.command === "applyFilter") {
        const f = msg.filter as FilterState;
        // Persist the most-recent filter so reopening the webview restores it
        // instead of always re-reading the Settings defaults.
        this.context.globalState.update(LAST_FILTER_KEY, f);
        try {
          const result = await listIssues({
            projectId:    f.projectId    || undefined,
            trackerId:    f.trackerId    || undefined,
            statusId:     f.statusId     || undefined,
            priorityId:   f.priorityId   || undefined,
            assignedToId: f.assignedToId || undefined,
            authorId:     f.authorId     || undefined,
            subject:      f.subject      || undefined,
            sort:         f.sort         || undefined,
            customFields: f.customFields && Object.keys(f.customFields).length ? f.customFields : undefined,
            limit:        f.pageSize,
            offset:       (f.page - 1) * f.pageSize,
          });
          this.panel?.webview.postMessage({
            command: "issuesResult",
            issues: result.issues,
            total: result.total_count,
            page: f.page,
            pageSize: f.pageSize,
          });
        } catch (err) {
          this.panel?.webview.postMessage({ command: "issuesError", message: String(err) });
        }
      }

      // ── Fetch members for assignee/author select ────────────────────────
      if (msg.command === "fetchMembers") {
        const projId = (msg.projectId as string ?? "").trim();
        const ms = projId
          ? await listProjectMembers(projId).then((m) => m.map((x) => ({ id: String(x.id), name: x.name }))).catch(() => [])
          : [];
        this.panel?.webview.postMessage({ command: "membersResult", members: ms });
      }

      // ── Open issue detail (full webview tab) ────────────────────────────
      if (msg.command === "openIssue") {
        vscode.commands.executeCommand("redmine.openIssue", { issue: { id: msg.issueId as number } });
      }

      // ── Push issue context to AI chat ──────────────────────────────────
      // pushIssueToAI needs a full Issue object, so resolve via getIssue first.
      if (msg.command === "pushToAI") {
        try {
          const issue = await getIssue(msg.issueId as number);
          await vscode.commands.executeCommand("redmine.pushToChat", { issue });
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to push issue: ${String(err)}`);
        }
      }

      // ── Fetch issue detail into the inline right-side panel ─────────────
      if (msg.command === "fetchIssueDetail") {
        try {
          const issue = await getIssue(msg.issueId as number);
          this.panel?.webview.postMessage({ command: "issueDetailResult", issue });
        } catch (err) {
          this.panel?.webview.postMessage({ command: "issueDetailError", message: String(err) });
        }
      }

      // ── Reset the persisted filter back to Settings defaults ───────────
      if (msg.command === "resetFilter") {
        await this.context.globalState.update(LAST_FILTER_KEY, undefined);
        this.panel?.webview.postMessage({ command: "filterReset", filter: computeDefaultFilter() });
      }

      // ── Lazy-load attachment images for the detail panel ───────────────
      if (msg.command === "loadImage") {
        const attachmentId = msg.attachmentId as number;
        try {
          const url = typeof msg.url === "string" ? msg.url : "";
          const dataUrl = await fetchAttachmentAsDataUrl(url);
          this.panel?.webview.postMessage({ command: "imageLoaded", attachmentId, dataUrl });
        } catch {
          this.panel?.webview.postMessage({ command: "imageError", attachmentId });
        }
      }

      // ── Fetch members for the detail panel's assignee dropdown ────────
      if (msg.command === "fetchDetailMembers") {
        const projId = String(msg.projectId ?? "").trim();
        const ms = projId
          ? await listProjectMembers(projId).then((m) => m.map((x) => ({ id: String(x.id), name: x.name }))).catch(() => [])
          : [];
        this.panel?.webview.postMessage({ command: "detailMembersResult", members: ms });
      }

      // ── Update status/assignee from the inline detail panel ────────────
      if (msg.command === "updateDetailIssue") {
        const issueId = msg.issueId as number;
        const updates: { statusId?: number; assignedToId?: number } = {};
        if (msg.statusId !== undefined) updates.statusId = msg.statusId as number;
        if (msg.assignedToId !== undefined) updates.assignedToId = msg.assignedToId as number;
        try {
          await updateIssue(issueId, updates);
          const issue = await getIssue(issueId);
          this.panel?.webview.postMessage({ command: "issueDetailResult", issue });
        } catch (err) {
          this.panel?.webview.postMessage({ command: "issueDetailUpdateError", message: String(err) });
        }
      }

      // ── Apply current filter to global settings ─────────────────────────
      if (msg.command === "applyToGlobal") {
        const f = msg.filter as FilterState;
        const summaryLines: string[] = [];
        if (f.projectId   !== undefined) summaryLines.push(`• Project: ${f.projectId || "(All)"}`);
        if (f.trackerId   !== undefined) summaryLines.push(`• Tracker: ${f.trackerId || "(All)"}`);
        if (f.statusId    !== undefined) summaryLines.push(`• Status: ${describeStatus(f.statusId)}`);
        if (f.assignedToId !== undefined) summaryLines.push(`• Assignee: ${f.assignedToId || "(All)"}`);

        const confirm = await vscode.window.showWarningMessage(
          `Apply these filters to Default Filters (Settings → Filters)?\n\n${summaryLines.join("\n")}`,
          { modal: true },
          "Apply",
        );
        if (confirm !== "Apply") return;

        const cfg = vscode.workspace.getConfiguration("redmine");
        await cfg.update("defaultProject",   f.projectId ?? "", vscode.ConfigurationTarget.Global);
        await cfg.update("defaultTrackerId", f.trackerId ?? "", vscode.ConfigurationTarget.Global);
        if (f.statusId !== undefined) {
          if (f.statusId === "" || f.statusId === "open" || f.statusId === "closed" || f.statusId === "*") {
            await cfg.update("defaultStatusMode", f.statusId || "open", vscode.ConfigurationTarget.Global);
            await cfg.update("defaultStatusIds", [], vscode.ConfigurationTarget.Global);
          } else {
            await cfg.update("defaultStatusMode", "custom", vscode.ConfigurationTarget.Global);
            await cfg.update("defaultStatusIds", f.statusId.split(",").filter(Boolean), vscode.ConfigurationTarget.Global);
          }
        }
        if (f.assignedToId !== undefined) {
          if (!f.assignedToId)       await cfg.update("defaultAssigneeMode", "all",    vscode.ConfigurationTarget.Global);
          else if (f.assignedToId === "me") await cfg.update("defaultAssigneeMode", "me", vscode.ConfigurationTarget.Global);
          else {
            await cfg.update("defaultAssigneeMode", "custom", vscode.ConfigurationTarget.Global);
            await cfg.update("defaultAssigneeId", f.assignedToId, vscode.ConfigurationTarget.Global);
          }
        }
        vscode.commands.executeCommand("redmine.refresh");
        vscode.window.showInformationMessage("✓ Filters applied to global Settings.");
      }
    });
  }
}

function describeStatus(s: string): string {
  if (s === "open" || s === "") return "Open";
  if (s === "closed") return "Closed";
  if (s === "*") return "All";
  return `IDs: ${s}`;
}

function e(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildHtml(data: {
  projects:   { id: string; name: string }[];
  trackers:   { id: string; name: string }[];
  statuses:   { id: string; name: string; is_closed: boolean }[];
  priorities: { id: string; name: string }[];
  cfFilters:  Array<{ id: number; name: string; trackerName: string; type: "text" | "select"; options: string[] }>;
  initFilter: {
    projectId?: string; trackerId?: string; statusId?: string; assignedToId?: string;
    customFields?: Record<string, string>; active: string[];
  };
  logoSrc:    string;
}): string {
  const { projects, trackers, statuses, priorities, cfFilters, initFilter, logoSrc } = data;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Redmine Issue List</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 14px 18px;
  }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .header img { width: 30px; height: 30px; object-fit: contain; }
  .header .title { font-size: 1.1em; font-weight: 700; }

  .filter-box { border: 1px solid var(--vscode-widget-border,#444); border-radius: 6px; padding: 12px 14px; margin-bottom: 14px; background: var(--vscode-editor-inactiveSelectionBackground); }
  /* Filter rows lay out in a responsive grid — 2-3 filters per row on a typical
     viewport instead of wasting a full row each. */
  .filter-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 6px 12px; margin-bottom: 10px; }
  .filter-row { display: grid; grid-template-columns: 88px 1fr 24px; gap: 6px; align-items: center; min-width: 0; }
  .filter-row label { font-size: .82em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .filter-row input, .filter-row select { width: 100%; min-width: 0; padding: 4px 7px; font-family: inherit; font-size: .82em; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border,#555); border-radius: 3px; }
  .filter-row .rm { background: none; border: 1px solid var(--vscode-widget-border,#444); color: var(--vscode-descriptionForeground); border-radius: 3px; cursor: pointer; padding: 2px 6px; font-size: .9em; line-height: 1; height: 24px; }
  .filter-row .rm:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }

  .filter-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border,#333); }
  .filter-actions .spacer { flex: 1; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 5px 12px; cursor: pointer; font-family: inherit; font-size: .85em; }
  .btn:hover { opacity: .87; }
  .btn-sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-sm  { padding: 4px 9px; font-size: .8em; }
  .add-filter-wrap select { padding: 4px 8px; font-size: .8em; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border,#555); border-radius: 3px; }

  table.issues { width: 100%; border-collapse: collapse; font-size: .85em; }
  table.issues th, table.issues td { border: 1px solid var(--vscode-widget-border,#444); padding: 6px 8px; text-align: left; vertical-align: top; }
  table.issues thead th { background: color-mix(in srgb, var(--vscode-button-background) 60%, transparent); color: var(--vscode-button-foreground); font-weight: 700; position: sticky; top: 0; cursor: pointer; user-select: none; white-space: nowrap; }
  table.issues thead th.no-sort { cursor: default; }
  table.issues tbody tr:nth-child(odd) { background: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 50%, transparent); }
  table.issues tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  /* Theme-aware neutral badge (same vars VS Code uses for tree-view badges) */
  .id-link { display: inline-block; padding: 2px 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; font-weight: 500; font-size: .82em; text-decoration: none; cursor: pointer; letter-spacing: .02em; font-family: var(--vscode-editor-font-family, monospace); }
  .id-link:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-textLink-foreground); }
  tr.selected .id-link { background: var(--vscode-textLink-foreground); color: var(--vscode-editor-background); }
  .subject-link { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .subject-link:hover { text-decoration: underline; }
  .progress { display: inline-block; width: 60px; height: 8px; border-radius: 4px; background: var(--vscode-widget-border,#444); overflow: hidden; vertical-align: middle; margin-right: 5px; }
  .progress > div { height: 100%; background: var(--vscode-testing-iconPassed,#4ec974); }
  .empty-row td { text-align: center; padding: 24px; color: var(--vscode-descriptionForeground); font-style: italic; }
  .sort-ind { display: inline-block; margin-left: 4px; font-size: .8em; opacity: .7; }

  .pagination { display: flex; align-items: center; gap: 6px; margin-top: 14px; flex-wrap: wrap; }
  .pagination .info { flex: 1; font-size: .82em; color: var(--vscode-descriptionForeground); }
  .pagination button { padding: 4px 10px; min-width: 30px; }
  .pagination button.current { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 700; }
  .feedback { display: none; margin-top: 10px; padding: 8px 12px; border-radius: 3px; font-size: .85em; }
  .feedback.error { display: block; background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); color: var(--vscode-errorForeground); }
  .feedback.info  { display: block; background: color-mix(in srgb, var(--vscode-charts-blue) 10%, transparent); }

  /* Split layout: table on the left, detail panel on the right */
  .main-split { display: flex; gap: 14px; align-items: flex-start; }
  .list-pane { flex: 1; min-width: 0; }
  .detail-pane { width: 420px; flex-shrink: 0; border: 1px solid var(--vscode-widget-border,#444); border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); display: none; max-height: calc(100vh - 140px); overflow-y: auto; position: sticky; top: 8px; }
  .detail-pane.open { display: block; }
  /* Sticky action toolbar at top of the detail pane — stays visible while scrolling */
  .detail-toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 6px; align-items: center; padding: 10px 14px; background: var(--vscode-editor-inactiveSelectionBackground); border-bottom: 1px solid var(--vscode-widget-border,#333); }
  .detail-toolbar .spacer { flex: 1; }
  .detail-toolbar .close-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 1.2em; line-height: 1; padding: 2px 8px; border-radius: 3px; }
  .detail-toolbar .close-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .detail-body { padding: 12px 16px 16px; }
  .detail-head { margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border,#333); }
  .detail-head .meta { font-size: .78em; color: var(--vscode-descriptionForeground); }
  .detail-head .meta .id { font-family: var(--vscode-editor-font-family,monospace); }
  .detail-head h2 { font-size: 1.05em; font-weight: 700; margin: 4px 0 6px; line-height: 1.3; word-break: break-word; }
  .detail-status-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .detail-chip { display: inline-block; padding: 3px 8px; border-radius: 10px; font-size: .78em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .detail-kv { display: grid; grid-template-columns: 95px 1fr; gap: 4px 10px; font-size: .82em; margin-bottom: 12px; }
  .detail-kv .k { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .detail-section-title { font-size: .72em; text-transform: uppercase; letter-spacing: .07em; color: var(--vscode-descriptionForeground); font-weight: 700; margin: 14px 0 6px; }
  .detail-desc { font-size: .85em; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: var(--vscode-editor-background); padding: 10px 12px; border-radius: 4px; border: 1px solid var(--vscode-widget-border,#333); }
  .detail-desc .inline-img { max-width: 100%; height: auto; display: block; margin: 6px 0; cursor: zoom-in; border-radius: 3px; background: var(--vscode-editor-inactiveSelectionBackground); min-height: 24px; }
  .detail-desc .inline-img.loading { opacity: .5; }
  .detail-empty { font-size: .82em; color: var(--vscode-descriptionForeground); font-style: italic; }
  .detail-cf-list { display: flex; flex-direction: column; gap: 4px; font-size: .82em; }
  .detail-cf-list .row { display: grid; grid-template-columns: 110px 1fr; gap: 8px; }
  .detail-cf-list .row .k { color: var(--vscode-descriptionForeground); }
  .detail-journals { display: flex; flex-direction: column; gap: 10px; }
  .detail-journal { font-size: .82em; padding: 8px 10px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border,#333); border-radius: 4px; }
  .detail-journal .head { font-size: .85em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .detail-journal .notes { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .detail-journal .notes .inline-img { max-width: 100%; height: auto; display: block; margin: 6px 0; cursor: zoom-in; border-radius: 3px; }
  tr.selected { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }

  /* Lightbox overlay for image preview */
  .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 1000; align-items: center; justify-content: center; cursor: zoom-out; padding: 24px; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 95%; max-height: 95%; object-fit: contain; box-shadow: 0 4px 24px rgba(0,0,0,.4); }

  /* Inline editable selects in the detail panel */
  .detail-select {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 2px 7px;
    font-size: .78em;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    max-width: 100%;
  }
  .detail-select:hover { border-color: var(--vscode-focusBorder); }
  .detail-select:focus { border-color: var(--vscode-focusBorder); }
  .detail-kv .detail-inline-select {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border,#555);
    border-radius: 3px;
    padding: 3px 6px;
    font-size: .82em;
    font-family: inherit;
    cursor: pointer;
    outline: none;
  }
  .detail-kv .detail-inline-select:hover { border-color: var(--vscode-focusBorder); }
  .detail-kv .detail-inline-select:focus { border-color: var(--vscode-focusBorder); }
</style>
</head>
<body>

<div class="header">
  <img src="${e(logoSrc)}" alt="Redmine">
  <div class="title">Issue List</div>
</div>

<div class="filter-box">
  <div class="filter-rows" id="filterRows"></div>
  <div class="filter-actions">
    <button class="btn" onclick="applyFilter()">✓ Apply</button>
    <button class="btn btn-sec btn-sm" onclick="clearFilters()">↺ Clear</button>
    <button class="btn btn-sec btn-sm" onclick="resetToDefaults()" title="Discard the saved filter and rebuild from Settings → Default Filters">⤺ Reset</button>
    <button class="btn btn-sec btn-sm" onclick="applyToGlobal()">💾 Save to Global</button>
    <span class="spacer"></span>
    <span class="add-filter-wrap">
      <label style="font-size:.82em;margin-right:4px">Add filter:</label>
      <select id="addFilter" onchange="onAddFilter(this)">
        <option value="">— Choose —</option>
      </select>
    </span>
  </div>
  <div class="feedback" id="fb"></div>
</div>

<div class="main-split">
  <div class="list-pane">
    <div id="tableWrap">
      <table class="issues">
        <thead>
          <tr>
            <th data-sort="id">#<span class="sort-ind" id="ind-id"></span></th>
            <th data-sort="tracker">Tracker<span class="sort-ind" id="ind-tracker"></span></th>
            <th data-sort="status">Status<span class="sort-ind" id="ind-status"></span></th>
            <th data-sort="priority">Priority<span class="sort-ind" id="ind-priority"></span></th>
            <th data-sort="subject">Subject<span class="sort-ind" id="ind-subject"></span></th>
            <th data-sort="assigned_to">Assignee<span class="sort-ind" id="ind-assigned_to"></span></th>
            <th data-sort="done_ratio">% Done<span class="sort-ind" id="ind-done_ratio"></span></th>
            <th class="no-sort">Type Bug</th>
          </tr>
        </thead>
        <tbody id="tbody">
          <tr class="empty-row"><td colspan="8">Loading…</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pagination" id="pagination"></div>
  </div>

  <aside class="detail-pane" id="detailPane">
    <div class="detail-toolbar" id="detailToolbar" style="display:none">
      <button class="btn btn-sm" id="detailOpenBtn">↗ Open in full tab</button>
      <button class="btn btn-sec btn-sm" id="detailPushAiBtn">💬 Push to AI</button>
      <span class="spacer"></span>
      <button class="close-btn" onclick="closeDetail()" title="Close">×</button>
    </div>
    <div class="detail-body" id="detailContent"></div>
  </aside>
</div>

<!-- Lightbox for image preview -->
<div class="lightbox" id="lightbox" onclick="closeLightbox()">
  <img id="lightboxImg" alt="">
</div>

<script>
  const vscode = acquireVsCodeApi();

  const PROJECTS   = ${JSON.stringify(projects)};
  const TRACKERS   = ${JSON.stringify(trackers)};
  const STATUSES   = ${JSON.stringify(statuses)};
  const PRIORITIES = ${JSON.stringify(priorities)};
  const CF_FILTERS = ${JSON.stringify(cfFilters)};
  const INIT_FILTER = ${JSON.stringify(initFilter)};

  // ── Filter spec ────────────────────────────────────────────────────────
  // Each filter field has: id (config key) / label / options getter
  const FILTER_DEFS = {
    project:    { label: 'Project',  options: () => [{id:'',name:'(any)'}].concat(PROJECTS) },
    tracker:    { label: 'Tracker',  options: () => [{id:'',name:'(any)'}].concat(TRACKERS) },
    status:     { label: 'Status',   options: () => [
      {id:'open',name:'open'},
      {id:'closed',name:'closed'},
      {id:'*',name:'all'},
    ].concat(STATUSES.map(s => ({ id: s.id, name: s.name + (s.is_closed?' (closed)':'') }))) },
    priority:   { label: 'Priority', options: () => [{id:'',name:'(any)'}].concat(PRIORITIES) },
    assignedTo: { label: 'Assignee', options: () => [
      {id:'',name:'(any)'},
      {id:'me',name:'<< me >>'},
      ..._members.map(m => ({ id: m.id, name: m.name })),
    ] },
    author:     { label: 'Author', options: () => [
      {id:'',name:'(any)'},
      {id:'me',name:'<< me >>'},
      ..._members.map(m => ({ id: m.id, name: m.name })),
    ] },
    subject:    { label: 'Subject contains', type: 'text' },
  };

  // CF entries surface as filter names of the form "cf:<id>"
  function cfDef(cfId) {
    return CF_FILTERS.find(function(f) { return f.id === cfId; });
  }

  let _members = [];

  // Initial filter pre-populated from Settings → Default Filters so the user
  // doesn't have to re-apply the same filters they've already configured.
  let _filter = Object.assign({
    pageSize: 25,
    page: 1,
    sort: 'id:desc',
    customFields: {},
  }, INIT_FILTER || {});
  if (!_filter.active || !_filter.active.length) {
    _filter.active = ['status'];
    _filter.statusId = 'open';
  }
  if (!_filter.customFields) _filter.customFields = {};

  // ── Filter UI ──────────────────────────────────────────────────────────
  function renderFilterRow(name) {
    // Custom field row: name = "cf:<id>"
    if (name.indexOf('cf:') === 0) {
      const cfId = Number(name.slice(3));
      const def = cfDef(cfId);
      if (!def) return null;
      const row = document.createElement('div');
      row.className = 'filter-row';
      row.dataset.field = name;

      const lbl = document.createElement('label');
      lbl.textContent = def.name;
      lbl.title = 'Custom field (' + def.trackerName + ')';
      row.appendChild(lbl);

      let inp;
      const currentVal = (_filter.customFields && _filter.customFields[cfId]) || '';
      if (def.type === 'select' && def.options.length > 0) {
        inp = document.createElement('select');
        inp.appendChild(new Option('(any)', ''));
        def.options.forEach(function(o) { inp.appendChild(new Option(o, o)); });
        inp.value = currentVal;
      } else {
        inp = document.createElement('input');
        inp.type = 'text';
        inp.value = currentVal;
        inp.placeholder = 'Value';
        inp.onkeydown = function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); applyFilter(); } };
      }
      inp.dataset.field = name;
      row.appendChild(inp);

      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '×';
      rm.title = 'Remove this filter';
      rm.onclick = function() { removeFilter(name); };
      row.appendChild(rm);
      return row;
    }

    // Built-in filter
    const def = FILTER_DEFS[name];
    if (!def) return null;
    const row = document.createElement('div');
    row.className = 'filter-row';
    row.dataset.field = name;

    const lbl = document.createElement('label');
    lbl.textContent = def.label;
    row.appendChild(lbl);

    let inp;
    if (def.type === 'text') {
      inp = document.createElement('input');
      inp.type = 'text';
      inp.value = _filter.subject || '';
      inp.placeholder = 'Type and press Apply';
      inp.onkeydown = function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); applyFilter(); } };
    } else {
      inp = document.createElement('select');
      def.options().forEach(function(o) {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.name;
        inp.appendChild(opt);
      });
      const stateKey = stateKeyFor(name);
      inp.value = _filter[stateKey] ?? '';
      if (name === 'project') inp.onchange = onProjectChange;
    }
    inp.dataset.field = name;
    row.appendChild(inp);

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Remove this filter';
    rm.onclick = function() { removeFilter(name); };
    row.appendChild(rm);
    return row;
  }

  function renderFilters() {
    const rows = document.getElementById('filterRows');
    rows.innerHTML = '';
    _filter.active.forEach(function(name) {
      const row = renderFilterRow(name);
      if (row) rows.appendChild(row);
    });

    // Populate "Add filter" dropdown with remaining built-in + CF filters
    const add = document.getElementById('addFilter');
    add.innerHTML = '<option value="">— Choose —</option>';
    // Built-in
    Object.keys(FILTER_DEFS).forEach(function(name) {
      if (_filter.active.indexOf(name) !== -1) return;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = FILTER_DEFS[name].label;
      add.appendChild(opt);
    });
    // Custom fields (grouped under a separator)
    const remainingCf = CF_FILTERS.filter(function(c) { return _filter.active.indexOf('cf:' + c.id) === -1; });
    if (remainingCf.length) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '── Custom fields ──';
      add.appendChild(sep);
      remainingCf.forEach(function(c) {
        const opt = document.createElement('option');
        opt.value = 'cf:' + c.id;
        opt.textContent = c.name + '  (' + c.trackerName + ')';
        add.appendChild(opt);
      });
    }
  }

  function stateKeyFor(name) {
    if (name === 'project')    return 'projectId';
    if (name === 'tracker')    return 'trackerId';
    if (name === 'status')     return 'statusId';
    if (name === 'priority')   return 'priorityId';
    if (name === 'assignedTo') return 'assignedToId';
    if (name === 'author')     return 'authorId';
    if (name === 'subject')    return 'subject';
    return name;
  }

  function readFilterValues() {
    if (!_filter.customFields) _filter.customFields = {};
    document.querySelectorAll('#filterRows .filter-row').forEach(function(row) {
      const name = row.dataset.field;
      const ctrl = row.querySelector('input, select');
      const val = ctrl ? ctrl.value : '';
      if (name.indexOf('cf:') === 0) {
        const cfId = name.slice(3);
        if (val) _filter.customFields[cfId] = val;
        else delete _filter.customFields[cfId];
      } else {
        _filter[stateKeyFor(name)] = val;
      }
    });
  }

  function onAddFilter(sel) {
    const name = sel.value;
    if (!name) return;
    _filter.active.push(name);
    if (name === 'assignedTo' || name === 'author') {
      if (_filter.projectId) vscode.postMessage({ command: 'fetchMembers', projectId: _filter.projectId });
    }
    renderFilters();
  }

  function removeFilter(name) {
    _filter.active = _filter.active.filter(function(n) { return n !== name; });
    if (name.indexOf('cf:') === 0) {
      const cfId = name.slice(3);
      if (_filter.customFields) delete _filter.customFields[cfId];
    } else {
      delete _filter[stateKeyFor(name)];
    }
    renderFilters();
  }

  function onProjectChange(ev) {
    _filter.projectId = ev.target.value;
    if (_filter.projectId) vscode.postMessage({ command: 'fetchMembers', projectId: _filter.projectId });
    else { _members = []; renderFilters(); }
  }

  // ── Actions ────────────────────────────────────────────────────────────
  function applyFilter() {
    readFilterValues();
    _filter.page = 1;
    fetchIssues();
  }

  function clearFilters() {
    _filter = { active: [], pageSize: _filter.pageSize, page: 1, sort: _filter.sort, customFields: {} };
    renderFilters();
    fetchIssues();
  }

  function applyToGlobal() {
    readFilterValues();
    vscode.postMessage({ command: 'applyToGlobal', filter: _filter });
  }

  function resetToDefaults() {
    vscode.postMessage({ command: 'resetFilter' });
  }

  function fetchIssues() {
    document.getElementById('tbody').innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
    vscode.postMessage({ command: 'applyFilter', filter: _filter });
  }

  function showFb(type, msg) {
    const el = document.getElementById('fb');
    el.className = 'feedback ' + type;
    el.textContent = msg;
  }

  // ── Table render ───────────────────────────────────────────────────────
  function findCf(issue, names) {
    if (!issue.custom_fields) return '';
    const lower = names.map(function(n) { return n.toLowerCase(); });
    const f = issue.custom_fields.find(function(c) { return lower.indexOf((c.name || '').toLowerCase()) !== -1; });
    if (!f) return '';
    if (Array.isArray(f.value)) return f.value.join(', ');
    return f.value || '';
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Same escaping for attribute contexts — esc() already handles double-quote.
  const escAttr = esc;

  function renderTable(issues, total, page, pageSize) {
    const tbody = document.getElementById('tbody');
    if (!issues.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No issues match your filter.</td></tr>';
      renderPagination(0, page, pageSize);
      return;
    }
    tbody.innerHTML = issues.map(function(i) {
      const assignee = i.assigned_to ? i.assigned_to.name : '';
      const done = i.done_ratio || 0;
      const typeBug = findCf(i, ['Type Bug','Type bug','TypeBug']);
      const selCls = _selectedId === i.id ? ' class="selected"' : '';
      return ''
        + '<tr data-issue-id="' + i.id + '"' + selCls + '>'
        + '<td><a class="id-link" onclick="openIssue(' + i.id + ')">#' + i.id + '</a></td>'
        + '<td>' + esc(i.tracker.name) + '</td>'
        + '<td>' + esc(i.status.name) + '</td>'
        + '<td>' + esc(i.priority.name) + '</td>'
        + '<td><span class="subject-link" onclick="openIssue(' + i.id + ')">' + esc(i.subject) + '</span></td>'
        + '<td>' + esc(assignee) + '</td>'
        + '<td><span class="progress"><div style="width:' + done + '%"></div></span>' + done + '%</td>'
        + '<td>' + esc(typeBug) + '</td>'
        + '</tr>';
    }).join('');
    renderPagination(total, page, pageSize);
    renderSortInd();
  }

  function renderSortInd() {
    document.querySelectorAll('.sort-ind').forEach(function(el) { el.textContent = ''; });
    if (!_filter.sort) return;
    const parts = _filter.sort.split(':');
    const el = document.getElementById('ind-' + parts[0]);
    if (el) el.textContent = parts[1] === 'desc' ? ' ↓' : ' ↑';
  }

  function renderPagination(total, page, pageSize) {
    const el = document.getElementById('pagination');
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    let html = '<span class="info">Showing ' + start + '–' + end + ' of ' + total + '</span>';
    html += '<button class="btn btn-sec btn-sm" ' + (page <= 1 ? 'disabled' : '') + ' onclick="goToPage(' + (page - 1) + ')">‹ Prev</button>';
    // Show up to 7 page numbers around current
    const startP = Math.max(1, page - 3);
    const endP = Math.min(totalPages, startP + 6);
    for (let p = startP; p <= endP; p++) {
      html += '<button class="btn btn-sec btn-sm ' + (p === page ? 'current' : '') + '" onclick="goToPage(' + p + ')">' + p + '</button>';
    }
    html += '<button class="btn btn-sec btn-sm" ' + (page >= totalPages ? 'disabled' : '') + ' onclick="goToPage(' + (page + 1) + ')">Next ›</button>';
    el.innerHTML = html;
  }

  function goToPage(p) {
    _filter.page = p;
    fetchIssues();
  }

  // Click an issue row → load detail into the right-side panel
  let _selectedId = null;
  function openIssue(id) {
    _selectedId = id;
    // Highlight selected row
    document.querySelectorAll('tr.selected').forEach(function(tr) { tr.classList.remove('selected'); });
    const tr = document.querySelector('tr[data-issue-id="' + id + '"]');
    if (tr) tr.classList.add('selected');

    const pane = document.getElementById('detailPane');
    pane.classList.add('open');
    document.getElementById('detailContent').innerHTML = '<div class="detail-empty">Loading…</div>';
    vscode.postMessage({ command: 'fetchIssueDetail', issueId: id });
  }

  function openIssueInTab(id) {
    vscode.postMessage({ command: 'openIssue', issueId: id });
  }

  function closeDetail() {
    document.getElementById('detailPane').classList.remove('open');
    document.getElementById('detailToolbar').style.display = 'none';
    document.getElementById('detailContent').innerHTML = '';
    document.querySelectorAll('tr.selected').forEach(function(tr) { tr.classList.remove('selected'); });
    _selectedId = null;
  }

  let _currentDetailIssue = null;

  function renderDetail(issue) {
    const el = document.getElementById('detailContent');
    const toolbar = document.getElementById('detailToolbar');
    if (!issue) { el.innerHTML = '<div class="detail-empty">Issue not available.</div>'; return; }
    _currentDetailIssue = issue;
    const author = issue.author ? issue.author.name : '—';
    const created = formatDate(issue.created_on);
    const updated = formatDate(issue.updated_on);
    const start  = issue.start_date ? formatDate(issue.start_date) : '—';
    const due    = issue.due_date ? formatDate(issue.due_date) : '—';
    const attachments = issue.attachments || [];

    toolbar.style.display = '';
    document.getElementById('detailOpenBtn').onclick = function() { openIssueInTab(issue.id); };
    document.getElementById('detailPushAiBtn').onclick = function() {
      vscode.postMessage({ command: 'pushToAI', issueId: issue.id });
    };

    let html = '';
    html += '<div class="detail-head">';
    html +=   '<div class="meta">';
    html +=     '<span class="id">#' + issue.id + '</span>'
              + ' · ' + esc(issue.project.name)
              + ' · created ' + esc(created)
              + ' by ' + esc(author);
    html +=   '</div>';
    html +=   '<h2>' + esc(issue.subject) + '</h2>';
    html += '</div>';

    // Status select styled as a chip
    const statusOpts = STATUSES.map(function(s) {
      return '<option value="' + s.id + '"' + (String(issue.status.id) === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    html += '<div class="detail-status-row">';
    html +=   '<select class="detail-select" id="detailStatusSel" data-field="status" onchange="updateDetailField(this.dataset.field, this.value)">' + statusOpts + '</select>';
    html +=   '<span class="detail-chip">' + esc(issue.priority.name) + '</span>';
    html +=   '<span class="detail-chip">' + esc(issue.tracker.name) + '</span>';
    if (typeof issue.done_ratio === 'number') html += '<span class="detail-chip">' + issue.done_ratio + '%</span>';
    html += '</div>';

    // Assignee select (populated after member fetch)
    const currentAssigneeId = issue.assigned_to ? String(issue.assigned_to.id) : '0';
    const currentAssigneeName = issue.assigned_to ? issue.assigned_to.name : '— Unassigned —';
    html += '<div class="detail-kv">';
    html +=   '<div class="k">Assignee</div>';
    html +=   '<div><select class="detail-inline-select" id="detailAssigneeSel" data-field="assignee" onchange="updateDetailField(this.dataset.field, this.value)">'
            +   '<option value="0"' + (currentAssigneeId === '0' ? ' selected' : '') + '>— Unassigned —</option>'
            +   (currentAssigneeId !== '0' ? '<option value="' + currentAssigneeId + '" selected>' + esc(currentAssigneeName) + '</option>' : '')
            + '</select></div>';
    html +=   '<div class="k">Updated</div><div>' + esc(updated) + '</div>';
    html +=   '<div class="k">Start date</div><div>' + esc(start) + '</div>';
    html +=   '<div class="k">Due date</div><div>' + esc(due) + '</div>';
    html += '</div>';

    // Fetch members for this project so assignee dropdown gets fully populated
    vscode.postMessage({ command: 'fetchDetailMembers', projectId: issue.project.id });

    if (issue.custom_fields && issue.custom_fields.length) {
      html += '<div class="detail-section-title">Custom Fields</div>';
      html += '<div class="detail-cf-list">';
      issue.custom_fields.forEach(function(cf) {
        const val = Array.isArray(cf.value) ? cf.value.join(', ') : (cf.value || '');
        if (!val) return;
        html += '<div class="row"><span class="k">' + esc(cf.name) + '</span><span>' + esc(val) + '</span></div>';
      });
      html += '</div>';
    }

    html += '<div class="detail-section-title">Description</div>';
    if (issue.description && issue.description.trim()) {
      html += '<div class="detail-desc">' + renderRichText(issue.description, attachments) + '</div>';
    } else {
      html += '<div class="detail-empty">(no description)</div>';
    }

    if (issue.journals && issue.journals.length) {
      const withNotes = issue.journals.filter(function(j) { return j.notes && j.notes.trim(); });
      if (withNotes.length) {
        html += '<div class="detail-section-title">Comments (' + withNotes.length + ')</div>';
        html += '<div class="detail-journals">';
        withNotes.slice(-5).reverse().forEach(function(j) {
          html += '<div class="detail-journal">'
            +   '<div class="head">' + esc(j.user ? j.user.name : '—') + ' · ' + esc(formatDate(j.created_on)) + '</div>'
            +   '<div class="notes">' + renderRichText(j.notes, attachments) + '</div>'
            + '</div>';
        });
        html += '</div>';
      }
    }

    if (attachments.length) {
      const standalone = attachments.filter(function(a) { return (a.content_type || '').indexOf('image/') === 0; });
      if (standalone.length) {
        html += '<div class="detail-section-title">Attachments</div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        standalone.forEach(function(a) {
          html += '<img class="inline-img" data-att-id="' + a.id + '" data-att-url="' + escAttr(a.content_url) + '" alt="' + escAttr(a.filename) + '" style="max-width:100%;border:1px solid var(--vscode-widget-border,#333)">';
        });
        html += '</div>';
      }
    }

    el.innerHTML = html;
    // Kick off image loading for every inline image (description, comments, attachments)
    loadInlineImages();
  }

  /**
   * Convert raw Redmine text (textile / markdown / plain) into HTML with the
   * minimal subset we care about: image references resolved to <img>, the rest
   * is HTML-escaped and rendered with preserved whitespace via CSS.
   *
   * Strategy: replace image refs with an ASCII sentinel *before* HTML-escaping,
   * escape the rest, then swap sentinels with <img> tags. This avoids fighting
   * regex/escape semantics on the user's text.
   */
  function renderRichText(text, attachments) {
    if (!text) return '';
    const images = (attachments || []).filter(function(a) {
      return (a.content_type || '').indexOf('image/') === 0;
    });
    let raw = String(text);
    images.forEach(function(att) {
      const fn = att.filename;
      if (!fn) return;
      const sentinel = '__REDMINE_IMG_' + att.id + '__';
      // Textile: !filename!
      raw = raw.split('!' + fn + '!').join(sentinel);
      // Markdown: ![alt](filename) — keep it simple with a manual scan
      let mark = '](' + fn + ')';
      let idx;
      while ((idx = raw.indexOf(mark)) !== -1) {
        const altStart = raw.lastIndexOf('![', idx);
        if (altStart === -1 || altStart > idx) break;
        raw = raw.slice(0, altStart) + sentinel + raw.slice(idx + mark.length);
      }
    });
    let html = esc(raw);
    images.forEach(function(att) {
      const sentinel = '__REDMINE_IMG_' + att.id + '__';
      const tag = '<img class="inline-img" data-att-id="' + att.id + '" data-att-url="' + escAttr(att.content_url) + '" alt="' + escAttr(att.filename || '') + '">';
      html = html.split(sentinel).join(tag);
    });
    return html;
  }

  function loadInlineImages() {
    document.querySelectorAll('.inline-img[data-att-url]').forEach(function(img) {
      const id = img.dataset.attId;
      const url = img.dataset.attUrl;
      img.classList.add('loading');
      img.onclick = null; // until loaded
      vscode.postMessage({ command: 'loadImage', attachmentId: Number(id), url: url });
    });
  }

  function updateDetailField(field, value) {
    if (!_currentDetailIssue) return;
    const msg = { command: 'updateDetailIssue', issueId: _currentDetailIssue.id };
    if (field === 'status')   msg.statusId     = parseInt(value, 10);
    if (field === 'assignee') msg.assignedToId = parseInt(value, 10);
    // Disable the changed select while saving
    const selId = field === 'status' ? 'detailStatusSel' : 'detailAssigneeSel';
    const sel = document.getElementById(selId);
    if (sel) sel.disabled = true;
    vscode.postMessage(msg);
  }

  function openLightbox(src) {
    const el = document.getElementById('lightbox');
    const im = document.getElementById('lightboxImg');
    im.src = src;
    el.classList.add('open');
  }

  function closeLightbox() {
    const el = document.getElementById('lightbox');
    const im = document.getElementById('lightboxImg');
    el.classList.remove('open');
    im.src = '';
  }

  // Esc key closes lightbox or detail panel
  document.addEventListener('keydown', function(ev) {
    if (ev.key !== 'Escape') return;
    const lb = document.getElementById('lightbox');
    if (lb.classList.contains('open')) { closeLightbox(); return; }
    const dp = document.getElementById('detailPane');
    if (dp.classList.contains('open')) closeDetail();
  });

  function formatDate(s) {
    if (!s) return '';
    // Redmine returns ISO 8601; show local short
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return s;
      const pad = function(n) { return n < 10 ? '0' + n : n; };
      return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return s; }
  }

  // ── Sort by column header ──────────────────────────────────────────────
  document.querySelectorAll('th[data-sort]').forEach(function(th) {
    th.onclick = function() {
      const field = th.dataset.sort;
      const cur = _filter.sort || '';
      let next = field + ':desc';
      if (cur === field + ':desc') next = field + ':asc';
      else if (cur === field + ':asc') next = '';
      _filter.sort = next;
      _filter.page = 1;
      fetchIssues();
    };
  });

  // ── Messages from extension ────────────────────────────────────────────
  window.addEventListener('message', function(ev) {
    const msg = ev.data;
    if (msg.command === 'issuesResult') {
      renderTable(msg.issues, msg.total, msg.page, msg.pageSize);
    }
    if (msg.command === 'issuesError') {
      document.getElementById('tbody').innerHTML = '<tr class="empty-row"><td colspan="8">Failed to load: ' + esc(msg.message) + '</td></tr>';
    }
    if (msg.command === 'membersResult') {
      _members = msg.members || [];
      renderFilters();
    }
    if (msg.command === 'issueDetailResult') {
      renderDetail(msg.issue);
    }
    if (msg.command === 'issueDetailError') {
      document.getElementById('detailContent').innerHTML = '<div class="detail-empty">Failed to load issue: ' + esc(msg.message) + '</div>';
    }
    if (msg.command === 'imageLoaded') {
      document.querySelectorAll('img.inline-img[data-att-id="' + msg.attachmentId + '"]').forEach(function(img) {
        img.src = msg.dataUrl;
        img.classList.remove('loading');
        const url = msg.dataUrl;
        img.onclick = function() { openLightbox(url); };
      });
    }
    if (msg.command === 'imageError') {
      document.querySelectorAll('img.inline-img[data-att-id="' + msg.attachmentId + '"]').forEach(function(img) {
        img.classList.remove('loading');
        img.alt = '⚠ Could not load image';
        img.style.opacity = '.4';
      });
    }
    if (msg.command === 'detailMembersResult') {
      const sel = document.getElementById('detailAssigneeSel');
      if (!sel || !_currentDetailIssue) return;
      const currentId = _currentDetailIssue.assigned_to ? String(_currentDetailIssue.assigned_to.id) : '0';
      sel.innerHTML = '<option value="0"' + (currentId === '0' ? ' selected' : '') + '>— Unassigned —</option>'
        + (msg.members || []).map(function(m) {
            return '<option value="' + m.id + '"' + (m.id === currentId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
          }).join('');
    }
    if (msg.command === 'issueDetailUpdateError') {
      // Re-enable any disabled selects
      ['detailStatusSel', 'detailAssigneeSel'].forEach(function(id) {
        const sel = document.getElementById(id);
        if (sel) sel.disabled = false;
      });
    }
    if (msg.command === 'filterReset') {
      _filter = Object.assign({
        pageSize: _filter.pageSize || 25,
        page: 1,
        sort: 'id:desc',
        customFields: {},
      }, msg.filter || {});
      if (!_filter.customFields) _filter.customFields = {};
      renderFilters();
      fetchIssues();
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────
  renderFilters();
  // If we restored a project on init, kick off member fetch so the assignee
  // dropdown can be populated when the user opens that filter.
  if (_filter.projectId) vscode.postMessage({ command: 'fetchMembers', projectId: _filter.projectId });
  fetchIssues();
</script>
</body>
</html>`;
}
