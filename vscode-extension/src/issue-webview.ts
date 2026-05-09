import * as vscode from "vscode";
import {
  Issue,
  Journal,
  Attachment,
  getIssue,
  listStatuses,
  listProjectMembers,
  updateIssue,
  updateJournal,
  deleteJournal,
  fetchAttachmentAsDataUrl,
  isImageAttachment,
  getBaseUrl,
  IssueStatus,
  Member,
} from "./redmine-client";
import { pushIssueToAI } from "./push-to-ai";
import { renderText, FORMATTER_CSS } from "./text-formatter";

export class IssueWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentIssue: Issue | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(issue: Issue) {
    this.currentIssue = issue;

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

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.currentIssue = null;
    });

    this.panel.webview.html = this.buildHtml(issue);

    this.panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.handleMessage(msg);
    });
  }

  private async refresh() {
    if (!this.currentIssue || !this.panel) return;
    try {
      const issue = await getIssue(this.currentIssue.id);
      this.currentIssue = issue;
      this.panel.title = `#${issue.id} ${issue.subject}`;
      this.panel.webview.html = this.buildHtml(issue);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to refresh issue: ${err}`);
    }
  }

  private async handleMessage(msg: WebviewMessage) {
    switch (msg.command) {
      case "pushToAI":
        if (this.currentIssue) await pushIssueToAI(this.currentIssue);
        break;

      case "openInBrowser": {
        const url = `${getBaseUrl()}/issues/${this.currentIssue!.id}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }

      case "changeStatus": {
        let statuses: IssueStatus[];
        try {
          statuses = await listStatuses();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to load statuses: ${err}`);
          return;
        }
        const statusPick = await vscode.window.showQuickPick(
          statuses.map((s) => ({
            label: s.name,
            description: s.is_closed ? "(closed)" : undefined,
            id: s.id,
          })),
          {
            title: `Update Status — #${this.currentIssue!.id}`,
            placeHolder: `Current: ${this.currentIssue!.status.name}`,
          }
        );
        if (!statusPick) return;
        try {
          await updateIssue(this.currentIssue!.id, { statusId: statusPick.id });
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to update status: ${err}`);
        }
        break;
      }

      case "changeAssignee": {
        let members: Member[];
        try {
          members = await listProjectMembers(String(this.currentIssue!.project.id));
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to load members: ${err}`);
          return;
        }
        const assignPicks: { label: string; description?: string; id: number }[] = [
          { label: "Unassigned", description: "Remove assignee", id: 0 },
          ...members.map((m) => ({
            label: m.name,
            description: m.roles.join(", "),
            id: m.id,
          })),
        ];
        const assignPick = await vscode.window.showQuickPick(assignPicks, {
          title: `Assign Issue #${this.currentIssue!.id}`,
          placeHolder: `Current: ${this.currentIssue!.assigned_to?.name ?? "Unassigned"}`,
        });
        if (!assignPick) return;
        try {
          await updateIssue(this.currentIssue!.id, { assignedToId: assignPick.id });
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to assign issue: ${err}`);
        }
        break;
      }

      case "addComment": {
        const notes = await vscode.window.showInputBox({
          title: `Add Comment to #${this.currentIssue!.id}`,
          prompt: "Enter your comment",
          ignoreFocusOut: true,
        });
        if (!notes?.trim()) return;
        try {
          await updateIssue(this.currentIssue!.id, { notes: notes.trim() });
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to add comment: ${err}`);
        }
        break;
      }

      case "replyComment": {
        const quote = typeof msg.quote === "string" ? msg.quote : "";
        const quotedBlock = quote
          ? quote
              .split("\n")
              .map((l: string) => `> ${l}`)
              .join("\n") + "\n\n"
          : "";
        const replyText = await vscode.window.showInputBox({
          title: "Reply to Comment",
          value: quotedBlock,
          prompt: "Enter your reply",
          ignoreFocusOut: true,
        });
        if (!replyText?.trim()) return;
        try {
          await updateIssue(this.currentIssue!.id, { notes: replyText.trim() });
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to post reply: ${err}`);
        }
        break;
      }

      case "editComment": {
        const journalId = msg.journalId as number;
        const currentNotes = typeof msg.currentNotes === "string" ? msg.currentNotes : "";
        const edited = await vscode.window.showInputBox({
          title: "Edit Comment",
          value: currentNotes,
          prompt: "Edit your comment",
          ignoreFocusOut: true,
        });
        if (edited === undefined) return;
        try {
          await updateJournal(journalId, edited);
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to edit comment: ${err}`);
        }
        break;
      }

      case "deleteComment": {
        const journalId = msg.journalId as number;
        const confirmed = await vscode.window.showWarningMessage(
          "Delete this comment permanently?",
          { modal: true },
          "Delete"
        );
        if (confirmed !== "Delete") return;
        try {
          await deleteJournal(journalId);
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to delete comment: ${err}`);
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
    const comments = (issue.journals ?? [])
      .filter((j) => j.notes && j.notes.trim())
      .slice()
      .reverse();

    const allJournals = (issue.journals ?? []).slice().reverse();

    const imageAttachments = (issue.attachments ?? []).filter(isImageAttachment);
    const fileAttachments = (issue.attachments ?? []).filter((a) => !isImageAttachment(a));

    const progressColor =
      issue.done_ratio >= 100
        ? "var(--vscode-testing-iconPassed)"
        : issue.done_ratio >= 50
        ? "var(--vscode-charts-blue)"
        : "var(--vscode-charts-yellow)";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>#${issue.id} ${esc(issue.subject)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0;
    max-width: 900px;
    margin: 0 auto;
  }

  /* ── Header ── */
  .issue-header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    position: sticky;
    top: 0;
    background: var(--vscode-editor-background);
    z-index: 10;
  }
  .issue-meta-top {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .issue-id {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px;
    border-radius: 10px;
  }
  .issue-tracker {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-inactiveSelectionBackground);
    padding: 2px 8px;
    border-radius: 10px;
  }
  .issue-status {
    font-size: 0.8em;
    font-weight: 600;
    padding: 2px 10px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--vscode-charts-blue) 20%, transparent);
    color: var(--vscode-charts-blue);
  }
  .issue-priority {
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--vscode-widget-border, #555);
  }
  .issue-title {
    font-size: 1.25em;
    font-weight: 700;
    line-height: 1.4;
    color: var(--vscode-foreground);
    margin-bottom: 12px;
  }

  /* ── Action bar ── */
  .action-bar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 14px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85em;
    font-weight: 500;
    transition: opacity 0.15s;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn:hover { opacity: 0.85; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-danger {
    background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent);
    color: var(--vscode-errorForeground);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent);
  }
  .btn-sm {
    padding: 3px 10px;
    font-size: 0.8em;
  }

  /* ── Body layout ── */
  .body-content {
    padding: 20px 24px;
  }

  /* ── Meta grid ── */
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1px;
    background: var(--vscode-widget-border, #333);
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  .meta-item {
    background: var(--vscode-editor-background);
    padding: 10px 14px;
  }
  .meta-label {
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 3px;
    font-weight: 600;
  }
  .meta-value {
    font-size: 0.9em;
    font-weight: 500;
  }
  .progress-bar-wrap {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 4px;
    height: 6px;
    margin-top: 5px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    border-radius: 4px;
    background: ${progressColor};
    width: ${issue.done_ratio}%;
    transition: width 0.3s;
  }

  /* ── Sections ── */
  .section {
    margin-bottom: 24px;
  }
  .section-title {
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--vscode-descriptionForeground);
    font-weight: 700;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title .count {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 0.9em;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 600;
  }
  .section-divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, #333);
    margin: 20px 0;
  }

  /* ── Description ── */
  .description-box {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 8px;
    padding: 16px;
  }
  .empty-desc {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.9em;
  }

  /* ── Attachments ── */
  .attachments-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .image-card {
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 8px;
    overflow: hidden;
    background: var(--vscode-editor-inactiveSelectionBackground);
    max-width: 200px;
    cursor: pointer;
  }
  .image-card img {
    width: 200px;
    height: 140px;
    object-fit: cover;
    display: block;
  }
  .image-card .img-name {
    font-size: 0.78em;
    padding: 5px 8px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .image-placeholder {
    width: 200px;
    height: 140px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
  }
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .file-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 5px;
    font-size: 0.85em;
  }
  .file-item a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    flex: 1;
  }
  .file-item a:hover { text-decoration: underline; }
  .file-size {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    white-space: nowrap;
  }

  /* ── Image modal ── */
  .img-modal {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 1000;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  .img-modal.open { display: flex; }
  .img-modal img {
    max-width: 95vw;
    max-height: 95vh;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
  }

  /* ── Comments ── */
  .comments-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .comment-card {
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 8px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  .comment-card:hover { border-color: var(--vscode-focusBorder, #007acc); }
  .comment-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    flex-wrap: wrap;
  }
  .comment-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75em;
    font-weight: 700;
    flex-shrink: 0;
  }
  .comment-author { font-weight: 600; font-size: 0.9em; }
  .comment-date {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    margin-left: 2px;
  }
  .comment-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .comment-card:hover .comment-actions { opacity: 1; }
  .comment-body {
    padding: 12px 16px;
  }
  .journal-changes {
    padding: 8px 16px 10px;
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-widget-border, #333);
  }
  .journal-change {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
  }
  .change-field {
    font-weight: 600;
    color: var(--vscode-foreground);
    min-width: 80px;
  }
  .change-arrow { opacity: 0.5; }
  .change-old { text-decoration: line-through; opacity: 0.6; }
  .change-new { font-weight: 500; }

  /* ── Rich text ── */
  ${FORMATTER_CSS}
</style>
</head>
<body>

<!-- Image Modal -->
<div class="img-modal" id="imgModal" onclick="closeModal()">
  <img id="modalImg" src="" alt="">
</div>

<!-- Sticky Header -->
<div class="issue-header">
  <div class="issue-meta-top">
    <span class="issue-id">#${issue.id}</span>
    <span class="issue-tracker">${esc(issue.tracker.name)}</span>
    <span class="issue-status">${esc(issue.status.name)}</span>
    <span class="issue-priority">⚡ ${esc(issue.priority.name)}</span>
  </div>
  <div class="issue-title">${esc(issue.subject)}</div>
  <div class="action-bar">
    <button class="btn btn-primary" onclick="send('pushToAI')">
      ⚡ Push to AI
    </button>
    <button class="btn" onclick="send('openInBrowser')">
      🌐 Open in Browser
    </button>
    <button class="btn" onclick="send('changeStatus')">
      🔄 Change Status
    </button>
    <button class="btn" onclick="send('changeAssignee')">
      👤 Change Assignee
    </button>
  </div>
</div>

<!-- Body -->
<div class="body-content">

  <!-- Meta info grid -->
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
      <div class="meta-value">${formatDate(issue.created_on)}</div>
    </div>
    ${
      issue.due_date
        ? `<div class="meta-item">
      <div class="meta-label">Due Date</div>
      <div class="meta-value">${esc(issue.due_date)}</div>
    </div>`
        : ""
    }
    <div class="meta-item">
      <div class="meta-label">Progress</div>
      <div class="meta-value">${issue.done_ratio}%</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar"></div>
      </div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Updated</div>
      <div class="meta-value">${formatDate(issue.updated_on)}</div>
    </div>
  </div>

  <!-- Description -->
  <div class="section">
    <div class="section-title">Description</div>
    <div class="description-box">
      ${
        issue.description
          ? `<div class="rich-text">${renderText(issue.description)}</div>`
          : `<div class="empty-desc">No description provided.</div>`
      }
    </div>
  </div>

  ${buildAttachmentsSection(imageAttachments, fileAttachments)}

  <hr class="section-divider">

  <!-- Comments -->
  <div class="section">
    <div class="comments-header">
      <div class="section-title" style="margin-bottom:0">
        Comments
        ${comments.length > 0 ? `<span class="count">${comments.length}</span>` : ""}
      </div>
      <button class="btn btn-primary btn-sm" onclick="send('addComment')">+ Add Comment</button>
    </div>

    ${comments.length === 0 ? `<p style="color:var(--vscode-descriptionForeground);font-style:italic;font-size:0.9em">No comments yet.</p>` : ""}

    ${allJournals
      .filter((j) => j.notes?.trim() || j.details?.length)
      .map((j) => buildJournalCard(j))
      .join("")}
  </div>
</div>

<div style="text-align:center;padding:20px 24px 12px;color:var(--vscode-descriptionForeground);font-size:0.75em;opacity:0.5;user-select:none;">
  Redmine Connector v${version}
</div>

<script>
  const vscode = acquireVsCodeApi();

  function send(command, extra) {
    vscode.postMessage(Object.assign({ command }, extra || {}));
  }

  function openModal(src) {
    document.getElementById('modalImg').src = src;
    document.getElementById('imgModal').classList.add('open');
  }
  function closeModal() {
    document.getElementById('imgModal').classList.remove('open');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // Lazy-load images
  document.querySelectorAll('img[data-attachment-id]').forEach((img) => {
    const id = parseInt(img.dataset.attachmentId);
    const url = img.dataset.src;
    send('loadImage', { attachmentId: id, url });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'imageLoaded') {
      const imgs = document.querySelectorAll('img[data-attachment-id="' + msg.attachmentId + '"]');
      imgs.forEach((img) => {
        img.src = msg.dataUrl;
        img.style.cursor = 'zoom-in';
        img.onclick = () => openModal(msg.dataUrl);
      });
      // Remove loading state from card
      const cards = document.querySelectorAll('[data-card-id="' + msg.attachmentId + '"]');
      cards.forEach((c) => c.classList.remove('loading'));
    }
    if (msg.command === 'imageError') {
      const imgs = document.querySelectorAll('img[data-attachment-id="' + msg.attachmentId + '"]');
      imgs.forEach((img) => { img.alt = 'Failed to load'; img.style.opacity = '0.4'; });
    }
  });
</script>

</body>
</html>`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface WebviewMessage {
  command: string;
  [key: string]: unknown;
}

function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsStr(s: string): string {
  return JSON.stringify(s);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.split("T")[0];
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function buildAttachmentsSection(images: Attachment[], files: Attachment[]): string {
  if (images.length === 0 && files.length === 0) return "";

  let html = `<div class="section">
  <div class="section-title">Attachments <span class="count">${images.length + files.length}</span></div>`;

  if (images.length > 0) {
    html += `<div class="attachments-grid">`;
    for (const img of images) {
      html += `
      <div class="image-card" data-card-id="${img.id}">
        <div class="image-placeholder" id="placeholder-${img.id}">Loading...</div>
        <img
          data-attachment-id="${img.id}"
          data-src="${esc(img.content_url)}"
          src=""
          alt="${esc(img.filename)}"
          style="display:none"
          onload="this.previousElementSibling.style.display='none'; this.style.display='block';"
        >
        <div class="img-name" title="${esc(img.filename)}">${esc(img.filename)}</div>
      </div>`;
    }
    html += `</div>`;
  }

  if (files.length > 0) {
    if (images.length > 0) html += `<div style="height:10px"></div>`;
    html += `<div class="file-list">`;
    for (const f of files) {
      html += `
      <div class="file-item">
        📎 <a href="${esc(f.content_url)}" target="_blank">${esc(f.filename)}</a>
        <span class="file-size">${formatFileSize(f.filesize)}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function buildJournalCard(j: Journal): string {
  const hasNotes = !!(j.notes && j.notes.trim());
  const hasChanges = j.details && j.details.length > 0;
  const avatar = initials(j.user.name) || "?";

  let html = `<div class="comment-card">
  <div class="comment-header">
    <div class="comment-avatar">${esc(avatar)}</div>
    <span class="comment-author">${esc(j.user.name)}</span>
    <span class="comment-date">${formatDate(j.created_on)}</span>`;

  if (hasNotes) {
    html += `
    <div class="comment-actions">
      <button class="btn btn-sm" onclick="send('replyComment', { quote: ${jsStr(j.notes)} })">↩ Reply</button>
      <button class="btn btn-sm" onclick="send('editComment', { journalId: ${j.id}, currentNotes: ${jsStr(j.notes)} })">✏ Edit</button>
      <button class="btn btn-sm btn-danger" onclick="send('deleteComment', { journalId: ${j.id} })">🗑 Delete</button>
    </div>`;
  }

  html += `</div>`;

  if (hasNotes) {
    html += `<div class="comment-body rich-text">${renderText(j.notes)}</div>`;
  }

  if (hasChanges) {
    html += `<div class="journal-changes">`;
    for (const d of j.details) {
      const fieldLabel = friendlyFieldName(d.name);
      html += `<div class="journal-change">
        <span class="change-field">${esc(fieldLabel)}</span>
        ${d.old_value ? `<span class="change-old">${esc(d.old_value)}</span> <span class="change-arrow">→</span>` : ""}
        <span class="change-new">${esc(d.new_value ?? "—")}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function friendlyFieldName(name: string): string {
  const map: Record<string, string> = {
    status_id: "Status",
    assigned_to_id: "Assignee",
    priority_id: "Priority",
    tracker_id: "Tracker",
    subject: "Subject",
    description: "Description",
    done_ratio: "Progress",
    due_date: "Due Date",
    start_date: "Start Date",
    estimated_hours: "Hours",
    fixed_version_id: "Version",
  };
  return map[name] ?? name;
}
