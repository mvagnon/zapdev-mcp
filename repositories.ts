import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
function requireDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected an existing directory, not a symlink: ${path}`);
  }
}

/** Resolve the directory containing branch-named worktree workspaces. */
export function worktreeRoot(): string {
  return join(homedir(), ".zapdev", "worktrees");
}

/** Return a checkout's relative configuration identity, or undefined when outside the checkout root. */
export function repositoryRelativePath(root: string, path: string): string | undefined {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`) ? part : undefined;
}

/** List immediate Git repositories and linked worktrees, excluding symlinked directories and node_modules. */
function repositoryPaths(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter(entry => {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") return false;
      const metadata = lstatSync(join(parent, entry.name, ".git"), { throwIfNoEntry: false });
      if (metadata?.isSymbolicLink()) throw new Error(`Refusing symlinked Git metadata: ${join(parent, entry.name)}`);
      return metadata?.isDirectory() || metadata?.isFile();
    })
    .map(entry => join(parent, entry.name)).sort();
}

type Repository = { path: string; source: string };

/** A target and its source configuration identity; mixed source groups have no shared identity. */
export type RepositorySelection = { path: string; source: string | undefined; root: string; isRepository: boolean; repositories: Repository[] };

async function repository(path: string): Promise<Repository> {
  const metadata = lstatSync(join(path, ".git"));
  if (!metadata.isDirectory() && !metadata.isFile()) throw new Error(`Invalid Git metadata: ${path}`);
  if (await git(path, "rev-parse", "--show-toplevel") !== path) throw new Error(`Git worktree does not match its path: ${path}`);
  let source = path;
  if (metadata.isFile()) {
    const record = (await git(path, "worktree", "list", "--porcelain", "-z")).split("\0", 1)[0];
    if (!record?.startsWith("worktree ")) throw new Error(`Cannot identify the source repository: ${path}`);
    source = record.slice("worktree ".length);
    requireDirectory(source);
    source = realpathSync(source);
  }
  return { path, source };
}

/** Resolve any enclosing Git repository or immediate child repositories, retaining source identities for configuration. */
export async function selectRepositories(path = process.cwd()): Promise<RepositorySelection> {
  requireDirectory(resolve(path));
  const target = realpathSync(path);
  const configuredRoot = repositoryRoot();
  const root = lstatSync(configuredRoot, { throwIfNoEntry: false })?.isDirectory() ? realpathSync(configuredRoot) : resolve(configuredRoot);
  for (let ancestor = target; ; ancestor = dirname(ancestor)) {
    if (lstatSync(join(ancestor, ".git"), { throwIfNoEntry: false })) {
      const selected = await repository(ancestor);
      return { ...selected, root, isRepository: true, repositories: [selected] };
    }
    if (ancestor === dirname(ancestor)) break;
  }
  const repositories = await Promise.all(repositoryPaths(target).map(repository));
  let source: string | undefined = target;
  if (repositories.some(repository => repository.path !== repository.source)) {
    const parents = new Set(repositories.map(({ source }) => dirname(source)));
    const [parent] = parents;
    source = parents.size === 1 ? parent : undefined;
  }
  return { root, path: target, source, isRepository: false, repositories };
}
