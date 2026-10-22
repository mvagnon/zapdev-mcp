import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/** GitHub repository identifier, normalized to owner/repo. */
export const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/)
  .transform((value) => value.replace(/\.git$/, "").toLowerCase())
  .refine((value) => !["", ".", ".."].includes(value.slice(value.indexOf("/") + 1)))
  .describe("GitHub repository as owner/repo.");

/** Optional checkout group, restricted to a single directory name. */
export const groupSchema = z
  .string()
  .regex(/^[^/\\\0]+$/)
  .refine((value) => ![".", ".."].includes(value))
  .optional()
  .describe("Optional group folder inside ZD_REPOS_DIR; a single directory name, not a path.");

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
