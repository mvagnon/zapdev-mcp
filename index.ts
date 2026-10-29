#!/usr/bin/env node
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { repositoryPath, repositorySelectionSchema } from "./schemas.js";
import { registerServerTools } from "./servers.js";
import { callWorkspaceCommand, configureZapdev, runZapdev } from "./zapdev.js";

const { values } = parseArgs({ options: { "zapdev-path": { type: "string" } } });
configureZapdev(values["zapdev-path"]);

const pullRequestResultSchema = z.object({
  pullRequests: z.array(z.object({
    repo: z.string(),
    branch: z.string(),
    url: z.string(),
    deletedWorktrees: z.array(z.string()),
    skippedWorktrees: z.array(z.object({ path: z.string(), reason: z.string() })),
  })),
  error: z.string().optional(),
});

const commitResultSchema = z.object({
  commits: z.array(z.object({ repo: z.string(), branch: z.string(), message: z.string(), pushed: z.boolean() })),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});

/** Run local or npm zapdev with a repository path, returning CLI output or an MCP error. */
async function zapdev(path: string, args: [string, ...string[]], branch?: string): Promise<CallToolResult> {
  const output: Partial<z.infer<typeof pullRequestResultSchema> & z.infer<typeof commitResultSchema>> & {
    stdout: string; stderr: string; instructions?: string;
  } = { stdout: "", stderr: "" };
  Object.assign(output, await runZapdev([args[0], path, ...args.slice(1), ...(branch ? [`--branch=${branch}`] : [])]));
  if (output.stdout || output.error === undefined) {
    try {
      const schema = args[0] === "commit" ? commitResultSchema : pullRequestResultSchema;
      Object.assign(output, schema.parse(JSON.parse(output.stdout)));
      output.instructions = args[0] === "commit"
        ? "Completed commits are preserved on failure. A pushed value of true confirms a successful push; " +
          "otherwise a push is not confirmed. If an error is reported, inspect local and remote state before retrying."
        : "Deleted worktree paths no longer exist; do not use them as a working directory. " +
          "Skipped worktrees were retained: inspect their paths and reasons before cleanup; never force removal. " +
          "If an error is reported, check remote PR state before retrying; partial results are preserved.";
    } catch {
      output.error ??= `Invalid JSON result from zapdev ${args[0]}; inspect stdout/stderr and ${args[0] === "commit" ? "local and remote" : "remote"} state before retrying.`;
    }
  }
  return {
    ...(output.error !== undefined && { isError: true }),
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

const server = new McpServer({ name: "zapdev-mcp", version: "1.0.0" });

server.registerTool(
  "prepare_repo",
  {
    description:
      "Clone/reset a disposable GitHub checkout under ZD_REPOS_DIR (default ~/.zapdev/repos). Requires repo; group is optional. " +
      "Call only when the user explicitly requests preparing or resetting this checkout; never call automatically as a prerequisite for another task. " +
      "Resolves configuration and secrets independently: uses the repository's resources if present, otherwise its direct parent's, without merging. " +
      "Destructive: discards tracked edits and untracked non-ignored files. Editing secret symlinks changes source secrets; keep links Git-ignored.",
    inputSchema: repositorySelectionSchema
      .extend({
        branch: z
          .string()
          .optional()
          .describe("Remote branch; default: the repo's remote default branch."),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ repo, group, branch }) => {
    return callWorkspaceCommand(["prepare-repo", repo, ...(group ? [`--group=${group}`] : []), ...(branch ? [`--branch=${branch}`] : [])]);
  },
);

server.registerTool(
  "prepare_worktree",
  {
    description:
      "Prepare linked worktrees under ~/.zapdev/worktrees/<branch with / replaced by __> from the selected source HEADs. " +
      "A repository path selects only that repository, even inside a group; a group path selects its immediate child repositories. " +
      "Creates the same new branch in every selected repository; never resets sources or overwrites existing branches or paths. " +
      "For sources below ZD_REPOS_DIR, resolves configuration and secrets independently: repo then direct parent, or group then immediate child repos, without merging or further fallback. External sources skip secrets and preparation commands. " +
      "Returns the created worktree paths. Secret links share source files; keep them Git-ignored. " +
      "Failures retain completed worktrees and report their paths; inspect them before retrying.",
    inputSchema: z.object({
      path: repositoryPath,
      branch: z.string().min(1).describe("New local branch; its workspace directory replaces / with __ without changing the branch name."),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  async ({ path, branch }) => callWorkspaceCommand(["prepare-worktree", path, `--branch=${branch}`]),
);

registerServerTools(server);

server.registerTool(
  "commit",
  {
    description:
      "Commit all changes in the enclosing repository or immediate child repositories via zapdev --json; pull and push only when requested (both default: false). " +
      "Returns completed commits, confirmed push results and warnings, including partial results on failure; inspect state before retrying. " +
      "Requires ZD_* configuration; sends commit context to the configured LLM.",
    inputSchema: z
      .object({
        path: repositoryPath,
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("Local branch to switch/create; default: current branch."),
        type: z
          .string()
          .regex(/^(auto|(?:feat|fix|deps|chore|docs|style|refactor|perf|test|build|ci|revert)!?)$/)
          .default("auto")
          .describe("Conventional Commit type; auto chooses, ! marks breaking changes."),
        pull: z
          .boolean()
          .default(false)
          .describe("Pull fast-forward updates before committing when an upstream exists; default: false."),
        push: z
          .boolean()
          .default(false)
          .describe("Push after committing without confirmation; default: false."),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ path, branch, type, pull, push }) => zapdev(path, [
    "commit", "--non-interactive", push ? "--push" : "--no-push", "--json",
    ...(pull ? ["--pull"] : []),
    ...(type === "auto" ? [] : [`--type=${type}`]),
  ], branch),
);

server.registerTool(
  "pr",
  {
    description:
      "Push branches and create GitHub PRs for the enclosing repository or immediate child repositories via zapdev --json. Requires clean trees, gh auth and ZD_* configuration. " +
      "Sends commit messages to the LLM. Never force-pushes; check remote state before retrying errors. " +
      "Always enables cleanup of the source branch's linked worktrees after PR creation, including ignored files; " +
      "the MCP server must run outside those worktrees. Preserves the main worktree, branches and commits; never forces removal. " +
      "Returns pullRequests with deletedWorktrees and skippedWorktrees (path and reason), including partial results on failure. " +
      "Do not use deleted worktree paths; inspect skipped worktrees before any manual cleanup.",
    inputSchema: z
      .object({
        path: repositoryPath,
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("PR target branch; default: repository's default branch."),
        closes: z
          .url({ protocol: /^https?$/ })
          .optional()
          .describe("HTTP(S) task URL to reference as Closes."),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  async ({ path, branch, closes }) => zapdev(path, [
    "pr", "--non-interactive", "--cleanup-worktrees", "--json",
    ...(closes ? [`--closes=${closes}`] : []),
  ], branch),
);

await server.connect(new StdioServerTransport());
