#!/usr/bin/env node
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { prepareSelection } from "./preparation.js";
import { git, repositorySelectionSchema } from "./repositories.js";
import { registerServerTools } from "./servers.js";

const exec = promisify(execFile);

/** Run zapdev through npx in one repository, returning CLI output or an MCP error. */
async function zapdev(path: string, args: string[], branch?: string): Promise<CallToolResult> {
  try {
    await git(path, "rev-parse", "--show-toplevel");
    if (branch !== undefined) await git(path, "check-ref-format", "--branch", branch);
    const { stdout, stderr } = await exec(
      "npx",
      ["--yes", "zapdev", ...args, ...(branch ? [`--branch=${branch}`] : [])],
      {
        cwd: path,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GH_PROMPT_DISABLED: "1",
        },
        timeout: 180_000,
      },
    );
    const output = { stdout: stdout.trim(), stderr: stderr.trim() };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const output = {
      error: error instanceof Error ? error.message : String(error),
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(output) }],
    };
  }
}

const repositoryPath = z
  .string()
  .refine(isAbsolute, "Expected an absolute repository path.")
  .describe("Absolute Git repository path (no ~).");

const server = new McpServer({ name: "zapdev-mcp", version: "1.0.0" });

server.registerTool(
  "prepare_repo",
  {
    description:
      "Clone/reset a disposable GitHub checkout under ZD_REPOS_DIR (default ~/.zapdev/repos). Requires repo; group is optional. " +
      "Call only when the user explicitly requests preparing or resetting this checkout; never call automatically as a prerequisite for another task. " +
      "Links repository secrets and, when grouped, group-root secrets; uses the group's config if present, otherwise the checkout's, for prepareCommand. " +
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
    try {
      const output = await prepareSelection({ repo, group, branch });
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const output = {
        error: error instanceof Error ? error.message : String(error),
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    }
  },
);

registerServerTools(server);

server.registerTool(
  "commit",
  {
    description:
      "Commit all changes via npx zapdev; pull and push only when requested (both default: false). " +
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
    "commit", "--yes", push ? "--push" : "--no-push",
    ...(pull ? ["--pull"] : []),
    ...(type === "auto" ? [] : [`--type=${type}`]),
  ], branch),
);

server.registerTool(
  "pr",
  {
    description:
      "Push the branch and create a GitHub PR via npx zapdev. Requires a clean tree, gh auth and ZD_* configuration. " +
      "Sends commit messages to the LLM. Never force-pushes; check remote state before retrying errors.",
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
    "pr", "--yes",
    ...(closes ? [`--closes=${closes}`] : []),
  ], branch),
);

await server.connect(new StdioServerTransport());
