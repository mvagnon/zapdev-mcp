import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readConfig, serviceNameSchema, type Config } from "./config.js";
import { groupSchema, repoSchema, repositoryRoot } from "./repositories.js";
import { runService, type Service, type ServiceResult } from "./service-manager.js";

type Selection = { repo?: string; group?: string; service?: string };
type Context = {
  path: string;
  agents_md?: string;
  frontUrl?: string;
  apiUrl?: string;
  dbUrl?: string;
};

function requireDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected an existing directory, not a symlink: ${path}`);
  }
}

function requireRepository(path: string): void {
  requireDirectory(path);
  if (!lstatSync(join(path, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected a prepared Git checkout: ${path}`);
  }
}

function context(path: string, config: Config): Context {
  const output: Context = { path };
  const instructions = join(path, "AGENTS.md");
  if (lstatSync(instructions, { throwIfNoEntry: false })?.isFile()) {
    output.agents_md = readFileSync(instructions, "utf8");
  }
  for (const key of ["frontUrl", "apiUrl", "dbUrl"] as const) {
    if (config[key] !== undefined) output[key] = config[key];
  }
  return output;
}

function selection({ repo, group }: Selection): {
  root: string; parent: string; path: string; parentConfig: Config;
} {
  if (!repo && !group) throw new Error("Supply a repo or a group.");
  const root = repositoryRoot();
  requireDirectory(root);
  const parent = group === undefined ? root : join(root, group);
  requireDirectory(parent);
  const path = repo ? join(parent, repo.replace("/", "-")) : parent;
  if (repo) requireRepository(path);
  const parentConfig = group === undefined ? {} : readConfig(root, parent);
  return { root, parent, path, parentConfig };
}

function selected(input: Selection): { context: Record<string, unknown>; services: Service[] } {
  const { root, parent, path, parentConfig } = selection(input);
  const paths = input.repo ? [path] : readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") &&
      lstatSync(join(parent, entry.name, ".git"), { throwIfNoEntry: false })?.isDirectory())
    .map(entry => join(parent, entry.name)).sort();
  const repositories = paths.map(path => {
    const config = { ...readConfig(root, path), ...parentConfig };
    return { context: context(path, config), config };
  });
  const services = parentConfig.services !== undefined
    ? Object.entries(parentConfig.services).map(([name, config]) => ({ name, path: parent, ...config }))
    : repositories.flatMap(({ context, config }) =>
      Object.entries(config.services ?? {}).map(([name, config]) => ({ name, path: context.path, ...config })));
  const filtered = input.service === undefined ? services : services.filter(({ name }) => name === input.service);
  if (input.service !== undefined && filtered.length === 0) throw new Error(`Unknown service: ${input.service}`);
  return {
    context: {
      ...(input.repo ? repositories[0]?.context : context(parent, parentConfig)),
      ...(input.repo && input.group !== undefined && { parent: context(parent, parentConfig) }),
      ...(!input.repo && { repositories: repositories.map(({ context }) => context) }),
    },
    services: filtered,
  };
}

async function result(action: () => Promise<Record<string, unknown> & { services: ServiceResult[] }>): Promise<CallToolResult> {
  try {
    const output = await action();
    return {
      ...(output.services.some(({ error }) => error !== undefined) && { isError: true }),
      content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output,
    };
  } catch (error) {
    const output = { error: error instanceof Error ? error.message : String(error) };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(output) }] };
  }
}

const selectionSchema = z.object({
  repo: repoSchema.optional(), group: groupSchema,
  service: serviceNameSchema.optional().describe("Optional configured service name; otherwise selects all services."),
}).strict();

/** Register named service startup, shutdown, and bounded log tools for prepared repositories and groups. */
export function registerServerTools(server: McpServer): void {
  server.registerTool(
    "start_server",
    {
      description:
        "Start an already prepared repository or group without running Git operations. " +
        "Supply repo, group, or both to select a repository within a group. " +
        "Requires Linux and a running systemd user manager. Reads named services from ~/.zapdev/config. " +
        "A parent's services object replaces all child services; otherwise starts selected child services. " +
        "Each service gets an independent systemd user unit and persistent logs; no PIDs to manage. " +
        "Already active services are reused; failed services return errors until stopped. " +
        "Returns service names, stable unit IDs and systemd states, not readiness guarantees. " +
        "Returns root AGENTS.md and URLs, plus every immediate child checkout's instructions and URLs for a group. " +
        "A single grouped repository also includes its parent's instructions and URLs under parent. " +
        "Parent instructions take priority over child instructions; parent URLs override matching child fields. " +
        "Missing URLs are omitted. Partial successes are preserved in the response; inspect per-service errors.",
      inputSchema: selectionSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => result(async () => {
      const selection = selected(input);
      const services: ServiceResult[] = [];
      for (const service of selection.services) services.push(await runService(service, "start"));
      return { ...selection.context, services };
    }),
  );

  server.registerTool("stop_server", {
    description:
      "Stop named services in a prepared repository or group using systemd --user. " +
      "Uses the same parent overrides and optional service filter as start_server. " +
      "Runs each service's optional stopCommand before terminating all remaining processes in its unit. " +
      "Shutdown commands and process termination each have a 30-second systemd timeout. " +
      "Already stopped services are unchanged. Returns final states, errors and bounded final logs. " +
      "Never operates on arbitrary PIDs or unrelated systemd units. Makes no Git changes.",
    inputSchema: selectionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async input => result(async () => {
    const selection = selected(input);
    const services: ServiceResult[] = [];
    for (const service of selection.services) services.push(await runService(service, "stop"));
    return { path: selection.context.path, services };
  }));

  server.registerTool("server_logs", {
    description:
      "Read persisted stdout/stderr logs for named services in a prepared repository or group. " +
      "Uses the same parent overrides and optional service filter as start_server. " +
      "Returns the last lines (default 100, maximum 1000), reading at most 64 KiB per service, without streaming. " +
      "ANSI control sequences are removed; truncated indicates omitted older content. " +
      "Logs remain available after stopping services or restarting the MCP. Logs may contain application secrets.",
    inputSchema: selectionSchema.extend({ lines: z.number().int().min(1).max(1000).default(100) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => result(async () => {
    const selection = selected(input);
    const services = await Promise.all(selection.services.map(service => runService(service, "logs", input.lines)));
    return { path: selection.context.path, services };
  }));
}
