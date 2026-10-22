import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readConfig, serviceNameSchema } from "./config.js";
import { repositoryPaths, repositoryRoot, requireDirectory } from "./repositories.js";
import { runService, type Service, type ServiceResult } from "./service-manager.js";

type Selection = { path?: string; service?: string };
type ServiceSummary = Pick<ServiceResult, "name" | "path" | "state" | "error">;
type ServiceOutput = { path: string; services: ServiceSummary[] };

function requireRepository(path: string): void {
  requireDirectory(path);
  if (!lstatSync(join(path, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected a prepared Git checkout: ${path}`);
  }
}

function selection({ path: requested }: Selection): {
  root: string; path: string; isRepository: boolean;
} {
  const root = repositoryRoot();
  requireDirectory(root);
  let path = resolve(requested ?? process.cwd());
  const relativePath = relative(root, path);
  const parts = relativePath.split(sep).filter(Boolean);
  if (isAbsolute(relativePath) || parts.includes("..")) {
    throw new Error(`Service path must be inside ZD_REPOS_DIR (${root}); supply an absolute path to a prepared checkout or group. The default is the MCP server's working directory.`);
  }
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    requireDirectory(directory);
  }
  let isRepository = false;
  for (let ancestor = path; ancestor !== root; ancestor = dirname(ancestor)) {
    if (lstatSync(join(ancestor, ".git"), { throwIfNoEntry: false })) {
      path = ancestor;
      isRepository = true;
      break;
    }
  }
  if (isRepository) requireRepository(path);
  return { root, path, isRepository };
}

function selected(input: Selection): { path: string; services: Service[] } {
  const { root, path, isRepository } = selection(input);
  const paths = isRepository ? [path] : [path, ...repositoryPaths(path)];
  const services = paths.flatMap(path =>
    Object.entries(readConfig(root, path).services ?? {}).map(([name, config]) => ({ name, path, ...config })));
  const filtered = input.service === undefined ? services : services.filter(({ name }) => name === input.service);
  if (input.service !== undefined && filtered.length === 0) throw new Error(`Unknown service: ${input.service}`);
  return { path, services: filtered };
}

async function manage(input: Selection, action: "start" | "stop"): Promise<ServiceOutput> {
  const selection = selected(input);
  const services: ServiceSummary[] = [];
  for (const service of selection.services) {
    const { name, path, state, error } = await runService(service, action);
    services.push({ name, path, ...(state !== undefined && { state }), ...(error !== undefined && { error }) });
  }
  return { path: selection.path, services };
}

async function result(action: () => Promise<ServiceOutput>): Promise<CallToolResult> {
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
  path: z.string().optional().transform(value => value === "" ? undefined : value)
    .refine(value => value === undefined || isAbsolute(value), "Expected an absolute checkout or group path.")
    .describe("Absolute checkout/group path in ZD_REPOS_DIR (no ~). Default: server cwd. A group includes its immediate child repos."),
  service: serviceNameSchema.optional().describe("Service name; omitted selects all."),
}).strict();

/** Register named service startup, shutdown, and bounded log tools for prepared repositories and groups. */
export function registerServerTools(server: McpServer): void {
  server.registerTool(
    "start_server",
    {
      description:
        "Start configured services using Linux/systemd; reuse active units. " +
        "Returns compact states/errors, not readiness. Use server_logs for diagnostics; stop failed units before restarting.",
      inputSchema: selectionSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async input => result(() => manage(input, "start")),
  );

  server.registerTool("stop_server", {
    description:
      "Stop services via Linux/systemd: SIGINT, then SIGKILL after 30s, then optional cleanup. " +
      "Returns final states/errors; use server_logs for diagnostics. Already stopped services are unchanged.",
    inputSchema: selectionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async input => result(() => manage(input, "stop")));

  server.registerTool("server_logs", {
    description:
      "Read stdout/stderr and systemd diagnostics from accessible Linux journals, scoped to the current user's unit. " +
      "Returns current state, exit codes and logs (up to 64 KiB/service). Logs may contain secrets.",
    inputSchema: selectionSchema.extend({ lines: z.number().int().min(1).max(1000).default(100) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => result(async () => {
    const selection = selected(input);
    const services = await Promise.all(selection.services.map(service => runService(service, "logs", input.lines)));
    return { path: selection.path, services };
  }));
}
