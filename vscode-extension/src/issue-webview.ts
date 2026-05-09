import * as vscode from "vscode";
import {
  Issue,
  Attachment,
  Journal,
  getBaseUrl,
  getIssue,
  updateIssue,
  updateJournal,
  deleteJournal,
  fetchAttachmentAsDataUrl,
  isImageAttachment,
  formatIssueAsMarkdown,
} from "./redmine-client";
import { copyImageToClipboard } from "./image-clipboard";
import { renderText, FORMATTER_CSS } from "./text-formatter";
import { openChatWithText } from "./chat-participant";

export class IssueWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentIssue: Issue | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(issue: Issue): Promise<void> {
    this.currentIssue = issue;

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "redmineIssue",
        `#${issue.id}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
        this.currentIssue = null;
      });
      this.panel.webview.onDidReceiveMessage(async (msg) => {
        await this.handleMessage(msg);
      });
    }

    this.panel.title = `#${issue.id} ${issue.subject.slice(0, 40)}`;

    // Show loading skeleton first, then load images
    this.panel.webview.html = await this.buildHtml(issue);
  }

  private async handleMessage(msg: { command: string; [key: string]: unknown }) {
    if (!this.currentIssue) return;

    if (msg.command === "addComment") {
      const notes = msg.notes as string;
      if (notes?.trim()) {
        await updateIssue(this.currentIssue.id, { notes });
        vscode.window.showInformationMessage("Comment added.");
        vscode.commands.executeCommand("redmine.refresh");
      }
    }
    if (msg.command === "openInBrowser") {
      vscode.env.openExternal(vscode.Uri.parse(`${getBaseUrl()}/issues/${this.currentIssue.id}`));
    }
    if (msg.command === "openInChat") {
      const markdown = formatIssueAsMarkdown(this.currentIssue, getBaseUrl());
      const prompt = `Here is a Redmine issue I need help with:\n\n${markdown}`;
      const opened = await openChatWithText(prompt);
      if (opened) {
        vscode.window.showInformationMessage(`Issue #${this.currentIssue.id} sent to AI chat.`);
      } else {
        await vscode.env.clipboard.writeText(markdown);
        vscode.window.showInformationMessage("Chat panel not detected — copied to clipboard instead.");
      }
    }
    if (msg.command === "copyMarkdown") {
      const markdown = formatIssueAsMarkdown(this.currentIssue, getBaseUrl());
      await vscode.env.clipboard.writeText(markdown);
      vscode.window.showInformationMessage(`Issue #${this.currentIssue.id} copied. Paste into any AI chat.`);
    }
    if (msg.command === "copyClaudePrompt") {
      const markdown = formatIssueAsMarkdown(this.currentIssue, getBaseUrl());
      const prompt = `Here is a Redmine issue I need help with:\n\n${markdown}`;
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage("Copied. Paste in Claude Code chat or terminal.");
    }
    if (msg.command === "openAttachment") {
      vscode.env.openExternal(vscode.Uri.parse(msg.url as string));
    }
    if (msg.command === "copyImageToClipboard") {
      const att = (this.currentIssue.attachments ?? []).find((a) => a.id === msg.id);
      if (att) await copyImageToClipboard(att);
    }
    if (msg.command === "editComment") {
      const journalId = msg.journalId as number;
      const currentText = msg.currentText as string;
      const newText = await vscode.window.showInputBox({
        title: "Edit Comment",
        value: currentText,
        ignoreFocusOut: true,
      });
      if (newText === undefined || newText === currentText) return;
      try {
        await updateJournal(journalId, newText);
        vscode.window.showInformationMessage("Comment updated.");
        const updated = await this.refreshIssue();
        if (updated) this.panel!.webview.html = await this.buildHtml(updated);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to edit: ${err}`);
      }
    }
    if (msg.command === "deleteComment") {
      const journalId = msg.journalId as number;
      const confirm = await vscode.window.showWarningMessage(
        "Delete this comment permanently?",
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;
      try {
        await deleteJournal(journalId);
        vscode.window.showInformationMessage("Comment deleted.");
        const updated = await this.refreshIssue();
        if (updated) this.panel!.webview.html = await this.buildHtml(updated);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete: ${err}`);
      }
    }
    if (msg.command === "replyComment") {
      // Quote original comment then scroll to textarea
      this.panel?.webview.postMessage({
        command: "fillReply",
        quote: msg.quote as string,
        author: msg.author as string,
      });
    }
  }

  private async refreshIssue(): Promise<Issue | null> {
    if (!this.currentIssue) return null;
    try {
      const fresh = await getIssue(this.currentIssue.id);
      this.currentIssue = fresh;
      vscode.commands.executeCommand("redmine.refresh");
      return fresh;
    } catch {
      return null;
    }
  }

  private async buildHtml(issue: Issue): Promise<string> {
    const baseUrl = getBaseUrl();
    const issueUrl = baseUrl ? `${baseUrl}/issues/${issue.id}` : "";
    const attachments = issue.attachments ?? [];
    const comments = (issue.journals ?? []).filter((j) => j.notes).reverse();
    const history = (issue.journals ?? []).filter((j) => j.details.length > 0);

    // Fetch images as base64 in parallel (max 10 images)
    const imageAttachments = attachments.filter(isImageAttachment).slice(0, 10);
    const imageDataUrls = new Map<number, string>();
    await Promise.allSettled(
      imageAttachments.map(async (att) => {
        try {
          const dataUrl = await fetchAttachmentAsDataUrl(att.content_url);
          imageDataUrls.set(att.id, dataUrl);
        } catch {
          // silently skip failed images
        }
      })
    );

    const attachmentsHtml = this.buildAttachmentsHtml(attachments, imageDataUrls, baseUrl);
    const commentsHtml = this.buildCommentsHtml(comments, attachments, imageDataUrls, baseUrl);
    const historyHtml = this.buildHistoryHtml(history);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>#${issue.id}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.3em; margin: 4px 0 0; }
  .issue-meta-line { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 16px; }
  .issue-meta-line a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 16px 0; }
  .meta-item { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; padding: 8px 12px; }
  .meta-label { font-size: 0.72em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
  .meta-value { font-weight: 600; }
  .section { margin: 20px 0; }
  .section h2 { font-size: 0.95em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 5px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
/* Attachments */
  .attachments-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .attachment-card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; overflow: hidden; cursor: pointer; border: 1px solid transparent; transition: border-color 0.15s; max-width: 220px; }
  .attachment-card:hover { border-color: var(--vscode-focusBorder); }
  .attachment-img { width: 220px; height: 140px; object-fit: cover; display: block; background: var(--vscode-textCodeBlock-background); }
  .attachment-img-placeholder { width: 220px; height: 140px; display: flex; align-items: center; justify-content: center; font-size: 2em; background: var(--vscode-textCodeBlock-background); }
  .attachment-name { padding: 6px 8px 2px; font-size: 0.78em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .attachment-footer { display: flex; align-items: center; justify-content: space-between; padding: 0 6px 6px; }
  .attachment-size { font-size: 0.72em; color: var(--vscode-descriptionForeground); }
  .copy-img-btn { font-size: 0.72em; padding: 2px 7px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; }
  .copy-img-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  /* Image lightbox */
  .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; align-items: center; justify-content: center; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 92vw; max-height: 90vh; border-radius: 4px; object-fit: contain; }
  .lightbox-close { position: fixed; top: 16px; right: 20px; font-size: 1.8em; color: white; cursor: pointer; background: none; border: none; line-height: 1; }
  /* Inline images in descriptions/comments */
  .inline-img { max-width: 100%; border-radius: 4px; margin: 6px 0; cursor: pointer; display: block; }
  /* Comments */
  .comment { border-left: 3px solid var(--vscode-textLink-foreground); padding: 8px 12px; margin: 10px 0; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 0 4px 4px 0; }
  .comment-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  .date { color: var(--vscode-descriptionForeground); font-size: 0.82em; }
  .comment-actions { margin-left: auto; display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
  .comment:hover .comment-actions { opacity: 1; }
  .comment-btn { font-size: 0.75em; padding: 2px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; cursor: pointer; font-family: inherit; }
  .comment-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .comment-btn-danger:hover { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
  .comment-body { white-space: pre-wrap; line-height: 1.5; }
  .reply-quote { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 6px 10px; margin-bottom: 6px; font-size: 0.88em; color: var(--vscode-descriptionForeground); border-radius: 0 3px 3px 0; white-space: pre-wrap; }
  .history-item { margin: 8px 0; font-size: 0.88em; }
  .history-item ul { margin: 4px 0; padding-left: 18px; }
  /* Actions */
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 18px; align-items: flex-start; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 0.88em; font-family: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-ai { background: #2d7d46; color: #fff; }
  .btn-ai:hover { background: #236b3a; }
  textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 4px; padding: 8px; font-family: inherit; font-size: inherit; resize: vertical; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .progress-bar { background: var(--vscode-progressBar-background); height: 5px; border-radius: 3px; width: ${issue.done_ratio}%; margin-top: 4px; }
  .progress-track { background: var(--vscode-scrollbarSlider-background); height: 5px; border-radius: 3px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  /* Rich text */
  ${FORMATTER_CSS}
</style>
</head>
<body>

<div class="issue-meta-line">${esc(issue.project.name)} · ${esc(issue.tracker.name)} · <a href="${issueUrl}" onclick="openBrowser(event,'${issueUrl}')">${issueUrl}</a></div>
<h1>#${issue.id} ${esc(issue.subject)}</h1>

<div class="actions">
  <button class="btn-ai" onclick="openInChat()">⚡ Push issue to AI</button>
  <button class="btn-secondary" onclick="openInBrowser()">Open in Browser</button>
</div>

<div class="meta-grid">
  <div class="meta-item">
    <div class="meta-label">Status</div>
    <div class="meta-value"><span class="badge">${esc(issue.status.name)}</span></div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Priority</div>
    <div class="meta-value">${esc(issue.priority.name)}</div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Assignee</div>
    <div class="meta-value">${esc(issue.assigned_to?.name ?? "Unassigned")}</div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Author</div>
    <div class="meta-value">${esc(issue.author.name)}</div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Progress</div>
    <div class="meta-value">${issue.done_ratio}%</div>
    <div class="progress-track"><div class="progress-bar"></div></div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Due Date</div>
    <div class="meta-value">${issue.due_date ?? "—"}</div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Created</div>
    <div class="meta-value">${issue.created_on.split("T")[0]}</div>
  </div>
  <div class="meta-item">
    <div class="meta-label">Updated</div>
    <div class="meta-value">${issue.updated_on.split("T")[0]}</div>
  </div>
</div>

${issue.description ? `<div class="section"><h2>Description</h2><div class="rich-text">${renderText(issue.description)}</div></div>` : ""}

${attachmentsHtml}

<div class="section">
  <h2>Comments (${comments.length})</h2>
  ${commentsHtml || `<div class="empty">No comments yet.</div>`}
  <div style="margin-top:12px">
    <div id="replyQuote" class="reply-quote" style="display:none"></div>
    <textarea id="newComment" rows="3" placeholder="Add a comment..."></textarea>
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
      <button onclick="addComment()">Add Comment</button>
      <button id="cancelReply" class="btn-secondary" style="display:none" onclick="cancelReply()">Cancel Reply</button>
    </div>
  </div>
</div>

${history.length > 0 ? `<div class="section"><h2>History</h2>${historyHtml}</div>` : ""}

<!-- Lightbox -->
<div class="lightbox" id="lightbox" onclick="closeLightbox()">
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
  <img id="lightboxImg" src="" alt="">
</div>

<script>
  const vscode = acquireVsCodeApi();
  function openInChat() { vscode.postMessage({ command: 'openInChat' }); }
  function openInBrowser() { vscode.postMessage({ command: 'openInBrowser' }); }
  function openBrowser(e, url) { e.preventDefault(); vscode.postMessage({ command: 'openInBrowser' }); }
  function openLightbox(src) {
    document.getElementById('lightboxImg').src = src;
    document.getElementById('lightbox').classList.add('open');
  }
  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
  }
  function copyImg(id) {
    vscode.postMessage({ command: 'copyImageToClipboard', id });
  }

  let replyPrefix = '';

  function getCommentData(btn) {
    const el = btn.closest('[data-id]');
    const id = parseInt(el.dataset.id);
    const notes = atob(el.dataset.notes);
    const author = el.dataset.author;
    return { id, notes, author };
  }

  function replyComment(btn) {
    const { notes, author } = getCommentData(btn);
    replyPrefix = notes;
    const quoteEl = document.getElementById('replyQuote');
    const cancelEl = document.getElementById('cancelReply');
    quoteEl.style.display = 'block';
    quoteEl.textContent = author + ' wrote:\n' + notes;
    cancelEl.style.display = 'inline-block';
    const textarea = document.getElementById('newComment');
    textarea.focus();
    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cancelReply() {
    replyPrefix = '';
    document.getElementById('replyQuote').style.display = 'none';
    document.getElementById('cancelReply').style.display = 'none';
  }

  function addComment() {
    const textarea = document.getElementById('newComment');
    const notes = textarea.value.trim();
    if (!notes) return;
    const fullNotes = replyPrefix
      ? replyPrefix.split('\n').map(l => '> ' + l).join('\n') + '\n\n' + notes
      : notes;
    vscode.postMessage({ command: 'addComment', notes: fullNotes });
    textarea.value = '';
    cancelReply();
  }

  function editComment(btn) {
    const { id, notes } = getCommentData(btn);
    vscode.postMessage({ command: 'editComment', journalId: id, currentText: notes });
  }

  function deleteComment(btn) {
    const { id } = getCommentData(btn);
    vscode.postMessage({ command: 'deleteComment', journalId: id });
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
</script>
</body>
</html>`;
  }

  private buildAttachmentsHtml(
    attachments: Attachment[],
    imageDataUrls: Map<number, string>,
    baseUrl: string
  ): string {
    if (attachments.length === 0) return "";

    const cards = attachments.map((att) => {
      const dataUrl = imageDataUrls.get(att.id);
      const isImage = isImageAttachment(att);
      const sizeKb = Math.round(att.filesize / 1024);
      const openUrl = att.content_url;

      const preview = isImage && dataUrl
        ? `<img class="attachment-img" src="${dataUrl}" alt="${esc(att.filename)}" onclick="openLightbox('${dataUrl}')">`
        : `<div class="attachment-img-placeholder">${fileIcon(att.content_type)}</div>`;

      const copyBtn = isImage
        ? `<button class="copy-img-btn" title="Copy image to clipboard — paste into Cursor/Windsurf chat" onclick="event.stopPropagation();copyImg(${att.id})">📋 Copy</button>`
        : "";

      return `<div class="attachment-card" title="${esc(att.filename)}" onclick="${isImage && dataUrl ? `openLightbox('${dataUrl}')` : `vscode.postMessage({command:'openAttachment',url:'${openUrl}'})`}">
        ${preview}
        <div class="attachment-name">${esc(att.filename)}</div>
        <div class="attachment-footer">
          <span class="attachment-size">${sizeKb} KB · ${esc(att.author.name)}</span>
          ${copyBtn}
        </div>
      </div>`;
    });

    return `<div class="section">
  <h2>Attachments (${attachments.length})</h2>
  <div class="attachments-grid">${cards.join("")}</div>
</div>`;
  }

  private buildCommentsHtml(
    comments: Journal[],
    attachments: Attachment[],
    imageDataUrls: Map<number, string>,
    baseUrl: string
  ): string {
    if (comments.length === 0) return "";
    return comments
      .map((c) => {
        // Substitute inline image macros before rendering
        const notesWithImages = c.notes.replace(/!([^!\s]+)!/g, (_, filename) => {
          const att = attachments.find((a) => a.filename === filename);
          if (att) {
            const dataUrl = imageDataUrls.get(att.id);
            if (dataUrl) return `![${filename}](data:inline:${att.id})`;
          }
          return `_[image: ${filename}]_`;
        });
        let body = renderText(notesWithImages);
        // Replace data:inline:<id> placeholders with actual data urls
        body = body.replace(/data:inline:(\d+)/g, (_, id) => {
          const dataUrl = imageDataUrls.get(parseInt(id));
          return dataUrl ?? "";
        });
        // Make inline images clickable
        body = body.replace(/<img([^>]+)src="(data:[^"]+)"([^>]*)>/g,
          (_, pre, src, post) => `<img${pre}src="${src}"${post} onclick="openLightbox('${src}')" style="cursor:pointer">`
        );

        // Store notes safely as base64 in data attribute — avoids any escaping issues
        const notesB64 = Buffer.from(c.notes, "utf8").toString("base64");

        return `<div class="comment" id="journal-${c.id}" data-id="${c.id}" data-notes="${notesB64}" data-author="${esc(c.user.name)}">
          <div class="comment-header">
            <strong>${esc(c.user.name)}</strong>
            <span class="date">${c.created_on.split("T")[0]}</span>
            <div class="comment-actions">
              <button class="comment-btn" onclick="replyComment(this)">↩ Reply</button>
              <button class="comment-btn" onclick="editComment(this)">✏ Edit</button>
              <button class="comment-btn comment-btn-danger" onclick="deleteComment(this)">🗑 Delete</button>
            </div>
          </div>
          <div class="comment-body rich-text">${body}</div>
        </div>`;
      })
      .join("");
  }

  private buildHistoryHtml(history: Journal[]): string {
    return history
      .map(
        (h) => `<div class="history-item">
        <strong>${esc(h.user.name)}</strong> <span class="date">${h.created_on.split("T")[0]}</span>
        <ul>${h.details.map((d: { name: string; old_value: string; new_value: string }) => `<li>${esc(d.name)}: <em>${esc(d.old_value ?? "—")}</em> → <em>${esc(d.new_value ?? "—")}</em></li>`).join("")}</ul>
      </div>`
      )
      .join("");
  }
}

function fileIcon(contentType: string): string {
  if (contentType.startsWith("image/")) return "🖼";
  if (contentType.includes("pdf")) return "📄";
  if (contentType.includes("zip") || contentType.includes("rar")) return "🗜";
  if (contentType.includes("text")) return "📝";
  if (contentType.includes("video")) return "🎬";
  return "📎";
}

function esc(str: string | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

