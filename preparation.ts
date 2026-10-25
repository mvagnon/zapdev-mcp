import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "./config.js";
import { ensureDirectory, git, repositoryRoot, requireDirectory } from "./repositories.js";

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

/** Link all checkout secrets before running each selected repository or group preparation command once. */
export async function prepareCheckouts(root: string, checkouts: { source: string; path: string }[]): Promise<void> {
  const commands = new Map<string, string>();
  for (const { source, path } of checkouts) {
    const group = relative(root, dirname(source)) || undefined;
    const parent = group === undefined ? path : dirname(path);
    if (group !== undefined) linkSelectedSecrets(parent, group);
    linkSelectedSecrets(path, group, basename(source));
    const config = readConfig(root, group === undefined ? source : dirname(source));
    const command = (config ?? readConfig(root, source))?.prepareCommand;
    if (command === undefined) continue;
    const cwd = config === undefined ? path : parent;
    if (commands.has(cwd) && commands.get(cwd) !== command) throw new Error(`Conflicting preparation commands for ${cwd}`);
    commands.set(cwd, command);
  }
  for (const [cwd, command] of commands) await exec("/bin/sh", ["-c", command], { cwd, timeout: 180_000 });
}

async function prepareRepository(root: string, repo: string, group?: string, branch?: string): Promise<{ path: string }> {
  const parent = group === undefined ? root : join(root, group);
  const checkoutName = repo.replace("/", "__");
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
    await prepareCheckouts(root, [{ source: path, path }]);
    return { path };
  } finally {
    rmdirSync(lock);
  }
}

/** Prepare one isolated checkout, linking group and repository secrets when grouped. */
export async function prepareSelection(
  { repo, group, branch }: { repo: string; group?: string; branch?: string },
): Promise<{ path: string }> {
  if (branch) await git(home, "check-ref-format", "--branch", branch);
  return prepareRepository(repositoryRoot(), repo, group, branch);
}
