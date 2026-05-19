import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CreateIssueWebview } from "./create-issue-webview";
import type { CustomFieldConfigEntry } from "./settings-webview";
import type { TrackerFieldCacheEntry } from "./extension";

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
  browser?: string;
  device?: string;
  evidence?: string;
  typeBug?: string;
  foundIn?: string;
  rootCause?: string;
  /**
   * Raw column map captured straight from the markdown header row, keyed by the
   * header text as the user wrote it ("TC ID", "Page/Screen", "Status 2 (QC)", …).
   * Anything the legacy hardcoded fields don't cover ends up here and is
   * available to templates as `{{Header Name}}`.
   */
  _columns?: Record<string, string>;
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
  const headerTexts: string[] = []; // original header text, preserving case + spacing

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("|") && line.includes("TC ID")) {
      headerIdx = i;
      const parts = line.split("|").slice(1, -1);
      parts.forEach((h, idx) => {
        const text = h.trim();
        headerTexts.push(text);
        colMap[text.toLowerCase()] = idx;
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

    // Flexible match: exact first, then any column name that contains the keyword
    const find = (...keywords: string[]): string => {
      for (const kw of keywords) {
        const v = get(kw);
        if (v) return v;
      }
      for (const kw of keywords) {
        const key = Object.keys(colMap).find(k => k.includes(kw.toLowerCase()));
        if (key !== undefined) return (cells[colMap[key]] ?? "").trim();
      }
      return "";
    };

    const tcId = get("tc id");
    if (!tcId || /^:?-+:?$/.test(tcId)) continue;

    // Capture every column straight from the header row, regardless of whether
    // the hardcoded TC fields below cover it. This is what powers the template
    // builder's "Available Columns" list and {{Header Name}} interpolation.
    const _columns: Record<string, string> = {};
    headerTexts.forEach((h, idx) => {
      _columns[h] = (cells[idx] ?? "").trim();
    });

    tcs.push({
      tcId,
      category: find("category"),
      module: find("module"),
      scenario: find("test scenario", "scenario"),
      priority: find("priority"),
      steps: find("steps"),
      expected: find("expected"),
      actual: find("actual"),
      statusQc: find("status qc"),
      date: find("date"),
      line: i + 1,
      browser:   find("browser", "browsers")                         || undefined,
      device:    find("device", "devices", "platform", "os")        || undefined,
      evidence:  find("evidence", "screenshot", "attachment")       || undefined,
      typeBug:   find("type bug", "bug type")                       || undefined,
      foundIn:   find("found in", "found_in", "foundin")            || undefined,
      rootCause: find("root cause", "root_cause", "rootcause")      || undefined,
      _columns,
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
  ];
  if (tc.browser) lines.push(`Browser: ${tc.browser}`);
  if (tc.device)  lines.push(`Device: ${tc.device}`);
  lines.push("");
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

function interpolateTemplate(template: string, tc: TC): string {
  const tcRecord = tc as unknown as Record<string, unknown>;
  const cols = (tc._columns ?? {}) as Record<string, string>;
  // Case-insensitive header lookup: "tc id" → "TC ID" → cell value
  const colLookup: Record<string, string> = {};
  for (const [k, v] of Object.entries(cols)) colLookup[k.toLowerCase()] = v ?? "";

  /** Look up a placeholder `{{key}}` against TC's camelCase fields then raw headers. */
  const lookup = (rawKey: string): { value: string; found: boolean } => {
    const key = rawKey.trim();
    // 1) Legacy camelCase property on TC (tcId, module, foundIn, …)
    if (key && key !== "_columns" && key in tcRecord) {
      const v = tcRecord[key];
      const s = (typeof v === "string" ? v : String(v ?? "")).trim();
      return { value: s, found: s.length > 0 };
    }
    // 2) Raw header text (case-insensitive)
    const lower = key.toLowerCase();
    if (lower in colLookup) {
      const s = (colLookup[lower] || "").trim();
      return { value: s, found: s.length > 0 };
    }
    return { value: "", found: false };
  };

  const lines = template.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    let interpolated = line;
    let hasEmptyKey = false;
    const placeholders = line.match(/\{\{[^}]+\}\}/g) ?? [];
    for (const ph of placeholders) {
      const key = ph.slice(2, -2);
      const r = lookup(key);
      if (!r.found) { hasEmptyKey = true; break; }
      interpolated = interpolated.split(ph).join(r.value);
    }
    if (!hasEmptyKey) output.push(interpolated);
  }

  // Remove consecutive blank lines
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseEvidenceAttachments(
  evidenceCell: string,
  mdDir: string,
): { data: string; filename: string; contentType: string }[] {
  const br2nl = (s: string) => s.replace(/<br\s*\/?>/gi, "\n");
  const text = br2nl(evidenceCell);
  const found = new Set<string>();

  // Markdown image: ![alt](path)
  const mdRe = /!\[.*?\]\((.+?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text)) !== null) found.add(m[1].trim());

  // Bare image path tokens
  for (const token of text.split(/[\n,;]/)) {
    const t = token.trim();
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(t) && !t.startsWith("!"))
      found.add(t);
  }

  const results: { data: string; filename: string; contentType: string }[] = [];
  for (const imgPath of found) {
    const fullPath = path.isAbsolute(imgPath) ? imgPath : path.resolve(mdDir, imgPath);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const data = fs.readFileSync(fullPath).toString("base64");
      const ext = path.extname(fullPath).toLowerCase().replace(".", "");
      const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      results.push({ data, filename: path.basename(fullPath), contentType });
    } catch { /* skip unreadable files */ }
  }
  return results;
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
    const cfg = vscode.workspace.getConfiguration("redmine");
    const template = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};
    const hasTemplate = Object.keys(template).length > 0;
    const customFieldConfig = this.context.globalState.get<CustomFieldConfigEntry[]>("customFieldConfig") ?? [];
    const trackerFieldCache = this.context.globalState.get<TrackerFieldCacheEntry[]>("trackerFieldCache") ?? [];
    const detect = {
      include: cfg.get<string[]>("issueDetection.include") ?? ["NG", "Fail"],
      exclude: cfg.get<string[]>("issueDetection.exclude") ?? [],
    };
    this.panel.webview.html = buildHtml(
      this.currentFileName!,
      this.currentFilePath,
      this.currentTcs,
      this.getLinkMap(),
      hasTemplate,
      template,
      customFieldConfig,
      trackerFieldCache,
      detect,
    );
  }

  async show(uri?: vscode.Uri) {
    // Check if template exists
    const cfg = vscode.workspace.getConfiguration("redmine");
    const template = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};
    const hasTemplate = Object.keys(template).length > 0;

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
      if (msg.command === "saveTemplate") {
        const template = msg.template as Record<string, unknown>;
        const cfg = vscode.workspace.getConfiguration("redmine");
        await cfg.update("testCaseTemplate", template, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("✓ Test case template saved");
        // Notify all webviews (including settings) that template was saved
        vscode.commands.executeCommand("redmine.refresh");
        this.rerender();
      }

      if (msg.command === "clearTemplate") {
        const cfg = vscode.workspace.getConfiguration("redmine");
        const existing = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};
        if (Object.keys(existing).length === 0) {
          vscode.window.showInformationMessage("Template is already empty.");
          this.panel?.webview.postMessage({ command: "templateCleared" });
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          "This will delete your current test case template. All fields and custom field mappings will be wiped. Continue?",
          { modal: true },
          "Clear",
        );
        if (confirm !== "Clear") return;
        await cfg.update("testCaseTemplate", {}, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("✓ Template cleared.");
        this.panel?.webview.postMessage({ command: "templateCleared" });
        this.rerender();
      }

      if (msg.command === "exportTemplate") {
        const cfg = vscode.workspace.getConfiguration("redmine");
        const template = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};
        if (Object.keys(template).length === 0) {
          vscode.window.showWarningMessage("No template to export.");
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(defaultDir, `redmine-template-${today}.json`)),
          filters: { "JSON": ["json"] },
          saveLabel: "Export",
        });
        if (!uri) return;
        const payload = { version: 1, kind: "redmine-connector.testCaseTemplate", exportedAt: new Date().toISOString(), template };
        try {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
          vscode.window.showInformationMessage(`✓ Template exported → ${uri.fsPath}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
      }

      if (msg.command === "importTemplate") {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "JSON": ["json"] },
          openLabel: "Import",
        });
        if (!uris || uris.length === 0) return;
        let parsed: { template?: Record<string, unknown> } | Record<string, unknown>;
        try {
          const buf = await vscode.workspace.fs.readFile(uris[0]);
          parsed = JSON.parse(Buffer.from(buf).toString("utf8"));
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to read file: ${String(err)}`);
          return;
        }
        const imported = (parsed && typeof parsed === "object" && "template" in parsed && parsed.template)
          ? parsed.template as Record<string, unknown>
          : parsed as Record<string, unknown>;
        if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
          vscode.window.showErrorMessage("Invalid template file.");
          return;
        }
        const cfg = vscode.workspace.getConfiguration("redmine");
        const existing = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};
        if (Object.keys(existing).length > 0) {
          const confirm = await vscode.window.showWarningMessage(
            "This will REPLACE your current test case template. Continue?",
            { modal: true },
            "Import",
          );
          if (confirm !== "Import") return;
        }
        const cache = this.context.globalState.get<TrackerFieldCacheEntry[]>("trackerFieldCache") ?? [];
        const trackerName = typeof imported.tracker === "string" ? imported.tracker : "";
        const localTracker = trackerName ? cache.find((t) => t.trackerName === trackerName) : undefined;
        const normalized: Record<string, unknown> = { ...imported };
        if (localTracker) normalized.trackerId = localTracker.trackerId;
        await cfg.update("testCaseTemplate", normalized, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage("✓ Template imported.");
        this.rerender();
      }

      if (msg.command === "createIssue") {
        const tc = msg.tc as TC;
        const filePath = this.currentFilePath;
        if (!filePath) return;

        const mdDir = path.dirname(filePath);
        const preAttachments = tc.evidence ? parseEvidenceAttachments(tc.evidence, mdDir) : [];

        const customFieldValues: Record<string, string> = {};

        // Get template and apply it
        const cfg = vscode.workspace.getConfiguration("redmine");
        const template = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};

        let subject = `[${tc.tcId}] ${tc.scenario}`;
        let description = formatDescription(tc);
        let trackerName = "Bug";
        let statusName = "New";
        // Names the template explicitly opted into — used to restrict the create-issue
        // form to ONLY these fields (rather than every CF configured for the tracker).
        let templateCfNames: string[] = [];

        if (Object.keys(template).length > 0) {
          if (template.subject) subject = interpolateTemplate(String(template.subject), tc);
          if (template.description) description = interpolateTemplate(String(template.description), tc);
          if (template.tracker) trackerName = String(template.tracker);
          if (template.status) statusName = String(template.status);

          // Apply custom fields from template
          const templateCf = ((template.customFields as Record<string, string> | undefined) ?? {});
          templateCfNames = Object.keys(templateCf);
          const trackerId = template.trackerId ? Number(template.trackerId) : 0;
          const customFieldConfig = this.context.globalState.get<CustomFieldConfigEntry[]>("customFieldConfig") ?? [];
          const trackerCfg = customFieldConfig.find((c) => c.trackerId === trackerId);

          for (const [fieldName, fieldTpl] of Object.entries(templateCf)) {
            if (!fieldTpl) continue;
            const interpolated = interpolateTemplate(fieldTpl, tc).trim();
            if (!interpolated) continue;

            // Validate select-type fields against configured options:
            // if value matches an option (case-insensitive) → use the canonical
            // option text; otherwise skip (don't send).
            const fieldDef = trackerCfg?.fields.find((f) => f.name === fieldName);
            if (fieldDef?.type === "select") {
              const canonical = fieldDef.options.find((o) => o.trim().toLowerCase() === interpolated.toLowerCase());
              if (canonical) {
                customFieldValues[fieldName] = canonical;
              }
              // else: skip — value not in configured options
            } else {
              customFieldValues[fieldName] = interpolated;
            }
          }
        }

        await this.createIssueWebview.show(
          {
            subject,
            description,
            trackerName,
            statusName,
            customFieldValues: Object.keys(customFieldValues).length ? customFieldValues : undefined,
            customFieldNames: templateCfNames.length ? templateCfNames : undefined,
            preAttachments: preAttachments.length ? preAttachments : undefined,
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

function buildHtml(fileName: string, filePath: string, tcs: TC[], linkMap: IssueLinkMap, hasTemplate: boolean, template: Record<string, unknown>, customFieldConfig: CustomFieldConfigEntry[], trackerFieldCache: TrackerFieldCacheEntry[], detect: { include: string[]; exclude: string[] }): string {
  const isFailableServer = (statusQc: string): boolean => {
    const s = (statusQc || "").toLowerCase();
    if ((detect.exclude || []).some((k) => k && s.includes(k.toLowerCase()))) return false;
    return (detect.include || []).some((k) => k && s.includes(k.toLowerCase()));
  };

  const linksForFile: Record<string, LinkedIssue> = {};
  for (const tc of tcs) {
    const linked = linkMap[mapKey(filePath, tc.tcId)];
    if (linked) linksForFile[tc.tcId] = linked;
  }
  const failCount  = tcs.filter(t => isFailableServer(t.statusQc)).length;
  const otherCount = tcs.length - failCount;

  // Available columns are taken straight from the markdown header row (preserved
  // in `tc._columns`). This is the only way to surface headers the legacy
  // TC interface doesn't cover (Page/Screen, PC, SP, Q&A, Status 2 (QC), …).
  // A column shows up only if at least one TC has a non-empty value for it.
  const headerOrder: string[] = [];
  const seenHeaders = new Set<string>();
  for (const t of tcs) {
    const cols = (t._columns ?? {}) as Record<string, string>;
    for (const h of Object.keys(cols)) {
      if (!seenHeaders.has(h)) { seenHeaders.add(h); headerOrder.push(h); }
    }
  }
  const availableColumns = headerOrder.filter((h) =>
    tcs.some((t) => {
      const v = (t._columns ?? {})[h];
      return v !== undefined && v !== null && String(v).trim() !== "";
    }),
  );
  const sampleData: Record<string, string> = {};
  availableColumns.forEach((col) => {
    const sampleTc = tcs.find((t) => {
      const v = (t._columns ?? {})[col];
      return v !== undefined && v !== null && String(v).trim() !== "";
    });
    const val = sampleTc ? (sampleTc._columns ?? {})[col] : "";
    sampleData[col] = typeof val === "string" ? val.substring(0, 50) : String(val ?? "").substring(0, 50);
  });

  const tcJson    = JSON.stringify(tcs).replace(/<\//g, "<\\/");
  const linksJson = JSON.stringify(linksForFile).replace(/<\//g, "<\\/");
  const colsJson  = JSON.stringify(availableColumns).replace(/<\//g, "<\\/");
  const sampleJson = JSON.stringify(sampleData).replace(/<\//g, "<\\/");
  const templateJson = JSON.stringify(template).replace(/<\//g, "<\\/");
  const cfConfigJson = JSON.stringify(customFieldConfig).replace(/<\//g, "<\\/");
  const trackerCacheJson = JSON.stringify(trackerFieldCache).replace(/<\//g, "<\\/");
  const detectJson = JSON.stringify(detect).replace(/<\//g, "<\\/");

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
  .hdr-btn { padding: 6px 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-widget-border, #444); border-radius: 4px; cursor: pointer; font-size: .82em; font-weight: 500; white-space: nowrap; font-family: inherit; }
  .hdr-btn:hover { opacity: .87; }
  .hdr-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; font-size: .85em; }

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

  .warning-banner {
    background: color-mix(in srgb, #f0a500 12%, transparent);
    border-left: 3px solid #f0a500;
    color: var(--vscode-foreground);
    padding: 10px 16px;
    margin: 12px 24px;
    border-radius: 4px;
    font-size: .85em;
    line-height: 1.5;
  }

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
  .btn-create:disabled {
    opacity: .4; cursor: not-allowed;
  }

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

  /* Confirm modal */
  .modal-backdrop {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.45); z-index: 100;
    align-items: center; justify-content: center;
  }
  .modal-backdrop.open { display: flex; }
  .modal-box {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 8px; padding: 20px 24px;
    max-width: 340px; width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  .modal-title { font-weight: 700; margin-bottom: 8px; font-size: 1em; }
  .modal-body  { font-size: .88em; color: var(--vscode-descriptionForeground); margin-bottom: 18px; line-height: 1.5; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .modal-btn {
    padding: 5px 16px; border-radius: 4px; border: none; cursor: pointer;
    font-family: inherit; font-size: .85em; font-weight: 600;
  }
  .modal-btn.cancel {
    background: var(--vscode-button-secondaryBackground, #3c3c3c);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }
  .modal-btn.danger {
    background: #c0392b; color: #fff;
  }
  .modal-btn:hover { opacity: .85; }
</style>
</head>
<body>

<div class="modal-backdrop" id="confirmModal">
  <div class="modal-box">
    <div class="modal-title">Unlink Issue</div>
    <div class="modal-body" id="confirmModalBody"></div>
    <div class="modal-actions">
      <button class="modal-btn cancel" onclick="closeModal()">Cancel</button>
      <button class="modal-btn danger" id="confirmModalOk">Unlink</button>
    </div>
  </div>
</div>

<!-- Template Builder Modal -->
<div class="modal-backdrop" id="templateModal">
  <div class="modal-box" style="max-width:900px;max-height:85vh;overflow-y:auto;display:flex;flex-direction:column">
    <div class="modal-title">Test Case → Issue Template</div>
    <div class="modal-body" style="flex:1;overflow-y:auto;display:grid;grid-template-columns:200px 1fr;gap:20px;min-width:0">
      <!-- Left: Available Columns -->
      <div style="min-width:0;overflow-y:auto;padding-right:8px">
        <div style="font-weight:600;font-size:.9em;margin-bottom:10px">Available Columns</div>
        <div style="display:flex;flex-direction:column;gap:10px" id="columnsList">
          ${availableColumns.map(col => `<div style="border:1px solid var(--vscode-widget-border);border-radius:4px;padding:8px;background:var(--vscode-editor-inactiveSelectionBackground)">
            <div draggable="true" ondragstart="dragColumn(event,'{{${col}}}')" style="padding:4px 6px;background:color-mix(in srgb,var(--vscode-button-background) 30%,transparent);border:1px solid var(--vscode-button-background);border-radius:3px;cursor:move;font-family:monospace;font-size:.8em;user-select:none;margin-bottom:4px" title="${col}"><strong>${col}</strong></div>
            <div style="font-size:.75em;color:var(--vscode-descriptionForeground);font-family:monospace;word-break:break-word;line-height:1.3">${e(sampleData[col] || '(empty)')}</div>
          </div>`).join('')}
        </div>
      </div>

      <!-- Right: Template Fields -->
      <div style="min-width:0">
        <div style="font-weight:600;font-size:.9em;margin-bottom:10px">Template Mapping</div>
        <div style="display:grid;gap:12px;overflow-y:auto;padding-right:8px">
          <div>
            <label style="font-weight:600;font-size:.9em;display:block;margin-bottom:4px">Subject</label>
            <input type="text" id="tpl_subject" placeholder="e.g. {{TC ID}} - {{Module}}" ondrop="dropColumn(event)" ondragover="allowDrop(event)" style="width:100%;padding:6px;border:1px solid var(--vscode-input-border);border-radius:4px;font-family:monospace;font-size:.85em">
          </div>

          <div>
            <label style="font-weight:600;font-size:.9em;display:block;margin-bottom:4px">Description</label>
            <textarea id="tpl_description" placeholder="e.g. {{Steps}}&#10;Expected: {{Expected}}" ondrop="dropColumn(event)" ondragover="allowDrop(event)" style="width:100%;padding:6px;border:1px solid var(--vscode-input-border);border-radius:4px;font-family:monospace;font-size:.85em;min-height:80px;resize:vertical"></textarea>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-weight:600;font-size:.9em;display:block;margin-bottom:4px">Tracker</label>
              <select id="tpl_tracker" onchange="onTplTrackerChange()" style="width:100%;padding:6px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground)">
                <option value="">— Select tracker —</option>
              </select>
            </div>
            <div>
              <label style="font-weight:600;font-size:.9em;display:block;margin-bottom:4px">Status</label>
              <input type="text" id="tpl_status" placeholder="New" value="New" style="width:100%;padding:6px;border:1px solid var(--vscode-input-border);border-radius:4px">
            </div>
          </div>

          <div id="tpl_customfields_section" style="display:none">
            <label style="font-weight:600;font-size:.9em;display:block;margin-bottom:8px">Custom Fields</label>
            <div id="tpl_customfields_body" style="display:flex;flex-direction:column;gap:8px"></div>
            <div id="tpl_addcf_picker" style="display:none;margin-top:10px;padding:10px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;border:1px dashed var(--vscode-widget-border,#444)">
              <label style="font-size:.82em;font-weight:600;display:block;margin-bottom:6px">Choose a custom field to add:</label>
              <div style="display:flex;gap:6px">
                <select id="tpl_addcf_select" style="flex:1;padding:5px;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:.85em">
                  <option value="">— Select —</option>
                </select>
                <button type="button" onclick="confirmAddCf()" style="padding:5px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:.82em">Add</button>
                <button type="button" onclick="cancelAddCf()" style="padding:5px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;font-size:.82em">Cancel</button>
              </div>
            </div>
            <button type="button" id="tpl_addcf_btn" onclick="openAddCfPicker()" style="margin-top:10px;padding:6px 12px;background:none;border:1px dashed var(--vscode-widget-border,#555);color:var(--vscode-textLink-foreground);border-radius:3px;cursor:pointer;font-size:.82em">+ Add Custom Field</button>
            <div id="tpl_addcf_empty" style="display:none;margin-top:8px;font-size:.8em;color:var(--vscode-descriptionForeground);font-style:italic"></div>
          </div>

          <div>
            <label style="font-weight:600;font-size:.9em;display:block;margin-bottom:4px">Attachments</label>
            <input type="text" id="tpl_attachment" placeholder="e.g. Screenshot,Image" ondrop="dropColumn(event)" ondragover="allowDrop(event)" style="width:100%;padding:6px;border:1px solid var(--vscode-input-border);border-radius:4px">
          </div>
        </div>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:16px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <button class="modal-btn danger" onclick="clearTemplate()">🗑 Clear Template</button>
      <div style="display:flex;gap:8px">
        <button class="modal-btn cancel" onclick="closeTemplateModal()">Cancel</button>
        <button class="modal-btn" onclick="saveTemplate()">💾 Save Template</button>
      </div>
    </div>
  </div>
</div>

<div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <div class="title">Test Case Report</div>
    <div class="sub">${e(fileName)}</div>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
    <button class="hdr-btn primary" onclick="openTemplateBuilder()">
      ${hasTemplate ? "📋 View Template" : "➕ Create Template"}
    </button>
    <button class="hdr-btn" onclick="exportTpl()" title="Export current template as JSON">📤 Export</button>
    <button class="hdr-btn" onclick="importTpl()" title="Import template from JSON">📥 Import</button>
  </div>
</div>

<div class="summary-bar">
  ${failCount  > 0 ? `<span class="stat-badge fail">✗ ${failCount} To Create</span>` : ""}
  ${otherCount > 0 ? `<span class="stat-badge none">— ${otherCount} Other</span>` : ""}
  <span style="font-size:.78em;color:var(--vscode-descriptionForeground);margin-left:4px">Total: ${tcs.length}</span>
</div>

${!hasTemplate ? `<div class="warning-banner">⚠️ <strong>No template configured.</strong> Click the "<strong>➕ Create Template</strong>" button above to define how columns map to issue fields.</div>` : ""}

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
const HAS_TEMPLATE = ${hasTemplate ? 'true' : 'false'};
const AVAILABLE_COLUMNS = ${colsJson};
const SAVED_TEMPLATE = ${templateJson};
const CF_CONFIG = ${cfConfigJson};
const TRACKER_CACHE = ${trackerCacheJson};
const DETECT = ${detectJson};

function isFailable(statusQc) {
  const s = (statusQc || '').toLowerCase();
  const exc = DETECT.exclude || [];
  for (let i = 0; i < exc.length; i++) {
    const k = (exc[i] || '').toLowerCase();
    if (k && s.indexOf(k) !== -1) return false;
  }
  const inc = DETECT.include || [];
  for (let i = 0; i < inc.length; i++) {
    const k = (inc[i] || '').toLowerCase();
    if (k && s.indexOf(k) !== -1) return true;
  }
  return false;
}

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
  return isFailable(s) ? 'fail' : 'none';
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
      html += '<button class="btn-create" onclick="createIssue(' + i + ')" ' + (!HAS_TEMPLATE ? 'disabled' : '') + '>✚ Create Issue</button>';
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

let _pendingUnlinkTcId = null;

function unlinkIssue(tcId) {
  const linked = LINKS[tcId];
  _pendingUnlinkTcId = tcId;
  document.getElementById('confirmModalBody').textContent =
    'Remove link to issue #' + (linked ? linked.issueId : '?') + ' from this test case? The issue on Redmine will not be deleted.';
  document.getElementById('confirmModal').classList.add('open');
  document.getElementById('confirmModalOk').focus();
}

let draggedText = null;

function dragColumn(ev, text) {
  draggedText = text;
  ev.dataTransfer.effectAllowed = 'copy';
}

function allowDrop(ev) {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
}

function dropColumn(ev) {
  ev.preventDefault();
  if (!draggedText) return;
  const target = ev.target;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const start = target.selectionStart || 0;
    const end = target.selectionEnd || 0;
    const before = target.value.substring(0, start);
    const after = target.value.substring(end);
    target.value = before + draggedText + after;
    target.selectionStart = start + draggedText.length;
    target.focus();
    // Notify any oninput listeners (e.g. _tplCf sync) so state stays consistent
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  draggedText = null;
}

// Currently selected custom fields in the template builder (opt-in)
// Shape: [{ name: 'Type Bug', value: '{{Type Bug}}' }, ...]
let _tplCf = [];

function escAttr(s) {
  return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openTemplateBuilder() {
  document.getElementById('templateModal').classList.add('open');
  // Populate tracker select from full TRACKER_CACHE (all trackers from Redmine)
  const sel = document.getElementById('tpl_tracker');
  sel.innerHTML = '<option value="">— Select tracker —</option>';
  TRACKER_CACHE.forEach(function(t) {
    const o = document.createElement('option');
    o.value = t.trackerName;
    o.dataset.trackerId = String(t.trackerId);
    o.textContent = t.trackerName + ((t.fields || []).length === 0 ? ' (no custom fields)' : '');
    if (t.trackerName === (SAVED_TEMPLATE.tracker || '')) o.selected = true;
    sel.appendChild(o);
  });
  document.getElementById('tpl_subject').value = SAVED_TEMPLATE.subject || '';
  document.getElementById('tpl_description').value = SAVED_TEMPLATE.description || '';
  document.getElementById('tpl_status').value = SAVED_TEMPLATE.status || 'New';
  document.getElementById('tpl_attachment').value = SAVED_TEMPLATE.attachmentPattern || '';

  // Hydrate _tplCf from saved template
  _tplCf = [];
  const savedCf = SAVED_TEMPLATE.customFields || {};
  Object.keys(savedCf).forEach(function(name) {
    _tplCf.push({ name: name, value: savedCf[name] || '' });
  });

  onTplTrackerChange(true); // initial load — don't clear _tplCf
}

function getCurrentTrackerEntry() {
  const sel = document.getElementById('tpl_tracker');
  const trackerName = sel.value;
  if (!trackerName) return null;
  return TRACKER_CACHE.find(function(t) { return t.trackerName === trackerName; }) || null;
}

function onTplTrackerChange(initial) {
  const cfSection = document.getElementById('tpl_customfields_section');
  const entry = getCurrentTrackerEntry();

  // When user picks a different tracker (not initial load), reset added fields
  if (!initial) _tplCf = [];

  if (!entry || (entry.fields || []).length === 0) {
    // Tracker has no CFs at all — hide the whole section
    cfSection.style.display = 'none';
    return;
  }
  cfSection.style.display = '';
  cancelAddCf(); // make sure picker is closed
  renderTplCfList();
}

function renderTplCfList() {
  const body = document.getElementById('tpl_customfields_body');
  const entry = getCurrentTrackerEntry();
  if (!entry) { body.innerHTML = ''; return; }
  if (_tplCf.length === 0) {
    body.innerHTML = '<div style="font-size:.82em;color:var(--vscode-descriptionForeground);font-style:italic">No custom fields added yet. Click <strong>+ Add Custom Field</strong> below to add.</div>';
    refreshAddCfBtn();
    return;
  }
  body.innerHTML = _tplCf.map(function(cf, idx) {
    return '<div style="display:grid;grid-template-columns:140px 1fr auto;gap:8px;align-items:center">'
      + '<label style="font-size:.85em;font-weight:600">' + escHtml(cf.name) + '</label>'
      + '<input type="text" data-cf-name="' + escAttr(cf.name) + '" class="tpl-cf-input" placeholder="{{Column}} or fixed value" ondrop="dropColumn(event)" ondragover="allowDrop(event)" oninput="onTplCfInput(this,' + idx + ')" value="' + escAttr(cf.value) + '" style="padding:5px;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-family:monospace;font-size:.85em">'
      + '<button type="button" onclick="removeTplCf(' + idx + ')" title="Remove" style="padding:4px 9px;background:none;border:1px solid var(--vscode-widget-border,#444);color:var(--vscode-descriptionForeground);border-radius:3px;cursor:pointer;font-size:1em;line-height:1">×</button>'
      + '</div>';
  }).join('');
  refreshAddCfBtn();
}

function onTplCfInput(inp, idx) {
  if (_tplCf[idx]) _tplCf[idx].value = inp.value;
}

function refreshAddCfBtn() {
  const entry = getCurrentTrackerEntry();
  const btn   = document.getElementById('tpl_addcf_btn');
  const empty = document.getElementById('tpl_addcf_empty');
  if (!entry) { btn.style.display = 'none'; empty.style.display = 'none'; return; }
  const usedNames = _tplCf.map(function(c) { return c.name; });
  const available = (entry.fields || []).filter(function(f) { return usedNames.indexOf(f.name) === -1; });
  if (available.length === 0) {
    btn.style.display = 'none';
    empty.style.display = '';
    empty.textContent = 'All custom fields of this tracker have been added.';
  } else {
    btn.style.display = '';
    empty.style.display = 'none';
  }
}

function openAddCfPicker() {
  const entry = getCurrentTrackerEntry();
  if (!entry) return;
  const usedNames = _tplCf.map(function(c) { return c.name; });
  const available = (entry.fields || []).filter(function(f) { return usedNames.indexOf(f.name) === -1; });
  const sel = document.getElementById('tpl_addcf_select');
  sel.innerHTML = '<option value="">— Select —</option>' + available.map(function(f) {
    return '<option value="' + escAttr(f.name) + '">' + escHtml(f.name) + '</option>';
  }).join('');
  document.getElementById('tpl_addcf_picker').style.display = '';
  document.getElementById('tpl_addcf_btn').style.display = 'none';
  sel.focus();
}

function cancelAddCf() {
  document.getElementById('tpl_addcf_picker').style.display = 'none';
  refreshAddCfBtn();
}

function syncTplCfFromDom() {
  // Make sure _tplCf reflects whatever is currently typed in the inputs
  // (covers cases where input events were missed, e.g. drop without sync, paste edge cases).
  document.querySelectorAll('#tpl_customfields_body .tpl-cf-input').forEach(function(inp) {
    const name = inp.dataset.cfName;
    const entry = _tplCf.find(function(c) { return c.name === name; });
    if (entry) entry.value = inp.value;
  });
}

function confirmAddCf() {
  const sel = document.getElementById('tpl_addcf_select');
  const name = sel.value;
  if (!name) return;
  if (_tplCf.some(function(c) { return c.name === name; })) { cancelAddCf(); return; }
  syncTplCfFromDom();
  _tplCf.push({ name: name, value: '' });
  document.getElementById('tpl_addcf_picker').style.display = 'none';
  renderTplCfList();
  // Focus the newly added input
  const inputs = document.querySelectorAll('#tpl_customfields_body .tpl-cf-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeTplCf(idx) {
  const cf = _tplCf[idx];
  if (!cf) return;
  syncTplCfFromDom();
  if (!confirm('Remove custom field "' + cf.name + '" from this template?')) return;
  _tplCf.splice(idx, 1);
  renderTplCfList();
}

function closeTemplateModal() {
  document.getElementById('templateModal').classList.remove('open');
}

function clearTemplate() {
  // Use a native VS Code modal on the extension side (window.confirm is
  // unreliable inside webviews).
  vscode.postMessage({ command: 'clearTemplate' });
}

function exportTpl() {
  vscode.postMessage({ command: 'exportTemplate' });
}

function importTpl() {
  vscode.postMessage({ command: 'importTemplate' });
}

function saveTemplate() {
  syncTplCfFromDom();
  const customFields = {};
  _tplCf.forEach(function(cf) {
    if (cf.name) customFields[cf.name] = cf.value || '';
  });
  const trackerSel = document.getElementById('tpl_tracker');
  const selectedOpt = trackerSel.options[trackerSel.selectedIndex];
  const trackerId = selectedOpt ? Number(selectedOpt.dataset.trackerId || 0) : 0;
  const template = {
    subject: document.getElementById('tpl_subject').value,
    description: document.getElementById('tpl_description').value,
    tracker: trackerSel.value,
    trackerId: trackerId,
    status: document.getElementById('tpl_status').value,
    attachmentPattern: document.getElementById('tpl_attachment').value,
    customFields: customFields,
  };
  vscode.postMessage({ command: 'saveTemplate', template: template });
  closeTemplateModal();
}

function closeModal() {
  _pendingUnlinkTcId = null;
  document.getElementById('confirmModal').classList.remove('open');
}

document.getElementById('confirmModalOk').onclick = function() {
  if (!_pendingUnlinkTcId) return;
  const tcId = _pendingUnlinkTcId;
  closeModal();
  vscode.postMessage({ command: 'unlinkIssue', tcId: tcId });
};

document.getElementById('confirmModal').addEventListener('click', function(ev) {
  if (ev.target === this) closeModal();
});

document.getElementById('templateModal').addEventListener('click', function(ev) {
  if (ev.target === this) closeTemplateModal();
});

render();
</script>
</body>
</html>`;
}
