import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serviceSelectionSchema as selectionSchema } from "./schemas.js";
import { callWorkspaceCommand } from "./zapdev.js";

type Selection = { path?: string; service?: string };

function serviceArgs(input: Selection): string[] {
  return [...(input.path ? [input.path] : []), ...(input.service ? [`--service=${input.service}`] : [])];
}

/** Register named service discovery, startup, shutdown, and bounded log tools for prepared repositories and groups. */
export function registerServerTools(server: McpServer): void {
  server.registerTool("list_services", {
    description:
      "List configured services available to start in a prepared checkout or group. " +
      "Returns service names and paths only; does not run commands, query systemd, or check readiness.",
    inputSchema: selectionSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => callWorkspaceCommand(["services", "list", ...serviceArgs(input)]));

  server.registerTool(
    "start_server",
    {
      description:
        "Start configured services using Linux/systemd; already active or activating units return errors with their ID, state and available PID, without restarting them. Useful for running services needed by end-to-end (E2E) tests. " +
        "New services automatically stop after 3 hours, then run stopCommand in the service directory. " +
        "Returns compact states/errors and maxRuntimeSeconds when configured, not readiness. " +
        "Repeated starts do not renew a unit's lifetime or add expiry to older units. Use server_logs for diagnostics; stop failed units before restarting.",
      inputSchema: selectionSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async input => callWorkspaceCommand(["services", "start", ...serviceArgs(input)]),
  );

  server.registerTool("stop_server", {
    description:
      "Stop services via Linux/systemd: SIGINT, then SIGKILL after 30s, then optional cleanup. Useful for shutting down services after end-to-end (E2E) tests. " +
      "Verifies process shutdown and unit release; clears old failed states. Cleanup or verification failures return errors. Use server_logs for diagnostics.",
    inputSchema: selectionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async input => callWorkspaceCommand(["services", "stop", ...serviceArgs(input)]));

  server.registerTool("server_logs", {
    description:
      "Read timestamped stdout/stderr and systemd diagnostics for the latest invocation of the current user's unit (systemd 257+). " +
      "Returns current state, exit codes and logs (up to 64 KiB/service). Logs may contain secrets.",
    inputSchema: selectionSchema.extend({ lines: z.number().int().min(1).max(1000).default(100) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async input => callWorkspaceCommand(["services", "logs", ...serviceArgs(input), `--lines=${input.lines}`]));
}
