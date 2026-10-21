import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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

function ensureDirectory(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) {
    throw new Error(`Refusing to use a non-directory or symlink: ${path}`);
  }
  mkdirSync(path, { recursive: true });
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
  "get_repo",
  {
    description:
      "Clone or refresh a GitHub repository in ~/.zapdev/repos/<owner>/<repo>. " +
      "Returns its absolute path and root AGENTS.md contents when present. " +
      "Uses the remote default branch unless branch is supplied. Fails if refresh fails. " +
      "Checkouts are disposable: overwrites tracked changes and removes untracked files, except ignored files. " +
      "Never use for repositories containing work you want to keep.",
    inputSchema: z
      .object({
        repo: z
          .string()
          .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/)
          .transform((value) => value.replace(/\.git$/, "").toLowerCase())
          .refine(
            (value) =>
              !["", ".", ".."].includes(value.slice(value.indexOf("/") + 1)),
          )
          .describe("GitHub repository as owner/repo."),
        branch: z
          .string()
          .optional()
          .describe("Optional remote branch to check out."),
      })
      .strict(),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ repo, branch }) => {
    try {
      if (branch) await git(home, "check-ref-format", "--branch", branch);
      const owner = repo.slice(0, repo.indexOf("/"));
      const name = repo.slice(repo.indexOf("/") + 1);
      const root = join(home, ".zapdev", "repos");
      const parent = join(root, owner);
      const path = join(parent, name);
      for (const directory of [join(home, ".zapdev"), root, parent]) {
        ensureDirectory(directory);
      }

      const lock = join(root, `.${owner}_${name}.lock`);
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
          const temporary = mkdtempSync(join(parent, ".get-repo-"));
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

        const output: { path: string; agents_md?: string } = { path };
        const instructions = join(path, "AGENTS.md");
        if (lstatSync(instructions, { throwIfNoEntry: false })?.isFile()) {
          output.agents_md = readFileSync(instructions, "utf8");
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
