import * as vscode from "vscode";
import {
  listProjects,
  listTrackers,
  listStatuses,
  listPriorities,
  listProjectMembers,
  uploadAttachment,
  createIssue,
  Project,
  Tracker,
  IssueStatus,
  Priority,
} from "./redmine-client";
import type { CustomFieldConfigEntry } from "./settings-webview";

export interface BulkCreateConfig {
  /** How many issues will be created when the form is submitted. */
  count: number;
  /**
   * Called when the user submits the form in bulk mode.
   * Return `true` to indicate the bulk creation ran (so the form can close),
   * or `false` to keep the form open (e.g. user cancelled the confirm modal).
   */
  onBulkSubmit: (formValues: BulkFormValues) => Promise<boolean>;
}

export interface BulkFormValues {
  projectId: string;
  projectName: string;
  trackerId: number;
  trackerName: string;
  statusId: number;
  statusName: string;
  priorityId: number;
  priorityName: string;
  assignedToId: number;
  assigneeName: string;
  dueDate: string;
  startDate: string;
  /**
   * CF values the user picked in the form — used as a fallback for any
   * template-driven CF that interpolates to empty for a given test case.
   * Solves the "required CF without per-TC data" case (e.g. Type Bug).
   */
  customFieldsFallback: { id: number; name: string; value: string }[];
  // Note: subject/description are NOT here — they're recomputed per test case
  // from the template by the bulk caller.
}

export class CreateIssueWebview {
  private panel: vscode.WebviewPanel | null = null;
  private onCreated: ((issueId: number, subject: string) => void) | null = null;
  private bulk: BulkCreateConfig | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  private allowedCfNames: string[] | null = null;
  private openedFromTemplate = false;

  async show(
    prefill?: {
      subject: string;
      description: string;
      trackerName?: string;
      statusName?: string;
      customFieldValues?: Record<string, string>;
      customFieldNames?: string[];
      preAttachments?: { data: string; filename: string; contentType: string }[];
    },
    onCreated?: (issueId: number, subject: string) => void,
    bulk?: BulkCreateConfig,
  ) {
    const standalone = !prefill;
    if (this.panel) {
      // Reveal only when the existing panel matches the request (both standalone).
      // Otherwise the cached panel still holds the previous template's prefill /
      // CF restriction — dispose and rebuild fresh.
      if (standalone && !this.openedFromTemplate && !bulk) {
        this.panel.reveal();
        return;
      }
      this.panel.dispose();
      this.panel = null;
    }
    this.onCreated = onCreated ?? null;
    this.openedFromTemplate = !standalone;
    this.bulk = bulk ?? null;

    // When opened from a template, restrict the custom field UI to the names the
    // template explicitly selected. Standalone "+ New Issue" passes nothing → show all.
    this.allowedCfNames = prefill?.customFieldNames ?? null;

    const cfg = vscode.workspace.getConfiguration("redmine");
    const defaultProjectId  = cfg.get<string>("defaultProject")  ?? "";
    const defaultTrackerId  = cfg.get<string>("defaultTrackerId") ?? "";

    let projects:      Project[]     = [];
    let trackers:      Tracker[]     = [];
    let statuses:      IssueStatus[] = [];
    let priorities: Priority[]                      = [];
    let members:    { id: string; name: string }[]  = [];

    try {
      [projects, trackers, statuses, priorities] = await Promise.all([
        listProjects().catch(() => []),
        listTrackers().catch(() => []),
        listStatuses().catch(() => []),
        listPriorities().catch(() => []),
      ]);
      if (defaultProjectId) {
        members = await listProjectMembers(defaultProjectId)
          .then((ms) => ms.map((m) => ({ id: String(m.id), name: m.name })))
          .catch(() => []);
      }
    } catch { /* continue with empty lists */ }

    this.panel = vscode.window.createWebviewPanel(
      "redmineCreateIssue",
      "Create Issue",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = null; this.onCreated = null; this.bulk = null; });

    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "redmine.png")
    );

    this.panel.webview.html = buildHtml(
      { defaultProjectId, defaultTrackerId },
      projects, trackers, statuses, priorities, members,
      logoUri.toString(),
      prefill,
      this.bulk ? { count: this.bulk.count } : undefined,
    );

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "fetchMembers") {
        const projId = (msg.projectId as string).trim();
        const ms = projId
          ? await listProjectMembers(projId)
              .then((m) => m.map((x) => ({ id: String(x.id), name: x.name })))
              .catch(() => [])
          : [];
        this.panel?.webview.postMessage({ command: "membersResult", members: ms });
      }

      if (msg.command === "fetchFields") {
        const trackerId = Number(msg.trackerId ?? 0);
        const customFieldConfig = this.context.globalState.get<CustomFieldConfigEntry[]>("customFieldConfig") ?? [];
        const trackerCfg = customFieldConfig.find((c) => c.trackerId === trackerId);

        if (!trackerCfg || trackerCfg.fields.length === 0) {
          this.panel?.webview.postMessage({ command: "fieldsResult", fields: [], status: "none" });
        } else {
          // Restrict to template-selected CFs when invoked from a template
          const allowed = this.allowedCfNames;
          const fields = allowed
            ? trackerCfg.fields.filter((f) => allowed.includes(f.name))
            : trackerCfg.fields;
          this.panel?.webview.postMessage({ command: "fieldsResult", fields, status: fields.length === 0 ? "none" : "ok" });
        }
      }

      // Bulk mode: caller (TestCaseWebview) owns the create loop. We forward
      // the user's common-field choices and let them iterate over the TCs.
      if (msg.command === "createBulk") {
        if (!this.bulk) return;
        const rawCf: unknown[] = Array.isArray(msg.customFieldsFallback) ? msg.customFieldsFallback : [];
        const customFieldsFallback: { id: number; name: string; value: string }[] = [];
        for (const item of rawCf) {
          if (typeof item !== "object" || item === null) continue;
          const obj = item as Record<string, unknown>;
          if (!("id" in obj)) continue;
          customFieldsFallback.push({
            id:    Number(obj.id),
            name:  String(obj.name ?? ""),
            value: String(obj.value ?? ""),
          });
        }
        const formValues: BulkFormValues = {
          projectId:    String(msg.projectId ?? ""),
          projectName:  String(msg.projectName ?? ""),
          trackerId:    Number(msg.trackerId ?? 0),
          trackerName:  String(msg.trackerName ?? ""),
          statusId:     Number(msg.statusId ?? 0),
          statusName:   String(msg.statusName ?? ""),
          priorityId:   Number(msg.priorityId ?? 0),
          priorityName: String(msg.priorityName ?? ""),
          assignedToId: Number(msg.assignedToId ?? 0),
          assigneeName: String(msg.assigneeName ?? ""),
          dueDate:      String(msg.dueDate ?? ""),
          startDate:    String(msg.startDate ?? ""),
          customFieldsFallback,
        };
        // Keep the form visible while the caller shows its confirm modal — if
        // the user cancels we want them back in the form, not on the test-case
        // page. Only dispose once onBulkSubmit reports it actually ran.
        try {
          const ran = await this.bulk.onBulkSubmit(formValues);
          if (ran) this.panel?.dispose();
        } catch (err) {
          vscode.window.showErrorMessage(`Bulk create failed: ${String(err)}`);
        }
        return;
      }

      if (msg.command === "create") {
        try {
          // Upload attachments first
          const files = Array.isArray(msg.files)
            ? (msg.files as { data: string; filename: string; contentType: string }[])
            : [];

          const uploads = await Promise.all(
            files.map(async (f) => ({
              token:        await uploadAttachment(f.data, f.filename, f.contentType),
              filename:     f.filename,
              content_type: f.contentType,
            }))
          );

          const issue = await createIssue({
            projectId:    msg.projectId as string,
            subject:      (msg.subject as string).trim(),
            description:  (msg.description as string)?.trim() || undefined,
            trackerId:    msg.trackerId    ? Number(msg.trackerId)    : undefined,
            statusId:     msg.statusId     ? Number(msg.statusId)     : undefined,
            priorityId:   msg.priorityId   ? Number(msg.priorityId)   : undefined,
            assignedToId: msg.assignedToId ? Number(msg.assignedToId) : undefined,
            dueDate:      (msg.dueDate as string) || undefined,
            uploads:      uploads.length ? uploads : undefined,
            customFields: Array.isArray(msg.customFields) && msg.customFields.length
              ? msg.customFields as { id: number; value: string }[]
              : undefined,
          });

          this.panel?.webview.postMessage({ command: "created", issueId: issue.id, subject: issue.subject });
          vscode.commands.executeCommand("redmine.refresh");
          this.onCreated?.(issue.id, issue.subject);
        } catch (err) {
          this.panel?.webview.postMessage({
            command: "createError",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (msg.command === "openIssue") {
        vscode.commands.executeCommand("redmine.openIssue", { issue: { id: msg.issueId as number } });
      }
    });
  }
}

function e(s: string) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(
  init:       { defaultProjectId: string; defaultTrackerId: string },
  projects:   Project[],
  trackers:   Tracker[],
  statuses:   IssueStatus[],
  priorities: Priority[],
  members:    { id: string; name: string }[],
  logoSrc:    string,
  prefill?:   {
    subject: string;
    description: string;
    trackerName?: string;
    statusName?: string;
    customFieldValues?: Record<string, string>;
    preAttachments?: { data: string; filename: string; contentType: string }[];
  },
  bulk?: { count: number },
): string {
  const defaultPriority = priorities.find((p) => p.is_default);
  const openStatuses    = statuses.filter((s) => !s.is_closed);

  const resolvedTrackerId = prefill?.trackerName
    ? String(trackers.find((t) => t.name.toLowerCase() === prefill.trackerName!.toLowerCase())?.id ?? init.defaultTrackerId)
    : init.defaultTrackerId;

  const resolvedStatusId = prefill?.statusName
    ? String(openStatuses.find((s) => s.name.toLowerCase() === prefill.statusName!.toLowerCase())?.id ?? "")
    : "";


  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Create Issue</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }

  .page-header {
    display: flex; align-items: center; gap: 12px;
    padding: 16px 28px 13px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    position: sticky; top: 0; z-index: 10;
    background: var(--vscode-editor-background);
  }
  .page-header img { width: 28px; height: 28px; object-fit: contain; }
  .page-header .title { font-size: 1.08em; font-weight: 700; }
  .page-header .sub   { font-size: .77em; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  .body { padding: 20px 28px 48px; max-width: 780px; }

  /* Section headers */
  .sec-title {
    font-size: .68em; text-transform: uppercase; letter-spacing: .08em;
    color: var(--vscode-descriptionForeground); font-weight: 700;
    margin: 22px 0 12px; padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
  }
  .sec-title:first-of-type { margin-top: 0; }

  /* Fields */
  .field { margin-bottom: 14px; }
  .row2  { display: grid; grid-template-columns: 1fr 1fr;     gap: 14px; margin-bottom: 14px; }
  .row3  { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  label.fl { display: block; margin-bottom: 5px; font-weight: 600; font-size: .84em; }
  .req { color: var(--vscode-errorForeground); margin-left: 1px; }
  .hint { font-size: .75em; color: var(--vscode-descriptionForeground); margin-top: 4px; }

  input[type="text"], input[type="date"], select, textarea {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 5px;
    padding: 7px 10px;
    font-family: inherit; font-size: inherit; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  textarea { min-height: 180px; resize: vertical; line-height: 1.6; }
  select option { background: var(--vscode-dropdown-background, #1e1e1e); }

  /* Attachment drop zone */
  .drop-zone {
    border: 2px dashed var(--vscode-widget-border, #555);
    border-radius: 8px; padding: 18px 20px;
    text-align: center; cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .drop-zone:hover, .drop-zone.drag-over {
    border-color: var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 6%, transparent);
  }
  .drop-zone-label { font-size: .84em; color: var(--vscode-descriptionForeground); pointer-events: none; }
  .drop-zone-label strong { color: var(--vscode-textLink-foreground); }

  /* File previews */
  .preview-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .preview-item {
    position: relative; border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 7px; overflow: hidden;
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  .preview-item img,
  .preview-item video {
    width: 120px; height: 90px; object-fit: cover; display: block;
  }
  .preview-item .file-thumb {
    width: 120px; height: 90px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 4px;
    font-size: .72em; color: var(--vscode-descriptionForeground);
    padding: 6px; word-break: break-all; text-align: center;
  }
  .preview-item .file-thumb .icon { font-size: 1.8em; }
  .preview-remove {
    position: absolute; top: 3px; right: 3px;
    width: 20px; height: 20px; border-radius: 50%;
    background: var(--vscode-errorForeground); color: #fff;
    border: none; cursor: pointer; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }
  .preview-name {
    font-size: .7em; color: var(--vscode-descriptionForeground);
    padding: 3px 6px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; max-width: 120px;
    background: var(--vscode-editor-inactiveSelectionBackground);
  }

  /* Buttons */
  .btn-row { display: flex; gap: 9px; margin-top: 22px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 8px 20px; border: none; border-radius: 5px; cursor: pointer;
    font-family: inherit; font-size: .88em; font-weight: 600;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    transition: opacity .12s;
  }
  .btn:hover { opacity: .85; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-sec {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }

  /* Feedback */
  .fb { display: none; margin-top: 14px; padding: 11px 15px; border-radius: 5px; font-size: .87em; line-height: 1.5; }
  .fb.error   { display: block; background: color-mix(in srgb,var(--vscode-errorForeground) 10%,transparent); border-left: 3px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .fb.info    { display: block; background: color-mix(in srgb,var(--vscode-charts-blue) 8%,transparent); border-left: 3px solid var(--vscode-charts-blue); }

  /* Success card */
  .success-card { display: none; margin-top: 20px; border: 1px solid var(--vscode-testing-iconPassed); border-radius: 8px; overflow: hidden; }
  .success-card.show { display: block; }
  .success-header {
    padding: 12px 18px;
    background: color-mix(in srgb,var(--vscode-testing-iconPassed) 10%,transparent);
    display: flex; align-items: center; gap: 10px;
  }
  .success-icon { font-size: 1.4em; }
  .success-title { font-weight: 700; font-size: .95em; color: var(--vscode-testing-iconPassed); }
  .success-sub   { font-size: .8em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .success-actions { padding: 12px 18px; display: flex; gap: 8px; }

  @media (max-width: 520px) {
    .row2, .row3 { grid-template-columns: 1fr; }
    .body { padding: 14px 16px 32px; }
  }
</style>
</head>
<body>

<div class="page-header">
  <img src="${e(logoSrc)}" alt="Redmine">
  <div>
    <div class="title">${bulk && bulk.count > 0 ? `Create ${bulk.count} Issues (Bulk)` : "Create New Issue"}</div>
    <div class="sub">${bulk && bulk.count > 0
      ? `Configure the shared fields below — <strong>Subject</strong>, <strong>Description</strong>, and <strong>Custom Fields</strong> are filled per test case from the template.`
      : `Fill in the details below — fields marked <span style="color:var(--vscode-errorForeground)">*</span> are required`}</div>
  </div>
</div>

<div class="body">
${bulk && bulk.count > 0 ? `
<div style="margin-bottom:14px;padding:10px 14px;border-radius:6px;background:color-mix(in srgb,var(--vscode-charts-blue) 12%,transparent);border-left:3px solid var(--vscode-charts-blue);font-size:.85em">
  <strong>Bulk mode:</strong> ${bulk.count} issue${bulk.count > 1 ? "s" : ""} will be created from the selected test cases. The Subject / Description / Custom Field inputs below show a <em>preview</em> using the first TC, but each issue gets its own values from the template.
</div>` : ""}

  <!-- ── Basic ── -->
  <div class="sec-title">Basic Information</div>

  <div class="row2">
    <div class="field">
      <label class="fl" for="project">Project <span class="req">*</span></label>
      <select id="project" onchange="onProjectChange()">
        <option value="">— Select project —</option>
        ${projects.map((p) =>
          `<option value="${e(p.identifier)}" ${p.identifier === init.defaultProjectId ? "selected" : ""}>${e(p.name)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="field">
      <label class="fl" for="tracker">Tracker <span class="req">*</span></label>
      <select id="tracker" onchange="onTrackerChange()">
        <option value="">— Select tracker —</option>
        ${trackers.map((t) =>
          `<option value="${t.id}" ${String(t.id) === resolvedTrackerId ? "selected" : ""}>${e(t.name)}</option>`
        ).join("")}
      </select>
    </div>
  </div>

  <div class="field">
    <label class="fl" for="subject">Subject <span class="req">*</span></label>
    <input type="text" id="subject" placeholder="Brief title describing the issue" maxlength="255" autofocus value="${e(prefill?.subject ?? "")}" >
  </div>

  <!-- ── Details ── -->
  <div class="sec-title">Details</div>

  <div class="row3">
    <div class="field">
      <label class="fl" for="status">Status</label>
      <select id="status">
        <option value="">— Default —</option>
        ${openStatuses.map((s) =>
          `<option value="${s.id}" ${String(s.id) === resolvedStatusId ? "selected" : ""}>${e(s.name)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="field">
      <label class="fl" for="priority">Priority</label>
      <select id="priority">
        <option value="">— Default —</option>
        ${priorities.map((p) =>
          `<option value="${p.id}" ${p.id === defaultPriority?.id ? "selected" : ""}>${e(p.name)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="field">
      <label class="fl" for="dueDate">Due Date</label>
      <input type="date" id="dueDate">
    </div>
  </div>

  <div class="field">
    <label class="fl" for="assignee">Assignee</label>
    <select id="assignee">
      <option value="">— Unassigned —</option>
      ${members.map((m) => `<option value="${e(m.id)}">${e(m.name)}</option>`).join("")}
    </select>
    ${!init.defaultProjectId ? `<div class="hint">Select a project above to load the member list.</div>` : ""}
  </div>

  <!-- ── Custom Fields ── -->
  <div id="customFieldsSection" style="display:none">
    <div class="sec-title">Additional Fields</div>
    <div id="customFieldsBody"></div>
  </div>

  <!-- ── Attachments ── -->
  <div class="sec-title">Attachments</div>

  <div class="drop-zone" id="dropZone"
    onclick="document.getElementById('fileInput').click()"
    ondragover="onDragOver(event)"
    ondragleave="onDragLeave(event)"
    ondrop="onDrop(event)">
    <input type="file" id="fileInput" accept="image/*,video/*,*/*" multiple
      style="display:none" onchange="handleFiles(this.files)">
    <div class="drop-zone-label">
      <strong>Click to attach files</strong> or drag &amp; drop here<br>
      <span style="font-size:.85em">Images, videos, and other files are supported</span>
    </div>
  </div>
  <div class="preview-grid" id="previewGrid"></div>

  <!-- ── Description ── -->
  <div class="sec-title">Description</div>

  <div class="field">
    <textarea id="description" placeholder="Describe the issue in detail…&#10;&#10;Steps to reproduce, expected vs actual behavior, environment info, etc.">${e(prefill?.description ?? "")}</textarea>
  </div>

  <div class="btn-row">
    <button class="btn" id="submitBtn" onclick="submit()">${bulk && bulk.count > 0 ? `✚ Create ${bulk.count} Issues` : "✚ Create Issue"}</button>
    <button class="btn btn-sec" onclick="resetForm()">↺ Reset</button>
  </div>

  <div class="fb" id="fb"></div>

  <div class="success-card" id="successCard">
    <div class="success-header">
      <span class="success-icon">✓</span>
      <div>
        <div class="success-title" id="successTitle"></div>
        <div class="success-sub"  id="successSub"></div>
      </div>
    </div>
    <div class="success-actions">
      <button class="btn" onclick="openIssue()">↗ Open Issue</button>
      <button class="btn btn-sec" onclick="createAnother()">✚ Create Another</button>
    </div>
  </div>

</div>

<script>
  const vscode = acquireVsCodeApi();
  const BULK_COUNT    = ${JSON.stringify(bulk?.count ?? 0)};
  const PREFILL_CF    = ${JSON.stringify(prefill?.customFieldValues ?? {})};
  const PREFILL_FILES = ${JSON.stringify(
    (prefill?.preAttachments ?? []).map((f, i) => ({
      id: i + 1,
      data: f.data,
      filename: f.filename,
      contentType: f.contentType,
      previewUrl: `data:${f.contentType};base64,${f.data}`,
    }))
  )};
  let pendingFiles = PREFILL_FILES.slice();
  let lastIssueId  = null;
  let customFieldsConfig = []; // populated from fieldsResult

  // ── Project change → load members ────────────────────────────────
  function onProjectChange() {
    const projId = document.getElementById('project').value;
    const sel    = document.getElementById('assignee');
    sel.innerHTML = '<option value="">— Loading… —</option>';
    if (!projId) { sel.innerHTML = '<option value="">— Unassigned —</option>'; onTrackerChange(); return; }
    vscode.postMessage({ command: 'fetchMembers', projectId: projId });
    onTrackerChange();
  }

  // ── Tracker change → fetch custom fields for this tracker ────────
  function onTrackerChange() {
    const sel       = document.getElementById('tracker');
    const trackerId = sel.value;
    if (trackerId) {
      vscode.postMessage({ command: 'fetchFields', trackerId });
    } else {
      renderCustomFields(false);
    }
  }

  // ── Render dynamic custom fields ──────────────────────────────────
  function renderCustomFields(show) {
    const section = document.getElementById('customFieldsSection');
    const body    = document.getElementById('customFieldsBody');
    if (!show || customFieldsConfig.length === 0) {
      section.style.display = 'none';
      body.innerHTML = '';
      return;
    }
    section.style.display = '';
    body.innerHTML = '<div class="row3">' + customFieldsConfig.map(function(f) {
      const prefillVal = PREFILL_CF[f.name] || '';
      if (f.type === 'select') {
        const opts = ['<option value="">— Select —</option>']
          .concat((f.options || []).map(function(o) {
            const selected = prefillVal === o ? ' selected' : '';
            return '<option value="' + escHtml(o) + '"' + selected + '>' + escHtml(o) + '</option>';
          })).join('');
        return '<div class="field"><label class="fl">' + escHtml(f.name) + '</label>'
          + '<select data-cf-id="' + f.id + '" data-cf-name="' + escHtml(f.name) + '">' + opts + '</select></div>';
      } else {
        return '<div class="field"><label class="fl">' + escHtml(f.name) + '</label>'
          + '<input type="text" data-cf-id="' + f.id + '" data-cf-name="' + escHtml(f.name) + '" value="' + escHtml(prefillVal) + '"></div>';
      }
    }).join('') + '</div>';
  }

  // ── Collect custom field values ───────────────────────────────────
  function collectCustomFields() {
    const result = [];
    document.querySelectorAll('[data-cf-id]').forEach(function(el) {
      const id = Number(el.getAttribute('data-cf-id'));
      if (!id) return;
      const name = el.getAttribute('data-cf-name') || '';
      result.push({ id, name, value: el.value });
    });
    return result;
  }

  // Init: show pre-loaded evidence attachments and trigger tracker check
  if (pendingFiles.length) renderPreviews();
  onTrackerChange();

  // ── File handling ─────────────────────────────────────────────────
  function handleFiles(fileList) {
    Array.from(fileList).forEach(addFile);
    document.getElementById('fileInput').value = '';
  }

  function addFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const id = Date.now() + Math.random();
      pendingFiles.push({ id, data: dataUrl.split(',')[1], filename: file.name, contentType: file.type || 'application/octet-stream', previewUrl: dataUrl });
      renderPreviews();
    };
    reader.readAsDataURL(file);
  }

  function renderPreviews() {
    const grid = document.getElementById('previewGrid');
    grid.innerHTML = '';
    pendingFiles.forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'preview-item';

      if (f.contentType.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = f.previewUrl; img.title = f.filename;
        wrap.appendChild(img);
      } else if (f.contentType.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = f.previewUrl; vid.muted = true; vid.playsInline = true;
        vid.addEventListener('mouseenter', () => vid.play().catch(() => {}));
        vid.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });
        wrap.appendChild(vid);
      } else {
        const thumb = document.createElement('div');
        thumb.className = 'file-thumb';
        thumb.innerHTML = '<span class="icon">📎</span>' + escHtml(f.filename);
        wrap.appendChild(thumb);
      }

      const name = document.createElement('div');
      name.className = 'preview-name'; name.title = f.filename;
      name.textContent = f.filename;
      wrap.appendChild(name);

      const rm = document.createElement('button');
      rm.className = 'preview-remove'; rm.textContent = '×'; rm.title = 'Remove';
      rm.onclick = (ev) => { ev.stopPropagation(); pendingFiles = pendingFiles.filter(x => x.id !== f.id); renderPreviews(); };
      wrap.appendChild(rm);

      grid.appendChild(wrap);
    });
  }

  // ── Drag & drop ──────────────────────────────────────────────────
  function onDragOver(ev)  { ev.preventDefault(); document.getElementById('dropZone').classList.add('drag-over'); }
  function onDragLeave(ev) { document.getElementById('dropZone').classList.remove('drag-over'); }
  function onDrop(ev)      { ev.preventDefault(); onDragLeave(ev); handleFiles(ev.dataTransfer.files); }

  // ── Submit ───────────────────────────────────────────────────────
  function submit() {
    const projectId   = document.getElementById('project').value;
    const trackerId   = document.getElementById('tracker').value;
    const subject     = document.getElementById('subject').value.trim();
    const description = document.getElementById('description').value.trim();
    const statusId    = document.getElementById('status').value;
    const priorityId  = document.getElementById('priority').value;
    const assignedToId = document.getElementById('assignee').value;
    const dueDate     = document.getElementById('dueDate').value;

    if (!projectId) { showFb('error', 'Please select a project.'); return; }
    if (!trackerId) { showFb('error', 'Please select a tracker.'); return; }
    if (!subject)   { showFb('error', 'Subject is required.'); return; }


    hideFb();
    if (pendingFiles.length) {
      showFb('info', 'Uploading ' + pendingFiles.length + ' file(s)…');
    }

    const btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = BULK_COUNT > 0 ? 'Creating ' + BULK_COUNT + '…' : 'Creating…';

    const files        = pendingFiles.map(f => ({ data: f.data, filename: f.filename, contentType: f.contentType }));
    const customFields = collectCustomFields();

    if (BULK_COUNT > 0) {
      // Bulk mode: forward common form values + the CF values picked in the
      // form as a fallback for TCs whose template interpolation comes back
      // empty (covers required CFs without per-TC data, e.g. "Type Bug").
      // Also send the display NAMES of each selected option so the bulk
      // confirm modal can show "Bug" instead of "Tracker ID: 1".
      const selText = function(id) {
        const o = document.getElementById(id);
        if (!o) return '';
        const opt = o.options[o.selectedIndex];
        return opt ? (opt.text || '') : '';
      };
      const projectName  = selText('project');
      const trackerName  = selText('tracker');
      const statusName   = selText('status');
      const priorityName = selText('priority');
      const assigneeName = selText('assignee');
      const customFieldsFallback = collectCustomFields();
      vscode.postMessage({
        command: 'createBulk',
        projectId, projectName,
        trackerId, trackerName,
        statusId, statusName,
        priorityId, priorityName,
        assignedToId, assigneeName,
        dueDate,
        customFieldsFallback,
      });
    } else {
      vscode.postMessage({ command: 'create', projectId, trackerId, subject, description, statusId, priorityId, assignedToId, dueDate, files, customFields });
    }
  }

  function resetForm() {
    if (!confirm('Reset the form? All entered data will be lost.')) return;
    document.getElementById('subject').value = '';
    document.getElementById('description').value = '';
    document.getElementById('dueDate').value = '';
    document.getElementById('assignee').selectedIndex = 0;
    document.getElementById('status').selectedIndex = 0;
    pendingFiles = []; renderPreviews();
    document.getElementById('successCard').classList.remove('show');
    hideFb();
  }

  function openIssue()     { if (lastIssueId) vscode.postMessage({ command: 'openIssue', issueId: lastIssueId }); }
  function createAnother() {
    document.getElementById('subject').value = '';
    document.getElementById('description').value = '';
    document.getElementById('dueDate').value = '';
    pendingFiles = []; renderPreviews();
    document.getElementById('successCard').classList.remove('show');
    hideFb();
    document.getElementById('subject').focus();
  }

  function showFb(type, msg) { const el = document.getElementById('fb'); el.className = 'fb ' + type; el.textContent = msg; }
  function hideFb()          { document.getElementById('fb').className = 'fb'; }
  function escHtml(s)        { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ── Messages from extension ───────────────────────────────────────
  window.addEventListener('message', ev => {
    const msg = ev.data;

    if (msg.command === 'membersResult') {
      const sel = document.getElementById('assignee');
      sel.innerHTML = '<option value="">— Unassigned —</option>';
      (msg.members || []).forEach(m => {
        const o = document.createElement('option');
        o.value = m.id; o.textContent = m.name;
        sel.appendChild(o);
      });
    }

    if (msg.command === 'fieldsResult') {
      customFieldsConfig = msg.fields || [];
      renderCustomFields(msg.status === 'ok' && customFieldsConfig.length > 0);
    }

    if (msg.command === 'created') {
      const btn = document.getElementById('submitBtn');
      btn.disabled = false; btn.textContent = '✚ Create Issue';
      lastIssueId = msg.issueId;
      pendingFiles = []; renderPreviews();
      hideFb();
      document.getElementById('successTitle').textContent = '✓ Issue #' + msg.issueId + ' created successfully!';
      document.getElementById('successSub').textContent   = msg.subject;
      document.getElementById('successCard').classList.add('show');
    }

    if (msg.command === 'createError') {
      const btn = document.getElementById('submitBtn');
      btn.disabled = false; btn.textContent = '✚ Create Issue';
      showFb('error', 'Failed to create: ' + msg.message);
    }
  });
</script>
</body>
</html>`;
}
