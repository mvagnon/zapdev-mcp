import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  prepareCommand: z.string().trim().min(1).optional(),
  startCommand: z.string().trim().min(1).optional(),
  stopCommand: z.string().trim().min(1).optional(),
  frontUrl: z.url().optional(),
  apiUrl: z.url().optional(),
  dbUrl: z.url().optional(),
});

/** Optional repository and group lifecycle commands and URLs. */
export type Config = z.infer<typeof configSchema>;

/** Read configuration matching a checkout path, rejecting source symlinks. */
export function readConfig(root: string, path: string): Config {
  let directory = homedir();
  for (const part of [".zapdev", "config", ...relative(root, path).split(sep)]) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return {};
    if (!entry.isDirectory()) {
      throw new Error(`Expected an existing directory, not a symlink: ${directory}`);
    }
  }
  const file = join(directory, "zapdev.json");
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return {};
  if (!entry.isFile()) throw new Error(`Expected a regular config file, not a symlink: ${file}`);
  try {
    return configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`Invalid configuration in ${file}: expected JSON with optional nonempty commands and valid URLs.`);
  }
}
