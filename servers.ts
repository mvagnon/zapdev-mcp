import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readConfig, type Config } from "./config.js";
import { git, groupSchema, repoSchema, repositoryRoot } from "./repositories.js";

type Selection = { repo?: string; group?: string };
type Context = {
  path: string;
  agents_md?: string;
  frontUrl?: string;
  apiUrl?: string;
  dbUrl?: string;
};
type Command = { path: string; command: string };

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

async function start({ path, command }: Command): Promise<{ path: string; pid: number }> {
  const child = spawn(command, { cwd: path, shell: true, detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`Could not launch the start command in ${path}`);
  return { path, pid: child.pid };
}

async function updateRepository(path: string, branch?: string): Promise<void> {
  const remotes = (await git(path, "remote")).split("\n");
  if (remotes.includes("origin")) await git(path, "fetch", "--quiet", "--prune", "origin");
  const refs = (await git(path, "for-each-ref", "--format=%(refname)")).split("\n");
  if (branch !== undefined) {
    if (refs.includes(`refs/heads/${branch}`)) {
      await git(path, "switch", "--quiet", "--no-guess", branch);
    } else if (refs.includes(`refs/remotes/origin/${branch}`)) {
      await git(path, "switch", "--quiet", "--track", "-c", branch, `refs/remotes/origin/${branch}`);
    } else {
      await git(path, "switch", "--quiet", "--no-track", "-c", branch);
    }
  }
  const current = await git(path, "symbolic-ref", "--quiet", "--short", "HEAD");
  let upstream = await git(path, "for-each-ref", "--format=%(upstream)", `refs/heads/${current}`);
  if (!upstream && refs.includes(`refs/remotes/origin/${current}`)) {
    upstream = `refs/remotes/origin/${current}`;
    await git(path, "branch", `--set-upstream-to=${upstream}`, current);
  }
  if (upstream) await git(path, "pull", "--ff-only");
}

async function result(action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const output = await action();
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    const output = { error: error instanceof Error ? error.message : String(error) };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(output) }] };
  }
}

/** Register the server startup tool for prepared repositories and groups. */
export function registerServerTools(server: McpServer): void {
  server.registerTool(
    "start_server",
    {
      description:
        "Start an already prepared repository or group; never clones or resets checkouts. " +
        "Supply repo, group, or both to select a repository within a group. " +
        "Before launching anything, switches every selected repository to branch when supplied, " +
        "creating it from origin if available or the current HEAD otherwise; defaults to each current branch. " +
        "Fetches origin and pulls fast-forward updates when an upstream exists; new local branches have no upstream. " +
        "Git errors prevent all command launches; earlier checkout updates are not rolled back. " +
        "Reads ~/.zapdev/config following the checkout layout. A parent's startCommand array replaces child arrays; " +
        "otherwise starts every command in each selected child's array, one detached process per entry. " +
        "Commands run detached with output discarded. Returned PIDs confirm shell launch, not server readiness. " +
        "Returns root AGENTS.md and URLs, plus every immediate child checkout's instructions and URLs for a group. " +
        "A single grouped repository also includes its parent's instructions and URLs under parent. " +
        "Parent instructions take priority over child instructions; parent URLs override matching child fields. " +
        "Missing commands and URLs are omitted. May start some commands before an error; do not retry blindly.",
      inputSchema: z.object({
        repo: repoSchema.optional(),
        group: groupSchema,
        branch: z.string().min(1).optional()
          .describe("Branch to switch to or create in every selected repository; defaults to each current branch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (input) => result(async () => {
      const { root, parent, path, parentConfig } = selection(input);
      if (input.branch !== undefined &&
        await git(path, "check-ref-format", "--branch", input.branch) !== input.branch) {
        throw new Error("Expected a literal branch name.");
      }
      const paths = input.repo ? [path] : readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") &&
          lstatSync(join(parent, entry.name, ".git"), { throwIfNoEntry: false })?.isDirectory())
        .map((entry) => join(parent, entry.name))
        .sort();
      for (const path of paths) await updateRepository(path, input.branch);
      const repositories = paths.map((path) => {
        const config = { ...readConfig(root, path), ...parentConfig };
        return { context: context(path, config), config };
      });
      const output = input.repo ? repositories[0]?.context : context(parent, parentConfig);
      const parentContext = input.repo && input.group !== undefined ? context(parent, parentConfig) : undefined;
      const commands: Command[] = parentConfig.startCommand !== undefined
        ? parentConfig.startCommand.map((command) => ({ path: parent, command }))
        : repositories.flatMap(({ context, config }) =>
          (config.startCommand ?? []).map((command) => ({ path: context.path, command })));
      const launched: Array<{ path: string; pid: number }> = [];
      for (const command of commands) launched.push(await start(command));
      return {
        ...output,
        ...(parentContext && { parent: parentContext }),
        ...(!input.repo && { repositories: repositories.map(({ context }) => context) }),
        ...(launched.length > 0 && { commands: launched }),
      };
    }),
  );
}
