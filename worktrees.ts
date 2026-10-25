import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { prepareCheckouts } from "./preparation.js";
import { ensureDirectory, git, repositoryRoot, selectRepositories } from "./repositories.js";

async function preparationSource(path: string, root: string, group?: string): Promise<string> {
  const listing = await git(path, "worktree", "list", "--porcelain", "-z");
  const record = listing.split("\0", 1)[0];
  if (!record?.startsWith("worktree ")) throw new Error("Cannot identify the main Git worktree.");
  const main = record.slice("worktree ".length);
  const parts = relative(root, main).split(sep);
  if (parts.length <= 2 && parts.every(part => part !== "" && part !== ".." && part !== ".")) return main;
  const origin = await git(path, "config", "--default", "", "--get", "remote.origin.url");
  const [, owner, repository] = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+)\/?$/i) ?? [];
  const name = owner && repository ? `${owner}__${repository.replace(/\.git$/i, "")}`.toLowerCase() : basename(main);
  return join(root, ...(group ? [group] : []), name);
}

/** Prepare branch-named worktrees for one repository or a group's immediate children without resetting sources. */
export async function prepareWorktree({ path, branch }: { path: string; branch: string }): Promise<{
  paths: string[]; instructions: string; error?: string;
}> {
  const paths: string[] = [];
  const workspace = join(homedir(), ".zapdev", "worktrees", branch);
  try {
    const { repositories, group } = await selectRepositories(path);
    if (await git(path, "check-ref-format", "--branch", branch) !== branch) throw new Error("Expected a literal new branch name.");
    const root = resolve(repositoryRoot());
    const checkouts: { repository: string; source: string; path: string; head: string }[] = [];
    for (const repository of repositories) {
      if (await git(repository, "branch", "--list", "--", branch)) throw new Error(`Branch already exists in ${repository}: ${branch}`);
      const head = await git(repository, "rev-parse", "--verify", "HEAD^{commit}");
      const source = await preparationSource(repository, root, group);
      const destination = group !== undefined || relative(root, source).split(sep).length === 2 ? join(workspace, basename(source)) : workspace;
      checkouts.push({ repository, source, path: destination, head });
    }
    if (new Set(checkouts.map(({ path }) => path)).size !== checkouts.length) throw new Error("Selected repositories have conflicting worktree paths.");
    let parent = homedir();
    for (const part of [".zapdev", "worktrees", ...branch.split("/").slice(0, -1)]) {
      parent = join(parent, part);
      ensureDirectory(parent);
      if (lstatSync(join(parent, ".git"), { throwIfNoEntry: false })) throw new Error(`Refusing to create a nested worktree inside ${parent}`);
    }
    mkdirSync(workspace);
    for (const checkout of checkouts) {
      await git(checkout.repository, "worktree", "add", "-b", branch, "--", checkout.path, checkout.head);
      paths.push(checkout.path);
    }
    await prepareCheckouts(root, checkouts);
    return { paths, instructions: "Work exclusively in the returned worktree paths. Do not modify the source repositories." };
  } catch (error) {
    return {
      paths,
      instructions: "Preparation failed. Inspect retained worktree paths and files before continuing; do not modify the source repositories or retry blindly.",
      error: `Worktree preparation failed at ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
