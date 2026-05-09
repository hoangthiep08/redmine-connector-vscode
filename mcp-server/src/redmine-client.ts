import axios, { AxiosInstance } from "axios";

export interface RedmineConfig {
  baseUrl: string;
  apiKey: string;
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
}

export interface Journal {
  id: number;
  user: { id: number; name: string };
  notes: string;
  created_on: string;
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
  status: number;
}

export interface Membership {
  id: number;
  user: { id: number; name: string };
  roles: Array<{ id: number; name: string }>;
}

export class RedmineClient {
  private http: AxiosInstance;

  constructor(config: RedmineConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ""),
      headers: {
        "X-Redmine-API-Key": config.apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  async listIssues(params: {
    projectId?: string;
    statusId?: string;
    assignedToId?: string;
    limit?: number;
    offset?: number;
    subject?: string;
  }): Promise<{ issues: Issue[]; total_count: number; offset: number; limit: number }> {
    const query: Record<string, string | number> = {
      limit: params.limit ?? 25,
      offset: params.offset ?? 0,
    };
    if (params.projectId) query["project_id"] = params.projectId;
    if (params.statusId) query["status_id"] = params.statusId;
    if (params.assignedToId) query["assigned_to_id"] = params.assignedToId;
    if (params.subject) query["subject"] = `~${params.subject}`;

    const res = await this.http.get("/issues.json", { params: query });
    return res.data;
  }

  async getIssue(id: number): Promise<Issue> {
    const res = await this.http.get(`/issues/${id}.json`, {
      params: { include: "journals,attachments,relations" },
    });
    return res.data.issue;
  }

  async updateIssue(id: number, updates: {
    statusId?: number;
    assignedToId?: number;
    notes?: string;
    subject?: string;
    description?: string;
    doneRatio?: number;
    dueDate?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (updates.statusId !== undefined) body["status_id"] = updates.statusId;
    if (updates.assignedToId !== undefined) body["assigned_to_id"] = updates.assignedToId;
    if (updates.notes !== undefined) body["notes"] = updates.notes;
    if (updates.subject !== undefined) body["subject"] = updates.subject;
    if (updates.description !== undefined) body["description"] = updates.description;
    if (updates.doneRatio !== undefined) body["done_ratio"] = updates.doneRatio;
    if (updates.dueDate !== undefined) body["due_date"] = updates.dueDate;
    await this.http.put(`/issues/${id}.json`, { issue: body });
  }

  async listStatuses(): Promise<IssueStatus[]> {
    const res = await this.http.get("/issue_statuses.json");
    return res.data.issue_statuses;
  }

  async listProjects(): Promise<Project[]> {
    const res = await this.http.get("/projects.json", { params: { limit: 100 } });
    return res.data.projects;
  }

  async listProjectMembers(projectId: string): Promise<Membership[]> {
    const res = await this.http.get(`/projects/${projectId}/memberships.json`, {
      params: { limit: 100 },
    });
    return res.data.memberships;
  }

  async createIssue(params: {
    projectId: string;
    subject: string;
    description?: string;
    statusId?: number;
    assignedToId?: number;
    trackerId?: number;
    priorityId?: number;
  }): Promise<Issue> {
    const body: Record<string, unknown> = {
      project_id: params.projectId,
      subject: params.subject,
    };
    if (params.description) body["description"] = params.description;
    if (params.statusId) body["status_id"] = params.statusId;
    if (params.assignedToId) body["assigned_to_id"] = params.assignedToId;
    if (params.trackerId) body["tracker_id"] = params.trackerId;
    if (params.priorityId) body["priority_id"] = params.priorityId;

    const res = await this.http.post("/issues.json", { issue: body });
    return res.data.issue;
  }
}
