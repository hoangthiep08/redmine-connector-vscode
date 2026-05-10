import * as vscode from "vscode";
import {
  Issue,
  Journal,
  Attachment,
  IssueStatus,
  Member,
  Priority,
  getIssue,
  listStatuses,
  listProjectMembers,
  listPriorities,
  getCurrentUser,
  updateIssue,
  updateJournal,
  deleteJournal,
  fetchAttachmentAsDataUrl,
  isImageAttachment,
  getBaseUrl,
} from "./redmine-client";
import { pushIssueToAI } from "./push-to-ai";
import { renderText, FORMATTER_CSS } from "./text-formatter";

export class IssueWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentIssue: Issue | null = null;
  private statusMap: Record<string, string> = {};
  private userMap: Record<string, string> = {};
  private priorityMap: Record<string, string> = {};
  private currentUserId: number = -1;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(issue: Issue) {
    this.currentIssue = issue;
    await this.fetchLookups(issue);

    if (this.panel) {
      this.panel.reveal();
      this.panel.title = `#${issue.id} ${issue.subject}`;
      this.panel.webview.html = this.buildHtml(issue);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "redmineIssue",
      `#${issue.id} ${issue.subject}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = null; this.currentIssue = null; });
    this.panel.webview.html = this.buildHtml(issue);
    this.panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.handleMessage(msg);
    });
  }

  private async fetchLookups(issue: Issue) {
    const [statuses, members, priorities, me] = await Promise.all([
      listStatuses().catch(() => [] as IssueStatus[]),
      listProjectMembers(String(issue.project.id)).catch(() => [] as Member[]),
      listPriorities().catch(() => [] as Priority[]),
      getCurrentUser().catch(() => null),
    ]);
    if (me) this.currentUserId = me.id;

    this.statusMap = Object.fromEntries(statuses.map((s) => [String(s.id), s.name]));
    this.priorityMap = Object.fromEntries(priorities.map((p) => [String(p.id), p.name]));

    this.userMap = {};
    for (const m of members) this.userMap[String(m.id)] = m.name;
    // Extract users from journal entries (covers authors + anyone referenced)
    for (const j of issue.journals ?? []) {
      this.userMap[String(j.user.id)] = j.user.name;
    }
    this.userMap[String(issue.author.id)] = issue.author.name;
    if (issue.assigned_to) this.userMap[String(issue.assigned_to.id)] = issue.assigned_to.name;
  }

  private async refresh() {
    if (!this.currentIssue || !this.panel) return;
    try {
      const issue = await getIssue(this.currentIssue.id);
      this.currentIssue = issue;
      await this.fetchLookups(issue);
      this.panel.title = `#${issue.id} ${issue.subject}`;
      this.panel.webview.html = this.buildHtml(issue);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to refresh: ${err}`);
    }
  }

  private resolveVal(field: string, raw: string | null | undefined): string {
    if (raw === null || raw === undefined || raw === "") return "—";
    if (field === "status_id") return this.statusMap[raw] ?? raw;
    if (field === "assigned_to_id") return this.userMap[raw] ?? `User #${raw}`;
    if (field === "priority_id") return this.priorityMap[raw] ?? raw;
    return raw;
  }

  private async handleMessage(msg: WebviewMessage) {
    switch (msg.command) {
      case "pushToAI":
        if (this.currentIssue) await pushIssueToAI(this.currentIssue);
        break;

      case "openInBrowser":
        await vscode.env.openExternal(
          vscode.Uri.parse(`${getBaseUrl()}/issues/${this.currentIssue!.id}`)
        );
        break;

      case "changeStatus": {
        let statuses: IssueStatus[];
        try { statuses = await listStatuses(); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); return; }
        const pick = await vscode.window.showQuickPick(
          statuses.map((s) => ({ label: s.name, description: s.is_closed ? "(closed)" : undefined, id: s.id })),
          { title: `Status — #${this.currentIssue!.id}`, placeHolder: `Current: ${this.currentIssue!.status.name}` }
        );
        if (!pick) return;
        try { await updateIssue(this.currentIssue!.id, { statusId: pick.id }); await this.refresh(); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); }
        break;
      }

      case "changeAssignee": {
        let members: Member[];
        try { members = await listProjectMembers(String(this.currentIssue!.project.id)); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); return; }
        const picks: { label: string; description?: string; id: number }[] = [
          { label: "Unassigned", description: "Remove assignee", id: 0 },
          ...members.map((m) => ({ label: m.name, description: m.roles.join(", "), id: m.id })),
        ];
        const pick = await vscode.window.showQuickPick(picks, {
          title: `Assign #${this.currentIssue!.id}`,
          placeHolder: `Current: ${this.currentIssue!.assigned_to?.name ?? "Unassigned"}`,
        });
        if (!pick) return;
        try { await updateIssue(this.currentIssue!.id, { assignedToId: pick.id }); await this.refresh(); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); }
        break;
      }

      case "addComment": {
        const notes = typeof msg.notes === "string" ? msg.notes.trim() : "";
        if (!notes) return;
        try { await updateIssue(this.currentIssue!.id, { notes }); await this.refresh(); }
        catch (err) {
          vscode.window.showErrorMessage(`${err}`);
          this.panel?.webview.postMessage({ command: "commentError" });
        }
        break;
      }

      case "replyComment": {
        const notes = typeof msg.notes === "string" ? msg.notes.trim() : "";
        if (!notes) return;
        try { await updateIssue(this.currentIssue!.id, { notes }); await this.refresh(); }
        catch (err) {
          vscode.window.showErrorMessage(`${err}`);
          this.panel?.webview.postMessage({ command: "commentError" });
        }
        break;
      }

      case "editComment": {
        const journalId = msg.journalId as number;
        const notes = typeof msg.notes === "string" ? msg.notes : "";
        try { await updateJournal(journalId, notes); await this.refresh(); }
        catch (err) {
          vscode.window.showErrorMessage(`${err}`);
          this.panel?.webview.postMessage({ command: "commentError" });
        }
        break;
      }

      case "deleteComment": {
        const journalId = msg.journalId as number;
        try { await deleteJournal(journalId); await this.refresh(); }
        catch (err) {
          vscode.window.showErrorMessage(`${err}`);
          this.panel?.webview.postMessage({ command: "deleteError", journalId });
        }
        break;
      }

      case "loadImage": {
        const url = typeof msg.url === "string" ? msg.url : "";
        const attachmentId = msg.attachmentId as number;
        try {
          const dataUrl = await fetchAttachmentAsDataUrl(url);
          this.panel?.webview.postMessage({ command: "imageLoaded", attachmentId, dataUrl });
        } catch {
          this.panel?.webview.postMessage({ command: "imageError", attachmentId });
        }
        break;
      }
    }
  }

  private buildHtml(issue: Issue): string {
    const version: string = this.context.extension?.packageJSON?.version ?? "1.0.x";

    const journals = issue.journals ?? [];
    const comments = journals.filter((j) => j.notes?.trim()).slice().reverse();
    const historyEntries = journals.filter((j) => j.details?.length).slice().reverse();

    const imageAttachments = (issue.attachments ?? []).filter(isImageAttachment);
    const fileAttachments = (issue.attachments ?? []).filter((a) => !isImageAttachment(a));

    const notesMap = Object.fromEntries(
      journals.filter((j) => j.notes).map((j) => [j.id, j.notes])
    );

    const progressColor =
      issue.done_ratio >= 100 ? "var(--vscode-testing-iconPassed)"
      : issue.done_ratio >= 50 ? "var(--vscode-charts-blue)"
      : "var(--vscode-charts-yellow)";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>#${issue.id}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    max-width: 900px; margin: 0 auto;
  }

  /* ── Header ── */
  .issue-header {
    padding: 18px 24px 14px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    position: sticky; top: 0;
    background: var(--vscode-editor-background); z-index: 10;
  }
  .meta-top { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; flex-wrap: wrap; }
  .badge { font-size: 0.78em; font-weight: 600; padding: 2px 9px; border-radius: 10px; }
  .badge-id { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge-tracker { background: var(--vscode-editor-inactiveSelectionBackground); }
  .badge-status { background: color-mix(in srgb,var(--vscode-charts-blue) 18%,transparent); color: var(--vscode-charts-blue); }
  .badge-priority { border: 1px solid var(--vscode-widget-border,#555); color: var(--vscode-descriptionForeground); }
  .issue-title { font-size: 1.2em; font-weight: 700; line-height: 1.4; margin-bottom: 11px; }

  /* ── Buttons ── */
  .action-bar { display: flex; gap: 7px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 5px 13px; border: none; border-radius: 5px; cursor: pointer;
    font-family: inherit; font-size: 0.84em; font-weight: 500;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); transition: opacity .12s;
  }
  .btn:hover { opacity: .82; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-danger {
    background: color-mix(in srgb,var(--vscode-errorForeground) 12%,transparent);
    color: var(--vscode-errorForeground);
    border: 1px solid color-mix(in srgb,var(--vscode-errorForeground) 30%,transparent);
  }
  .btn-ghost { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border,#555); }
  .btn-ghost:hover { color: var(--vscode-foreground); }
  .btn-sm { padding: 3px 9px; font-size: 0.79em; }

  /* ── Body ── */
  .body { padding: 18px 24px; }

  /* ── Meta grid ── */
  .meta-grid {
    display: grid; grid-template-columns: repeat(auto-fill,minmax(185px,1fr));
    gap: 1px; background: var(--vscode-widget-border,#333);
    border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px;
    overflow: hidden; margin-bottom: 20px;
  }
  .meta-item { background: var(--vscode-editor-background); padding: 9px 13px; }
  .meta-label { font-size: .7em; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin-bottom: 3px; font-weight: 600; }
  .meta-value { font-size: .88em; font-weight: 500; }
  .prog-wrap { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; height: 5px; margin-top: 5px; overflow: hidden; }
  .prog-bar { height: 100%; border-radius: 4px; background: ${progressColor}; width: ${issue.done_ratio}%; }

  /* ── Sections ── */
  .section { margin-bottom: 20px; }
  .section-title {
    font-size: .78em; text-transform: uppercase; letter-spacing: .07em;
    color: var(--vscode-descriptionForeground); font-weight: 700;
    margin-bottom: 9px; display: flex; align-items: center; gap: 7px;
  }
  .cnt { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 7px; border-radius: 10px; font-size: .9em; text-transform: none; letter-spacing: 0; font-weight: 600; }
  .divider { border: none; border-top: 1px solid var(--vscode-widget-border,#333); margin: 18px 0; }

  /* ── Description ── */
  .desc-box { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px; padding: 14px; }
  .empty-note { color: var(--vscode-descriptionForeground); font-style: italic; font-size: .9em; }

  /* ── Attachments ── */
  .attach-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .img-card { border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px; overflow: hidden; background: var(--vscode-editor-inactiveSelectionBackground); max-width: 200px; }
  .img-card img { width: 200px; height: 136px; object-fit: cover; display: block; cursor: zoom-in; }
  .img-placeholder { width: 200px; height: 136px; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-size: .8em; }
  .img-name { font-size: .75em; padding: 5px 8px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .file-list { display: flex; flex-direction: column; gap: 5px; }
  .file-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 5px; font-size: .84em; }
  .file-item a { color: var(--vscode-textLink-foreground); text-decoration: none; flex: 1; }
  .file-item a:hover { text-decoration: underline; }
  .file-size { color: var(--vscode-descriptionForeground); font-size: .84em; white-space: nowrap; }

  /* ── Image modal ── */
  .img-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.88); z-index: 1000; align-items: center; justify-content: center; cursor: zoom-out; }
  .img-modal.open { display: flex; }
  .img-modal img { max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; }

  /* ── Tabs ── */
  .tab-bar {
    display: flex; gap: 0; border-bottom: 2px solid var(--vscode-widget-border,#333);
    margin-bottom: 14px;
  }
  .tab-btn {
    padding: 7px 16px; background: none; border: none; cursor: pointer;
    font-family: inherit; font-size: .85em; font-weight: 500;
    color: var(--vscode-descriptionForeground);
    border-bottom: 2px solid transparent; margin-bottom: -2px;
    transition: color .12s;
  }
  .tab-btn:hover { color: var(--vscode-foreground); }
  .tab-btn.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder,#007acc); }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }

  /* ── Comments header ── */
  .comments-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }

  /* ── Add comment box ── */
  .add-box { border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px; margin-bottom: 12px; overflow: hidden; display: none; }
  .add-box.open { display: block; }
  .add-box-head { padding: 7px 13px; background: var(--vscode-editor-inactiveSelectionBackground); font-size: .84em; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
  .add-box-body { padding: 11px 13px; }

  /* ── Textarea ── */
  textarea {
    width: 100%; min-height: 78px; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border,#555); border-radius: 5px;
    padding: 7px 10px; font-family: inherit; font-size: inherit; outline: none; line-height: 1.5;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .form-row { display: flex; gap: 7px; margin-top: 7px; align-items: center; }

  /* ── Comment card ── */
  .comment-card { border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
  .comment-card:hover { border-color: color-mix(in srgb,var(--vscode-focusBorder) 55%,transparent); }
  .card-header { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--vscode-editor-inactiveSelectionBackground); flex-wrap: wrap; }
  .avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--vscode-button-background); color: var(--vscode-button-foreground); display: flex; align-items: center; justify-content: center; font-size: .72em; font-weight: 700; flex-shrink: 0; }
  .card-author { font-weight: 600; font-size: .88em; }
  .card-date { color: var(--vscode-descriptionForeground); font-size: .77em; }
  .card-actions { margin-left: auto; display: flex; gap: 5px; opacity: 0; transition: opacity .12s; }
  .comment-card:hover .card-actions { opacity: 1; }
  .card-body { padding: 11px 14px; }

  /* ── Inline forms ── */
  .inline-form { padding: 11px 13px; border-top: 1px solid var(--vscode-widget-border,#333); display: none; }
  .inline-form.open { display: block; }

  /* ── Delete confirm ── */
  .del-confirm { display: none; padding: 8px 13px; background: color-mix(in srgb,var(--vscode-errorForeground) 7%,transparent); border-top: 1px solid color-mix(in srgb,var(--vscode-errorForeground) 22%,transparent); align-items: center; gap: 8px; }
  .del-confirm.open { display: flex; }
  .del-confirm span { font-size: .85em; flex: 1; }

  /* ── History entries ── */
  .history-card { border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .history-header { display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .history-body { padding: 8px 14px 10px; }
  .change-row { display: flex; align-items: baseline; gap: 7px; padding: 3px 0; font-size: .87em; }
  .change-field { font-weight: 600; min-width: 90px; color: var(--vscode-foreground); }
  .change-old { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .change-arrow { color: var(--vscode-descriptionForeground); font-size: .8em; }
  .change-new { font-weight: 500; }
  .history-note { margin-top: 6px; padding: 6px 10px; background: var(--vscode-textCodeBlock-background); border-radius: 5px; font-size: .83em; color: var(--vscode-descriptionForeground); border-left: 2px solid var(--vscode-widget-border,#555); white-space: pre-wrap; }

  /* ── Footer ── */
  .version-footer { text-align: center; padding: 16px 0 10px; color: var(--vscode-descriptionForeground); font-size: .72em; opacity: .4; user-select: none; }

  ${FORMATTER_CSS}
</style>
</head>
<body>

<div class="img-modal" id="imgModal" onclick="closeModal()">
  <img id="modalImg" src="" alt="">
</div>

<!-- Sticky header -->
<div class="issue-header">
  <div class="meta-top">
    <span class="badge badge-id">#${issue.id}</span>
    <span class="badge badge-tracker">${esc(issue.tracker.name)}</span>
    <span class="badge badge-status">${esc(issue.status.name)}</span>
    <span class="badge badge-priority">⚡ ${esc(issue.priority.name)}</span>
  </div>
  <div class="issue-title">${esc(issue.subject)}</div>
  <div class="action-bar">
    <button class="btn btn-primary" onclick="vsc('pushToAI')">⚡ Push to AI</button>
    <button class="btn" onclick="vsc('openInBrowser')">🌐 Browser</button>
    <button class="btn" onclick="vsc('changeStatus')">🔄 Status</button>
    <button class="btn" onclick="vsc('changeAssignee')">👤 Assignee</button>
  </div>
</div>

<div class="body">

  <!-- Meta grid -->
  <div class="meta-grid">
    <div class="meta-item">
      <div class="meta-label">Project</div>
      <div class="meta-value">${esc(issue.project.name)}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Assignee</div>
      <div class="meta-value">${esc(issue.assigned_to?.name ?? "—")}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Author</div>
      <div class="meta-value">${esc(issue.author.name)}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Created</div>
      <div class="meta-value">${fmtDate(issue.created_on)}</div>
    </div>
    ${issue.due_date ? `<div class="meta-item"><div class="meta-label">Due Date</div><div class="meta-value">${esc(issue.due_date)}</div></div>` : ""}
    <div class="meta-item">
      <div class="meta-label">Progress</div>
      <div class="meta-value">${issue.done_ratio}%</div>
      <div class="prog-wrap"><div class="prog-bar"></div></div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Updated</div>
      <div class="meta-value">${fmtDate(issue.updated_on)}</div>
    </div>
  </div>

  <!-- Description -->
  <div class="section">
    <div class="section-title">Description</div>
    <div class="desc-box">
      ${issue.description
        ? `<div class="rich-text">${renderText(issue.description)}</div>`
        : `<div class="empty-note">No description provided.</div>`}
    </div>
  </div>

  ${this.buildAttachmentsHtml(imageAttachments, fileAttachments)}

  <hr class="divider">

  <!-- Tabs: Comments | History -->
  <div class="tab-bar">
    <button class="tab-btn active" onclick="switchTab('comments', this)">
      Comments${comments.length ? ` <span class="cnt">${comments.length}</span>` : ""}
    </button>
    <button class="tab-btn" onclick="switchTab('history', this)">
      History${historyEntries.length ? ` <span class="cnt">${historyEntries.length}</span>` : ""}
    </button>
  </div>

  <!-- Comments tab -->
  <div class="tab-pane active" id="tab-comments">
    <div class="comments-top">
      <span></span>
      <button class="btn btn-primary btn-sm" onclick="toggleAddForm()">+ Add Comment</button>
    </div>

    <div class="add-box" id="addBox">
      <div class="add-box-head">
        <span>New Comment</span>
        <button class="btn btn-ghost btn-sm" onclick="toggleAddForm()">✕ Cancel</button>
      </div>
      <div class="add-box-body">
        <textarea id="newCommentText" placeholder="Write your comment..."></textarea>
        <div class="form-row">
          <button class="btn btn-primary btn-sm" onclick="submitAdd()">Submit</button>
        </div>
      </div>
    </div>

    ${comments.length === 0
      ? `<p class="empty-note">No comments yet.</p>`
      : comments.map((j) => this.buildCommentHtml(j)).join("")}
  </div>

  <!-- History tab -->
  <div class="tab-pane" id="tab-history">
    ${historyEntries.length === 0
      ? `<p class="empty-note">No change history.</p>`
      : historyEntries.map((j) => this.buildHistoryHtml(j)).join("")}
  </div>

</div>

<div class="version-footer">Redmine Connector v${version}</div>

<script>
  const vscode = acquireVsCodeApi();
  const NOTES = ${JSON.stringify(notesMap)};

  function vsc(cmd, extra) {
    vscode.postMessage(Object.assign({ command: cmd }, extra || {}));
  }

  // ── Tabs ──────────────────────────────────────────────────
  function switchTab(name, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  // ── Image modal ───────────────────────────────────────────
  function openModal(src) { document.getElementById('modalImg').src = src; document.getElementById('imgModal').classList.add('open'); }
  function closeModal() { document.getElementById('imgModal').classList.remove('open'); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ── Add comment ───────────────────────────────────────────
  function toggleAddForm() {
    const box = document.getElementById('addBox');
    const open = box.classList.toggle('open');
    if (open) document.getElementById('newCommentText').focus();
    else document.getElementById('newCommentText').value = '';
  }
  function submitAdd() {
    const notes = document.getElementById('newCommentText').value.trim();
    if (!notes) return;
    setSubmitting(event.currentTarget, 'Submitting…');
    vsc('addComment', { notes });
  }

  // ── Reply ─────────────────────────────────────────────────
  function showReply(id) {
    closeAllForms();
    const ta = document.getElementById('reply-ta-' + id);
    const quote = (NOTES[id] || '').split('\\n').map(l => '> ' + l).join('\\n');
    ta.value = quote ? quote + '\\n\\n' : '';
    document.getElementById('reply-form-' + id).classList.add('open');
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function cancelReply(id) { document.getElementById('reply-form-' + id).classList.remove('open'); }
  function submitReply(id) {
    const notes = document.getElementById('reply-ta-' + id).value.trim();
    if (!notes) return;
    setSubmitting(event.currentTarget, 'Posting…');
    vsc('replyComment', { notes });
  }

  // ── Edit ──────────────────────────────────────────────────
  function showEdit(id) {
    closeAllForms();
    document.getElementById('body-' + id).style.display = 'none';
    const ta = document.getElementById('edit-ta-' + id);
    ta.value = NOTES[id] || '';
    document.getElementById('edit-form-' + id).classList.add('open');
    ta.focus();
  }
  function cancelEdit(id) {
    document.getElementById('body-' + id).style.display = '';
    document.getElementById('edit-form-' + id).classList.remove('open');
  }
  function submitEdit(id) {
    const notes = document.getElementById('edit-ta-' + id).value;
    setSubmitting(event.currentTarget, 'Saving…');
    vsc('editComment', { journalId: id, notes });
  }

  // ── Delete ────────────────────────────────────────────────
  function showDelete(id) { closeAllForms(); document.getElementById('del-' + id).classList.add('open'); }
  function cancelDelete(id) { document.getElementById('del-' + id).classList.remove('open'); }
  function confirmDelete(id) {
    setSubmitting(event.currentTarget, 'Deleting…');
    vsc('deleteComment', { journalId: id });
  }

  // ── Helpers ───────────────────────────────────────────────
  function closeAllForms() {
    document.querySelectorAll('.inline-form.open').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.del-confirm.open').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('[id^="body-"][style]').forEach(el => el.style.display = '');
  }
  function setSubmitting(btn, label) {
    btn.disabled = true; btn.textContent = label;
  }

  // ── Messages from extension ───────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'imageLoaded') {
      document.querySelectorAll('img[data-aid="' + msg.attachmentId + '"]').forEach(img => {
        const ph = img.previousElementSibling;
        if (ph) ph.style.display = 'none';
        img.src = msg.dataUrl;
        img.style.display = 'block';
        img.onclick = () => openModal(msg.dataUrl);
      });
    }
    if (msg.command === 'imageError') {
      document.querySelectorAll('img[data-aid="' + msg.attachmentId + '"]').forEach(img => { img.alt = '⚠ Error'; img.style.opacity = '.4'; });
    }
    if (msg.command === 'commentError' || msg.command === 'deleteError') {
      document.querySelectorAll('button[disabled]').forEach(btn => {
        btn.disabled = false;
        btn.textContent = btn.textContent.replace('…', '').replace('Submitting', 'Submit').replace('Posting', 'Post Reply').replace('Saving', 'Save').replace('Deleting', 'Delete');
      });
    }
  });

  // Lazy-load images
  document.querySelectorAll('img[data-aid]').forEach(img => {
    vsc('loadImage', { attachmentId: parseInt(img.dataset.aid), url: img.dataset.src });
  });
</script>
</body>
</html>`;
  }

  private buildCommentHtml(j: Journal): string {
    const av = esc(initials(j.user.name));
    const isOwn = j.user.id === this.currentUserId;
    return `<div class="comment-card">
  <div class="card-header">
    <div class="avatar">${av}</div>
    <span class="card-author">${esc(j.user.name)}</span>
    <span class="card-date">${fmtDate(j.created_on)}</span>
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm" onclick="showReply(${j.id})">↩ Reply</button>
      ${isOwn ? `<button class="btn btn-ghost btn-sm" onclick="showEdit(${j.id})">✏ Edit</button>
      <button class="btn btn-danger btn-sm" onclick="showDelete(${j.id})">🗑</button>` : ""}
    </div>
  </div>
  <div class="card-body rich-text" id="body-${j.id}">${renderText(j.notes)}</div>

  <div class="inline-form" id="reply-form-${j.id}">
    <textarea id="reply-ta-${j.id}" placeholder="Write your reply..."></textarea>
    <div class="form-row">
      <button class="btn btn-primary btn-sm" onclick="submitReply(${j.id})">Post Reply</button>
      <button class="btn btn-ghost btn-sm" onclick="cancelReply(${j.id})">Cancel</button>
    </div>
  </div>

  ${isOwn ? `<div class="inline-form" id="edit-form-${j.id}">
    <textarea id="edit-ta-${j.id}"></textarea>
    <div class="form-row">
      <button class="btn btn-primary btn-sm" onclick="submitEdit(${j.id})">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="cancelEdit(${j.id})">Cancel</button>
    </div>
  </div>

  <div class="del-confirm" id="del-${j.id}">
    <span>Delete this comment?</span>
    <button class="btn btn-danger btn-sm" onclick="confirmDelete(${j.id})">Delete</button>
    <button class="btn btn-ghost btn-sm" onclick="cancelDelete(${j.id})">Cancel</button>
  </div>` : ""}
</div>`;
  }

  private buildHistoryHtml(j: Journal): string {
    const av = esc(initials(j.user.name));
    const details = j.details ?? [];
    let html = `<div class="history-card">
  <div class="history-header">
    <div class="avatar">${av}</div>
    <span class="card-author">${esc(j.user.name)}</span>
    <span class="card-date">${fmtDate(j.created_on)}</span>
  </div>
  <div class="history-body">`;

    for (const d of details) {
      const field = friendlyField(d.name);
      const oldVal = this.resolveVal(d.name, d.old_value);
      const newVal = this.resolveVal(d.name, d.new_value);
      html += `<div class="change-row">
      <span class="change-field">${esc(field)}</span>
      ${d.old_value ? `<span class="change-old">${esc(oldVal)}</span><span class="change-arrow"> → </span>` : ""}
      <span class="change-new">${esc(newVal)}</span>
    </div>`;
    }

    // If this journal also has a comment, show a preview
    if (j.notes?.trim()) {
      const preview = j.notes.trim().replace(/\n/g, " ").slice(0, 120);
      html += `<div class="history-note">💬 ${esc(preview)}${j.notes.length > 120 ? "…" : ""}</div>`;
    }

    html += `</div></div>`;
    return html;
  }

  private buildAttachmentsHtml(images: Attachment[], files: Attachment[]): string {
    if (!images.length && !files.length) return "";
    let html = `<div class="section">
  <div class="section-title">Attachments <span class="cnt">${images.length + files.length}</span></div>`;

    if (images.length) {
      html += `<div class="attach-grid">`;
      for (const img of images) {
        html += `<div class="img-card">
      <div class="img-placeholder">Loading…</div>
      <img data-aid="${img.id}" data-src="${esc(img.content_url)}" src="" alt="${esc(img.filename)}" style="display:none">
      <div class="img-name" title="${esc(img.filename)}">${esc(img.filename)}</div>
    </div>`;
      }
      html += `</div>`;
    }

    if (files.length) {
      if (images.length) html += `<div style="height:8px"></div>`;
      html += `<div class="file-list">`;
      for (const f of files) {
        html += `<div class="file-item">📎 <a href="${esc(f.content_url)}" target="_blank">${esc(f.filename)}</a><span class="file-size">${fmtSize(f.filesize)}</span></div>`;
      }
      html += `</div>`;
    }

    return html + `</div>`;
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

interface WebviewMessage {
  command: string;
  [key: string]: unknown;
}

function esc(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return iso.split("T")[0]; }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

function friendlyField(name: string): string {
  const map: Record<string, string> = {
    status_id: "Status", assigned_to_id: "Assignee", priority_id: "Priority",
    tracker_id: "Tracker", subject: "Subject", description: "Description",
    done_ratio: "Progress", due_date: "Due Date", start_date: "Start Date",
    estimated_hours: "Hours", fixed_version_id: "Version",
  };
  return map[name] ?? name;
}
