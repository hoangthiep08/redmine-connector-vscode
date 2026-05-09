#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RedmineClient } from "./redmine-client.js";

const REDMINE_URL = process.env.REDMINE_URL ?? "";
const REDMINE_API_KEY = process.env.REDMINE_API_KEY ?? "";

if (!REDMINE_URL || !REDMINE_API_KEY) {
  console.error("Error: REDMINE_URL and REDMINE_API_KEY environment variables are required");
  process.exit(1);
}

const client = new RedmineClient({ baseUrl: REDMINE_URL, apiKey: REDMINE_API_KEY });

const tools: Tool[] = [
  {
    name: "redmine_list_issues",
    description: "List Redmine issues with optional filters. Returns id, subject, status, assignee, priority.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project identifier or numeric ID" },
        status_id: {
          type: "string",
          description: "Filter by status: 'open', 'closed', '*' (all), or numeric status ID",
        },
        assigned_to_id: {
          type: "string",
          description: "Filter by assignee: 'me' for current user, or numeric user ID",
        },
        subject: { type: "string", description: "Search keyword in issue subject" },
        limit: { type: "number", description: "Number of results (default 25, max 100)" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
  {
    name: "redmine_get_issue",
    description: "Get full details of a Redmine issue including description, comments (journals), and history.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Issue ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "redmine_update_issue",
    description: "Update a Redmine issue: change status, reassign, update description, set due date, or change completion %.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Issue ID to update" },
        status_id: { type: "number", description: "New status ID" },
        assigned_to_id: { type: "number", description: "User ID to assign to" },
        subject: { type: "string", description: "New subject/title" },
        description: { type: "string", description: "New description" },
        done_ratio: { type: "number", description: "Completion percentage (0-100)" },
        due_date: { type: "string", description: "Due date in YYYY-MM-DD format" },
      },
      required: ["id"],
    },
  },
  {
    name: "redmine_add_comment",
    description: "Add a comment/note to a Redmine issue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Issue ID" },
        notes: { type: "string", description: "Comment text to add" },
      },
      required: ["id", "notes"],
    },
  },
  {
    name: "redmine_list_projects",
    description: "List all Redmine projects available to the current user.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "redmine_list_statuses",
    description: "List all available issue statuses in Redmine.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "redmine_list_members",
    description: "List members of a Redmine project (for assigning issues).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project identifier or numeric ID" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "redmine_create_issue",
    description: "Create a new issue in a Redmine project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project identifier or numeric ID" },
        subject: { type: "string", description: "Issue title/subject" },
        description: { type: "string", description: "Issue description" },
        assigned_to_id: { type: "number", description: "User ID to assign to" },
        status_id: { type: "number", description: "Initial status ID" },
        tracker_id: { type: "number", description: "Tracker ID (bug, feature, etc.)" },
        priority_id: { type: "number", description: "Priority ID" },
      },
      required: ["project_id", "subject"],
    },
  },
];

const server = new Server(
  { name: "redmine-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "redmine_list_issues": {
        const params = args as {
          project_id?: string;
          status_id?: string;
          assigned_to_id?: string;
          subject?: string;
          limit?: number;
          offset?: number;
        };
        const result = await client.listIssues({
          projectId: params.project_id,
          statusId: params.status_id,
          assignedToId: params.assigned_to_id,
          subject: params.subject,
          limit: params.limit,
          offset: params.offset,
        });

        const formatted = result.issues.map((issue) => ({
          id: issue.id,
          subject: issue.subject,
          status: issue.status.name,
          priority: issue.priority.name,
          assignee: issue.assigned_to?.name ?? "Unassigned",
          project: issue.project.name,
          updated: issue.updated_on.split("T")[0],
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { total: result.total_count, issues: formatted },
                null,
                2
              ),
            },
          ],
        };
      }

      case "redmine_get_issue": {
        const { id } = args as { id: number };
        const issue = await client.getIssue(id);

        const comments = (issue.journals ?? [])
          .filter((j) => j.notes)
          .map((j) => ({
            by: j.user.name,
            date: j.created_on.split("T")[0],
            comment: j.notes,
          }));

        const history = (issue.journals ?? [])
          .filter((j) => j.details.length > 0)
          .map((j) => ({
            by: j.user.name,
            date: j.created_on.split("T")[0],
            changes: j.details.map(
              (d) => `${d.name}: "${d.old_value}" → "${d.new_value}"`
            ),
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: issue.id,
                  subject: issue.subject,
                  project: issue.project.name,
                  tracker: issue.tracker.name,
                  status: issue.status.name,
                  priority: issue.priority.name,
                  author: issue.author.name,
                  assignee: issue.assigned_to?.name ?? "Unassigned",
                  done_ratio: issue.done_ratio,
                  start_date: issue.start_date,
                  due_date: issue.due_date,
                  created_on: issue.created_on.split("T")[0],
                  updated_on: issue.updated_on.split("T")[0],
                  description: issue.description,
                  comments,
                  history,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "redmine_update_issue": {
        const params = args as {
          id: number;
          status_id?: number;
          assigned_to_id?: number;
          subject?: string;
          description?: string;
          done_ratio?: number;
          due_date?: string;
        };
        await client.updateIssue(params.id, {
          statusId: params.status_id,
          assignedToId: params.assigned_to_id,
          subject: params.subject,
          description: params.description,
          doneRatio: params.done_ratio,
          dueDate: params.due_date,
        });
        return {
          content: [{ type: "text", text: `Issue #${params.id} updated successfully.` }],
        };
      }

      case "redmine_add_comment": {
        const { id, notes } = args as { id: number; notes: string };
        await client.updateIssue(id, { notes });
        return {
          content: [{ type: "text", text: `Comment added to issue #${id}.` }],
        };
      }

      case "redmine_list_projects": {
        const projects = await client.listProjects();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                projects.map((p) => ({
                  id: p.id,
                  identifier: p.identifier,
                  name: p.name,
                })),
                null,
                2
              ),
            },
          ],
        };
      }

      case "redmine_list_statuses": {
        const statuses = await client.listStatuses();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                statuses.map((s) => ({ id: s.id, name: s.name, is_closed: s.is_closed })),
                null,
                2
              ),
            },
          ],
        };
      }

      case "redmine_list_members": {
        const { project_id } = args as { project_id: string };
        const members = await client.listProjectMembers(project_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                members
                  .filter((m) => m.user)
                  .map((m) => ({
                    id: m.user.id,
                    name: m.user.name,
                    roles: m.roles.map((r) => r.name),
                  })),
                null,
                2
              ),
            },
          ],
        };
      }

      case "redmine_create_issue": {
        const params = args as {
          project_id: string;
          subject: string;
          description?: string;
          assigned_to_id?: number;
          status_id?: number;
          tracker_id?: number;
          priority_id?: number;
        };
        const issue = await client.createIssue({
          projectId: params.project_id,
          subject: params.subject,
          description: params.description,
          assignedToId: params.assigned_to_id,
          statusId: params.status_id,
          trackerId: params.tracker_id,
          priorityId: params.priority_id,
        });
        return {
          content: [
            {
              type: "text",
              text: `Issue created: #${issue.id} - ${issue.subject}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Redmine MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
