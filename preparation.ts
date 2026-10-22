import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "./config.js";
import { ensureDirectory, git, repositoryPaths, repositoryRoot, repoSchema, requireDirectory } from "./repositories.js";

const exec = promisify(execFile);
const home = homedir();

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
      if (target) rmSync(to);
      symlinkSync(from, to);
    }
  }
}

function linkSelectedSecrets(parent: string, group?: string, checkoutName?: string): void {
  const secrets = join(home, ".zapdev", "secrets");
  const source = group === undefined ? secrets : join(secrets, group);
  for (const directory of new Set([secrets, source])) {
    if (!lstatSync(directory, { throwIfNoEntry: false })) return;
    requireDirectory(directory);
  }
  linkSecrets(checkoutName === undefined ? source : join(source, checkoutName), parent, checkoutName !== undefined);
}

async function prepareCommand(root: string, path: string): Promise<void> {
  const command = readConfig(root, path).prepareCommand;
  if (command !== undefined) await exec("/bin/sh", ["-c", command], { cwd: path, timeout: 180_000 });
}

async function prepareRepository(root: string, repo: string, group?: string, branch?: string): Promise<{ path: string }> {
  const parent = group === undefined ? root : join(root, group);
  const checkoutName = repo.replace("/", "-");
  const path = join(parent, checkoutName);
  const directories = process.env.ZD_REPOS_DIR ? [root, parent] : [join(home, ".zapdev"), root, parent];
  for (const directory of directories) ensureDirectory(directory);
  const lock = join(parent, `.${checkoutName}.lock`);
  mkdirSync(lock);
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry) {
      if (!entry.isDirectory() || !lstatSync(join(path, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`Refusing to overwrite a non-checkout path: ${path}`);
      }
      if ((await git(path, "rev-parse", "--show-toplevel")) !== realpathSync(path)) {
        throw new Error(`Checkout worktree does not match its path: ${path}`);
      }
      const remote = (await git(path, "config", "--get", "remote.origin.url")).replace(/\.git$/, "").toLowerCase();
      if (![`https://github.com/${repo}`, `git@github.com:${repo}`, `ssh://git@github.com/${repo}`].includes(remote)) {
        throw new Error(`Checkout remote does not match ${repo}: ${path}`);
      }
      await git(path, "fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*");
    } else {
      mkdirSync(path);
      try {
        await git(parent, "clone", "--quiet", "--filter=blob:none", `https://github.com/${repo}.git`, path);
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
    }
    if (!branch) {
      await git(path, "remote", "set-head", "origin", "--auto");
      branch = (await git(path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")).slice("refs/remotes/origin/".length);
    }
    const reference = `refs/remotes/origin/${branch}`;
    await git(path, "rev-parse", "--verify", `${reference}^{commit}`);
    await git(path, "checkout", "--quiet", "--force", "-B", branch, reference);
    await git(path, "clean", "--quiet", "-fd");
    linkSelectedSecrets(path, group, checkoutName);
    await prepareCommand(root, path);
    return { path };
  } finally {
    rmdirSync(lock);
  }
}

/** Prepare one isolated checkout, or an existing group and all its immediate checkouts. */
export async function prepareSelection(
  { repo, group, branch }: { repo?: string; group?: string; branch?: string },
): Promise<{ path: string; repositories?: Array<{ path: string }> }> {
  if (branch) await git(home, "check-ref-format", "--branch", branch);
  const root = repositoryRoot();
  if (repo) return prepareRepository(root, repo, group, branch);
  if (group === undefined) throw new Error("Supply a repo or a group.");
  requireDirectory(root);
  const parent = join(root, group);
  requireDirectory(parent);
  const repos: string[] = [];
  for (const path of repositoryPaths(parent)) {
    const remote = await git(path, "config", "--get", "remote.origin.url");
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+)$/i.exec(remote);
    const repo = repoSchema.parse(match?.[1]);
    if (basename(path) !== repo.replace("/", "-")) throw new Error(`Checkout remote does not match its directory: ${path}`);
    repos.push(repo);
  }
  const repositories: Array<{ path: string }> = [];
  for (const repo of repos) repositories.push(await prepareRepository(root, repo, group, branch));
  linkSelectedSecrets(parent, group);
  await prepareCommand(root, parent);
  return { path: parent, repositories };
}
