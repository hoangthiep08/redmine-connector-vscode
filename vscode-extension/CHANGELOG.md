# Changelog

All notable changes to the **Redmine Connector** extension are documented in this file.

## [1.2.4]

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
