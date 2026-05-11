import * as vscode from "vscode";
import axios from "axios";
import { listProjects, listStatuses, listProjectMembers, configureClient } from "./redmine-client";

export class SettingsWebview {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show() {
    if (this.panel) { this.panel.reveal(); return; }

    const cfg = vscode.workspace.getConfiguration("redmine");
    const baseUrl = cfg.get<string>("baseUrl") ?? "";
    const apiKey  = cfg.get<string>("apiKey") ?? "";

    const init = {
      baseUrl,
      apiKey,
      defaultProject:       cfg.get<string>("defaultProject") ?? "",
      showOnlyAssignedToMe: cfg.get<boolean>("showOnlyAssignedToMe") ?? false,
      textFormat:           cfg.get<string>("textFormat") ?? "textile",
      defaultStatusMode:    cfg.get<string>("defaultStatusMode") ?? "open",
      defaultStatusIds:     cfg.get<string[]>("defaultStatusIds") ?? [],
      defaultAssigneeMode:  cfg.get<string>("defaultAssigneeMode") ?? "all",
      defaultAssigneeId:    cfg.get<string>("defaultAssigneeId") ?? "",
    };

    // Pre-fetch lookup data before building the webview
    let projects: { id: string; name: string }[] = [];
    let statuses: { id: string; name: string; is_closed: boolean }[] = [];
    let members:  { id: string; name: string }[] = [];

    if (baseUrl && apiKey) {
      try {
        configureClient(baseUrl, apiKey);
        [projects, statuses] = await Promise.all([
          listProjects().then((ps) => ps.map((p) => ({ id: p.identifier, name: p.name }))).catch(() => []),
          listStatuses().then((ss) => ss.map((s) => ({ id: String(s.id), name: s.name, is_closed: s.is_closed }))).catch(() => []),
        ]);
        if (init.defaultProject) {
          members = await listProjectMembers(init.defaultProject)
            .then((ms) => ms.map((m) => ({ id: String(m.id), name: m.name })))
            .catch(() => []);
        }
      } catch { /* show empty — user can reload */ }
    }

    this.panel = vscode.window.createWebviewPanel(
      "redmineSettings", "Redmine — Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = null; });

    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "redmine.png")
    );

    this.panel.webview.html = buildHtml(init, projects, statuses, members, logoUri.toString());

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "openFeedback") {
        vscode.commands.executeCommand("redmine.feedback");
        return;
      }

      // ── Save ──────────────────────────────────────────────────────────────
      if (msg.command === "save") {
        const c = vscode.workspace.getConfiguration("redmine");
        await c.update("baseUrl",               (msg.baseUrl as string).trim().replace(/\/$/, ""), vscode.ConfigurationTarget.Global);
        await c.update("apiKey",                (msg.apiKey as string).trim(),                    vscode.ConfigurationTarget.Global);
        await c.update("defaultProject",        (msg.defaultProject as string).trim(),            vscode.ConfigurationTarget.Global);
        await c.update("defaultProjectName",    (msg.defaultProjectName as string ?? "").trim(),  vscode.ConfigurationTarget.Global);
        await c.update("showOnlyAssignedToMe",  msg.defaultAssigneeMode === "me",                 vscode.ConfigurationTarget.Global);
        await c.update("textFormat",            msg.textFormat,                                   vscode.ConfigurationTarget.Global);
        await c.update("defaultStatusMode",     msg.defaultStatusMode,                            vscode.ConfigurationTarget.Global);
        await c.update("defaultStatusIds",      msg.defaultStatusIds ?? [],                       vscode.ConfigurationTarget.Global);
        await c.update("defaultAssigneeMode",   msg.defaultAssigneeMode,                          vscode.ConfigurationTarget.Global);
        await c.update("defaultAssigneeId",     msg.defaultAssigneeId ?? "",                      vscode.ConfigurationTarget.Global);
        await c.update("defaultAssigneeName",   msg.defaultAssigneeName ?? "",                    vscode.ConfigurationTarget.Global);
        this.panel?.webview.postMessage({ command: "saved" });
        vscode.commands.executeCommand("redmine.refresh");
      }

      // ── Test connection ───────────────────────────────────────────────────
      if (msg.command === "testConnection") {
        try {
          const url = (msg.baseUrl as string).trim().replace(/\/$/, "");
          const res = await axios.get(`${url}/users/current.json`, {
            headers: { "X-Redmine-API-Key": (msg.apiKey as string).trim() },
            timeout: 8000,
          });
          const u = res.data.user;
          this.panel?.webview.postMessage({
            command: "testResult", success: true,
            message: `Connected as: ${u.firstname} ${u.lastname} (${u.login})`,
          });
        } catch (err) {
          this.panel?.webview.postMessage({
            command: "testResult", success: false,
            message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // ── Reload all options ────────────────────────────────────────────────
      if (msg.command === "reloadOptions") {
        try {
          const url = (msg.baseUrl as string).trim().replace(/\/$/, "");
          const key = (msg.apiKey as string).trim();
          configureClient(url, key);
          const [ps, ss] = await Promise.all([
            listProjects().catch(() => []),
            listStatuses().catch(() => []),
          ]);
          const projId = (msg.selectedProject as string) ?? "";
          let ms: { id: string; name: string }[] = [];
          if (projId) {
            ms = await listProjectMembers(projId)
              .then((m) => m.map((x) => ({ id: String(x.id), name: x.name })))
              .catch(() => []);
          }
          this.panel?.webview.postMessage({
            command: "reloadResult",
            projects: ps.map((p) => ({ id: p.identifier, name: p.name })),
            statuses: ss.map((s) => ({ id: String(s.id), name: s.name, is_closed: s.is_closed })),
            members: ms,
          });
        } catch (err) {
          this.panel?.webview.postMessage({
            command: "reloadError",
            message: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // ── Fetch members for a project ───────────────────────────────────────
      if (msg.command === "fetchMembers") {
        try {
          const projId = (msg.projectId as string).trim();
          if (!projId) {
            this.panel?.webview.postMessage({ command: "membersResult", members: [] });
            return;
          }
          const ms = await listProjectMembers(projId)
            .then((m) => m.map((x) => ({ id: String(x.id), name: x.name })))
            .catch(() => []);
          this.panel?.webview.postMessage({ command: "membersResult", members: ms });
        } catch {
          this.panel?.webview.postMessage({ command: "membersResult", members: [] });
        }
      }
    });
  }
}

function e(s: string) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildHtml(
  init: {
    baseUrl: string; apiKey: string; defaultProject: string;
    showOnlyAssignedToMe: boolean; textFormat: string;
    defaultStatusMode: string; defaultStatusIds: string[];
    defaultAssigneeMode: string; defaultAssigneeId: string;
  },
  projects: { id: string; name: string }[],
  statuses: { id: string; name: string; is_closed: boolean }[],
  members:  { id: string; name: string }[],
  logoSrc: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redmine Settings</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 28px 32px;
    max-width: 660px; margin: 0 auto;
  }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .header img { width: 36px; height: 36px; object-fit: contain; }
  .header-text .logo { font-size: 1.25em; font-weight: 700; }
  .header-text .subtitle { color: var(--vscode-descriptionForeground); font-size: .82em; margin-top: 2px; }

  .tab-bar { display: flex; border-bottom: 2px solid var(--vscode-widget-border,#333); margin-bottom: 24px; }
  .tab-btn { padding: 8px 20px; background: none; border: none; cursor: pointer; font-family: inherit; font-size: .88em; font-weight: 500; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tab-btn:hover { color: var(--vscode-foreground); }
  .tab-btn.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder,#007acc); }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }

  .section { margin-bottom: 22px; }
  .section-title { font-size: .72em; text-transform: uppercase; letter-spacing: .07em; color: var(--vscode-descriptionForeground); font-weight: 700; margin-bottom: 12px; }
  .field { margin-bottom: 14px; }
  label.fl { display: block; margin-bottom: 5px; font-weight: 500; font-size: .9em; }
  .hint { font-size: .78em; color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.5; }
  input[type="text"], input[type="password"], select {
    width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border,#555); border-radius: 4px;
    padding: 7px 10px; font-family: inherit; font-size: inherit; outline: none;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }

  input[type="checkbox"], input[type="radio"] { width: 15px; height: 15px; cursor: pointer; accent-color: var(--vscode-button-background); }
  .radio-group { display: flex; flex-direction: column; gap: 8px; }
  .radio-row { display: flex; align-items: center; gap: 9px; }
  .radio-row label { font-size: .9em; cursor: pointer; }

  .status-list { margin-top: 12px; padding: 13px 14px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; display: none; }
  .status-list.show { display: block; }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(175px,1fr)); gap: 7px; }
  .status-check { display: flex; align-items: center; gap: 7px; }
  .status-check label { font-size: .87em; cursor: pointer; }
  .status-hint { font-size: .8em; color: var(--vscode-descriptionForeground); margin-bottom: 9px; }

  .member-list { margin-top: 10px; display: none; }
  .member-list.show { display: block; }
  .member-hint { font-size: .78em; color: var(--vscode-descriptionForeground); margin-bottom: 7px; }

  .loading-text { font-size: .84em; color: var(--vscode-descriptionForeground); font-style: italic; }
  .empty-text   { font-size: .84em; color: var(--vscode-descriptionForeground); }

  .btn-row { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 6px; }
  button.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 18px; cursor: pointer; font-family: inherit; font-size: .88em; font-weight: 500; }
  button.btn:hover { opacity: .87; }
  button.btn-sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.btn-sm { padding: 5px 12px; font-size: .82em; }
  .show-key { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: .79em; }
  .show-key:hover { text-decoration: underline; }

  .feedback { display: none; margin-top: 11px; padding: 9px 13px; border-radius: 4px; font-size: .87em; }
  .feedback.success { display: block; background: color-mix(in srgb,var(--vscode-testing-iconPassed) 12%,transparent); border-left: 3px solid var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
  .feedback.error   { display: block; background: color-mix(in srgb,var(--vscode-errorForeground) 12%,transparent); border-left: 3px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .feedback.info    { display: block; background: color-mix(in srgb,var(--vscode-charts-blue) 10%,transparent); border-left: 3px solid var(--vscode-charts-blue); color: var(--vscode-foreground); }
  .divider { border: none; border-top: 1px solid var(--vscode-widget-border,#333); margin: 20px 0; }
</style>
</head>
<body>

<div class="header">
  <img src="${e(logoSrc)}" alt="Redmine">
  <div class="header-text">
    <div class="logo">Redmine Connector</div>
    <div class="subtitle">Cấu hình kết nối và điều kiện lọc mặc định</div>
  </div>
</div>

<div class="tab-bar">
  <button class="tab-btn active" onclick="switchTab('conn',this)">⚙ Connection</button>
  <button class="tab-btn" onclick="switchTab('filters',this)">🔽 Default Filters</button>
</div>

<!-- TAB: Connection -->
<div class="tab-pane active" id="tab-conn">
  <div class="section">
    <div class="section-title">Redmine Server</div>
    <div class="field">
      <label class="fl" for="baseUrl">Redmine URL</label>
      <input type="text" id="baseUrl" value="${e(init.baseUrl)}" placeholder="https://redmine.company.com">
      <div class="hint">URL của Redmine server (không có / ở cuối)</div>
    </div>
    <div class="field">
      <label class="fl">API Key <button class="show-key" onclick="toggleKey(event)">show</button></label>
      <input type="password" id="apiKey" value="${e(init.apiKey)}" placeholder="Paste your API key here">
      <div class="hint">Redmine → tên user → <strong>My Account</strong> → <strong>API access key</strong> → Show</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-sec btn-sm" onclick="testConn()">⚡ Test Connection</button>
    </div>
    <div class="feedback" id="testFb"></div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">Text Format</div>
    <div class="radio-group">
      <div class="radio-row"><input type="radio" name="textFormat" id="tf-textile"  value="textile"  ${init.textFormat==="textile"?"checked":""}><label for="tf-textile">Textile <span style="color:var(--vscode-descriptionForeground);font-size:.85em">(Redmine mặc định)</span></label></div>
      <div class="radio-row"><input type="radio" name="textFormat" id="tf-markdown" value="markdown" ${init.textFormat==="markdown"?"checked":""}><label for="tf-markdown">Markdown</label></div>
      <div class="radio-row"><input type="radio" name="textFormat" id="tf-plain"    value="plain"    ${init.textFormat==="plain"?"checked":""}><label for="tf-plain">Plain text</label></div>
    </div>
  </div>

  <hr class="divider">
  <div class="btn-row"><button class="btn" onclick="save()">💾 Save Settings</button></div>
  <div class="feedback" id="saveFb1"></div>
</div>

<!-- TAB: Default Filters -->
<div class="tab-pane" id="tab-filters">

  <div class="feedback" id="reloadFb"></div>

  <div class="section" style="margin-top:16px">
    <div class="section-title">Default Project</div>
    <select id="defaultProject" onchange="onProjectChange()">
      <option value="">All Projects</option>
    </select>
    <div class="hint" style="margin-top:6px">Project hiển thị mặc định. Có thể override bằng filter trong sidebar.</div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">Default Status Filter</div>
    <div class="radio-group">
      <div class="radio-row"><input type="radio" name="sm" id="sm-open"   value="open"   ${init.defaultStatusMode==="open"?"checked":""}   onchange="onSmChange()"><label for="sm-open">Open issues <span style="color:var(--vscode-descriptionForeground);font-size:.85em">(mặc định)</span></label></div>
      <div class="radio-row"><input type="radio" name="sm" id="sm-closed" value="closed" ${init.defaultStatusMode==="closed"?"checked":""} onchange="onSmChange()"><label for="sm-closed">Closed issues</label></div>
      <div class="radio-row"><input type="radio" name="sm" id="sm-all"    value="*"      ${init.defaultStatusMode==="*"?"checked":""}      onchange="onSmChange()"><label for="sm-all">All statuses</label></div>
      <div class="radio-row"><input type="radio" name="sm" id="sm-custom" value="custom" ${init.defaultStatusMode==="custom"?"checked":""} onchange="onSmChange()"><label for="sm-custom">Custom — chọn cụ thể bên dưới</label></div>
    </div>

    <div class="status-list ${init.defaultStatusMode==="custom"?"show":""}" id="statusList">
      <div class="status-hint">Chọn một hoặc nhiều status muốn hiển thị mặc định:</div>
      <div class="status-grid" id="statusGrid"></div>
    </div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">Default Assignee</div>
    <div class="radio-group">
      <div class="radio-row"><input type="radio" name="am" id="am-all"    value="all"    ${init.defaultAssigneeMode==="all"?"checked":""}    onchange="onAmChange()"><label for="am-all">All — không lọc theo người</label></div>
      <div class="radio-row"><input type="radio" name="am" id="am-me"     value="me"     ${init.defaultAssigneeMode==="me"?"checked":""}     onchange="onAmChange()"><label for="am-me">Assigned to me</label></div>
      <div class="radio-row"><input type="radio" name="am" id="am-custom" value="custom" ${init.defaultAssigneeMode==="custom"?"checked":""} onchange="onAmChange()"><label for="am-custom">Cụ thể — chọn người bên dưới</label></div>
    </div>

    <div class="member-list ${init.defaultAssigneeMode==="custom"?"show":""}" id="memberList">
      <div class="member-hint">Chọn thành viên (cần chọn project mặc định trước):</div>
      <select id="defaultAssigneeId" style="width:100%">
        <option value="">— Chọn thành viên —</option>
      </select>
    </div>
  </div>

  <hr class="divider">
  <div class="btn-row">
    <button class="btn" onclick="save()">💾 Save Settings</button>
    <button class="btn btn-sec btn-sm" onclick="reloadAll()">🔄 Reload từ Redmine</button>
  </div>
  <div class="feedback" id="saveFb2"></div>
</div>

<!-- Feedback footer (always visible) -->
<div style="margin-top:32px;padding-top:16px;border-top:1px solid var(--vscode-widget-border,#333);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
  <span style="font-size:.78em;color:var(--vscode-descriptionForeground)">Have a suggestion or found a bug?</span>
  <button class="btn btn-sec btn-sm" onclick="vscode.postMessage({command:'openFeedback'})">📣 Send Feedback</button>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // Data injected at build time — no async round-trip needed
  const PROJECTS  = ${JSON.stringify(projects)};
  const STATUSES  = ${JSON.stringify(statuses)};
  const MEMBERS   = ${JSON.stringify(members)};
  const INIT_IDS  = ${JSON.stringify(init.defaultStatusIds)};
  const INIT_PROJ = ${JSON.stringify(init.defaultProject)};
  const INIT_AM   = ${JSON.stringify(init.defaultAssigneeMode)};
  const INIT_AID  = ${JSON.stringify(init.defaultAssigneeId)};

  let _membersLoaded = MEMBERS.length > 0;

  // Render immediately on load
  renderProjects(PROJECTS);
  renderStatuses(STATUSES);
  renderMembers(MEMBERS, INIT_AID);

  // ── Tab switching ──────────────────────────────────────────────────────────
  function switchTab(name, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'filters') {
      const projId = val('defaultProject');
      if (projId && !_membersLoaded) onProjectChange();
    }
  }

  function toggleKey(ev) {
    const inp = document.getElementById('apiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    ev.currentTarget.textContent = inp.type === 'password' ? 'show' : 'hide';
  }

  // ── Render helpers ──────────────────────────────────────────────────────────
  function renderProjects(list) {
    const sel = document.getElementById('defaultProject');
    sel.innerHTML = '<option value="">All Projects</option>';
    list.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      if (p.id === INIT_PROJ) o.selected = true;
      sel.appendChild(o);
    });
  }

  function renderStatuses(list) {
    const grid = document.getElementById('statusGrid');
    if (!list.length) {
      grid.innerHTML = '<span class="empty-text">Chưa load được — nhấn "Reload từ Redmine"</span>';
      return;
    }
    grid.innerHTML = '';
    list.forEach(s => {
      const wrap = document.createElement('div'); wrap.className = 'status-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'st-' + s.id; cb.value = s.id;
      cb.checked = INIT_IDS.includes(s.id);
      const lbl = document.createElement('label'); lbl.htmlFor = 'st-' + s.id;
      lbl.textContent = s.name + (s.is_closed ? ' (closed)' : '');
      lbl.style.cssText = 'font-size:.87em;cursor:pointer';
      wrap.appendChild(cb); wrap.appendChild(lbl); grid.appendChild(wrap);
    });
  }

  function renderMembers(list, selectedId) {
    const sel = document.getElementById('defaultAssigneeId');
    const currentVal = selectedId !== undefined ? selectedId : sel.value;
    sel.innerHTML = '<option value="">— Select member —</option>';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(No members — select a project first)'; o.disabled = true;
      sel.appendChild(o);
      _membersLoaded = false;
      return;
    }
    list.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.name;
      if (m.id === currentVal) o.selected = true;
      sel.appendChild(o);
    });
    _membersLoaded = true;
  }

  // ── Event handlers ──────────────────────────────────────────────────────────
  function onSmChange() {
    const v = document.querySelector('input[name="sm"]:checked')?.value;
    document.getElementById('statusList').classList.toggle('show', v === 'custom');
  }

  function onAmChange() {
    const v = document.querySelector('input[name="am"]:checked')?.value;
    document.getElementById('memberList').classList.toggle('show', v === 'custom');
  }

  function onProjectChange() {
    const projId = document.getElementById('defaultProject').value;
    if (!projId) { renderMembers([], ''); return; }
    vscode.postMessage({ command: 'fetchMembers', projectId: projId });
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function testConn() {
    showFb('testFb', 'info', 'Testing…');
    vscode.postMessage({ command: 'testConnection', baseUrl: val('baseUrl'), apiKey: val('apiKey') });
  }

  function reloadAll() {
    showFb('reloadFb', 'info', 'Loading từ Redmine…');
    vscode.postMessage({
      command: 'reloadOptions',
      baseUrl: val('baseUrl'),
      apiKey: val('apiKey'),
      selectedProject: val('defaultProject'),
    });
  }

  function save() {
    const sm = document.querySelector('input[name="sm"]:checked')?.value ?? 'open';
    const am = document.querySelector('input[name="am"]:checked')?.value ?? 'all';
    const ids = sm === 'custom'
      ? Array.from(document.querySelectorAll('#statusGrid input:checked')).map(c => c.value)
      : [];
    const tf = document.querySelector('input[name="textFormat"]:checked')?.value ?? 'textile';

    const projSel = document.getElementById('defaultProject');
    const projId   = projSel.value;
    const projName = projSel.selectedIndex >= 0 ? projSel.options[projSel.selectedIndex].text : '';

    const memberSel = document.getElementById('defaultAssigneeId');
    const assigneeId   = am === 'custom' ? memberSel.value : '';
    const assigneeName = (am === 'custom' && memberSel.selectedIndex >= 0)
      ? memberSel.options[memberSel.selectedIndex].text : '';

    if (am === 'custom' && !assigneeId) {
      showFb('saveFb2', 'error', 'Please select a member for custom assignee mode. If the list is empty, select a project first.');
      showFb('saveFb1', 'error', 'Please select a member for custom assignee mode.');
      return;
    }

    vscode.postMessage({
      command: 'save',
      baseUrl:              val('baseUrl'),
      apiKey:               val('apiKey'),
      defaultProject:       projId,
      defaultProjectName:   projId ? projName : '',
      textFormat:           tf,
      defaultStatusMode:    sm,
      defaultStatusIds:     ids,
      defaultAssigneeMode:  am,
      defaultAssigneeId:    assigneeId,
      defaultAssigneeName:  assigneeName,
    });
  }

  function val(id) { return document.getElementById(id)?.value ?? ''; }

  function showFb(id, type, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'feedback ' + type; el.textContent = msg;
  }

  // ── Messages from extension ────────────────────────────────────────────────
  window.addEventListener('message', ev => {
    const msg = ev.data;

    if (msg.command === 'testResult') {
      showFb('testFb', msg.success ? 'success' : 'error', msg.message);
    }

    if (msg.command === 'reloadResult') {
      renderProjects(msg.projects);
      renderStatuses(msg.statuses);
      renderMembers(msg.members, INIT_AID);
      showFb('reloadFb', 'success', '✓ Updated from Redmine.');
    }

    if (msg.command === 'reloadError') {
      showFb('reloadFb', 'error', msg.message);
    }

    if (msg.command === 'membersResult') {
      renderMembers(msg.members, undefined);
    }

    if (msg.command === 'saved') {
      ['saveFb1','saveFb2'].forEach(id => {
        showFb(id, 'success', '✓ Đã lưu! Sidebar sẽ tự refresh.');
        setTimeout(() => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }, 3000);
      });
    }
  });
</script>
</body>
</html>`;
}
