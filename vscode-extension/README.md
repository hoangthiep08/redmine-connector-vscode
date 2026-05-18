# Redmine Connector

Browse, filter, and manage your Redmine issues without leaving your editor. Works with **VS Code**, **Cursor**, and **Windsurf**.

---

## Features

### Issue Sidebar
View your Redmine issues in a dedicated panel in the Activity Bar. Issues are grouped by project automatically, and the panel updates in real time as you apply filters.

### Rich Issue Detail
Click any issue to open a full detail view: description with inline images (Textile & Markdown), attachments, journal history with comments and images, and inline editors for status, assignee, and progress — no dialog boxes needed.

### Smart Filtering
Filter by project, status, or assignee directly from the toolbar. Typing a plain number (e.g. `123`) or `#123` in the search box jumps straight to that issue by ID. Text search works across issue subjects.

Filters set in **Settings → Default Filters** apply as persistent defaults; toolbar filters override them for the current session without touching your saved preferences.

### AI Chat Integration
Push any issue to your AI assistant with one click, or use the built-in chat participant:

```
@redmine list my open issues in project acme
@redmine show issue 42
@redmine what's assigned to me?
```

### Inline Actions (right-click on an issue)
| Action | Description |
|--------|-------------|
| Open Detail | Full issue view in a webview panel |
| Push to AI Chat | Send the issue context to your AI assistant |
| Update Status | Pick a new status from a quick-pick list |
| Assign Issue | Reassign to any project member |
| Add Comment | Post a note directly from the editor |
| Copy as Markdown | Copy the issue as formatted Markdown |

### Test Case → Issue Workflow
Open any QC test case Markdown file and the extension parses the table into a rich report. Each failed row gets a one-click **Create Issue** button that pre-fills subject, description, attachments, and custom fields from your template — no manual copy-paste.

- **Template Builder** with drag-and-drop column mapping. Drag any column header (e.g. `{{tcId}}`, `{{module}}`, `{{steps}}`) into Subject / Description / Custom Field inputs.
- **Auto-attach evidence**: image files referenced in the test case are uploaded to the issue automatically.
- **Issue Detection rules**: Settings → 🎯 Issue Detection lets you configure which `Status QC` values count as a failure via **Include** keywords (e.g. `NG`, `Fail`) and **Exclude** vetoes (e.g. `test NG`). Case-insensitive substring match.
- **Export / Import templates** as JSON so the whole QC team uses the same one.

### Per-Tracker Custom Fields
Settings → 🔧 Custom Fields discovers every tracker's custom fields from real issues (no admin API needed) and lets you mark each one as a text input or a select with predefined options. Collapsible per-tracker view; option lists managed inline (`+ Add option` / `×` remove). Config is Export/Import-friendly — share with your team via a single JSON file.

### Inline Custom Fields on Create
When creating an issue from a test case template, only the custom fields you explicitly added to that template appear in the form. Standalone `+ New Issue` still shows the full set. Select-type values are matched case-insensitively against configured options before submission — so `dev` lines up with `Dev` automatically.

---

## Requirements

- A running **Redmine** instance (self-hosted or cloud) with REST API enabled
- A valid **API key** (Redmine → My Account → API access key)

---

## Setup

1. After installing, the **Settings** panel opens automatically if no connection is configured.
2. Enter your **Redmine URL** (e.g. `https://redmine.company.com`) and **API Key**.
3. Click **Test Connection** to verify.
4. Click **Save Settings** — issues load immediately in the sidebar.

You can reopen Settings at any time via the gear icon (⚙) in the sidebar toolbar.

### Default Filters (optional)

Switch to the **Default Filters** tab in Settings to configure:

- **Default Project** — show a specific project on startup
- **Default Status** — Open, Closed, All, or a custom selection
- **Default Assignee** — Everyone, Assigned to me, or a specific team member

These defaults are always shown in the sidebar. Toolbar filters override them temporarily without changing your saved preferences.

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `redmine.baseUrl` | — | Redmine server URL |
| `redmine.apiKey` | — | Your Redmine API key |
| `redmine.defaultProject` | — | Project identifier shown by default |
| `redmine.defaultStatusMode` | `open` | `open` / `closed` / `*` / `custom` |
| `redmine.defaultStatusIds` | `[]` | Status IDs when mode is `custom` |
| `redmine.defaultAssigneeMode` | `all` | `all` / `me` / `custom` |
| `redmine.defaultAssigneeId` | — | User ID when assignee mode is `custom` |
| `redmine.textFormat` | `textile` | `textile` / `markdown` / `plain` |

---

## Toolbar Buttons

| Icon | Action |
|------|--------|
| $(refresh) | Reload issues from Redmine |
| $(search) | Search by keyword or issue number |
| $(filter) | Open filter menu (project / status / assignee) |
| $(settings-gear) | Open Settings |
| $(feedback) | Send feedback to the developer |

---

## Tips

- **Search by ID**: type `42` or `#42` in the search box to jump directly to issue #42, even if it's outside the current 200-issue page.
- **Changing filters clears search**: switching project, status, or assignee via the filter menu automatically clears any active text/ID search to avoid conflicting results.
- **Inline image support**: images embedded in issue descriptions or comments (Textile `!url!` or Markdown `![](url)`) are loaded and displayed inline in the detail view.
- **Saving settings clears search**: saving new connection or filter settings resets any active keyword search so the sidebar reflects your new defaults cleanly.

---

## Feedback & Support

Use the **$(feedback) Send Feedback** button in the sidebar toolbar to report bugs or request features. Your Redmine email is pre-filled automatically so we can follow up.

---

## Release Notes

### 1.4.1
- **Inline issue detail panel** in the Issue List webview — click any row and the detail slides in on the right side of the same tab (GitLab-style split view).
  - Sticky toolbar with `↗ Open in full tab` stays at the top while scrolling.
  - Shows subject, status / priority / tracker / % chips, assignee, dates, custom fields, description, last 5 comments, image attachments.
  - **Inline image rendering** in descriptions and comments (textile `!filename!` and markdown `![alt](filename)` references resolved against attachments).
  - **Lightbox**: click any image for full-screen zoom; `Esc` or click-outside to close.
- **ID badge** now uses VS Code's theme-aware badge colors (subtle pill, no more red).
- Removed `Found in` column and the unused selection checkbox column from the issue table — `Found in` is still visible inside the detail panel.

### 1.4.0
- **🗂 Redmine-style Issue List webview** — new "Open Issue List" button next to **Refresh** in the sidebar title bar. Opens a tab that mirrors Redmine's issue table:
  - Top filter panel pre-populated with your **Default Filters** from Settings (project, tracker, status, assignee, custom fields). Add or remove filter rows via the **`+ Add filter`** dropdown.
  - Apply / Clear / **Save to Global** (push the current filter into Settings → Default Filters).
  - Sortable column headers with `↑`/`↓` indicators, pagination (`Showing X–Y of Z`), page size 25.
  - Click an issue ID or subject to open the existing issue detail webview.
- **Custom field filters everywhere**
  - **Issue List webview**: any configured CF can be added as a filter row (text or dropdown depending on Settings).
  - **Settings → Default Filters → Default Custom Field Filters**: new section to set CF defaults that apply on every load.
  - **Sidebar** respects the same defaults — `customFieldConfig` is now threaded through every `listIssues()` call.
- **Marketplace categories** bumped from `Other` to `SCM Providers`, `Testing`, `Other` — more discoverable.
- **UI polish**: softer brick-red for the ID badge in the new Issue List view (was glaring red).

### 1.3.0
- **Settings → 🎯 Issue Detection tab**: configure which `Status QC` values count as a failure via two keyword lists
  - **Include** (substring, case-insensitive): triggers the "Create Issue" button (default: `NG`, `Fail`)
  - **Exclude** (veto): even if Include matches, these prevent detection (e.g. `test NG`)
  - Replaces the old hardcoded `NG`/`Fail` check
- **Export / Import Test Case Template from the Test Case Report header** (in addition to Settings); imports re-resolve `trackerId` by name so templates are portable across Redmine instances
- **Clear Template** now uses a native VS Code modal in both Settings and the template builder (in-webview `confirm()` was unreliable)
- **Test case classification simplified** — no more pass/skip/blocked categories. A row is either *To Create* (matches Include and not Exclude) or *Other*
- **Available Columns panel** no longer lists fields the markdown header doesn't contain (`typeBug`, `rootCause`, etc. that the parser set to `undefined` are filtered out)
- **Default Filters → Bug Tracker custom field IDs section removed** — obsolete after the per-tracker Custom Fields tab
- **Fix**: TDZ crash (`Cannot access 'isFailableServer' before initialization`) when opening a test case report
- **Fix**: duplicate `clearTemplate` function in Settings webview was shadowing the working one — Clear Template now actually clears

### 1.2.3
- **Settings → 🔧 Custom Fields tab redesigned**
  - Sticky header + tab bar stay visible while scrolling
  - Each tracker is a collapsible block; trackers without custom fields are sorted to the bottom
  - Options for `select`-type fields managed as a list (`+ Add option` / per-row remove), preserved per-field even when toggling type back to `text`
  - Switching field type (`text` ↔ `select`) auto-saves
- **Import / Export Custom Fields configuration** — JSON file, matches entries by **tracker name + field name** so config is portable across Redmine instances
- **Test Case Template builder — opt-in custom fields**
  - Tracker dropdown now lists **all trackers** from Redmine
  - Custom fields added one at a time via `+ Add Custom Field` (picker only shows fields not yet added); each row has a `×` remove with confirm
  - All template CF inputs are text inputs supporting column-drop or fixed values
- **Settings → Test Case Template** view stays in sync with the latest template (live config-change listener)
- **Create-issue form respects template scope** — only the custom fields explicitly added to that template are rendered; standalone `+ New Issue` still shows all configured fields
- **Case-insensitive option matching** for select-type custom fields — the canonical option text is sent to Redmine (e.g. `"dev"` → `"Dev"`)
- **Fix**: regex `/\n/g` inside the TS template literal was cooked into a real newline, freezing the entire Settings webview. Added a pre-build `check:webview` step that catches this class of bug going forward
- **Fix**: template builder lost typed data when adding a new custom field — drag-to-drop now fires an `input` event
- **Fix**: export save dialog failed with `EROFS` when no workspace was open; defaults to the user's home directory

### 1.2.0 ✨ Test Case → Issue Template System
- **Test Case Viewer**: Open markdown test case files, parse structured tables, view test results in a rich report
- **Test Case Template Builder**: Settings → Test Case Template tab to define how test case columns map to issue fields
  - Support template syntax: `{{columnName}}` for field interpolation, concat multiple columns
  - Configurable fields: Subject, Description, Tracker, Status, Assignee, Priority, Due Date, Attachments
  - Global template saved in settings, reusable across all test case files
- **Create Issue from Test Case**: Failed test cases now show "✚ Create Issue" button that pre-fills forms based on template
  - Auto-extract data from configured columns
  - Attachment support: auto-fetch image files referenced in test evidence
- **Bug Tracker Custom Fields**: 
  - Settings to configure Bug tracker field IDs (Type Bug, Found in, Root Cause)
  - Auto-detect fields from existing Bug issues if admin API unavailable
  - Custom fields pre-filled when creating issues from failed test cases
- **Template Validation**: Warning banner if no template is set; disable Create Issue button until template is configured
- **Feedback Button**: Only visible when Redmine connection is configured

### 1.1.0
- Create Issue webview with full form (project, tracker, status, priority, assignee, due date, attachments)
- Custom field support with drag-drop and autocomplete in create form
- Default tracker = Bug + status = New when creating from test cases
- Test case right-click context menu: "Redmine: View Test Case"

### 1.0.1
- Inline status, assignee, and progress editing in issue detail view
- Smart search by issue number (`#123`)
- Persistent default filters (project / status / assignee) in Settings
- Inline image rendering in descriptions and journal comments
- AI chat participant (`@redmine`)
- Send Feedback form with n8n webhook integration

### 1.0.0
- Initial release
