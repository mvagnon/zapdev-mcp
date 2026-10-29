import { isAbsolute } from "node:path";
import { z } from "zod";

/** MCP text input for an absolute repository, worktree, subdirectory or group. */
export const repositoryPath = z.string().refine(isAbsolute, "Expected an absolute repository path.")
  .describe("Absolute existing Git repository, worktree, subdirectory or group path anywhere on the host (no ~).");

/** Validate and normalize GitHub repository and optional group inputs. */
export const repositorySelectionSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/)
    .transform(value => value.replace(/\.git$/, "").toLowerCase())
    .refine(value => !["", ".", ".."].includes(value.slice(value.indexOf("/") + 1))).describe("GitHub owner/repo."),
  group: z.string().optional().transform(value => value === "" ? undefined : value).pipe(
    z.string().regex(/^[^/\\\0]+$/).refine(value => ![".", ".."].includes(value)).optional(),
  ).describe("Group folder name, not a path. Omit or leave empty for a root checkout."),
}).strict();

/** Service tool inputs, including the server working-directory default. */
export const serviceSelectionSchema = z.object({
  path: z.string().optional().transform(value => value === "" ? undefined : value)
    .refine(value => value === undefined || isAbsolute(value), "Expected an absolute checkout or group path.")
    .describe("Absolute existing repository/group path anywhere on the host (no ~). Default: server cwd. Only sources inside ZD_REPOS_DIR use configuration; external sources have no services. Worktrees use source configuration. A repo uses its config, otherwise its direct parent's; a group uses its config, otherwise each immediate child repo's. No merging or further fallback."),
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/).optional().describe("Service name; omitted selects all."),
}).strict();
