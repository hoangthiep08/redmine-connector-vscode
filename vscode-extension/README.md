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

### 1.0.1
- Inline status, assignee, and progress editing in issue detail view
- Smart search by issue number (`#123`)
- Persistent default filters (project / status / assignee) in Settings
- Inline image rendering in descriptions and journal comments
- AI chat participant (`@redmine`)
- Send Feedback form with n8n webhook integration

### 1.0.0
- Initial release
