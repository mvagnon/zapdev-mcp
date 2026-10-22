import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

/** Run Git without interactive credential prompts, returning trimmed standard output. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    timeout: 180_000,
  });
  return stdout.trim();
}

/** GitHub repository identifier, normalized to owner/repo. */
const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/)
  .transform((value) => value.replace(/\.git$/, "").toLowerCase())
  .refine((value) => !["", ".", ".."].includes(value.slice(value.indexOf("/") + 1)))
  .describe("GitHub owner/repo.");

const optionalSelector = z.string().optional().transform(value => value === "" ? undefined : value);

/** Required repository and optional group; an empty group selects a root checkout. */
export const repositorySelectionSchema = z.object({
  repo: repoSchema,
  group: optionalSelector.pipe(
    z.string().regex(/^[^/\\\0]+$/).refine(value => ![".", ".."].includes(value)).optional(),
  ).describe(
    "Group folder name, not a path. Omit or leave empty for a root checkout.",
  ),
}).strict();

/** Resolve the configured absolute root for disposable checkouts. */
export function repositoryRoot(): string {
  const root = process.env.ZD_REPOS_DIR || join(homedir(), ".zapdev", "repos");
  if (!isAbsolute(root)) throw new Error("ZD_REPOS_DIR must be an absolute path.");
  return root;
}

/** Create a directory, rejecting existing files and symbolic links. */
export function ensureDirectory(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) {
    throw new Error(`Refusing to use a non-directory or symlink: ${path}`);
  }
  mkdirSync(path, { recursive: true });
}

/** Require an existing directory, rejecting files and symbolic links. */
export function requireDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected an existing directory, not a symlink: ${path}`);
  }
}

/** List immediate prepared checkouts, excluding hidden directories and symlinks. */
export function repositoryPaths(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") &&
      lstatSync(join(parent, entry.name, ".git"), { throwIfNoEntry: false })?.isDirectory())
    .map(entry => join(parent, entry.name)).sort();
}
