import axios, { AxiosInstance } from "axios";

export interface Attachment {
  id: number;
  filename: string;
  filesize: number;
  content_type: string;
  description: string;
  content_url: string;
  thumbnail_url?: string;
  author: { id: number; name: string };
  created_on: string;
}

export interface Issue {
  id: number;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  subject: string;
  description: string;
  start_date?: string;
  due_date?: string;
  done_ratio: number;
  created_on: string;
  updated_on: string;
  journals?: Journal[];
  attachments?: Attachment[];
}

export interface Journal {
  id: number;
  user: { id: number; name: string };
  notes: string;
  created_on: string;
  updated_on?: string;
  details: Array<{ property: string; name: string; old_value: string; new_value: string }>;
}

export interface IssueStatus {
  id: number;
  name: string;
  is_closed: boolean;
}

export interface Project {
  id: number;
  name: string;
  identifier: string;
  description: string;
}

export interface Member {
  id: number;
  name: string;
  roles: string[];
}

export interface Priority {
  id: number;
  name: string;
  is_default: boolean;
}

let httpClient: AxiosInstance | null = null;
let currentBaseUrl = "";
let currentApiKey = "";

export function configureClient(baseUrl: string, apiKey: string) {
  currentBaseUrl = baseUrl.replace(/\/$/, "");
  currentApiKey = apiKey;
  httpClient = axios.create({
    baseURL: currentBaseUrl,
    headers: {
      "X-Redmine-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

function getClient(): AxiosInstance {
  if (!httpClient) {
    throw new Error("Redmine is not configured. Please set baseUrl and apiKey in settings.");
  }
  return httpClient;
}

export async function listIssues(params: {
  projectId?: string;
  statusId?: string;
  assignedToId?: string;
  limit?: number;
  offset?: number;
  subject?: string;
}): Promise<{ issues: Issue[]; total_count: number }> {
  const query: Record<string, string | number> = {
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  };
  if (params.projectId) query["project_id"] = params.projectId;
  if (params.statusId) query["status_id"] = params.statusId;
  if (params.assignedToId) query["assigned_to_id"] = params.assignedToId;
  if (params.subject) query["subject"] = `~${params.subject}`;

  const res = await getClient().get("/issues.json", { params: query });
  return res.data;
}

export async function getCurrentUser(): Promise<{ id: number; name: string; login: string }> {
  const res = await getClient().get("/users/current.json");
  return res.data.user;
}

export async function updateJournal(journalId: number, notes: string): Promise<void> {
  await getClient().put(`/journals/${journalId}.json`, { journal: { notes } });
}

export async function deleteJournal(journalId: number): Promise<void> {
  // Redmine REST API has no DELETE endpoint for journals.
  // Clearing notes via PUT is the only supported way to remove a comment.
  await getClient().put(`/journals/${journalId}.json`, { journal: { notes: "" } });
}

export async function getIssue(id: number): Promise<Issue> {
  const res = await getClient().get(`/issues/${id}.json`, {
    params: { include: "journals,attachments" },
  });
  return res.data.issue;
}

export interface UploadToken {
  token: string;
  filename: string;
  content_type: string;
}

export async function uploadAttachment(base64: string, filename: string, contentType: string): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const res = await getClient().post("/uploads.json", buffer, {
    headers: { "Content-Type": "application/octet-stream" },
    params: { filename },
  });
  return res.data.upload.token;
}

export async function updateIssue(
  id: number,
  updates: {
    statusId?: number;
    assignedToId?: number;
    notes?: string;
    subject?: string;
    description?: string;
    doneRatio?: number;
    dueDate?: string;
    uploads?: UploadToken[];
  }
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (updates.statusId !== undefined) body["status_id"] = updates.statusId;
  if (updates.assignedToId !== undefined) body["assigned_to_id"] = updates.assignedToId === 0 ? "" : updates.assignedToId;
  if (updates.notes !== undefined) body["notes"] = updates.notes;
  if (updates.subject !== undefined) body["subject"] = updates.subject;
  if (updates.description !== undefined) body["description"] = updates.description;
  if (updates.doneRatio !== undefined) body["done_ratio"] = updates.doneRatio;
  if (updates.dueDate !== undefined) body["due_date"] = updates.dueDate;
  if (updates.uploads?.length) body["uploads"] = updates.uploads;
  await getClient().put(`/issues/${id}.json`, { issue: body });
}

export async function listStatuses(): Promise<IssueStatus[]> {
  const res = await getClient().get("/issue_statuses.json");
  return res.data.issue_statuses;
}

export async function listProjects(): Promise<Project[]> {
  const res = await getClient().get("/projects.json", { params: { limit: 100 } });
  return res.data.projects;
}

export async function listProjectMembers(projectId: string): Promise<Member[]> {
  const res = await getClient().get(`/projects/${projectId}/memberships.json`, {
    params: { limit: 100 },
  });
  return (res.data.memberships as Array<{ user?: { id: number; name: string }; roles: Array<{ name: string }> }>)
    .filter((m) => m.user)
    .map((m) => ({
      id: m.user!.id,
      name: m.user!.name,
      roles: m.roles.map((r) => r.name),
    }));
}

export async function listPriorities(): Promise<Priority[]> {
  const res = await getClient().get("/enumerations/issue_priorities.json");
  return res.data.issue_priorities;
}

export async function createIssue(params: {
  projectId: string;
  subject: string;
  description?: string;
  assignedToId?: number;
  statusId?: number;
  trackerId?: number;
}): Promise<Issue> {
  const body: Record<string, unknown> = {
    project_id: params.projectId,
    subject: params.subject,
  };
  if (params.description) body["description"] = params.description;
  if (params.assignedToId) body["assigned_to_id"] = params.assignedToId;
  if (params.statusId) body["status_id"] = params.statusId;
  if (params.trackerId) body["tracker_id"] = params.trackerId;

  const res = await getClient().post("/issues.json", { issue: body });
  return res.data.issue;
}

export async function deleteAttachment(id: number): Promise<void> {
  await getClient().delete(`/attachments/${id}.json`);
}

export async function fetchAttachmentAsDataUrl(url: string): Promise<string> {
  const res = await getClient().get(url, { responseType: "arraybuffer" });
  const contentType = (res.headers["content-type"] as string) || "image/png";
  const base64 = Buffer.from(res.data as ArrayBuffer).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

export function isImageAttachment(attachment: Attachment): boolean {
  return attachment.content_type.startsWith("image/");
}

export function formatIssueAsMarkdown(issue: Issue, baseUrl?: string): string {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/issues/${issue.id}` : `#${issue.id}`;
  const lines: string[] = [
    `## [#${issue.id}] ${issue.subject}`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Project** | ${issue.project.name} |`,
    `| **Tracker** | ${issue.tracker.name} |`,
    `| **Status** | ${issue.status.name} |`,
    `| **Priority** | ${issue.priority.name} |`,
    `| **Author** | ${issue.author.name} |`,
    `| **Assignee** | ${issue.assigned_to?.name ?? "Unassigned"} |`,
    `| **Progress** | ${issue.done_ratio}% |`,
    issue.due_date ? `| **Due Date** | ${issue.due_date} |` : null,
    `| **URL** | ${url} |`,
  ].filter(Boolean) as string[];

  if (issue.description) {
    lines.push(``, `### Description`, ``, issue.description);
  }

  const comments = (issue.journals ?? []).filter((j) => j.notes);
  if (comments.length > 0) {
    lines.push(``, `### Comments`);
    for (const c of comments) {
      lines.push(``, `**${c.user.name}** (${c.created_on.split("T")[0]}):`, c.notes);
    }
  }

  return lines.join("\n");
}

export function getBaseUrl(): string {
  return currentBaseUrl;
}
