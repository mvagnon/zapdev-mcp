#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ensureDirectory, groupSchema, repoSchema, repositoryRoot } from "./repositories.js";
import { registerServerTools } from "./servers.js";

const exec = promisify(execFile);
const home = homedir();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    timeout: 180_000,
  });
  return stdout.trim();
}

function linkSecrets(source: string, destination: string, recursive: boolean): void {
  const directory = lstatSync(source, { throwIfNoEntry: false });
  if (!directory) return;
  if (!directory.isDirectory()) {
    throw new Error(`Refusing to read secrets from a non-directory or symlink: ${source}`);
  }
  ensureDirectory(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.name.toLowerCase() === ".git") {
      throw new Error(`Refusing to link Git metadata from secrets: ${from}`);
    }
    if (entry.isDirectory()) {
      if (recursive) linkSecrets(from, to, true);
    } else {
      if (!entry.isFile()) {
        throw new Error(`Refusing to link a non-file or symlink from secrets: ${from}`);
      }
      const target = lstatSync(to, { throwIfNoEntry: false });
      if (target?.isSymbolicLink() && readlinkSync(to) === from) continue;
      if (target && !target.isFile()) {
        throw new Error(`Refusing to overwrite a non-file or symlink: ${to}`);
      }
      const temporary = mkdtempSync(join(destination, ".prepare-repo-secret-"));
      try {
        const file = join(temporary, "secret");
        symlinkSync(from, file);
        renameSync(file, to);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}

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
      "Links matching files from ~/.zapdev/secrets into the group root and repository after refresh. " +
      "Secret symlinks replace matching files; keep them Git-ignored to avoid committing them. " +
      "Edits through these links modify the source secrets. " +
      "Returns only its absolute path; use start_server for AGENTS.md instructions and configured URLs. " +
      "Uses the remote default branch unless branch is supplied. Fails if refresh fails. " +
      "Checkouts are disposable: overwrites tracked changes and removes untracked files, except ignored files. " +
      "Never use for repositories containing work you want to keep.",
    inputSchema: z
      .object({
        repo: repoSchema,
        group: groupSchema,
        branch: z
          .string()
          .optional()
          .describe("Optional remote branch to check out."),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ repo, group, branch }) => {
    try {
      if (branch) await git(home, "check-ref-format", "--branch", branch);
      const owner = repo.slice(0, repo.indexOf("/"));
      const name = repo.slice(repo.indexOf("/") + 1);
      const root = repositoryRoot();
      const parent = group === undefined ? root : join(root, group);
      const checkoutName = `${owner}-${name}`;
      const path = join(parent, checkoutName);
      const directories = process.env.ZD_REPOS_DIR
        ? [root, parent]
        : [join(home, ".zapdev"), root, parent];
      for (const directory of directories) {
        ensureDirectory(directory);
      }

      const lock = join(parent, `.${checkoutName}.lock`);
      mkdirSync(lock);
      try {
        const entry = lstatSync(path, { throwIfNoEntry: false });
        if (entry) {
          if (
            !entry.isDirectory() ||
            !lstatSync(join(path, ".git"), {
              throwIfNoEntry: false,
            })?.isDirectory()
          ) {
            throw new Error(
              `Refusing to overwrite a non-checkout path: ${path}`,
            );
          }
          if (
            (await git(path, "rev-parse", "--show-toplevel")) !==
            realpathSync(path)
          ) {
            throw new Error(
              `Checkout worktree does not match its path: ${path}`,
            );
          }
          const remote = (
            await git(path, "config", "--get", "remote.origin.url")
          )
            .replace(/\.git$/, "")
            .toLowerCase();
          if (
            ![
              `https://github.com/${repo}`,
              `git@github.com:${repo}`,
              `ssh://git@github.com/${repo}`,
            ].includes(remote)
          ) {
            throw new Error(`Checkout remote does not match ${repo}: ${path}`);
          }
          await git(
            path,
            "fetch",
            "--quiet",
            "--prune",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
          );
        } else {
          const temporary = mkdtempSync(join(parent, ".prepare-repo-"));
          try {
            await git(
              parent,
              "clone",
              "--quiet",
              "--filter=blob:none",
              `https://github.com/${repo}.git`,
              temporary,
            );
            renameSync(temporary, path);
          } finally {
            rmSync(temporary, { recursive: true, force: true });
          }
        }

        if (!branch) {
          await git(path, "remote", "set-head", "origin", "--auto");
          branch = (
            await git(
              path,
              "symbolic-ref",
              "--quiet",
              "refs/remotes/origin/HEAD",
            )
          ).slice("refs/remotes/origin/".length);
        }
        const reference = `refs/remotes/origin/${branch}`;
        await git(path, "rev-parse", "--verify", `${reference}^{commit}`);
        await git(
          path,
          "checkout",
          "--quiet",
          "--force",
          "-B",
          branch,
          reference,
        );
        await git(path, "clean", "--quiet", "-fd");

        const output = { path };
        const secrets = join(home, ".zapdev", "secrets");
        const secretsDirectory = lstatSync(secrets, { throwIfNoEntry: false });
        if (secretsDirectory) {
          if (!secretsDirectory.isDirectory()) {
            throw new Error(`Refusing to use a non-directory or symlink: ${secrets}`);
          }
          const secretsParent = group === undefined ? secrets : join(secrets, group);
          if (group !== undefined) linkSecrets(secretsParent, parent, false);
          linkSecrets(join(secretsParent, checkoutName), path, true);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } finally {
        rmdirSync(lock);
      }
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
      "Always uses --yes --pull --no-push and the supplied --branch. " +
      "Pulls fast-forward updates when an upstream is configured; never pushes. " +
      "Sends commit context to the configured zapdev LLM endpoint. " +
      "Requires npx and ZD_* environment configuration; no global zapdev installation needed.",
    inputSchema: z
      .object({
        path: repositoryPath,
        branch: z
          .string()
          .min(1)
          .describe("Local branch to switch to or create before committing."),
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
