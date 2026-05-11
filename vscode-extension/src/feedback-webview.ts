import * as vscode from "vscode";
import axios from "axios";
import { getCurrentUser } from "./redmine-client";

const FEEDBACK_WEBHOOK_URL = "https://hoangthiep08.top/webhook-test/redmine-feedback";
// Production: https://hoangthiep08.top/webhook/redmine-feedback

export class FeedbackWebview {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show() {
    if (this.panel) { this.panel.reveal(); return; }


    this.panel = vscode.window.createWebviewPanel(
      "redmineFeedback",
      "Send Feedback",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = null; });

    const version: string = this.context.extension?.packageJSON?.version ?? "1.0.x";
    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "redmine.png")
    );

    let userEmail = "";
    try {
      const user = await getCurrentUser();
      userEmail = (user as unknown as Record<string, string>)["mail"] ?? "";
    } catch { /* use empty */ }

    this.panel.webview.html = buildHtml(version, logoUri.toString(), userEmail);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "submit") {
        await this.handleSubmit(msg);
      }
    });
  }

  private async handleSubmit(msg: Record<string, unknown>) {
    const webhookUrl = FEEDBACK_WEBHOOK_URL ||
      (vscode.workspace.getConfiguration("redmine").get<string>("feedbackWebhookUrl") ?? "");

    if (!webhookUrl) {
      this.panel?.webview.postMessage({
        command: "submitResult", success: false,
        message: "Feedback webhook URL is not configured. Please set redmine.feedbackWebhookUrl in settings.",
      });
      return;
    }

    try {
      const version: string = this.context.extension?.packageJSON?.version ?? "1.0.x";
      const payload = {
        type:      msg.type,
        title:     msg.title,
        message:   msg.message,
        email:     msg.email,
        version,
        timestamp: new Date().toISOString(),
      };

      await axios.post(webhookUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      });

      this.panel?.webview.postMessage({ command: "submitResult", success: true });
    } catch (err) {
      this.panel?.webview.postMessage({
        command: "submitResult", success: false,
        message: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

function e(s: string) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildHtml(version: string, logoSrc: string, userEmail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send Feedback</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 28px 32px;
    max-width: 620px; margin: 0 auto;
  }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .header img { width: 34px; height: 34px; object-fit: contain; }
  .header-text .title { font-size: 1.15em; font-weight: 700; }
  .header-text .sub { font-size: .8em; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  .field { margin-bottom: 16px; }
  label.fl { display: block; margin-bottom: 5px; font-weight: 500; font-size: .88em; }
  .hint { font-size: .76em; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  input[type="text"], input[type="email"], select, textarea {
    width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border,#555); border-radius: 4px;
    padding: 7px 10px; font-family: inherit; font-size: inherit; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  textarea { min-height: 130px; resize: vertical; line-height: 1.5; }

  /* Buttons */
  .btn-row { display: flex; gap: 9px; margin-top: 22px; }
  button.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 20px; cursor: pointer; font-family: inherit; font-size: .88em; font-weight: 500; }
  button.btn:hover { opacity: .87; }
  button.btn:disabled { opacity: .45; cursor: not-allowed; }
  button.btn-sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

  /* Feedback */
  .feedback { display: none; margin-top: 14px; padding: 10px 14px; border-radius: 4px; font-size: .87em; }
  .feedback.success { display: block; background: color-mix(in srgb,var(--vscode-testing-iconPassed) 12%,transparent); border-left: 3px solid var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
  .feedback.error   { display: block; background: color-mix(in srgb,var(--vscode-errorForeground) 12%,transparent); border-left: 3px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .divider { border: none; border-top: 1px solid var(--vscode-widget-border,#333); margin: 6px 0 18px; }
  .version-note { font-size: .72em; color: var(--vscode-descriptionForeground); opacity: .5; margin-top: 18px; }
</style>
</head>
<body>

<div class="header">
  <img src="${e(logoSrc)}" alt="Redmine">
  <div class="header-text">
    <div class="title">Send Feedback</div>
    <div class="sub">Report a bug, request a feature, or share your thoughts</div>
  </div>
</div>
<hr class="divider">

<div class="field">
  <label class="fl" for="fbType">Type</label>
  <select id="fbType">
    <option value="Bug Report">🐛 Bug Report</option>
    <option value="Feature Request">✨ Feature Request</option>
    <option value="General Feedback">💬 General Feedback</option>
    <option value="Other">📝 Other</option>
  </select>
</div>

<div class="field">
  <label class="fl" for="fbTitle">Title <span style="color:var(--vscode-errorForeground)">*</span></label>
  <input type="text" id="fbTitle" placeholder="Brief summary of your feedback">
</div>

<div class="field">
  <label class="fl" for="fbMsg">Message <span style="color:var(--vscode-errorForeground)">*</span></label>
  <textarea id="fbMsg" placeholder="Describe in detail…"></textarea>
</div>

<div class="field">
  <label class="fl" for="fbEmail">Your Email</label>
  <input type="email" id="fbEmail" value="${e(userEmail)}" readonly
    style="opacity:.7;cursor:default;background:var(--vscode-editor-inactiveSelectionBackground)">
  <div class="hint">Automatically filled from your Redmine account. Used to follow up on your feedback.</div>
</div>

<div class="btn-row">
  <button class="btn" id="submitBtn" onclick="submit()">📤 Send Feedback</button>
  <button class="btn btn-sec" onclick="reset()">Reset</button>
</div>
<div class="feedback" id="fb"></div>
<div class="version-note">Redmine Connector v${e(version)}</div>

<script>
  const vscode = acquireVsCodeApi();

  function submit() {
    const title = document.getElementById('fbTitle').value.trim();
    const msg   = document.getElementById('fbMsg').value.trim();
    const email = document.getElementById('fbEmail').value.trim();
    if (!title || !msg) {
      showFb('error', 'Please fill in Title and Message.');
      return;
    }
    const btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    vscode.postMessage({
      command: 'submit',
      type:    document.getElementById('fbType').value,
      title,
      message: msg,
      email:   document.getElementById('fbEmail').value.trim(),
    });
  }

  function reset() {
    document.getElementById('fbTitle').value = '';
    document.getElementById('fbMsg').value = '';
    document.getElementById('fbType').selectedIndex = 0;
    document.getElementById('fb').className = 'feedback';
  }

  function showFb(type, msg) {
    const el = document.getElementById('fb');
    el.className = 'feedback ' + type; el.textContent = msg;
  }

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg.command === 'submitResult') {
      const btn = document.getElementById('submitBtn');
      btn.disabled = false; btn.textContent = '📤 Send Feedback';
      if (msg.success) {
        showFb('success', '✓ Feedback sent! Thank you.');
        document.getElementById('fbTitle').value = '';
        document.getElementById('fbMsg').value = '';
      } else {
        showFb('error', msg.message || 'Failed to send feedback.');
      }
    }
  });
</script>
</body>
</html>`;
}
