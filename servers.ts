import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readConfig, serviceNameSchema, type Config } from "./config.js";
import { repositoryPaths, repositoryRoot, requireDirectory } from "./repositories.js";
import { runService, type Service, type ServiceResult } from "./service-manager.js";

type Selection = { path?: string; service?: string };
type Context = {
  path: string;
  agents_md?: string;
  frontUrl?: string;
  apiUrl?: string;
  dbUrl?: string;
};

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

function selection({ path: requested }: Selection): {
  root: string; parent: string; path: string; parentConfig: Config; isRepository: boolean;
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
  const parent = isRepository ? dirname(path) : path;
  const parentConfig = isRepository && parent === root ? {} : readConfig(root, parent);
  return { root, parent, path, parentConfig, isRepository };
}

function selected(input: Selection): { context: Record<string, unknown>; services: Service[] } {
  const { root, parent, path, parentConfig, isRepository } = selection(input);
  const paths = isRepository ? [path] : repositoryPaths(path);
  const repositories = paths.map(path => {
    const config = readConfig(root, path);
    return { context: context(path, { ...config, ...parentConfig }), config };
  });
  const services = [
    ...(!isRepository ? Object.entries(parentConfig.services ?? {}).map(([name, config]) => ({ name, path, ...config })) : []),
    ...repositories.flatMap(({ context, config }) =>
      Object.entries(config.services ?? {}).map(([name, config]) => ({ name, path: context.path, ...config }))),
  ];
  const filtered = input.service === undefined ? services : services.filter(({ name }) => name === input.service);
  if (input.service !== undefined && filtered.length === 0) throw new Error(`Unknown service: ${input.service}`);
  return {
    context: {
      ...(isRepository ? repositories[0]?.context : context(path, parentConfig)),
      ...(isRepository && parent !== root && { parent: context(parent, parentConfig) }),
      ...(!isRepository && { repositories: repositories.map(({ context }) => context) }),
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
        "Returns state, AGENTS.md and URLs (parent priority), not readiness guarantees. " +
        "Failures include logs; stop failed units before restarting.",
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
      "Stop services via Linux/systemd: SIGINT, then SIGKILL after 30s, then optional cleanup. " +
      "Returns final state, errors and logs. Already stopped services are unchanged.",
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
      "Read stdout/stderr and systemd diagnostics from journald; requires a readable Linux user journal. " +
      "Returns current state, exit codes and logs (up to 64 KiB/service). Logs may contain secrets.",
    inputSchema: selectionSchema.extend({ lines: z.number().int().min(1).max(1000).default(100) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => result(async () => {
    const selection = selected(input);
    const services = await Promise.all(selection.services.map(service => runService(service, "logs", input.lines)));
    return { path: selection.context.path, services };
  }));
}
