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
  uploadAttachment,
  updateIssue,
  updateJournal,
  deleteJournal,
  fetchAttachmentAsDataUrl,
  deleteAttachment,
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
  private currentUserName: string = "";
  private allStatuses: IssueStatus[] = [];
  private allMembers: Member[] = [];

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
    if (me) { this.currentUserId = me.id; this.currentUserName = me.name; }

    this.allStatuses = statuses;
    this.allMembers = members;
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

      case "updateProgress": {
        const ratio = msg.ratio as number;
        try { await updateIssue(this.currentIssue!.id, { doneRatio: ratio }); await this.refresh(); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); }
        break;
      }

      case "updateStatus": {
        const statusId = msg.statusId as number;
        try { await updateIssue(this.currentIssue!.id, { statusId }); await this.refresh(); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); }
        break;
      }

      case "updateAssignee": {
        const assignedToId = msg.assignedToId as number;
        try { await updateIssue(this.currentIssue!.id, { assignedToId }); await this.refresh(); }
        catch (err) { vscode.window.showErrorMessage(`${err}`); }
        break;
      }

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
        const files = Array.isArray(msg.files) ? msg.files as { data: string; filename: string; contentType: string }[] : [];
        if (!notes && !files.length) return;
        try {
          const uploads = await Promise.all(
            files.map(async (f) => ({
              token: await uploadAttachment(f.data, f.filename, f.contentType),
              filename: f.filename,
              content_type: f.contentType,
            }))
          );
          await updateIssue(this.currentIssue!.id, { notes: notes || undefined, uploads: uploads.length ? uploads : undefined });
          await this.refresh();
        } catch (err) {
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

      case "updateContent": {
        const subject     = typeof msg.subject     === "string" ? msg.subject.trim()     : undefined;
        const description = typeof msg.description === "string" ? msg.description        : undefined;
        if (subject !== undefined && !subject) {
          vscode.window.showErrorMessage("Subject cannot be empty.");
          this.panel?.webview.postMessage({ command: "editError" });
          return;
        }
        try {
          await updateIssue(this.currentIssue!.id, { subject, description });
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`${err}`);
          this.panel?.webview.postMessage({ command: "editError" });
        }
        break;
      }

      case "deleteAttachment": {
        const attachId = msg.attachmentId as number;
        try {
          await deleteAttachment(attachId);
          await this.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Không thể xóa file: ${err}`);
          this.panel?.webview.postMessage({ command: "deleteAttachError", attachmentId: attachId });
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

      case "loadInlineImage": {
        const url = typeof msg.url === "string" ? msg.url : "";
        const iid = msg.iid as number;
        try {
          const dataUrl = await fetchAttachmentAsDataUrl(url);
          this.panel?.webview.postMessage({ command: "inlineImageLoaded", iid, dataUrl });
        } catch {
          this.panel?.webview.postMessage({ command: "inlineImageError", iid });
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

    const allAttachments = issue.attachments ?? [];
    const imageAttachments = allAttachments.filter(isImageAttachment);
    const fileAttachments = allAttachments.filter((a) => !isImageAttachment(a));
    // Map attachmentId → Attachment for journal inline display
    const attachmentMap = Object.fromEntries(allAttachments.map((a) => [a.id, a]));

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
  .issue-title { font-size: 1.2em; font-weight: 700; line-height: 1.4; margin-bottom: 4px; }
  .issue-byline { font-size: .78em; color: var(--vscode-descriptionForeground); margin-bottom: 11px; }
  .byline-sep { margin: 0 4px; opacity: .5; }
  .meta-select {
    width: 100%; background: transparent; color: var(--vscode-foreground);
    border: none; border-bottom: 1px dashed var(--vscode-widget-border,#555);
    font-family: inherit; font-size: .88em; font-weight: 500; cursor: pointer;
    padding: 0 2px 1px; outline: none; appearance: auto;
  }
  .meta-select:hover { border-bottom-color: var(--vscode-focusBorder); }
  .meta-select:focus { border-bottom-color: var(--vscode-focusBorder); }

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
  .prog-wrap { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; height: 5px; margin-top: 6px; overflow: hidden; }
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
  .img-footer { display: flex; align-items: center; padding: 4px 8px; gap: 4px; }
  .img-name { font-size: .75em; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .img-del-btn {
    flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 2px 4px;
    color: var(--vscode-descriptionForeground); font-size: .82em; border-radius: 3px;
    opacity: 0; transition: opacity .12s;
  }
  .img-card:hover .img-del-btn { opacity: 1; }
  .img-del-btn:hover { background: color-mix(in srgb,var(--vscode-errorForeground) 14%,transparent); color: var(--vscode-errorForeground); }
  .img-del-confirm { display: none; padding: 5px 8px; background: color-mix(in srgb,var(--vscode-errorForeground) 7%,transparent); border-top: 1px solid color-mix(in srgb,var(--vscode-errorForeground) 22%,transparent); gap: 6px; align-items: center; font-size: .78em; }
  .img-del-confirm.open { display: flex; }
  .img-del-confirm span { flex: 1; color: var(--vscode-foreground); }
  .file-list { display: flex; flex-direction: column; gap: 5px; }
  .file-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 5px; font-size: .84em; }
  .file-item a { color: var(--vscode-textLink-foreground); text-decoration: none; flex: 1; }
  .file-item a:hover { text-decoration: underline; }
  .file-size { color: var(--vscode-descriptionForeground); font-size: .84em; white-space: nowrap; }
  .file-del-btn {
    background: none; border: none; cursor: pointer; padding: 2px 5px;
    color: var(--vscode-descriptionForeground); font-size: .82em; border-radius: 3px;
    opacity: 0; transition: opacity .12s;
  }
  .file-item:hover .file-del-btn { opacity: 1; }
  .file-del-btn:hover { background: color-mix(in srgb,var(--vscode-errorForeground) 14%,transparent); color: var(--vscode-errorForeground); }

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

  /* ── Compose box (toggle) ── */
  .add-comment-btn {
    display: inline-flex; align-items: center; gap: 6px;
    margin-bottom: 14px; padding: 7px 16px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: .86em; font-weight: 500;
  }
  .add-comment-btn:hover { opacity: .87; }
  .compose-box {
    border: 1px solid var(--vscode-widget-border,#333); border-radius: 8px;
    margin-bottom: 16px; overflow: hidden;
    transition: border-color .15s; display: none;
  }
  .compose-box.open { display: block; }
  .compose-box:focus-within { border-color: var(--vscode-focusBorder,#007acc); }
  .compose-box textarea {
    border: none; border-radius: 0; min-height: 72px;
    padding: 11px 13px; resize: none;
  }
  .compose-box textarea:focus { border-color: transparent; }
  .compose-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; background: var(--vscode-editor-inactiveSelectionBackground);
    border-top: 1px solid var(--vscode-widget-border,#333);
  }
  .attach-btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; cursor: pointer;
    font-family: inherit; font-size: .79em; font-weight: 500;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border,#555); border-radius: 5px;
  }
  .attach-btn:hover { color: var(--vscode-foreground); }
  .compose-hint { font-size: .75em; color: var(--vscode-descriptionForeground); opacity: .6; }
  .compose-submit { margin-left: auto; }

  /* ── Image previews ── */
  .img-previews { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border,#333); }
  .img-previews:empty { display: none; }
  .preview-item { position: relative; width: 72px; height: 72px; }
  .preview-item img { width: 72px; height: 72px; object-fit: cover; border-radius: 5px; border: 1px solid var(--vscode-widget-border,#333); }
  .preview-remove {
    position: absolute; top: -5px; right: -5px; width: 18px; height: 18px;
    background: var(--vscode-errorForeground); color: #fff;
    border: none; border-radius: 50%; cursor: pointer;
    font-size: 11px; line-height: 18px; text-align: center; padding: 0;
  }

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
  .card-date { color: var(--vscode-descriptionForeground); font-size: .77em; cursor: default; }
  .card-date:hover { text-decoration: underline dotted; }
  .edited-badge { font-size: .72em; color: var(--vscode-descriptionForeground); opacity: .7; font-style: italic; }
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
  <div class="issue-byline">
    by <strong>${esc(issue.author.name)}</strong>
    <span class="byline-sep">·</span> Created: ${fmtDate(issue.created_on)}
    <span class="byline-sep">·</span> Updated: ${fmtDate(issue.updated_on)}
  </div>
  <div class="action-bar">
    <button class="btn btn-primary" onclick="vsc('pushToAI')">⚡ Push to AI</button>
    <button class="btn" onclick="openEditContent()">✏ Edit</button>
    <button class="btn" onclick="vsc('openInBrowser')">🌐 Browser</button>
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
      <div class="meta-label">Status</div>
      <select class="meta-select" onchange="vsc('updateStatus',{statusId:parseInt(this.value)})">
        ${this.allStatuses.map((s) =>
          `<option value="${s.id}"${s.id === issue.status.id ? " selected" : ""}>${esc(s.name)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="meta-item">
      <div class="meta-label">Assignee</div>
      <select class="meta-select" onchange="vsc('updateAssignee',{assignedToId:parseInt(this.value)})">
        <option value="0"${!issue.assigned_to ? " selected" : ""}>— Unassigned —</option>
        ${this.allMembers.map((m) =>
          `<option value="${m.id}"${issue.assigned_to?.id === m.id ? " selected" : ""}>${esc(m.name)}</option>`
        ).join("")}
      </select>
    </div>
    <div class="meta-item">
      <div class="meta-label">Progress</div>
      <select class="meta-select" onchange="vsc('updateProgress',{ratio:parseInt(this.value)})">
        ${[0,10,20,30,40,50,60,70,80,90,100].map((v) =>
          `<option value="${v}"${v === issue.done_ratio ? " selected" : ""}>${v}%</option>`
        ).join("")}
      </select>
      <div class="prog-wrap"><div class="prog-bar"></div></div>
    </div>
  </div>

  <!-- Description -->
  <div class="section">
    <div class="section-title">Description</div>
    <div class="desc-box" id="descView">
      ${issue.description
        ? `<div class="rich-text">${renderText(issue.description, undefined, getBaseUrl())}</div>`
        : `<div class="empty-note">No description provided.</div>`}
    </div>
    <div class="edit-content-panel" id="editContentPanel" style="display:none;margin-top:8px">
      <div class="field" style="margin-bottom:10px">
        <label class="meta-label" for="editSubject" style="display:block;margin-bottom:5px">Subject</label>
        <input type="text" id="editSubject" maxlength="255"
               style="width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:5px;padding:7px 10px;font-family:inherit;font-size:inherit;outline:none"
               value="${esc(issue.subject)}">
      </div>
      <div class="field">
        <label class="meta-label" for="editDescription" style="display:block;margin-bottom:5px">Description</label>
        <textarea id="editDescription" style="min-height:180px;line-height:1.6">${esc(issue.description ?? "")}</textarea>
      </div>
      <div class="form-row" style="margin-top:10px">
        <button class="btn btn-primary btn-sm" id="editContentSave" onclick="saveEditContent()">💾 Save</button>
        <button class="btn btn-ghost btn-sm" onclick="cancelEditContent()">Cancel</button>
      </div>
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

    <!-- Toggle compose box -->
    <button class="add-comment-btn" id="addCommentBtn" onclick="openCompose()">✏ Add Comment</button>
    <div class="compose-box" id="composeBox">
      <textarea id="newCommentText" placeholder="Write a comment…"></textarea>
      <div class="img-previews" id="imgPreviews"></div>
      <div class="compose-footer">
        <label class="attach-btn" title="Attach file">
          📎 Attach
          <input type="file" id="fileInput" accept="image/*,*/*" multiple style="display:none"
                 onchange="handleFileInput(this.files)">
        </label>
        <span class="compose-hint">click Attach to add files</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="closeCompose()">✕ Close</button>
          <button class="btn btn-primary btn-sm" id="submitBtn" onclick="submitAdd()">Submit</button>
        </div>
      </div>
    </div>

    ${comments.length === 0
      ? `<p class="empty-note">No comments yet.</p>`
      : comments.map((j) => this.buildCommentHtml(j, attachmentMap)).join("")}
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

  // ── Image attachment ──────────────────────────────────────
  let pendingFiles = []; // { data: base64, filename, contentType, previewUrl }

  function addFileToQueue(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const base64 = dataUrl.split(',')[1];
      const id = Date.now() + Math.random();
      pendingFiles.push({ id, data: base64, filename: file.name, contentType: file.type, previewUrl: dataUrl });
      renderPreviews();
    };
    reader.readAsDataURL(file);
  }

  function renderPreviews() {
    const container = document.getElementById('imgPreviews');
    container.innerHTML = '';
    pendingFiles.forEach(f => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const isImage = f.contentType.startsWith('image/');
      if (isImage) {
        const img = document.createElement('img');
        img.src = f.previewUrl;
        img.title = f.filename;
        item.appendChild(img);
      } else {
        item.style.cssText = 'display:flex;align-items:center;justify-content:center;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:5px;border:1px solid var(--vscode-widget-border);font-size:.7em;padding:4px;text-align:center;word-break:break-all;';
        item.textContent = f.filename;
      }
      const rm = document.createElement('button');
      rm.className = 'preview-remove';
      rm.textContent = '×';
      rm.onclick = () => { pendingFiles = pendingFiles.filter(x => x.id !== f.id); renderPreviews(); };
      item.appendChild(rm);
      container.appendChild(item);
    });
  }

  function handleFileInput(files) {
    Array.from(files).forEach(f => addFileToQueue(f));
    document.getElementById('fileInput').value = '';
  }


  // ── Compose toggle ────────────────────────────────────────
  function openCompose() {
    document.getElementById('addCommentBtn').style.display = 'none';
    document.getElementById('composeBox').classList.add('open');
    document.getElementById('newCommentText').focus();
  }
  function closeCompose() {
    const hasText = document.getElementById('newCommentText').value.trim().length > 0;
    if (hasText || pendingFiles.length > 0) {
      if (!confirm('Discard your comment? The content you entered will be lost.')) return;
    }
    document.getElementById('composeBox').classList.remove('open');
    document.getElementById('newCommentText').value = '';
    pendingFiles = []; renderPreviews();
    document.getElementById('addCommentBtn').style.display = '';
  }

  // ── Add comment ───────────────────────────────────────────
  function submitAdd() {
    const notes = document.getElementById('newCommentText').value.trim();
    if (!notes && !pendingFiles.length) return;
    const btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    const files = pendingFiles.map(f => ({ data: f.data, filename: f.filename, contentType: f.contentType }));
    vsc('addComment', { notes, files });
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

  // ── Edit issue content (subject + description) ───────────
  function openEditContent() {
    document.getElementById('descView').style.display = 'none';
    document.getElementById('editContentPanel').style.display = '';
    document.getElementById('editSubject').focus();
  }
  function cancelEditContent() {
    document.getElementById('descView').style.display = '';
    document.getElementById('editContentPanel').style.display = 'none';
  }
  function saveEditContent() {
    const subject     = document.getElementById('editSubject').value.trim();
    const description = document.getElementById('editDescription').value;
    if (!subject) { alert('Subject cannot be empty.'); return; }
    const btn = document.getElementById('editContentSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    vsc('updateContent', { subject, description });
  }

  // ── Delete comment ────────────────────────────────────────
  function showDelete(id) { closeAllForms(); document.getElementById('del-' + id).classList.add('open'); }
  function cancelDelete(id) { document.getElementById('del-' + id).classList.remove('open'); }
  function confirmDelete(id) {
    setSubmitting(event.currentTarget, 'Deleting…');
    vsc('deleteComment', { journalId: id });
  }

  // ── Delete attachment ─────────────────────────────────────
  function showDelAttach(id) {
    document.querySelectorAll('.img-del-confirm.open').forEach(el => el.classList.remove('open'));
    const el = document.getElementById('del-att-' + id);
    if (el) el.classList.add('open');
  }
  function cancelDelAttach(id) {
    const el = document.getElementById('del-att-' + id);
    if (el) el.classList.remove('open');
  }
  function confirmDelAttach(id) {
    setSubmitting(event.currentTarget, 'Deleting…');
    vsc('deleteAttachment', { attachmentId: id });
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
    if (msg.command === 'editError') {
      const btn = document.getElementById('editContentSave');
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
    }
    if (msg.command === 'commentError' || msg.command === 'deleteError') {
      document.querySelectorAll('button[disabled]').forEach(btn => {
        btn.disabled = false;
        btn.textContent = btn.textContent.replace('…', '').replace('Submitting', 'Submit').replace('Posting', 'Post Reply').replace('Saving', 'Save').replace('Deleting', 'Delete');
      });
    }
    if (msg.command === 'inlineImageLoaded') {
      document.querySelectorAll('img.rich-img[data-iid="' + msg.iid + '"]').forEach(img => {
        img.src = msg.dataUrl;
        img.onclick = () => openModal(msg.dataUrl);
      });
    }
    if (msg.command === 'inlineImageError') {
      document.querySelectorAll('img.rich-img[data-iid="' + msg.iid + '"]').forEach(img => {
        img.alt = '⚠ Could not load image'; img.style.opacity = '.4';
      });
    }
    if (msg.command === 'deleteAttachError') {
      cancelDelAttach(msg.attachmentId);
      document.querySelectorAll('button[disabled]').forEach(btn => { btn.disabled = false; });
    }
  });

  // ── Relative time ────────────────────────────────────────
  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 45)       return 'just now';
    if (diff < 90)       return 'a minute ago';
    if (diff < 3300)     return Math.round(diff / 60) + ' minutes ago';
    if (diff < 5400)     return 'about an hour ago';
    if (diff < 79200)    return Math.round(diff / 3600) + ' hours ago';
    if (diff < 129600)   return 'a day ago';
    if (diff < 561600)   return Math.round(diff / 86400) + ' days ago';
    if (diff < 1036800)  return 'a week ago';
    if (diff < 2419200)  return Math.round(diff / 604800) + ' weeks ago';
    if (diff < 31536000) return Math.round(diff / 2592000) + ' months ago';
    return Math.round(diff / 31536000) + ' years ago';
  }
  function fmtFull(iso) {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
  document.querySelectorAll('time[data-iso]').forEach(el => {
    el.textContent = timeAgo(el.dataset.iso);
    el.title = fmtFull(el.dataset.iso);
  });

  // Lazy-load attachment images
  document.querySelectorAll('img[data-aid]').forEach(img => {
    vsc('loadImage', { attachmentId: parseInt(img.dataset.aid), url: img.dataset.src });
  });

  // Lazy-load inline images inside rich text (comments, description)
  let _iid = 0;
  document.querySelectorAll('img.rich-img[data-src]').forEach(img => {
    const id = ++_iid;
    img.dataset.iid = id;
    vsc('loadInlineImage', { iid: id, url: img.dataset.src });
  });
</script>
</body>
</html>`;
  }

  private buildCommentHtml(j: Journal, attachmentMap: Record<number, Attachment> = {}): string {
    const av = esc(initials(j.user.name));
    const isOwn = j.user.id === this.currentUserId;
    const isEdited = !!(j.updated_on && j.updated_on !== j.created_on);

    // Images attached with this journal entry
    const journalImages = (j.details ?? [])
      .filter((d) => d.property === "attachment" && d.new_value && !d.old_value)
      .map((d) => attachmentMap[Number(d.name)])
      .filter((a): a is Attachment => !!a && isImageAttachment(a));

    const journalFiles = (j.details ?? [])
      .filter((d) => d.property === "attachment" && d.new_value && !d.old_value)
      .map((d) => attachmentMap[Number(d.name)])
      .filter((a): a is Attachment => !!a && !isImageAttachment(a));

    const attachHtml = [
      ...journalImages.map((a) => `
        <div class="j-img-wrap">
          <div class="img-placeholder" style="width:100%;height:90px">Loading…</div>
          <img data-aid="${a.id}" data-src="${esc(a.content_url)}" src="" alt="${esc(a.filename)}" style="display:none;max-width:260px;border-radius:6px;cursor:zoom-in;margin-top:6px">
        </div>`),
      ...journalFiles.map((a) => `
        <div class="file-item" style="margin-top:6px">📎 <a href="${esc(a.content_url)}" target="_blank">${esc(a.filename)}</a><span class="file-size">${fmtSize(a.filesize)}</span></div>`),
    ].join("");

    return `<div class="comment-card">
  <div class="card-header">
    <div class="avatar">${av}</div>
    <span class="card-author">${esc(j.user.name)}</span>
    <time class="card-date" data-iso="${esc(j.created_on)}">${fmtDate(j.created_on)}</time>
    ${isEdited ? `<span class="edited-badge">· Edited</span>` : ""}
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm" onclick="showReply(${j.id})">↩ Reply</button>
      ${isOwn ? `<button class="btn btn-ghost btn-sm" onclick="showEdit(${j.id})">✏ Edit</button>
      <button class="btn btn-danger btn-sm" onclick="showDelete(${j.id})">🗑</button>` : ""}
    </div>
  </div>
  <div class="card-body rich-text" id="body-${j.id}">${renderText(j.notes, undefined, getBaseUrl())}${attachHtml}</div>

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
    <time class="card-date" data-iso="${esc(j.created_on)}">${fmtDate(j.created_on)}</time>
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
        html += `<div class="img-card" id="att-card-${img.id}">
      <div class="img-placeholder">Loading…</div>
      <img data-aid="${img.id}" data-src="${esc(img.content_url)}" src="" alt="${esc(img.filename)}" style="display:none">
      <div class="img-footer">
        <span class="img-name" title="${esc(img.filename)}">${esc(img.filename)}</span>
        <button class="img-del-btn" onclick="showDelAttach(${img.id})" title="Delete attachment">🗑</button>
      </div>
      <div class="img-del-confirm" id="del-att-${img.id}">
        <span>Delete this file?</span>
        <button class="btn btn-danger btn-sm" onclick="confirmDelAttach(${img.id})">Delete</button>
        <button class="btn btn-ghost btn-sm" onclick="cancelDelAttach(${img.id})">Cancel</button>
      </div>
    </div>`;
      }
      html += `</div>`;
    }

    if (files.length) {
      if (images.length) html += `<div style="height:8px"></div>`;
      html += `<div class="file-list">`;
      for (const f of files) {
        html += `<div class="file-item" id="att-card-${f.id}">📎 <a href="${esc(f.content_url)}" target="_blank">${esc(f.filename)}</a><span class="file-size">${fmtSize(f.filesize)}</span><button class="file-del-btn" onclick="showDelAttach(${f.id})" title="Delete attachment">🗑</button></div>`;
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
