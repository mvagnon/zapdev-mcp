import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import { repositoryRelativePath } from "./repositories.js";

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

/** Read managed source configuration; ignore external or ambiguous sources and reject configuration symlinks. */
export function readConfig(root: string, path: string | undefined): Config | undefined {
  const identity = path === undefined ? undefined : repositoryRelativePath(root, path);
  if (identity === undefined) return undefined;
  let directory = homedir();
  for (const part of [".zapdev", "config", ...identity.split(sep)]) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return undefined;
    if (!entry.isDirectory()) {
      throw new Error(`Expected an existing directory, not a symlink: ${directory}`);
    }
  }
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
