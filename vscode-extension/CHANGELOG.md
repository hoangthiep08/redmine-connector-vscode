# Changelog

All notable changes to the **Redmine Connector** extension are documented in this file.

## [1.5.0]

### Added
- **🚀 Bulk-create issues from selected test cases.**
  - New checkbox column on the Test Case Report. Only **failable + unlinked** rows are selectable (linked TCs and pass/skip rows are excluded).
  - **Sticky bulk action bar at the top of the table** (stays visible while scrolling): **Select all** + **Unselect all** are always shown; **`✚ Create N Issues`** sits next to them — disabled when no row is selected, active and labelled with the count once you tick a checkbox; selection count chip appears beside the buttons when ≥1 row is selected.
  - Click **`✚ Create N Issues`** → opens the Create Issue form in **bulk mode**: a banner explains what's about to happen, the **Subject / Description / Custom Fields** show a *preview* using the first selected TC, and the rest of the form (**Project / Tracker / Status / Priority / Assignee / Due Date**) is the *common* settings that will apply to every issue.
  - On submit, a modal confirms (the form **stays open** during confirmation — cancelling keeps you on the form so you can adjust and resubmit). Once confirmed, the extension loops over the TCs creating one Redmine issue per TC:
    - Subject, Description, Custom Fields are **re-interpolated from the template per test case** — so each issue has its own data, not the preview shown in the form.
    - For any required custom field that interpolates to empty for a given TC (e.g. "Type Bug" on a TC without that column populated), the CF value picked in the bulk form is used as a **fallback** so the issue still creates successfully.
    - Evidence attachments are parsed and uploaded **per test case**.
    - Select-type custom fields are validated case-insensitively against the configured options.
  - Progress notification (`N/Total · TC-ID`) during the run; final summary toast: `✓ Created X issues, Y failed, Z skipped (already linked)` with details for failed ones.
  - Each newly created issue is linked back to its TC in the local link map.

### Fixed
- **TC parser** now stops at the first non-table line after the main test case table — previously it kept walking past blank lines and folded in rows from any later table that also had a `TC ID` column (e.g. an "NG Summary" cheat-sheet at the end of the file), which doubled the selection count.

### Changed
- Test Case Report table gained an extra column at the left for selection checkboxes — placeholder spacing keeps non-failable rows aligned.

## [1.4.2]

### Fixed
- **Test case header detection now covers every column** in the markdown table — `Page/Screen`, `PC`, `SP`, `Q&A`, `Status 2 (QC)`, `Date 2`, `ID Bug`, `Browser/Device`, and any other custom header now show up as draggable chips in the template builder. The legacy parser only knew about a fixed set (`tcId`, `module`, `priority`, …) and silently dropped anything else.

### Changed
- **Template interpolation accepts raw header names** in addition to the legacy camelCase keys. New templates can use `{{TC ID}}`, `{{Page/Screen}}`, `{{Status 2 (QC)}}`, etc. Existing templates using `{{tcId}}`, `{{module}}`, `{{foundIn}}` continue to work — the lookup tries TC's typed field first, then falls back to the raw header (case-insensitive).
- **"Available Columns"** panel in the template builder now lists every header from the markdown source (in source order), filtered to those with real data in at least one TC.

### Added
- **Filter persistence in the Issue List webview** — the most recent filter is saved to `globalState` on every Apply, so reopening the tab restores it instead of re-reading Settings defaults. New `⤺ Reset` button next to **Clear** discards the saved filter and rebuilds from Settings defaults.
- **Detail panel — `💬 Push to AI` button** in the sticky toolbar pushes the selected issue to the AI chat (same QuickPick as the sidebar context menu) without leaving the list.
- **Compact filter grid** — filter rows now lay out in a responsive `auto-fill` grid (2–3 per row on a typical viewport) instead of one full row per filter.

## [1.4.1]

### Added
- **Inline issue detail panel** in the Issue List webview — click any row and the detail slides in on the right side of the same tab (GitLab-style split view).
  - Sticky toolbar at the top of the panel with `↗ Open in full tab` button and close `×` — stays visible while scrolling the panel content.
  - Shows: subject, status / priority / tracker / % chips, assignee, dates, custom fields, description, last 5 comments, image attachments.
  - **Inline image rendering**: textile (`!filename!`) and markdown (`![alt](filename)`) references inside description + comments are resolved to actual images. Images load lazily via `fetchAttachmentAsDataUrl` (same mechanism as the full issue webview).
  - **Lightbox**: click any image → full-screen zoom overlay (`Esc` or click-outside to close).
  - `Esc` closes the lightbox first, then the detail panel.
  - Detail panel is ~100px taller than the previous draft (`calc(100vh - 140px)`).

### Changed
- **ID badge** in the issue table now uses VS Code's theme-aware `--vscode-badge-background` / `--vscode-badge-foreground` (subtle pill, no more eye-catching red). Hover lifts to the link color; the row's `.selected` state inverts to `--vscode-textLink-foreground` background.

### Removed
- **`Found in` column** from the issue list table (data is still visible in the detail panel under Custom Fields).
- **Selection checkbox column** — removed for now since no bulk-actions are implemented. Will return once bulk-create/update is wired.

### Internal
- `redmine-client.listIssues()` extended with `authorId`, `priorityId`, `sort`, `include`, and `customFields` (`cf_<id>` query params).
- Pre-build webview-script syntax check now also covers `src/issue-list-webview.ts`.

## [1.4.0]

### Added
- **🗂 Redmine-style Issue List webview** — new command `Redmine: Open Issue List` (also surfaced as `$(list-flat)` button next to **Refresh** in the sidebar title bar).
  - Top filter panel: pre-populated with the active **Default Filters** from Settings (project, tracker, status, assignee, default custom fields). Add/remove filter rows individually; **`+ Add filter`** dropdown lists every built-in + every configured custom field grouped under a `── Custom fields ──` separator.
  - **Save to Global** action pushes the current filter back into Settings → Default Filters with a confirm modal.
  - Sortable column headers (#, Tracker, Status, Priority, Subject, Assignee, % Done) with asc/desc indicators.
  - Pagination (Prev / page numbers / Next) with `Showing X–Y of Z` counter, page size 25.
  - Click an issue ID or subject to open the existing issue detail webview.
- **Custom field filters everywhere**
  - **Issue List webview**: any configured CF can be added as a filter row (text or `select` depending on Settings).
  - **Settings → Default Filters → Default Custom Field Filters**: new section to set CF defaults that apply on every load. Persisted at `redmine.defaultCustomFields`.
  - **Sidebar issue list** (`IssueProvider`): `resolveQueryParams()` now resolves `defaultCustomFields` and threads them through every `listIssues()` call (single-project, multi-project, append).
- **Marketplace categories**: bumped from `["Other"]` to `["SCM Providers", "Testing", "Other"]` — more discoverable for QC / dev workflows.

### Changed
- **ID badge** in the new Issue List webview uses a muted brick-red (`#9c4040`) instead of the harsh `--vscode-errorForeground`. Hover lightens to `#b35353`.
- `redmine-client.listIssues()` extended with `authorId`, `priorityId`, `sort`, `include`, and `customFields` (`cf_<id>` query params).

## [1.3.0]

### Added
- **Settings → 🎯 Issue Detection tab** — configure which `Status QC` values mark a row as failed.
  - Two lists with chip UI: **Include** (substring keywords that trigger detection) and **Exclude** (substring keywords that veto Include, e.g. `test NG`).
  - Save / Reset-to-defaults; Enter in input also adds a keyword.
  - Drives both the `Create Issue` button visibility and the summary counter — replaces the previous hardcoded `NG`/`Fail` check.
- **Export / Import Test Case Template from the Test Case Report header** — `📤 Export` and `📥 Import` buttons now sit next to `View Template` / `Create Template` (in addition to the same buttons in Settings).
- **Clear Template** button works reliably now via native VS Code modal confirm (the in-webview `confirm()` was unreliable across versions).

### Changed
- **Test case row classification simplified** — `pass` / `skip` / `blocked` / `not tested` categories removed. A row is either *failable* (matches Include and not Exclude) or *Other*. Summary bar now shows `✗ N To Create` + `— M Other`.
- **Bulk-issue groundwork**: the unified `isFailable()` predicate is the single source of truth for both button visibility and counters, making the upcoming "create all" feature straightforward to wire.

### Fixed
- **Available Columns panel in template builder** no longer lists fields the markdown header doesn't contain — `typeBug`, `rootCause`, etc. that the parser set to `undefined` are filtered out. Only columns with real data in at least one TC are shown; sample data is pulled from the first non-empty row.
- **TDZ crash when opening a test case report** — `failCount` referenced `isFailableServer` before its `const` declaration. Moved the helper to the top of `buildHtml`.
- **Settings → Clear Template** wasn't working — a leftover duplicate `clearTemplate` function (using the unreliable in-webview `confirm()` and the wrong command name) was shadowing the working one. Dead code removed.

### Removed
- **Default Filters → "Bug Tracker — Custom Field IDs" section** — obsolete after the per-tracker Custom Fields tab; the three settings (`bugFieldTypeBugId`, `bugFieldFoundInId`, `bugFieldRootCauseId`) are no longer used.

## [1.2.3]

### Added
- **Settings — Custom Fields tab redesigned**
  - Sticky header + tab bar stay visible while scrolling.
  - Each tracker is now a collapsible block (`<details>`); trackers without custom fields are sorted to the bottom.
  - Options for `select`-type fields are managed as a list with `+ Add option` / per-row remove, and are preserved per-field even when switching type back to `text`.
  - Switching field type (`text` ↔ `select`) auto-saves; option edits still saved via **Save Custom Fields**.
- **Import / Export Custom Fields configuration**
  - Export to JSON (file picker, default to workspace or home dir).
  - Import matches entries by **tracker name + field name** (portable across Redmine instances with different IDs); confirms before replacing existing config.
- **Test Case Template builder — opt-in custom fields**
  - Tracker dropdown now lists **all trackers** from Redmine (not only those configured in Settings).
  - Custom fields are added one at a time via `+ Add Custom Field` (picker shows only fields not yet added); each row has a `×` remove with confirm.
  - All template CF inputs are text inputs supporting column-drop or fixed values, regardless of the field's underlying `select`/`text` type in Settings.
- **Settings → Test Case Template** view stays in sync with the latest template (re-renders on `redmine.testCaseTemplate` config changes).

### Changed
- **Create-issue form respects template scope** — when triggered from a template, only the custom fields explicitly added to that template are rendered. Standalone `+ New Issue` still shows all configured fields.
- **Case-insensitive option matching** — interpolated select values are matched to configured options ignoring case and surrounding whitespace; the canonical option text is sent to Redmine.

### Fixed
- **Settings webview frozen** — regex `/\n/g` inside the TS template literal was cooked into a real newline, breaking the entire script. Added a pre-build `check:webview` step that catches this class of bug going forward.
- **Template builder lost typed data when adding a new custom field** — drag-to-drop now fires an `input` event so state stays in sync; DOM ↔ state sync runs before any re-render.
- **Export save dialog** failed with `EROFS` when no workspace was open; defaults to the user's home directory instead of `/`.

## [1.2.1]

### Added
- **Custom Fields in Template** — template builder now includes a Tracker selector (populated from Custom Fields config) and renders the corresponding custom fields for that tracker.
  - Select-type fields: choose a static value or map to a test case column via `{{columnName}}`.
  - Text-type fields: drag a column header from the left panel or type a template string.
- **Custom Fields applied on issue creation** — when creating an issue from a failed test case, the extension now interpolates and applies all custom field mappings defined in the template.
  - Select-type validation: if the interpolated value does not match any configured option, the field is left empty instead of auto-selecting a wrong value.
- **Tracker-scoped custom field discovery** — on extension startup, fetches one issue per tracker to discover custom fields and caches them; a *Refresh from Redmine* button in Settings → Custom Fields forces a full re-fetch.
- **Custom Fields settings tab** — new tab in the Settings webview to define type (`text` / `select`) and options for each discovered custom field, per tracker.
- **Dynamic custom fields in Create Issue form** — custom fields are now loaded from `customFieldConfig` globalState for any tracker, replacing the previous hardcoded Bug-only fields.

### Fixed
- Removed hardcoded Bug tracker custom fields (`Type Bug`, `Found in`, `Root Cause`); all custom fields are now managed through the Custom Fields settings tab.
- Template builder no longer includes Due Date and Priority fields.

---

## [1.2.0]

### Added — Test Case Template System
- **Test Case Template Builder** — new Settings tab (`Settings → Test Case Template`) to define how test case columns map to issue fields.
  - Visual template editor: drag/drop columns or type template syntax `{{columnName}}` to interpolate field values.
  - Support concatenation: `{{col1}} {{col2}}` combines multiple columns with spaces.
  - Configurable issue fields: Subject, Description, Tracker, Status, Assignee, Priority, Due Date, Attachments.
  - Global settings storage: template is saved once and reused across all test case files in the workspace.
- **Template-Driven Issue Creation** — when creating an issue from a failed test case, the extension applies the template to extract and pre-fill form fields.
  - Auto-interpolate column values into subject and description fields.
  - Auto-resolve tracker and status names from Redmine if configured.
  - Auto-fetch attachment files referenced in configured columns (searches for matching files in the test case directory).
  - Skip empty column mappings gracefully (no "blank field" errors).
- **Template Validation in Test Case Viewer** — warning banner if no template is configured; "✚ Create Issue" button disabled until template is saved.
  - Clear user guidance: "Go to Settings → Test Case Template to create one."
- **Feedback Button Visibility** — feedback button in the sidebar is only shown when connection is fully configured (`baseUrl` + `apiKey` present).

### Fixed
- **Custom field submission** — marked `{{columnName}}` fields as required in Bug tracker forms only if custom field IDs are configured in Settings.
- **Extension activation** — downgraded `marked` from ESM-only v18 to CommonJS-compatible v4 to fix "cannot find module" errors on startup.

---

## [1.1.0]

### Added — Issue Creation
- **Create Issue webview** — full form to create new issues with project, tracker, subject, description, status, priority, assignee, due date, and attachments (drag & drop or click to upload).
- **Bug tracker custom fields** — automatically render `Type Bug`, `Found in`, `Root Cause` dropdowns when the selected tracker is *Bug*.
- **Auto-detect custom field IDs** — on extension startup, the extension fetches one existing Bug issue as a template and caches the custom field IDs in global state, so subsequent issue creation works without admin access to `/custom_fields.json`.
- **Manual override in Settings** — three new settings (`bugFieldTypeBugId`, `bugFieldFoundInId`, `bugFieldRootCauseId`) to enter custom field IDs manually if auto-detection cannot resolve them.
- **Helpful guide when no template exists** — if no Bug issue has ever been created, the form shows an inline instruction asking the user to create one Bug issue on Redmine first so the extension can detect field IDs.

### Added — Issue Editing
- **Edit Subject + Description** — new ✏ Edit button in the issue detail view opens an inline editor for the issue subject and description without leaving the panel.
- **Inline status / assignee / progress** — change these directly from the meta grid via dropdowns; no need to open quick-pick menus.
- **Comment reply / edit / delete** — own comments can be edited or removed in place; any comment can be replied to with the original text auto-quoted.

### Added — Test Case Integration
- **Auto-detect test case files** — any Markdown file containing a `TC ID` column shows the **Redmine: View Test Case** command in the Explorer and editor context menus.
- **Test Case Report viewer** — parses the Markdown test case table and displays a summary (Pass / Fail / Skip / Blocked / Not Tested) with status badges and priority indicators.
- **One-click Create Issue from Fail rows** — failed test cases get a ✚ Create Issue button that opens the Create Issue webview pre-filled with the TC ID, scenario, steps, expected, and actual values, with tracker = *Bug* and status = *New*.
- **Persistent issue ↔ test case linking** — after an issue is created, the row's Action column is replaced with a clickable `#1234` badge showing the linked issue. The mapping (file path + TC ID + line number + issue ID) is stored in extension global state and survives reloads. A small `×` button lets you unlink and recreate.

### Added — Issue List
- **Filter by Tracker** — new filter option in the sidebar to narrow issues by tracker (Bug, Feature, etc.).
- **Load More** — sidebar paginates issues with a configurable batch size. When more results are available, a *Load More* item appears at the bottom so large projects don't freeze the UI.

### Added — Issue Detail View
- **Complete UI redesign** — sticky header with badges, meta grid, tabs for *Comments* / *History*, attachment gallery, image modal viewer with click-to-zoom, and lazy loading of attachment images.
- **Avatars** — user initials shown next to each comment / history entry.
- **Rich text rendering** — Markdown + inline image attachments rendered properly in descriptions and comments.

### Fixed
- **Feedback submission requires API config** — sending feedback is now blocked with a clear error message until `redmine.baseUrl` and `redmine.apiKey` (and `redmine.feedbackWebhookUrl`) are saved. Previously the action would silently fail.
- **Issue list no longer loads everything at once** — replaced the unbounded fetch with paginated requests and explicit *Load More* control. Prevents long initial loads and memory spikes on large Redmine instances.
- **Test case table horizontal scroll** — wide tables now scroll horizontally on narrow viewports instead of compressing columns and hiding content.
- **Create Issue button placement** — moved to the first column of the test case table so users on small screens see it without having to scroll right.
- **Empty subject guard on edit** — saving an empty subject is rejected with a user-facing error rather than producing a 422 from Redmine.

### Changed
- Bumped minimum required VS Code version (`engines.vscode`) and updated `package.json` activation events and command/menu contributions accordingly.

---

## [1.0.0]

- Initial release: Redmine sidebar, issue list, basic detail view, status / assignee quick actions, configuration UI.
