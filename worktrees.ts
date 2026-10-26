import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { prepareCheckouts } from "./preparation.js";
import { ensureDirectory, git, selectRepositories, worktreeRoot } from "./repositories.js";

/** Prepare branch-named worktrees for one repository or a group's immediate children without resetting sources. */
export async function prepareWorktree({ path, branch }: { path: string; branch: string }): Promise<{
  paths: string[]; error?: string;
}> {
  const paths: string[] = [];
  const workspace = join(worktreeRoot(), branch.replaceAll("/", "__"));
  try {
    const { root, repositories, isRepository } = await selectRepositories(path);
    if (repositories.length === 0) throw new Error(`No Git repository found in ${path} or its immediate children.`);
    if (await git(path, "check-ref-format", "--branch", branch) !== branch) throw new Error("Expected a literal new branch name.");
    const checkouts: { repository: string; source: string; path: string; head: string }[] = [];
    for (const { path: repository, source } of repositories) {
      if (await git(repository, "branch", "--list", "--", branch)) throw new Error(`Branch already exists in ${repository}: ${branch}`);
      const head = await git(repository, "rev-parse", "--verify", "HEAD^{commit}");
      const destination = !isRepository || dirname(source) !== root ? join(workspace, basename(source)) : workspace;
      checkouts.push({ repository, source, path: destination, head });
    }
    if (new Set(checkouts.map(({ path }) => path)).size !== checkouts.length) throw new Error("Selected repositories have conflicting worktree paths.");
    let parent = homedir();
    for (const part of [".zapdev", "worktrees"]) {
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
    return { paths };
  } catch (error) {
    return {
      paths,
      error: `Worktree preparation failed at ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
