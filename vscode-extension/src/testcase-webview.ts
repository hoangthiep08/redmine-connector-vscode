import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CreateIssueWebview } from "./create-issue-webview";

interface TC {
  tcId: string;
  category: string;
  module: string;
  scenario: string;
  priority: string;
  steps: string;
  expected: string;
  actual: string;
  statusQc: string;
  date: string;
  line: number;
}

interface LinkedIssue {
  issueId: number;
  subject: string;
  line: number;
  createdAt: string;
}

type IssueLinkMap = Record<string, LinkedIssue>;

const STORAGE_KEY = "testCaseIssueMap";

function mapKey(filePath: string, tcId: string): string {
  return `${filePath}::${tcId}`;
}

function parseMarkdownTable(content: string): TC[] {
  const lines = content.split("\n");
  let headerIdx = -1;
  const colMap: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("|") && line.includes("TC ID")) {
      headerIdx = i;
      const parts = line.split("|").slice(1, -1);
      parts.forEach((h, idx) => {
        colMap[h.trim().toLowerCase()] = idx;
      });
      break;
    }
  }

  if (headerIdx === -1 || colMap["tc id"] === undefined) return [];

  const tcs: TC[] = [];

  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;

    const cells = line.split("|").slice(1, -1);
    if (cells.length < 3) continue;

    const get = (name: string): string => {
      const idx = colMap[name.toLowerCase()];
      return idx !== undefined ? (cells[idx] ?? "").trim() : "";
    };

    const tcId = get("tc id");
    if (!tcId || /^:?-+:?$/.test(tcId)) continue;

    tcs.push({
      tcId,
      category: get("category"),
      module: get("module"),
      scenario: get("test scenario"),
      priority: get("priority"),
      steps: get("steps"),
      expected: get("expected"),
      actual: get("actual"),
      statusQc: get("status qc"),
      date: get("date"),
      line: i + 1,
    });
  }

  return tcs;
}

function formatDescription(tc: TC): string {
  const br2nl = (s: string) => s.replace(/<br\s*\/?>/gi, "\n");
  const lines: string[] = [
    `TC ID: ${tc.tcId}`,
    `Category: ${tc.category}`,
    `Module: ${tc.module}`,
    `Priority: ${tc.priority}`,
    "",
  ];
  if (tc.steps) {
    lines.push("Steps:");
    lines.push(br2nl(tc.steps));
    lines.push("");
  }
  if (tc.expected) {
    lines.push("Expected:");
    lines.push(br2nl(tc.expected));
    lines.push("");
  }
  if (tc.actual) {
    lines.push("Actual:");
    lines.push(br2nl(tc.actual));
  }
  return lines.join("\n");
}

function e(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TestCaseWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentFilePath: string | null = null;
  private currentFileName: string | null = null;
  private currentTcs: TC[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly createIssueWebview: CreateIssueWebview,
  ) {}

  private getLinkMap(): IssueLinkMap {
    return this.context.globalState.get<IssueLinkMap>(STORAGE_KEY) ?? {};
  }

  private rerender() {
    if (!this.panel || !this.currentFilePath) return;
    this.panel.webview.html = buildHtml(
      this.currentFileName!,
      this.currentFilePath,
      this.currentTcs,
      this.getLinkMap(),
    );
  }

  async show(uri?: vscode.Uri) {
    let filePath: string | undefined;

    if (uri) {
      filePath = uri.fsPath;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.fileName.endsWith(".md")) {
        filePath = editor.document.fileName;
      } else {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { Markdown: ["md"] },
          title: "Open Test Case File",
        });
        if (!uris || uris.length === 0) return;
        filePath = uris[0].fsPath;
      }
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to read file: ${err}`);
      return;
    }

    const tcs = parseMarkdownTable(content);
    if (tcs.length === 0) {
      vscode.window.showWarningMessage(
        "No test case table found. Make sure the file has a table with a 'TC ID' column."
      );
      return;
    }

    const fileName = path.basename(filePath);
    this.currentFilePath = filePath;
    this.currentFileName = fileName;
    this.currentTcs = tcs;

    if (this.panel) {
      this.panel.title = `Test Cases — ${fileName}`;
      this.rerender();
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "redmineTestCase",
      `Test Cases — ${fileName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => { this.panel = null; });
    this.rerender();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === "createIssue") {
        const tc = msg.tc as TC;
        const filePath = this.currentFilePath;
        if (!filePath) return;
        await this.createIssueWebview.show(
          {
            subject: `[${tc.tcId}] ${tc.scenario}`,
            description: formatDescription(tc),
            trackerName: "Bug",
            statusName: "New",
          },
          (issueId, subject) => {
            const map = this.getLinkMap();
            map[mapKey(filePath, tc.tcId)] = {
              issueId,
              subject,
              line: tc.line,
              createdAt: new Date().toISOString(),
            };
            this.context.globalState.update(STORAGE_KEY, map);
            this.rerender();
          },
        );
      }

      if (msg.command === "openIssue") {
        vscode.commands.executeCommand("redmine.openIssue", { issue: { id: msg.issueId as number } });
      }

      if (msg.command === "unlinkIssue") {
        if (!this.currentFilePath) return;
        const map = this.getLinkMap();
        delete map[mapKey(this.currentFilePath, msg.tcId as string)];
        await this.context.globalState.update(STORAGE_KEY, map);
        this.rerender();
      }
    });
  }
}

function buildHtml(fileName: string, filePath: string, tcs: TC[], linkMap: IssueLinkMap): string {
  const linksForFile: Record<string, LinkedIssue> = {};
  for (const tc of tcs) {
    const linked = linkMap[mapKey(filePath, tc.tcId)];
    if (linked) linksForFile[tc.tcId] = linked;
  }
  const failCount     = tcs.filter(t => t.statusQc.toLowerCase() === "fail").length;
  const passCount     = tcs.filter(t => t.statusQc.toLowerCase() === "pass").length;
  const skipCount     = tcs.filter(t => ["skip", "skipped"].includes(t.statusQc.toLowerCase())).length;
  const blockedCount  = tcs.filter(t => t.statusQc.toLowerCase() === "blocked").length;
  const notTestedCount = tcs.filter(t => !t.statusQc || t.statusQc === "—").length;

  const tcJson    = JSON.stringify(tcs).replace(/<\//g, "<\\/");
  const linksJson = JSON.stringify(linksForFile).replace(/<\//g, "<\\/");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test Cases</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .page-header {
    padding: 14px 24px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    position: sticky; top: 0; z-index: 10;
    background: var(--vscode-editor-background);
  }
  .page-header .title { font-size: 1.05em; font-weight: 700; }
  .page-header .sub { font-size: .78em; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  .summary-bar {
    display: flex; flex-wrap: wrap; gap: 10px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    align-items: center;
  }
  .stat-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border-radius: 12px;
    font-size: .82em; font-weight: 700;
  }
  .stat-badge.fail    { background: color-mix(in srgb, #e05353 15%, transparent); color: #e05353; }
  .stat-badge.pass    { background: color-mix(in srgb, #4ec974 15%, transparent); color: #4ec974; }
  .stat-badge.skip    { background: color-mix(in srgb, #f0a500 15%, transparent); color: #f0a500; }
  .stat-badge.blocked { background: color-mix(in srgb, #a57bf8 15%, transparent); color: #a57bf8; }
  .stat-badge.none    { background: color-mix(in srgb, #888 15%, transparent); color: #888; }

  .table-wrap {
    padding: 16px 24px 48px;
    max-width: 100%;
    overflow-x: auto;
  }
  table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    font-size: .875em;
  }
  th {
    text-align: left; padding: 7px 10px;
    border-bottom: 2px solid var(--vscode-widget-border, #444);
    font-size: .72em; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground); font-weight: 700;
    white-space: nowrap;
  }
  td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
    vertical-align: top;
  }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.fail-row td { background: color-mix(in srgb, #e05353 5%, transparent); }
  tr.fail-row:hover td { background: color-mix(in srgb, #e05353 10%, transparent); }

  .tc-id { font-family: monospace; font-size: .82em; white-space: nowrap; color: var(--vscode-textLink-foreground); }
  .scenario { max-width: 320px; }
  .module { white-space: nowrap; font-size: .82em; color: var(--vscode-descriptionForeground); }

  .priority-badge {
    display: inline-block; padding: 2px 7px; border-radius: 4px;
    font-size: .72em; font-weight: 700; white-space: nowrap;
  }
  .priority-badge.crit { background: color-mix(in srgb,#e05353 15%,transparent); color: #e05353; }
  .priority-badge.high { background: color-mix(in srgb,#f0a500 15%,transparent); color: #f0a500; }
  .priority-badge.med  { background: color-mix(in srgb,#4ec974 15%,transparent); color: #4ec974; }
  .priority-badge.low  { background: color-mix(in srgb,#888 15%,transparent); color: #888; }

  .status-badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: .78em; font-weight: 700; white-space: nowrap;
  }
  .status-badge.fail    { background: color-mix(in srgb,#e05353 20%,transparent); color: #e05353; border: 1px solid color-mix(in srgb,#e05353 40%,transparent); }
  .status-badge.pass    { background: color-mix(in srgb,#4ec974 20%,transparent); color: #4ec974; }
  .status-badge.skip    { background: color-mix(in srgb,#f0a500 20%,transparent); color: #f0a500; }
  .status-badge.blocked { background: color-mix(in srgb,#a57bf8 20%,transparent); color: #a57bf8; }
  .status-badge.none    { background: color-mix(in srgb,#888 15%,transparent); color: #888; }

  .btn-create {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: .8em; font-weight: 600;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    white-space: nowrap;
    transition: opacity .12s;
  }
  .btn-create:hover { opacity: .85; }

  .issue-link {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px; border-radius: 4px;
    font-family: monospace; font-size: .82em; font-weight: 700;
    background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
    color: var(--vscode-textLink-foreground);
    text-decoration: none; cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 35%, transparent);
  }
  .issue-link:hover { background: color-mix(in srgb, var(--vscode-textLink-foreground) 22%, transparent); }
  .issue-unlink {
    background: transparent; border: none; cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: .78em; padding: 2px 4px;
  }
  .issue-unlink:hover { color: var(--vscode-errorForeground); }
</style>
</head>
<body>

<div class="page-header">
  <div class="title">Test Case Report</div>
  <div class="sub">${e(fileName)}</div>
</div>

<div class="summary-bar">
  ${failCount     > 0 ? `<span class="stat-badge fail">✗ ${failCount} Failed</span>` : ""}
  ${passCount     > 0 ? `<span class="stat-badge pass">✓ ${passCount} Passed</span>` : ""}
  ${skipCount     > 0 ? `<span class="stat-badge skip">⊘ ${skipCount} Skipped</span>` : ""}
  ${blockedCount  > 0 ? `<span class="stat-badge blocked">⊡ ${blockedCount} Blocked</span>` : ""}
  ${notTestedCount > 0 ? `<span class="stat-badge none">— ${notTestedCount} Not Tested</span>` : ""}
  <span style="font-size:.78em;color:var(--vscode-descriptionForeground);margin-left:4px">Total: ${tcs.length}</span>
</div>

<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th style="width:1%">Action</th>
      <th>TC ID</th>
      <th>Module</th>
      <th>Test Scenario</th>
      <th>Priority</th>
      <th>Status QC</th>
      <th>Date</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
</div>

<script>
const vscode = acquireVsCodeApi();
const TCS   = ${tcJson};
const LINKS = ${linksJson};

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function priorityClass(p) {
  const lp = (p || '').toLowerCase();
  if (lp === 'crit') return 'crit';
  if (lp === 'high') return 'high';
  if (lp === 'med' || lp === 'medium') return 'med';
  return 'low';
}

function statusClass(s) {
  const ls = (s || '').toLowerCase();
  if (ls === 'fail') return 'fail';
  if (ls === 'pass') return 'pass';
  if (ls === 'skip' || ls === 'skipped') return 'skip';
  if (ls === 'blocked') return 'blocked';
  return 'none';
}

function render() {
  const tbody = document.getElementById('tbody');
  let html = '';
  TCS.forEach(function(tc, i) {
    const sc = statusClass(tc.statusQc);
    const isFail = sc === 'fail';
    const rowClass = isFail ? 'fail-row' : '';
    html += '<tr class="' + rowClass + '">';
    html += '<td>';
    const linked = LINKS[tc.tcId];
    if (linked) {
      html += '<a class="issue-link" onclick="openIssue(' + linked.issueId + ')" title="' + escHtml(linked.subject) + '">'
        + '#' + linked.issueId + '</a>'
        + '<button class="issue-unlink" onclick="unlinkIssue(\\'' + escHtml(tc.tcId) + '\\')" title="Unlink issue">×</button>';
    } else if (isFail) {
      html += '<button class="btn-create" onclick="createIssue(' + i + ')">✚ Create Issue</button>';
    }
    html += '</td>';
    html += '<td><span class="tc-id">' + escHtml(tc.tcId) + '</span></td>';
    html += '<td><span class="module">' + escHtml(tc.module || tc.category) + '</span></td>';
    html += '<td><div class="scenario">' + escHtml(tc.scenario) + '</div></td>';
    html += '<td><span class="priority-badge ' + priorityClass(tc.priority) + '">' + escHtml(tc.priority || '—') + '</span></td>';
    html += '<td><span class="status-badge ' + sc + '">' + escHtml(tc.statusQc || '—') + '</span></td>';
    html += '<td style="font-size:.78em;color:var(--vscode-descriptionForeground);white-space:nowrap">' + escHtml(tc.date || '') + '</td>';
    html += '</tr>';
  });
  tbody.innerHTML = html;
}

function createIssue(idx) {
  vscode.postMessage({ command: 'createIssue', tc: TCS[idx] });
}

function openIssue(issueId) {
  vscode.postMessage({ command: 'openIssue', issueId: issueId });
}

function unlinkIssue(tcId) {
  if (!confirm('Unlink this issue from the test case? You can recreate it later.')) return;
  vscode.postMessage({ command: 'unlinkIssue', tcId: tcId });
}

render();
</script>
</body>
</html>`;
}
