import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import axios from "axios";
import { listProjects, listStatuses, listProjectMembers, listTrackers, listIssues, getIssue, configureClient } from "./redmine-client";
import type { TrackerFieldCacheEntry } from "./extension";

export interface CustomFieldDef {
  id: number;
  name: string;
  type: "text" | "select";
  options: string[];
}

export interface CustomFieldConfigEntry {
  trackerId: number;
  trackerName: string;
  fields: CustomFieldDef[];
}

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
      defaultTrackerId:     cfg.get<string>("defaultTrackerId") ?? "",
      testCaseTemplate:     cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {},
      issueDetectInclude:   cfg.get<string[]>("issueDetection.include") ?? ["NG", "Fail"],
      issueDetectExclude:   cfg.get<string[]>("issueDetection.exclude") ?? [],
    };

    // Pre-fetch lookup data before building the webview
    let projects: { id: string; name: string }[] = [];
    let statuses: { id: string; name: string; is_closed: boolean }[] = [];
    let members:  { id: string; name: string }[] = [];
    let trackers: { id: string; name: string }[] = [];

    if (baseUrl && apiKey) {
      try {
        configureClient(baseUrl, apiKey);
        [projects, statuses, trackers] = await Promise.all([
          listProjects().then((ps) => ps.map((p) => ({ id: p.identifier, name: p.name }))).catch(() => []),
          listStatuses().then((ss) => ss.map((s) => ({ id: String(s.id), name: s.name, is_closed: s.is_closed }))).catch(() => []),
          listTrackers().then((ts) => ts.map((t) => ({ id: String(t.id), name: t.name }))).catch(() => []),
        ]);
        if (init.defaultProject) {
          members = await listProjectMembers(init.defaultProject)
            .then((ms) => ms.map((m) => ({ id: String(m.id), name: m.name })))
            .catch(() => []);
        }
      } catch { /* show empty — user can reload */ }
    }

    // Load custom field data from global state
    const trackerFieldCache = this.context.globalState.get<TrackerFieldCacheEntry[]>("trackerFieldCache") ?? [];
    const customFieldConfig = this.context.globalState.get<CustomFieldConfigEntry[]>("customFieldConfig") ?? [];

    this.panel = vscode.window.createWebviewPanel(
      "redmineSettings", "Redmine — Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    // Refresh template view when config changes (e.g. user saves template from test case webview)
    const cfgSub = vscode.workspace.onDidChangeConfiguration((evt) => {
      if (!this.panel) return;
      if (evt.affectsConfiguration("redmine.testCaseTemplate")) {
        const latest = vscode.workspace.getConfiguration("redmine").get<Record<string, unknown>>("testCaseTemplate") ?? {};
        this.panel.webview.postMessage({ command: "templateSaved", template: latest });
      }
    });
    this.panel.onDidDispose(() => { cfgSub.dispose(); this.panel = null; });

    const logoUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "redmine.png")
    );

    this.panel.webview.html = buildHtml(init, projects, statuses, members, trackers, logoUri.toString(), trackerFieldCache, customFieldConfig);

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
        await c.update("defaultTrackerId",      msg.defaultTrackerId ?? "",                        vscode.ConfigurationTarget.Global);
        await c.update("defaultTrackerName",    msg.defaultTrackerName ?? "",                      vscode.ConfigurationTarget.Global);
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
          const [ps, ss, ts] = await Promise.all([
            listProjects().catch(() => []),
            listStatuses().catch(() => []),
            listTrackers().catch(() => []),
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
            trackers: ts.map((t) => ({ id: String(t.id), name: t.name })),
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

      // ── Save test case template ───────────────────────────────────────
      if (msg.command === "saveTemplate") {
        const c = vscode.workspace.getConfiguration("redmine");
        await c.update("testCaseTemplate", msg.template ?? {}, vscode.ConfigurationTarget.Global);
        this.panel?.webview.postMessage({ command: "templateSaved" });
      }

      // ── Save issue detection keywords ─────────────────────────────────
      if (msg.command === "saveIssueDetection") {
        const include = Array.isArray(msg.include) ? msg.include.filter((s: unknown) => typeof s === "string" && s.trim() !== "") : [];
        const exclude = Array.isArray(msg.exclude) ? msg.exclude.filter((s: unknown) => typeof s === "string" && s.trim() !== "") : [];
        const c = vscode.workspace.getConfiguration("redmine");
        await c.update("issueDetection.include", include, vscode.ConfigurationTarget.Global);
        await c.update("issueDetection.exclude", exclude, vscode.ConfigurationTarget.Global);
        this.panel?.webview.postMessage({ command: "issueDetectionSaved" });
      }

      // ── Clear test case template ──────────────────────────────────────
      if (msg.command === "clearTemplate") {
        const c = vscode.workspace.getConfiguration("redmine");
        const existing = c.get<Record<string, unknown>>("testCaseTemplate") ?? {};
        if (Object.keys(existing).length === 0) {
          vscode.window.showInformationMessage("Template is already empty.");
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          "This will delete your current test case template. Continue?",
          { modal: true },
          "Clear",
        );
        if (confirm !== "Clear") return;
        await c.update("testCaseTemplate", {}, vscode.ConfigurationTarget.Global);
        // onDidChangeConfiguration listener re-renders the display automatically
        vscode.window.showInformationMessage("✓ Template cleared.");
      }

      // ── Save custom field config ──────────────────────────────────────
      if (msg.command === "saveCustomFieldConfig") {
        const config = msg.config as CustomFieldConfigEntry[];
        await this.context.globalState.update("customFieldConfig", config);
        this.panel?.webview.postMessage({ command: "customFieldConfigSaved", silent: !!msg.silent });
      }

      // ── Re-fetch custom fields from Redmine ───────────────────────────
      if (msg.command === "refetchCustomFields") {
        try {
          const cfg = vscode.workspace.getConfiguration("redmine");
          const projectId = cfg.get<string>("defaultProject") || undefined;
          const trackers = await listTrackers();

          // Reset cache — force re-fetch all
          await this.context.globalState.update("trackerFieldCache", []);
          const newCache: TrackerFieldCacheEntry[] = [];

          for (const tracker of trackers) {
            try {
              const result = await listIssues({ trackerId: String(tracker.id), projectId, limit: 1 });
              const fields = result.issues.length
                ? (await getIssue(result.issues[0].id)).custom_fields?.map((cf) => ({ id: cf.id, name: cf.name })) ?? []
                : [];
              newCache.push({ trackerId: tracker.id, trackerName: tracker.name, fields, fetched: true });
            } catch { newCache.push({ trackerId: tracker.id, trackerName: tracker.name, fields: [], fetched: true }); }
          }

          await this.context.globalState.update("trackerFieldCache", newCache);

          // Backward compat
          const bugEntry = newCache.find((e) => /^bug$/i.test(e.trackerName));
          if (bugEntry) {
            await this.context.globalState.update("bugIssueExists", bugEntry.fields.length > 0);
            await this.context.globalState.update("bugCustomFieldDefs", bugEntry.fields);
          }

          this.panel?.webview.postMessage({ command: "refetchResult", cache: newCache });
        } catch (err) {
          this.panel?.webview.postMessage({ command: "refetchError", message: String(err) });
        }
      }

      // ── Export custom field config ────────────────────────────────────
      if (msg.command === "exportCustomFields") {
        const config = this.context.globalState.get<CustomFieldConfigEntry[]>("customFieldConfig") ?? [];
        if (config.length === 0) {
          vscode.window.showWarningMessage("No custom field configuration to export.");
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(defaultDir, `redmine-custom-fields-${today}.json`)),
          filters: { "JSON": ["json"] },
          saveLabel: "Export",
        });
        if (!uri) return;
        const payload = {
          version: 1,
          kind: "redmine-connector.customFieldConfig",
          exportedAt: new Date().toISOString(),
          customFieldConfig: config,
        };
        try {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
          const fieldCount = config.reduce((sum, t) => sum + t.fields.length, 0);
          vscode.window.showInformationMessage(`✓ Exported ${config.length} tracker(s), ${fieldCount} field(s) → ${uri.fsPath}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
      }

      // ── Import custom field config ────────────────────────────────────
      if (msg.command === "importCustomFields") {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "JSON": ["json"] },
          openLabel: "Import",
        });
        if (!uris || uris.length === 0) return;

        let parsed: { customFieldConfig?: CustomFieldConfigEntry[] } | CustomFieldConfigEntry[];
        try {
          const buf = await vscode.workspace.fs.readFile(uris[0]);
          parsed = JSON.parse(Buffer.from(buf).toString("utf8"));
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to read file: ${String(err)}`);
          return;
        }

        const imported = Array.isArray(parsed)
          ? parsed
          : (parsed?.customFieldConfig ?? []);

        if (!Array.isArray(imported) || imported.length === 0) {
          vscode.window.showErrorMessage("Invalid file: no customFieldConfig found.");
          return;
        }

        const cache = this.context.globalState.get<TrackerFieldCacheEntry[]>("trackerFieldCache") ?? [];
        if (cache.length === 0) {
          vscode.window.showWarningMessage(
            "No tracker data found. Click 'Refresh from Redmine' first so the importer can match by name.",
          );
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          "This will REPLACE your current Custom Fields configuration. Fields are matched by tracker name + field name; entries not found in your Redmine will be skipped. Continue?",
          { modal: true },
          "Import",
        );
        if (confirm !== "Import") return;

        let matched = 0;
        let skipped = 0;
        const next: CustomFieldConfigEntry[] = [];

        for (const impTracker of imported) {
          if (!impTracker || typeof impTracker !== "object") continue;
          const localTracker = cache.find((t) => t.trackerName === impTracker.trackerName);
          if (!localTracker) {
            skipped += (impTracker.fields ?? []).length || 1;
            continue;
          }
          const entry: CustomFieldConfigEntry = {
            trackerId: localTracker.trackerId,
            trackerName: localTracker.trackerName,
            fields: [],
          };
          for (const impField of impTracker.fields ?? []) {
            const localField = localTracker.fields.find((f) => f.name === impField.name);
            if (!localField) { skipped++; continue; }
            entry.fields.push({
              id: localField.id,
              name: localField.name,
              type: impField.type === "select" ? "select" : "text",
              options: Array.isArray(impField.options) ? impField.options.filter((s: unknown) => typeof s === "string") : [],
            });
            matched++;
          }
          if (entry.fields.length > 0) next.push(entry);
        }

        await this.context.globalState.update("customFieldConfig", next);
        this.panel?.webview.postMessage({ command: "importResult", success: true, matched, skipped, config: next });

        const summary = `Imported ${matched} field(s)` + (skipped ? `, ${skipped} skipped (not found in your Redmine)` : "");
        vscode.window.showInformationMessage(`✓ ${summary}`);
      }

      // ── Export test case template ─────────────────────────────────────
      if (msg.command === "exportTemplate") {
        const cfg = vscode.workspace.getConfiguration("redmine");
        const template = cfg.get<Record<string, unknown>>("testCaseTemplate") ?? {};
        if (Object.keys(template).length === 0) {
          vscode.window.showWarningMessage("No template configured. Open a test case file and create a template first.");
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
        const payload = {
          version: 1,
          kind: "redmine-connector.testCaseTemplate",
          exportedAt: new Date().toISOString(),
          template,
        };
        try {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
          vscode.window.showInformationMessage(`✓ Template exported → ${uri.fsPath}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
      }

      // ── Import test case template ─────────────────────────────────────
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

        // Accept either the wrapped envelope { template: {...} } or a bare template object
        const imported = (parsed && typeof parsed === "object" && "template" in parsed && parsed.template)
          ? parsed.template as Record<string, unknown>
          : parsed as Record<string, unknown>;

        if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
          vscode.window.showErrorMessage("Invalid template file.");
          return;
        }

        const currentCfg = vscode.workspace.getConfiguration("redmine");
        const hadExisting = Object.keys(currentCfg.get<Record<string, unknown>>("testCaseTemplate") ?? {}).length > 0;
        if (hadExisting) {
          const confirm = await vscode.window.showWarningMessage(
            "This will REPLACE your current test case template. Continue?",
            { modal: true },
            "Import",
          );
          if (confirm !== "Import") return;
        }

        // Re-resolve trackerId by matching trackerName against the local cache
        // (IDs differ between Redmine instances; tracker names are usually shared).
        const cache = this.context.globalState.get<TrackerFieldCacheEntry[]>("trackerFieldCache") ?? [];
        const trackerName = typeof imported.tracker === "string" ? imported.tracker : "";
        const localTracker = trackerName ? cache.find((t) => t.trackerName === trackerName) : undefined;
        const normalized: Record<string, unknown> = { ...imported };
        if (localTracker) {
          normalized.trackerId = localTracker.trackerId;
        } else if (trackerName) {
          // Keep the imported trackerId as a best-effort fallback
          // but warn the user — the create-issue flow won't be able to resolve CFs.
          vscode.window.showWarningMessage(
            `Tracker "${trackerName}" not found in your Redmine. Click 'Refresh from Redmine' in the Custom Fields tab if you expected it to exist.`,
          );
        }

        await currentCfg.update("testCaseTemplate", normalized, vscode.ConfigurationTarget.Global);
        // Settings webview's existing onDidChangeConfiguration listener will re-render the display.
        vscode.window.showInformationMessage("✓ Template imported.");
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
    defaultTrackerId: string;
    testCaseTemplate: Record<string, unknown>;
    issueDetectInclude: string[];
    issueDetectExclude: string[];
  },
  projects: { id: string; name: string }[],
  statuses: { id: string; name: string; is_closed: boolean }[],
  members:  { id: string; name: string }[],
  trackers: { id: string; name: string }[],
  logoSrc: string,
  trackerFieldCache: TrackerFieldCacheEntry[],
  customFieldConfig: CustomFieldConfigEntry[],
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

  /* Sticky top bar (header + tabs) */
  .topbar { position: sticky; top: 0; z-index: 10; background: var(--vscode-editor-background); padding-top: 4px; margin-bottom: 24px; }
  .topbar .header { margin-bottom: 16px; }
  .topbar .tab-bar { margin-bottom: 0; }

  /* Custom Fields tab */
  details.tracker-block { border: 1px solid var(--vscode-widget-border,#444); border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
  details.tracker-block > summary { padding: 10px 14px; background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 700; font-size: .9em; cursor: pointer; display: flex; align-items: center; gap: 8px; list-style: none; user-select: none; }
  details.tracker-block > summary::-webkit-details-marker { display: none; }
  details.tracker-block > summary::before { content: '▸'; font-size: .9em; transition: transform .15s; display: inline-block; }
  details.tracker-block[open] > summary::before { transform: rotate(90deg); }
  .tracker-name { flex: 1; }
  .tracker-count { font-weight: 400; font-size: .82em; color: var(--vscode-descriptionForeground); }
  .tracker-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
  .empty-tracker { padding: 12px 14px; font-size: .85em; color: var(--vscode-descriptionForeground); font-style: italic; }

  .cf-field { border: 1px solid var(--vscode-widget-border,#333); border-radius: 4px; padding: 10px 12px; }
  .cf-field-head { display: flex; align-items: center; gap: 12px; margin-bottom: 0; }
  .cf-name { font-weight: 600; font-size: .9em; flex: 1; }
  .cf-name small { font-family: monospace; font-size: .85em; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .cf-type-sel { width: auto !important; padding: 3px 8px !important; font-size: .85em !important; }
  .cf-options { margin-top: 10px; padding: 10px 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; }
  .cf-options-label { font-size: .8em; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 7px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
  .cf-no-options { font-size: .82em; color: var(--vscode-descriptionForeground); font-style: italic; margin-bottom: 8px; }
  .cf-option-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .cf-option-row { display: flex; gap: 6px; align-items: center; }
  .cf-option-input { flex: 1; padding: 4px 8px !important; font-size: .85em !important; }
  .cf-opt-remove { background: none; border: 1px solid var(--vscode-widget-border,#444); color: var(--vscode-descriptionForeground); border-radius: 3px; cursor: pointer; padding: 2px 8px; font-size: 1em; line-height: 1; height: 26px; }
  .cf-opt-remove:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .cf-opt-add { background: none; border: 1px dashed var(--vscode-widget-border,#555); color: var(--vscode-textLink-foreground); border-radius: 3px; cursor: pointer; padding: 5px 12px; font-size: .82em; font-family: inherit; }
  .cf-opt-add:hover { border-color: var(--vscode-textLink-foreground); background: color-mix(in srgb,var(--vscode-textLink-foreground) 8%,transparent); }
</style>
</head>
<body>

<div class="topbar">
  <div class="header">
    <img src="${e(logoSrc)}" alt="Redmine">
    <div class="header-text">
      <div class="logo">Redmine Connector</div>
      <div class="subtitle">Connection settings and default filter preferences</div>
    </div>
  </div>

  <div class="tab-bar">
    <button class="tab-btn active" onclick="switchTab('conn',this)">⚙ Connection</button>
    <button class="tab-btn" onclick="switchTab('filters',this)">🔽 Default Filters</button>
    <button class="tab-btn" onclick="switchTab('customfields',this)">🔧 Custom Fields</button>
    <button class="tab-btn" onclick="switchTab('detection',this)">🎯 Issue Detection</button>
    <button class="tab-btn" onclick="switchTab('template',this)">📋 Test Case Template</button>
  </div>
</div>

<!-- TAB: Connection -->
<div class="tab-pane active" id="tab-conn">
  <div class="section">
    <div class="section-title">Redmine Server</div>
    <div class="field">
      <label class="fl" for="baseUrl">Redmine URL</label>
      <input type="text" id="baseUrl" value="${e(init.baseUrl)}" placeholder="https://redmine.company.com">
      <div class="hint">Redmine server URL (no trailing slash)</div>
    </div>
    <div class="field">
      <label class="fl">API Key <button class="show-key" onclick="toggleKey(event)">show</button></label>
      <input type="password" id="apiKey" value="${e(init.apiKey)}" placeholder="Paste your API key here">
      <div class="hint">Redmine → your username → <strong>My Account</strong> → <strong>API access key</strong> → Show</div>
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
      <div class="radio-row"><input type="radio" name="textFormat" id="tf-textile"  value="textile"  ${init.textFormat==="textile"?"checked":""}><label for="tf-textile">Textile <span style="color:var(--vscode-descriptionForeground);font-size:.85em">(Redmine default)</span></label></div>
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
    <div class="hint" style="margin-top:6px">Default project shown on startup. Can be overridden by the sidebar filter.</div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">Default Status Filter</div>
    <div class="radio-group">
      <div class="radio-row"><input type="radio" name="sm" id="sm-open"   value="open"   ${init.defaultStatusMode==="open"?"checked":""}   onchange="onSmChange()"><label for="sm-open">Open issues <span style="color:var(--vscode-descriptionForeground);font-size:.85em">(default)</span></label></div>
      <div class="radio-row"><input type="radio" name="sm" id="sm-closed" value="closed" ${init.defaultStatusMode==="closed"?"checked":""} onchange="onSmChange()"><label for="sm-closed">Closed issues</label></div>
      <div class="radio-row"><input type="radio" name="sm" id="sm-all"    value="*"      ${init.defaultStatusMode==="*"?"checked":""}      onchange="onSmChange()"><label for="sm-all">All statuses</label></div>
      <div class="radio-row"><input type="radio" name="sm" id="sm-custom" value="custom" ${init.defaultStatusMode==="custom"?"checked":""} onchange="onSmChange()"><label for="sm-custom">Custom — select specific statuses below</label></div>
    </div>

    <div class="status-list ${init.defaultStatusMode==="custom"?"show":""}" id="statusList">
      <div class="status-hint">Select one or more statuses to show by default:</div>
      <div class="status-grid" id="statusGrid"></div>
    </div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">Default Assignee</div>
    <div class="radio-group">
      <div class="radio-row"><input type="radio" name="am" id="am-all"    value="all"    ${init.defaultAssigneeMode==="all"?"checked":""}    onchange="onAmChange()"><label for="am-all">All — no assignee filter</label></div>
      <div class="radio-row"><input type="radio" name="am" id="am-me"     value="me"     ${init.defaultAssigneeMode==="me"?"checked":""}     onchange="onAmChange()"><label for="am-me">Assigned to me</label></div>
      <div class="radio-row"><input type="radio" name="am" id="am-custom" value="custom" ${init.defaultAssigneeMode==="custom"?"checked":""} onchange="onAmChange()"><label for="am-custom">Custom — select a specific member below</label></div>
    </div>

    <div class="member-list ${init.defaultAssigneeMode==="custom"?"show":""}" id="memberList">
      <div class="member-hint">Select a member (requires a default project to be set):</div>
      <select id="defaultAssigneeId" style="width:100%">
        <option value="">— Select member —</option>
      </select>
    </div>
  </div>

  <hr class="divider">

  <div class="section">
    <div class="section-title">Default Tracker</div>
    <select id="defaultTrackerId">
      <option value="">All Trackers</option>
    </select>
    <div class="hint" style="margin-top:6px">Filter issues by tracker type (e.g. Bug, Task, Feature). Can be overridden by the sidebar filter.</div>
  </div>

  <hr class="divider">
  <div class="btn-row">
    <button class="btn" onclick="save()">💾 Save Settings</button>
    <button class="btn btn-sec btn-sm" onclick="reloadAll()">🔄 Reload from Redmine</button>
  </div>
  <div class="feedback" id="saveFb2"></div>
</div>

<!-- TAB: Custom Fields -->
<div class="tab-pane" id="tab-customfields">
  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div>
        <div class="section-title">Custom Fields per Tracker</div>
        <div class="hint" style="margin-top:4px">Discovered from existing issues. Set type and options for each field.</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn btn-sec btn-sm" onclick="refetchCustomFields()" id="btnRefetch">🔄 Refresh</button>
        <button class="btn btn-sec btn-sm" onclick="exportCustomFields()">📤 Export</button>
        <button class="btn btn-sec btn-sm" onclick="importCustomFields()">📥 Import</button>
      </div>
    </div>

    <div class="feedback" id="cfFb"></div>
    <div id="cfContent"></div>

    <div class="btn-row" style="margin-top:20px">
      <button class="btn" onclick="saveCustomFieldConfig()">💾 Save Custom Fields</button>
    </div>
  </div>
</div>

<!-- TAB: Issue Detection -->
<div class="tab-pane" id="tab-detection">
  <div class="section">
    <div class="section-title">Auto-Detect Failing Test Cases</div>
    <div class="hint" style="margin-bottom:16px">Configure which <strong>Status QC</strong> values mark a test case row as a failure. Rows that match show the <strong>Create Issue</strong> button.<br>Matching is <strong>case-insensitive substring</strong>: <code>NG</code> matches both <code>NG</code> and <code>NG (re-check)</code>.</div>

    <div class="feedback" id="detectFb"></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:8px">
      <!-- Include list -->
      <div style="border:1px solid var(--vscode-widget-border,#444);border-radius:6px;padding:14px">
        <div style="font-weight:700;font-size:.9em;margin-bottom:4px;color:var(--vscode-testing-iconFailed,#f48771)">✓ Include</div>
        <div class="hint" style="margin-bottom:10px">Treated as failure if the Status QC contains any keyword here.</div>
        <div id="detectIncludeList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <div style="display:flex;gap:6px">
          <input type="text" id="detectIncludeInput" placeholder="e.g. NG" onkeydown="onDetectInputKey(event,'include')" style="flex:1;padding:5px 8px;font-size:.85em">
          <button class="btn btn-sec btn-sm" onclick="addDetectKeyword('include')">+ Add</button>
        </div>
      </div>

      <!-- Exclude list -->
      <div style="border:1px solid var(--vscode-widget-border,#444);border-radius:6px;padding:14px">
        <div style="font-weight:700;font-size:.9em;margin-bottom:4px;color:var(--vscode-charts-blue,#4ec9b0)">✗ Exclude (veto)</div>
        <div class="hint" style="margin-bottom:10px">Rows matching any of these are NEVER treated as failure, even if they also match Include. Example: <code>test NG</code>.</div>
        <div id="detectExcludeList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <div style="display:flex;gap:6px">
          <input type="text" id="detectExcludeInput" placeholder="e.g. test NG" onkeydown="onDetectInputKey(event,'exclude')" style="flex:1;padding:5px 8px;font-size:.85em">
          <button class="btn btn-sec btn-sm" onclick="addDetectKeyword('exclude')">+ Add</button>
        </div>
      </div>
    </div>

    <div class="btn-row" style="margin-top:20px">
      <button class="btn" onclick="saveDetection()">💾 Save Detection Rules</button>
      <button class="btn btn-sec btn-sm" onclick="resetDetection()">↺ Reset to defaults</button>
    </div>
  </div>
</div>

<!-- TAB: Test Case Template -->
<div class="tab-pane" id="tab-template">
  <div class="section">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px">
      <div style="flex:1">
        <div class="section-title">Test Case → Issue Template</div>
        <div class="hint" style="margin-top:4px">View the template that defines how test case columns map to issue fields. To edit or create a template, open a test case file and use the <strong>Create Template</strong> button at the top.</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn btn-sec btn-sm" onclick="exportTemplate()">📤 Export</button>
        <button class="btn btn-sec btn-sm" onclick="importTemplate()">📥 Import</button>
        <button class="btn btn-sec btn-sm" onclick="clearTemplate()">🗑 Clear</button>
      </div>
    </div>

    <div class="feedback" id="tplFb"></div>

    <div id="templateDisplay" style="padding:16px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;border:1px solid var(--vscode-widget-border,#444)">
      <div style="color:var(--vscode-descriptionForeground);font-size:.9em">No template configured yet.</div>
    </div>
  </div>
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
  const TRACKERS  = ${JSON.stringify(trackers)};
  const INIT_IDS  = ${JSON.stringify(init.defaultStatusIds)};
  const INIT_PROJ = ${JSON.stringify(init.defaultProject)};
  const INIT_AM   = ${JSON.stringify(init.defaultAssigneeMode)};
  const INIT_AID  = ${JSON.stringify(init.defaultAssigneeId)};
  const INIT_TID  = ${JSON.stringify(init.defaultTrackerId)};
  const INIT_TPL  = ${JSON.stringify(init.testCaseTemplate)};
  const TRACKER_FIELD_CACHE = ${JSON.stringify(trackerFieldCache)};
  const CUSTOM_FIELD_CONFIG = ${JSON.stringify(customFieldConfig)};
  const INIT_DETECT_INC = ${JSON.stringify(init.issueDetectInclude)};
  const INIT_DETECT_EXC = ${JSON.stringify(init.issueDetectExclude)};

  let _membersLoaded = MEMBERS.length > 0;
  let _cfConfig = JSON.parse(JSON.stringify(CUSTOM_FIELD_CONFIG)); // deep copy

  let _detectInc = (INIT_DETECT_INC || []).slice();
  let _detectExc = (INIT_DETECT_EXC || []).slice();

  // Render immediately on load
  renderProjects(PROJECTS);
  renderStatuses(STATUSES);
  renderMembers(MEMBERS, INIT_AID);
  renderTrackers(TRACKERS);
  renderTemplate(INIT_TPL);
  renderCustomFields(TRACKER_FIELD_CACHE, _cfConfig);
  renderDetectionLists();

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

  function escAttr(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      grid.innerHTML = '<span class="empty-text">Not loaded yet — click "Reload from Redmine"</span>';
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

  function renderTrackers(list) {
    const sel = document.getElementById('defaultTrackerId');
    const currentVal = sel.value || INIT_TID;
    sel.innerHTML = '<option value="">All Trackers</option>';
    list.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      if (t.id === currentVal) o.selected = true;
      sel.appendChild(o);
    });
  }

  function renderTemplate(template) {
    const display = document.getElementById('templateDisplay');
    if (!template || Object.keys(template).length === 0) {
      display.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:.9em">No template configured yet. Open a test case file and click <strong>Create Template</strong> to get started.</div>';
      return;
    }
    const codeStyle = 'font-family:monospace;background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:3px;white-space:pre-wrap;word-break:break-word';
    const rowStyle  = 'display:grid;grid-template-columns:130px 1fr;gap:10px;align-items:start;margin-bottom:10px;font-size:.9em';
    function row(label, valueHtml) {
      return '<div style="' + rowStyle + '"><strong>' + label + '</strong><div>' + valueHtml + '</div></div>';
    }
    function codeVal(v) { return '<code style="' + codeStyle + '">' + escAttr(v) + '</code>'; }

    let html = '';
    if (template.subject)           html += row('Subject',     codeVal(template.subject));
    if (template.description)       html += row('Description', codeVal(String(template.description).replace(/\\n/g, ' ↵ ')));
    if (template.tracker)           html += row('Tracker',     escAttr(template.tracker));
    if (template.status)            html += row('Status',      escAttr(template.status));
    if (template.attachmentPattern) html += row('Attachments', escAttr(template.attachmentPattern));

    const cf = template.customFields || {};
    const cfKeys = Object.keys(cf);
    if (cfKeys.length > 0) {
      let cfHtml = '<div style="display:flex;flex-direction:column;gap:6px">';
      cfKeys.forEach(function(name) {
        const val = cf[name] || '';
        cfHtml += '<div style="display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center">'
          + '<span style="font-size:.85em;color:var(--vscode-descriptionForeground)">' + escAttr(name) + '</span>'
          + (val ? codeVal(val) : '<span style="color:var(--vscode-descriptionForeground);font-style:italic;font-size:.85em">(empty)</span>')
          + '</div>';
      });
      cfHtml += '</div>';
      html += row('Custom Fields', cfHtml);
    }

    if (!html) {
      display.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:.9em">Template is empty.</div>';
      return;
    }
    display.innerHTML = html;
  }

  // ── Custom Fields ──────────────────────────────────────────────────────────
  function renderCustomFields(cache, config) {
    const el = document.getElementById('cfContent');
    if (!cache || cache.length === 0) {
      el.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:.9em;padding:16px 0">No tracker data found. Make sure Redmine is connected, then click <strong>Refresh from Redmine</strong>.</div>';
      return;
    }
    // Sort: trackers with custom fields first, empty ones at bottom
    const sorted = cache.slice().sort(function(a, b) {
      const ae = (a.fields || []).length === 0 ? 1 : 0;
      const be = (b.fields || []).length === 0 ? 1 : 0;
      return ae - be;
    });

    let html = '';
    sorted.forEach(function(tracker) {
      const hasFields = (tracker.fields || []).length > 0;
      html += '<details class="tracker-block"' + (hasFields ? ' open' : '') + ' data-tracker="' + tracker.trackerId + '">';
      html += '<summary>';
      html += '<span class="tracker-name">' + escAttr(tracker.trackerName) + '</span>';
      html += '<span class="tracker-count">' + (hasFields ? (tracker.fields.length + ' field' + (tracker.fields.length > 1 ? 's' : '')) : 'no custom fields') + '</span>';
      html += '</summary>';

      if (!hasFields) {
        html += '<div class="empty-tracker">No custom fields discovered for this tracker.</div>';
      } else {
        html += '<div class="tracker-body">';
        tracker.fields.forEach(function(field) {
          html += renderCfField(tracker.trackerId, field);
        });
        html += '</div>';
      }
      html += '</details>';
    });
    el.innerHTML = html;
  }

  function renderCfField(trackerId, field) {
    const cfg = getCfgField(trackerId, field.id) || { id: field.id, name: field.name, type: 'text', options: [] };
    const isSelect = cfg.type === 'select';
    let html = '<div class="cf-field" data-tracker="' + trackerId + '" data-field="' + field.id + '">';
    html += '<div class="cf-field-head">';
    html += '<div class="cf-name">' + escAttr(field.name) + ' <small>(ID: ' + field.id + ')</small></div>';
    html += '<label style="font-size:.85em">Type:</label>';
    html += '<select class="cf-type-sel" onchange="onCfTypeChange(this,' + trackerId + ',' + field.id + ')">';
    html += '<option value="text"' + (isSelect ? '' : ' selected') + '>Text input</option>';
    html += '<option value="select"' + (isSelect ? ' selected' : '') + '>Select (dropdown)</option>';
    html += '</select>';
    html += '</div>';
    html += '<div class="cf-options" data-options-for="' + trackerId + '_' + field.id + '" style="display:' + (isSelect ? 'block' : 'none') + '">';
    html += renderCfOptions(trackerId, field.id, cfg.options || []);
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderCfOptions(trackerId, fieldId, options) {
    let html = '<label class="cf-options-label">Options</label>';
    if (!options || options.length === 0) {
      html += '<div class="cf-no-options">No options yet.</div>';
    } else {
      html += '<div class="cf-option-list">';
      options.forEach(function(opt, idx) {
        html += '<div class="cf-option-row">';
        html += '<input type="text" class="cf-option-input" value="' + escAttr(opt) + '" placeholder="Option value" oninput="onCfOptionInput(this,' + trackerId + ',' + fieldId + ',' + idx + ')">';
        html += '<button class="cf-opt-remove" onclick="removeCfOption(' + trackerId + ',' + fieldId + ',' + idx + ')" title="Remove option">×</button>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '<button class="cf-opt-add" onclick="addCfOption(' + trackerId + ',' + fieldId + ')">+ Add option</button>';
    return html;
  }

  function rerenderCfOptions(trackerId, fieldId) {
    const cfg = getCfgField(trackerId, fieldId);
    const wrap = document.querySelector('.cf-options[data-options-for="' + trackerId + '_' + fieldId + '"]');
    if (wrap && cfg) wrap.innerHTML = renderCfOptions(trackerId, fieldId, cfg.options || []);
  }

  // ── _cfConfig accessors ────────────────────────────────────────────────────
  function getCfgField(trackerId, fieldId) {
    const entry = _cfConfig.find(function(c) { return c.trackerId === trackerId; });
    if (!entry) return null;
    return entry.fields.find(function(f) { return f.id === fieldId; }) || null;
  }

  function ensureCfgField(trackerId, fieldId) {
    const tracker = TRACKER_FIELD_CACHE.find(function(t) { return t.trackerId === trackerId; });
    if (!tracker) return null;
    const fieldDef = (tracker.fields || []).find(function(f) { return f.id === fieldId; });
    if (!fieldDef) return null;
    let entry = _cfConfig.find(function(c) { return c.trackerId === trackerId; });
    if (!entry) {
      entry = { trackerId: trackerId, trackerName: tracker.trackerName, fields: [] };
      _cfConfig.push(entry);
    }
    let cfg = entry.fields.find(function(f) { return f.id === fieldId; });
    if (!cfg) {
      cfg = { id: fieldId, name: fieldDef.name, type: 'text', options: [] };
      entry.fields.push(cfg);
    }
    return cfg;
  }

  function commitCfConfig(silent) {
    vscode.postMessage({ command: 'saveCustomFieldConfig', config: _cfConfig, silent: !!silent });
  }

  // ── Type change → auto-save ────────────────────────────────────────────────
  function onCfTypeChange(sel, trackerId, fieldId) {
    const cfg = ensureCfgField(trackerId, fieldId);
    if (!cfg) return;
    cfg.type = sel.value;
    const optionsWrap = document.querySelector('.cf-options[data-options-for="' + trackerId + '_' + fieldId + '"]');
    if (optionsWrap) optionsWrap.style.display = sel.value === 'select' ? 'block' : 'none';
    commitCfConfig(true); // silent auto-save
  }

  // ── Option add / remove / edit ────────────────────────────────────────────
  function addCfOption(trackerId, fieldId) {
    const cfg = ensureCfgField(trackerId, fieldId);
    if (!cfg) return;
    if (!cfg.options) cfg.options = [];
    cfg.options.push('');
    rerenderCfOptions(trackerId, fieldId);
    // Focus the newly added input
    const wrap = document.querySelector('.cf-options[data-options-for="' + trackerId + '_' + fieldId + '"]');
    if (wrap) {
      const inputs = wrap.querySelectorAll('.cf-option-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }
  }

  function removeCfOption(trackerId, fieldId, idx) {
    const cfg = getCfgField(trackerId, fieldId);
    if (!cfg || !cfg.options) return;
    cfg.options.splice(idx, 1);
    rerenderCfOptions(trackerId, fieldId);
  }

  function onCfOptionInput(inp, trackerId, fieldId, idx) {
    const cfg = ensureCfgField(trackerId, fieldId);
    if (!cfg || !cfg.options) return;
    cfg.options[idx] = inp.value;
  }

  function saveCustomFieldConfig() {
    // Trim empty option strings and persist
    _cfConfig.forEach(function(entry) {
      entry.fields.forEach(function(f) {
        if (f.options) f.options = f.options.map(function(s) { return (s || '').trim(); }).filter(Boolean);
      });
    });
    commitCfConfig(false);
    renderCustomFields(TRACKER_FIELD_CACHE, _cfConfig);
  }

  function refetchCustomFields() {
    document.getElementById('btnRefetch').disabled = true;
    showFb('cfFb', 'info', 'Fetching custom fields from Redmine...');
    vscode.postMessage({ command: 'refetchCustomFields' });
  }

  function exportCustomFields() {
    vscode.postMessage({ command: 'exportCustomFields' });
  }

  function importCustomFields() {
    vscode.postMessage({ command: 'importCustomFields' });
  }

  function exportTemplate() {
    vscode.postMessage({ command: 'exportTemplate' });
  }

  function importTemplate() {
    vscode.postMessage({ command: 'importTemplate' });
  }

  function clearTemplate() {
    vscode.postMessage({ command: 'clearTemplate' });
  }

  // ── Issue Detection ────────────────────────────────────────────────────────
  function renderDetectionLists() {
    renderDetectChips('include', _detectInc, 'detectIncludeList');
    renderDetectChips('exclude', _detectExc, 'detectExcludeList');
  }

  function renderDetectChips(kind, list, elId) {
    const el = document.getElementById(elId);
    if (list.length === 0) {
      el.innerHTML = '<div style="font-size:.82em;color:var(--vscode-descriptionForeground);font-style:italic">(empty)</div>';
      return;
    }
    el.innerHTML = list.map(function(kw, idx) {
      return '<div style="display:flex;align-items:center;gap:6px">'
        + '<code style="flex:1;font-family:monospace;background:var(--vscode-textCodeBlock-background);padding:4px 8px;border-radius:3px;font-size:.85em">' + escAttr(kw) + '</code>'
        + '<button class="btn btn-sec btn-sm" onclick="removeDetectKeyword(\\'' + kind + '\\',' + idx + ')" title="Remove" style="padding:2px 8px;line-height:1">×</button>'
        + '</div>';
    }).join('');
  }

  function addDetectKeyword(kind) {
    const inp = document.getElementById(kind === 'include' ? 'detectIncludeInput' : 'detectExcludeInput');
    const val = (inp.value || '').trim();
    if (!val) return;
    const list = kind === 'include' ? _detectInc : _detectExc;
    if (list.some(function(k) { return k.toLowerCase() === val.toLowerCase(); })) {
      showFb('detectFb', 'error', 'Keyword "' + val + '" already exists in ' + kind + ' list.');
      return;
    }
    list.push(val);
    inp.value = '';
    renderDetectionLists();
    inp.focus();
  }

  function removeDetectKeyword(kind, idx) {
    const list = kind === 'include' ? _detectInc : _detectExc;
    list.splice(idx, 1);
    renderDetectionLists();
  }

  function onDetectInputKey(ev, kind) {
    if (ev.key === 'Enter') { ev.preventDefault(); addDetectKeyword(kind); }
  }

  function saveDetection() {
    vscode.postMessage({ command: 'saveIssueDetection', include: _detectInc, exclude: _detectExc });
  }

  function resetDetection() {
    if (!confirm('Reset detection rules to defaults (Include: NG, Fail; Exclude: empty)?')) return;
    _detectInc = ['NG', 'Fail'];
    _detectExc = [];
    renderDetectionLists();
    saveDetection();
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
    showFb('reloadFb', 'info', 'Loading from Redmine…');
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

    const trackerSel = document.getElementById('defaultTrackerId');
    const trackerId   = trackerSel.value;
    const trackerName = (trackerSel.selectedIndex >= 0 && trackerId)
      ? trackerSel.options[trackerSel.selectedIndex].text : '';

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
      defaultTrackerId:     trackerId,
      defaultTrackerName:   trackerName,
    });
  }

  function val(id) { return document.getElementById(id)?.value ?? ''; }

  // ── Test Case Template ─────────────────────────────────────────────────────
  function saveTemplate() {
    const template = {
      subject:    val('tmpl_subject'),
      description: val('tmpl_description'),
      tracker:    val('tmpl_tracker'),
      status:     val('tmpl_status'),
      assignee:   val('tmpl_assignee'),
      priority:   val('tmpl_priority'),
      dueDate:    val('tmpl_dueDate'),
      attachment: val('tmpl_attachment'),
    };
    vscode.postMessage({ command: 'saveTemplate', template });
  }

  function clearTemplate() {
    if (!confirm('Clear template? You can rebuild it anytime.')) return;
    vscode.postMessage({ command: 'saveTemplate', template: {} });
  }

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
      if (msg.trackers) renderTrackers(msg.trackers);
      showFb('reloadFb', 'success', '✓ Updated from Redmine.');
    }

    if (msg.command === 'templateSaved') {
      renderTemplate(msg.template);
    }

    if (msg.command === 'customFieldConfigSaved') {
      if (!msg.silent) {
        showFb('cfFb', 'success', '✓ Custom field configuration saved.');
        setTimeout(() => { const el = document.getElementById('cfFb'); if (el) el.style.display = 'none'; }, 2500);
      }
    }

    if (msg.command === 'refetchResult') {
      document.getElementById('btnRefetch').disabled = false;
      renderCustomFields(msg.cache, _cfConfig);
      showFb('cfFb', 'success', '✓ Custom fields refreshed from Redmine.');
    }

    if (msg.command === 'importResult' && msg.success) {
      _cfConfig = msg.config || [];
      renderCustomFields(TRACKER_FIELD_CACHE, _cfConfig);
      const summary = '✓ Imported ' + (msg.matched || 0) + ' field(s)' + (msg.skipped ? ', ' + msg.skipped + ' skipped' : '') + '.';
      showFb('cfFb', 'success', summary);
      setTimeout(() => { const el = document.getElementById('cfFb'); if (el) el.style.display = 'none'; }, 5000);
    }

    if (msg.command === 'issueDetectionSaved') {
      showFb('detectFb', 'success', '✓ Detection rules saved.');
      setTimeout(() => { const el = document.getElementById('detectFb'); if (el) el.style.display = 'none'; }, 2500);
    }

    if (msg.command === 'refetchError') {
      document.getElementById('btnRefetch').disabled = false;
      showFb('cfFb', 'error', 'Failed to refresh: ' + msg.message);
    }

    if (msg.command === 'reloadError') {
      showFb('reloadFb', 'error', msg.message);
    }

    if (msg.command === 'membersResult') {
      renderMembers(msg.members, undefined);
    }

    if (msg.command === 'saved') {
      ['saveFb1','saveFb2'].forEach(id => {
        showFb(id, 'success', '✓ Saved! The sidebar will refresh automatically.');
        setTimeout(() => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }, 3000);
      });
    }
  });
</script>
</body>
</html>`;
}
