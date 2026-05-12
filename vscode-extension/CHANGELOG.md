# Changelog

All notable changes to the **Redmine Connector** extension are documented in this file.

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
