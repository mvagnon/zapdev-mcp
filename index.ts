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
      "Commit all changes in a local Git repository using the installed zapdev CLI. " +
      "Always uses --yes --pull --no-push and the supplied --branch. " +
      "Pulls fast-forward updates when an upstream is configured; never pushes. " +
      "Sends commit context to the configured zapdev LLM endpoint. " +
      "Requires zapdev with --branch support and its ZD_* environment configuration.",
    inputSchema: z
      .object({
        path: z
          .string()
          .refine(isAbsolute, "Expected an absolute repository path.")
          .describe("Absolute path inside the Git repository to commit."),
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
  async ({ path, branch, type }) => {
    try {
      await git(path, "rev-parse", "--show-toplevel");
      await git(path, "check-ref-format", "--branch", branch);
      const { stdout, stderr } = await exec(
        "zapdev",
        [
          "commit", "--yes", "--pull", "--no-push", `--branch=${branch}`,
          ...(type === "auto" ? [] : [`--type=${type}`]),
        ],
        {
          cwd: path,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
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
  },
);

await server.connect(new StdioServerTransport());
