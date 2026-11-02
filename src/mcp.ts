// Newline-delimited JSON-RPC for a local stdio MCP server. The editor starts
// `supa mcp` and stops it; each tool call runs the same supa binary.

import { VERSION } from "./util.ts";

export interface McpMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

const DESTRUCTIVE = new Set(["supa_destroy", "supa_rotate", "supa_restore", "supa_pg_upgrade"]);

const TOOLS = [
  tool("supa_ls", "List registered projects and unmanaged running stacks.", {}),
  tool("supa_status", "Docker status of running Supabase containers.", {}),
  tool("supa_stats", "CPU and RAM of running Supabase containers.", {}),
  tool("supa_doctor", "Check docker, the CLI, the registry, ports, and duplicate project ids.", {}),
  tool("supa_config", "Show supa limits and paths.", {}),
  tool("supa_env", "Read a running project's keys as JSON. Does not write a file.", {
    project: { type: "string" },
  }, ["project"]),
  tool(
    "supa_logs",
    "Print logs for one service. Stopped containers are included. Does not follow.",
    {
      project: { type: "string" },
      service: { type: "string" },
      since: { type: "string" },
    },
    ["project", "service"],
  ),
  tool("supa_up", "Start a registered project.", {
    project: { type: "string" },
    exclude: { type: "string" },
  }, ["project"]),
  tool("supa_down", "Stop a registered project.", { project: { type: "string" } }, ["project"]),
  tool("supa_restart", "Stop then start a registered project.", { project: { type: "string" } }, [
    "project",
  ]),
  tool("supa_switch", "Run one project and stop the other registered ones.", {
    project: { type: "string" },
  }, ["project"]),
  tool("supa_studio", "Open the project's Studio in the browser if the stack is running.", {
    project: { type: "string" },
  }, ["project"]),
  tool(
    "supa_destroy",
    "Delete a project's containers and volumes. Requires confirm: true after the user agreed.",
    { project: { type: "string" }, confirm: { type: "boolean" } },
    ["project", "confirm"],
  ),
  tool(
    "supa_rotate",
    "Generate a new JWT signing key and restart. Requires confirm: true after the user agreed.",
    { project: { type: "string" }, confirm: { type: "boolean" } },
    ["project", "confirm"],
  ),
  tool(
    "supa_restore",
    "Load a dump into the live database. Requires confirm: true after the user agreed.",
    { project: { type: "string" }, file: { type: "string" }, confirm: { type: "boolean" } },
    ["project", "file", "confirm"],
  ),
  tool(
    "supa_pg_upgrade",
    "Upgrade Postgres major version. Requires confirm: true after the user agreed.",
    { project: { type: "string" }, to: { type: "string" }, confirm: { type: "boolean" } },
    ["project", "to", "confirm"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string }>,
  required: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required },
  };
}

export function toolArgs(
  name: string,
  args: Record<string, unknown>,
): string[] | { error: string } {
  const project = typeof args.project === "string" ? args.project : "";
  if (DESTRUCTIVE.has(name) && args.confirm !== true) {
    return {
      error:
        "refusing: this replaces or deletes data. Call again with confirm: true only after the user agreed to this project.",
    };
  }
  switch (name) {
    case "supa_ls":
      return ["ls", "--json"];
    case "supa_status":
      return ["status", "--json"];
    case "supa_stats":
      return ["stats", "--json"];
    case "supa_doctor":
      return ["doctor", "--json"];
    case "supa_config":
      return ["config", "--json"];
    case "supa_env":
      return project ? ["env", project, "--json"] : { error: "project is required" };
    case "supa_logs": {
      if (!project || typeof args.service !== "string") {
        return { error: "project and service are required" };
      }
      const out = ["logs", project, args.service];
      if (typeof args.since === "string" && args.since !== "") out.push("--since", args.since);
      return out;
    }
    case "supa_up": {
      if (!project) return { error: "project is required" };
      const out = ["up", project, "--json"];
      if (typeof args.exclude === "string" && args.exclude !== "") {
        out.push("--exclude", args.exclude);
      }
      return out;
    }
    case "supa_down":
      return project ? ["down", project] : { error: "project is required" };
    case "supa_restart":
      return project ? ["restart", project] : { error: "project is required" };
    case "supa_switch":
      return project ? ["switch", project] : { error: "project is required" };
    case "supa_studio":
      return project ? ["studio", project] : { error: "project is required" };
    case "supa_destroy":
      return project ? ["destroy", project, "--yes"] : { error: "project is required" };
    case "supa_rotate":
      return project ? ["rotate", project, "--yes"] : { error: "project is required" };
    case "supa_restore":
      return project && typeof args.file === "string"
        ? ["restore", project, args.file, "--yes"]
        : { error: "project and file are required" };
    case "supa_pg_upgrade":
      return project && typeof args.to === "string"
        ? ["pg-upgrade", project, "--to", args.to, "--yes"]
        : { error: "project and to are required" };
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** Returns a JSON-RPC response, or null when the message is a notification. */
export async function handleMcpMessage(
  msg: McpMessage,
  run: (args: string[]) => Promise<{ code: number; out: string; err: string }>,
): Promise<Record<string, unknown> | null> {
  if (msg.id === undefined || msg.id === null) return null;
  const id = msg.id;
  if (msg.method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "supa", version: VERSION },
    });
  }
  if (msg.method === "tools/list") return ok(id, { tools: TOOLS });
  if (msg.method === "tools/call") {
    const name = msg.params?.name ?? "";
    const args = msg.params?.arguments ?? {};
    const planned = toolArgs(name, args);
    if ("error" in planned) {
      return ok(id, { content: [{ type: "text", text: planned.error }], isError: true });
    }
    const ran = await run(planned);
    const text = ran.code === 0 ? ran.out : ran.err || ran.out;
    return ok(id, {
      content: [{ type: "text", text }],
      isError: ran.code !== 0,
    });
  }
  return err(id, -32601, `method not found: ${msg.method ?? ""}`);
}

function ok(id: number | string, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}
function err(id: number | string, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
