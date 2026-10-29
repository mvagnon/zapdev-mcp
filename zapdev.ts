import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const exec = promisify(execFile);
let entry: string | undefined;

/** Configure the existing local-clone override without an npm fallback. */
export function configureZapdev(path: string | undefined): void {
  if (path !== undefined && !isAbsolute(path)) throw new Error("Expected --zapdev-path to be an absolute path to a local zapdev clone (no ~).");
  entry = path === undefined ? undefined : join(path, "dist", "index.js");
}

/** Execute a compatible CLI with prompts disabled and retain both output streams on failure. */
export async function runZapdev(args: string[]): Promise<{ stdout: string; stderr: string; error?: string }> {
  const output: { stdout: string; stderr: string; error?: string } = { stdout: "", stderr: "" };
  try {
    if (entry !== undefined && !statSync(entry, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Local zapdev build not found at ${entry}. Run npm install and npm run build in the zapdev clone.`);
    }
    const { stdout, stderr } = await exec(entry === undefined ? "npx" : process.execPath,
      [...(entry === undefined ? ["--yes", "zapdev@^5.3.0"] : [entry]), ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GH_PROMPT_DISABLED: "1" },
        timeout: args[0] === "commit" || args[0] === "pr" ? 180_000 : undefined,
      });
    output.stdout = stdout.trim();
    output.stderr = stderr.trim();
  } catch (error) {
    output.error = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      if ("stdout" in error && typeof error.stdout === "string") output.stdout = error.stdout.trim();
      if ("stderr" in error && typeof error.stderr === "string") output.stderr = error.stderr.trim();
    }
  }
  return output;
}

/** Translate a CLI workspace result into the unchanged MCP text/structured response contract. */
export async function callWorkspaceCommand(args: string[]): Promise<CallToolResult> {
  const execution = await runZapdev([...args, "--non-interactive", "--json"]);
  let output: Record<string, unknown>;
  try {
    output = z.record(z.string(), z.unknown()).parse(JSON.parse(execution.stdout));
  } catch {
    output = { error: execution.error ?? `Invalid JSON result from zapdev ${args[0]}.` };
  }
  const services = Array.isArray(output.services) ? output.services : [];
  const failed = output.error !== undefined || services.some(service => service?.error !== undefined);
  if (execution.error !== undefined && !failed) output.error = execution.error;
  const isError = failed || execution.error !== undefined;
  return {
    ...(isError && { isError: true }),
    content: [{ type: "text", text: JSON.stringify(output) }],
    ...((!isError || "paths" in output || "services" in output) && { structuredContent: output }),
  };
}
