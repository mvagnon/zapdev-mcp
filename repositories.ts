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
export function requireDirectory(path: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Expected an existing directory, not a symlink: ${path}`);
  }
}

/** Resolve the directory containing branch-named worktree workspaces. */
export function worktreeRoot(): string {
  return join(homedir(), ".zapdev", "worktrees");
}

function contains(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

function managedDirectory(path: string): string {
  const target = resolve(path);
  for (const root of [repositoryRoot(), worktreeRoot()]) {
    const canonical = lstatSync(root, { throwIfNoEntry: false })?.isDirectory() ? realpathSync(root) : resolve(root);
    const boundary = [resolve(root), canonical].find(root => contains(root, target));
    if (boundary === undefined) continue;
    if (root === worktreeRoot()) requireDirectory(join(homedir(), ".zapdev"));
    requireDirectory(root);
    let directory = boundary;
    for (const part of relative(boundary, target).split(sep).filter(Boolean)) {
      directory = join(directory, part);
      requireDirectory(directory);
    }
    const actual = realpathSync(target);
    if (contains(canonical, actual)) return actual;
  }
  throw new Error("Path must be inside ZD_REPOS_DIR or ~/.zapdev/worktrees; directory symlinks are not allowed.");
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

/** A managed target and its original configuration identity, shared by Git, preparation, and service tools. */
export type RepositorySelection = Repository & { root: string; isRepository: boolean; repositories: Repository[] };

async function repository(path: string, root: string): Promise<Repository> {
  path = managedDirectory(path);
  const metadata = lstatSync(join(path, ".git"));
  if (!metadata.isDirectory() && !metadata.isFile()) throw new Error(`Invalid Git metadata: ${path}`);
  if (await git(path, "rev-parse", "--show-toplevel") !== path) throw new Error(`Git worktree does not match its path: ${path}`);
  let source = path;
  if (metadata.isFile()) {
    const record = (await git(path, "worktree", "list", "--porcelain", "-z")).split("\0", 1)[0];
    if (!record?.startsWith("worktree ")) throw new Error(`Cannot identify the source repository: ${path}`);
    source = managedDirectory(record.slice("worktree ".length));
  }
  if (source === root || !contains(root, source)) throw new Error(`Repository source must be below ZD_REPOS_DIR: ${source}`);
  return { path, source };
}

/** Resolve one enclosing repository or a group's immediate children, enforcing managed paths and worktree provenance. */
export async function selectRepositories(path = process.cwd()): Promise<RepositorySelection> {
  const target = managedDirectory(path);
  const root = realpathSync(repositoryRoot());
  for (let ancestor = target; ; ancestor = dirname(ancestor)) {
    if (lstatSync(join(ancestor, ".git"), { throwIfNoEntry: false })) {
      const selected = await repository(ancestor, root);
      return { ...selected, root, isRepository: true, repositories: [selected] };
    }
    if (ancestor === dirname(ancestor)) break;
  }
  const repositories = await Promise.all(repositoryPaths(target).map(path => repository(path, root)));
  let source = target;
  if (!contains(root, target) || repositories.some(repository => repository.path !== repository.source)) {
    const parents = new Set(repositories.map(({ source }) => dirname(source)));
    const [parent] = parents;
    if (parents.size !== 1 || parent === undefined) throw new Error(`Cannot identify a unique source group: ${target}`);
    source = parent;
  }
  return { root, path: target, source, isRepository: false, repositories };
}
