import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import { repositoryRelativePath, worktreeRoot, type RepositorySelection } from "./repositories.js";

/** Stable service name used by configuration and lifecycle tools. */
export const serviceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/);

const commandSchema = z.string().trim().min(1).refine(value => !value.includes("\0"));
const configSchema = z.object({
  prepareCommand: z.string().trim().min(1).optional(),
  services: z.record(serviceNameSchema, z.object({
    startCommand: commandSchema,
    stopCommand: commandSchema.optional(),
  }).strict()).optional(),
  frontUrl: z.url().optional(),
  apiUrl: z.url().optional(),
  dbUrl: z.url().optional(),
}).strict();

/** Optional repository and group lifecycle commands and URLs. */
export type Config = z.infer<typeof configSchema>;

function resourceDirectory(root: string, source: string | undefined, kind: "config" | "secrets"): string | undefined {
  const identity = source === undefined ? undefined : repositoryRelativePath(root, source);
  if (identity === undefined) return undefined;
  let directory = homedir();
  for (const part of [".zapdev", kind, ...identity.split(sep).filter(Boolean)]) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (!entry.isDirectory()) {
      throw new Error(`Expected an existing directory, not a symlink: ${directory}`);
    }
  }
  return directory;
}

/** Resolve managed resources at the selected scope, falling back once to a repository's parent or a group's immediate repositories. */
export function resolveResources<T>(
  selection: RepositorySelection, kind: "config" | "secrets", read: (directory: string, recursive: boolean) => T | undefined,
): { path: string; value: T }[] {
  const { root, path, source, isRepository, repositories } = selection;
  const at = (target: { path: string; source: string | undefined }, recursive: boolean): { path: string; value: T }[] => {
    const directory = resourceDirectory(root, target.source, kind);
    const value = directory === undefined ? undefined : read(directory, recursive);
    return value === undefined ? [] : [{ path: target.path, value }];
  };
  const own = at(selection, isRepository);
  if (own.length > 0) return own;
  const fallback = isRepository
    ? at({ path: dirname(path), source: source === undefined ? undefined : dirname(source) }, false)
    : repositories.flatMap(repository => at(repository, true));
  if (isRepository && path !== source && fallback.some(target => target.path === worktreeRoot())) {
    throw new Error(`Parent resources require an isolated workspace; prepare a new worktree instead: ${path}`);
  }
  return fallback;
}

function readConfig(directory: string): Config | undefined {
  const file = join(directory, "zapdev.json");
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile()) throw new Error(`Expected a regular config file, not a symlink: ${file}`);
  try {
    return configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`Invalid configuration in ${file}: expected prepareCommand, named services with startCommand and optional stopCommand, and valid URLs. Legacy top-level startCommand is not supported.`);
  }
}

/** Resolve repository/group configuration with the same exclusive fallback used for secrets. */
export function resolveConfigs(selection: RepositorySelection): { path: string; value: Config }[] {
  return resolveResources(selection, "config", readConfig);
}
