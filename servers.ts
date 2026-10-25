import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readConfig, serviceNameSchema } from "./config.js";
import { selectRepositories } from "./repositories.js";
import { runService, type Service, type ServiceResult } from "./service-manager.js";

type Selection = { path?: string; service?: string };
type ServiceSummary = Pick<ServiceResult, "name" | "path" | "state" | "error">;
type ServiceOutput = { path: string; services: ServiceSummary[] };

async function selected(input: Selection): Promise<{ path: string; services: Service[] }> {
  const { root, path, source, isRepository, repositories } = await selectRepositories(input.path);
  const config = readConfig(root, source);
  const targets = isRepository || config !== undefined ? [{ path, source }] : repositories;
  const services = targets.flatMap(target =>
    Object.entries((target.path === path ? config : readConfig(root, target.source))?.services ?? {})
      .map(([name, config]) => ({ name, path: target.path, ...config })));
  const filtered = input.service === undefined ? services : services.filter(({ name }) => name === input.service);
  if (input.service !== undefined && filtered.length === 0) throw new Error(`Unknown service: ${input.service}`);
  return { path, services: filtered };
}

async function manage(input: Selection, action: "start" | "stop"): Promise<ServiceOutput> {
  const selection = await selected(input);
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
    .describe("Absolute repository/group path in ZD_REPOS_DIR or ~/.zapdev/worktrees (no ~). Default: server cwd. Worktrees use source configuration. A group uses its config if present; otherwise its immediate child repos."),
  service: serviceNameSchema.optional().describe("Service name; omitted selects all."),
}).strict();

/** Register named service discovery, startup, shutdown, and bounded log tools for prepared repositories and groups. */
export function registerServerTools(server: McpServer): void {
  server.registerTool("list_services", {
    description:
      "List configured services available to start in a prepared checkout or group. " +
      "Returns service names and paths only; does not run commands, query systemd, or check readiness.",
    inputSchema: selectionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => result(async () => {
    const selection = await selected(input);
    return { path: selection.path, services: selection.services.map(({ name, path }) => ({ name, path })) };
  }));

  server.registerTool(
    "start_server",
    {
      description:
        "Start configured services using Linux/systemd; reuse active units. Useful for running services needed by end-to-end (E2E) tests. " +
        "Returns compact states/errors, not readiness. Use server_logs for diagnostics; stop failed units before restarting.",
      inputSchema: selectionSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async input => result(() => manage(input, "start")),
  );

  server.registerTool("stop_server", {
    description:
      "Stop services via Linux/systemd: SIGINT, then SIGKILL after 30s, then optional cleanup. Useful for shutting down services after end-to-end (E2E) tests. " +
      "Verifies process shutdown and unit release; clears old failed states. Cleanup or verification failures return errors. Use server_logs for diagnostics.",
    inputSchema: selectionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async input => result(() => manage(input, "stop")));

  server.registerTool("server_logs", {
    description:
      "Read timestamped stdout/stderr and systemd diagnostics for the latest invocation of the current user's unit (systemd 257+). " +
      "Returns current state, exit codes and logs (up to 64 KiB/service). Logs may contain secrets.",
    inputSchema: selectionSchema.extend({ lines: z.number().int().min(1).max(1000).default(100) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => result(async () => {
    const selection = await selected(input);
    const services = await Promise.all(selection.services.map(service => runService(service, "logs", input.lines)));
    return { path: selection.path, services };
  }));
}
