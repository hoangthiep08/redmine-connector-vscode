import * as vscode from "vscode";
import axios from "axios";

export class SettingsWebview {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "redmineSettings",
      "Redmine — Settings",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.onDidDispose(() => { this.panel = null; });

    const config = vscode.workspace.getConfiguration("redmine");
    const currentUrl = config.get<string>("baseUrl") ?? "";
    const currentKey = config.get<string>("apiKey") ?? "";
    const currentProject = config.get<string>("defaultProject") ?? "";
    const onlyMe = config.get<boolean>("showOnlyAssignedToMe") ?? false;

    this.panel.webview.html = this.buildHtml(currentUrl, currentKey, currentProject, onlyMe);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "save") {
        const cfg = vscode.workspace.getConfiguration("redmine");
        await cfg.update("baseUrl", msg.baseUrl.trim().replace(/\/$/, ""), vscode.ConfigurationTarget.Global);
        await cfg.update("apiKey", msg.apiKey.trim(), vscode.ConfigurationTarget.Global);
        await cfg.update("defaultProject", msg.defaultProject.trim(), vscode.ConfigurationTarget.Global);
        await cfg.update("showOnlyAssignedToMe", msg.onlyMe, vscode.ConfigurationTarget.Global);

        this.panel?.webview.postMessage({ command: "saved" });
        vscode.commands.executeCommand("redmine.refresh");
      }

      if (msg.command === "testConnection") {
        try {
          const url = msg.baseUrl.trim().replace(/\/$/, "");
          const key = msg.apiKey.trim();
          const res = await axios.get(`${url}/users/current.json`, {
            headers: { "X-Redmine-API-Key": key },
            timeout: 8000,
          });
          const user = res.data.user;
          this.panel?.webview.postMessage({
            command: "testResult",
            success: true,
            message: `Connected as: ${user.firstname} ${user.lastname} (${user.login})`,
          });
        } catch (err) {
          const msg2 = err instanceof Error ? err.message : String(err);
          this.panel?.webview.postMessage({
            command: "testResult",
            success: false,
            message: `Connection failed: ${msg2}`,
          });
        }
      }
    });
  }

  private buildHtml(url: string, apiKey: string, project: string, onlyMe: boolean): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redmine Settings</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 32px;
    max-width: 600px;
    margin: 0 auto;
  }
  .logo { font-size: 1.6em; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 32px; font-size: 0.9em; }
  .section { margin-bottom: 28px; }
  .section-title {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    font-weight: 600;
  }
  .field { margin-bottom: 16px; }
  label { display: block; margin-bottom: 5px; font-weight: 500; font-size: 0.9em; }
  .hint { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  input[type="text"], input[type="password"] {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    padding: 7px 10px;
    font-family: inherit;
    font-size: inherit;
    outline: none;
  }
  input[type="text"]:focus, input[type="password"]:focus {
    border-color: var(--vscode-focusBorder);
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
  }
  .toggle-row label { margin: 0; font-weight: normal; }
  input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
  .btn-row { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 8px 18px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9em;
    font-weight: 500;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .test-result {
    display: none;
    margin-top: 12px;
    padding: 10px 14px;
    border-radius: 4px;
    font-size: 0.9em;
  }
  .test-result.success {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent);
    border-left: 3px solid var(--vscode-testing-iconPassed);
    color: var(--vscode-testing-iconPassed);
  }
  .test-result.error {
    background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent);
    border-left: 3px solid var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
  }
  .save-feedback {
    display: none;
    margin-top: 12px;
    padding: 10px 14px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent);
    border-left: 3px solid var(--vscode-testing-iconPassed);
    color: var(--vscode-testing-iconPassed);
    font-size: 0.9em;
  }
  .divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, #333);
    margin: 24px 0;
  }
  .api-help {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 6px;
    padding: 12px 16px;
    font-size: 0.85em;
    line-height: 1.7;
  }
  .api-help ol { margin: 6px 0; padding-left: 20px; }
  .show-key { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.8em; padding: 0; margin-left: 8px; }
  .show-key:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="logo">🔴 Redmine Connector</div>
<div class="subtitle">Connect your Redmine instance to the IDE</div>

<div class="section">
  <div class="section-title">Connection</div>

  <div class="field">
    <label for="baseUrl">Redmine URL</label>
    <input type="text" id="baseUrl" value="${esc(url)}" placeholder="https://redmine.company.com" />
    <div class="hint">URL của Redmine server công ty bạn (không có dấu / ở cuối)</div>
  </div>

  <div class="field">
    <label for="apiKey">
      API Key
      <button class="show-key" id="toggleKey" onclick="toggleKey()">show</button>
    </label>
    <input type="password" id="apiKey" value="${esc(apiKey)}" placeholder="Paste your API key here" />
    <div class="hint">Lấy API key: Redmine → click tên user → <strong>My Account</strong> → mục <strong>API access key</strong> → Show</div>
  </div>

  <div class="btn-row">
    <button class="btn-secondary" onclick="testConnection()">⚡ Test Connection</button>
  </div>
  <div class="test-result" id="testResult"></div>
</div>

<hr class="divider">

<div class="section">
  <div class="section-title">Display Options</div>

  <div class="field">
    <label for="defaultProject">Default Project (optional)</label>
    <input type="text" id="defaultProject" value="${esc(project)}" placeholder="e.g. backend or 5" />
    <div class="hint">Identifier hoặc ID của project muốn hiển thị mặc định trong sidebar</div>
  </div>

  <div class="toggle-row">
    <input type="checkbox" id="onlyMe" ${onlyMe ? "checked" : ""} />
    <label for="onlyMe">Chỉ hiển thị issues được assign cho tôi</label>
  </div>
</div>

<div class="btn-row">
  <button onclick="save()">💾 Save Settings</button>
</div>
<div class="save-feedback" id="saveFeedback">✓ Settings saved! Sidebar will refresh automatically.</div>

<hr class="divider">

<div class="section">
  <div class="section-title">How to get your API Key</div>
  <div class="api-help">
    <ol>
      <li>Đăng nhập vào Redmine của công ty</li>
      <li>Click vào tên của bạn ở góc trên bên phải</li>
      <li>Chọn <strong>My Account</strong></li>
      <li>Ở cột bên phải, tìm mục <strong>API access key</strong></li>
      <li>Click <strong>Show</strong> rồi copy key</li>
    </ol>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  function toggleKey() {
    const input = document.getElementById('apiKey');
    const btn = document.getElementById('toggleKey');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'hide';
    } else {
      input.type = 'password';
      btn.textContent = 'show';
    }
  }

  function testConnection() {
    const el = document.getElementById('testResult');
    el.style.display = 'block';
    el.className = 'test-result';
    el.textContent = 'Testing connection...';
    vscode.postMessage({
      command: 'testConnection',
      baseUrl: document.getElementById('baseUrl').value,
      apiKey: document.getElementById('apiKey').value,
    });
  }

  function save() {
    vscode.postMessage({
      command: 'save',
      baseUrl: document.getElementById('baseUrl').value,
      apiKey: document.getElementById('apiKey').value,
      defaultProject: document.getElementById('defaultProject').value,
      onlyMe: document.getElementById('onlyMe').checked,
    });
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'testResult') {
      const el = document.getElementById('testResult');
      el.style.display = 'block';
      el.className = 'test-result ' + (msg.success ? 'success' : 'error');
      el.textContent = msg.message;
    }
    if (msg.command === 'saved') {
      const el = document.getElementById('saveFeedback');
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3000);
    }
  });
</script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
