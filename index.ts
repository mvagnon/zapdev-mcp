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
  .describe("Absolute path inside the Git repository.");

const server = new McpServer({ name: "zapdev-mcp", version: "1.0.0" });

server.registerTool(
  "prepare_repo",
  {
    description:
      "Clone or refresh a GitHub repository in <ZD_REPOS_DIR>/<owner>-<repo> " +
      "(defaults to ~/.zapdev/repos/<owner>-<repo>). " +
      "When group is supplied, place the checkout in <ZD_REPOS_DIR>/<group>/<owner>-<repo>. " +
      "repo and group are individually optional; omitted or empty strings are ignored, but at least one must be nonempty. " +
      "Supply group alone to refresh all existing immediate child checkouts, without cloning new repositories. " +
      "With repo, links matching files from ~/.zapdev/secrets and runs prepareCommand only for that checkout, never for its group. " +
      "With group alone, prepares each child, then links group-root secrets and runs the group's prepareCommand once. " +
      "Secret symlinks replace matching files; keep them Git-ignored to avoid committing them. " +
      "Edits through these links modify the source secrets. " +
      "After linking secrets, runs the optional prepareCommand from ~/.zapdev/config and waits up to 180 seconds. " +
      "Missing commands do nothing; failures return an error. Group preparation stops at the first failure; completed changes are not rolled back. " +
      "Returns its absolute path, plus repositories for a whole group; use start_server for AGENTS.md instructions and configured URLs. " +
      "Uses the remote default branch unless branch is supplied. Fails if refresh fails. " +
      "Checkouts are disposable: overwrites tracked changes and removes untracked files, except ignored files. " +
      "Never use for repositories containing work you want to keep.",
    inputSchema: repositorySelectionSchema
      .extend({
        branch: z
          .string()
          .optional()
          .describe("Optional remote branch to check out in each selected repository."),
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
      "Commit all changes in a local Git repository using npx --yes zapdev. " +
      "Always uses --yes --pull --no-push; adds --branch when supplied, otherwise keeps the current branch. " +
      "Pulls fast-forward updates when an upstream is configured; never pushes. " +
      "Sends commit context to the configured zapdev LLM endpoint. " +
      "Requires npx and ZD_* environment configuration; no global zapdev installation needed.",
    inputSchema: z
      .object({
        path: repositoryPath,
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("Local branch to switch to or create before committing; defaults to the current branch."),
        type: z
          .string()
          .regex(/^(auto|(?:feat|fix|deps|chore|docs|style|refactor|perf|test|build|ci|revert)!?)$/)
          .default("auto")
          .describe("Conventional Commit type, optionally ending in !; auto lets zapdev choose."),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ path, branch, type }) => zapdev(path, [
    "commit", "--yes", "--pull", "--no-push",
    ...(type === "auto" ? [] : [`--type=${type}`]),
  ], branch),
);

server.registerTool(
  "pr",
  {
    description:
      "Push the current branch and create a GitHub pull request using npx --yes zapdev pr --yes. " +
      "Requires a clean working tree, npx, authenticated GitHub CLI (gh), and ZD_* configuration. " +
      "Sends full branch commit messages to the configured LLM endpoint to generate the title. " +
      "Builds the description from commits and optionally appends a Closes task URL. " +
      "Never force-pushes; no global zapdev installation needed. Do not retry blindly after errors: " +
      "the branch may already have been pushed or the PR created.",
    inputSchema: z
      .object({
        path: repositoryPath,
        branch: z
          .string()
          .min(1)
          .optional()
          .describe("Target branch of the PR; defaults to the GitHub repository's default branch."),
        closes: z
          .url({ protocol: /^https?$/ })
          .optional()
          .describe("HTTP(S) PM task URL to reference as Closes in the PR description."),
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
