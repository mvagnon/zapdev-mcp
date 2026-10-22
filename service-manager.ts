import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { ensureDirectory } from "./repositories.js";

const exec = promisify(execFile);
const logLimit = 65_536;

/** One named service configured in its repository or group directory. */
export type Service = { name: string; path: string; startCommand: string; stopCommand?: string };
/** Systemd state and optional bounded logs or operation error for a named service. */
export type ServiceResult = {
  name: string; path: string; id: string; state?: string; subState?: string;
  result?: string; exitCode?: number; exists?: boolean; logs?: string; truncated?: boolean; error?: string;
};
type Status = { state: string; subState: string; result: string; exitCode: number; exists: boolean };

async function systemd(command: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    return (await exec(command, ["--user", ...args], { timeout, maxBuffer: 262_144 })).stdout;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Service supervision requires Linux with systemd-run and a running systemd user manager.", { cause: error });
    }
    if (command === "systemctl" && args[0] === "show" && error instanceof Error &&
      "stdout" in error && typeof error.stdout === "string" && error.stdout.includes("LoadState=not-found")) {
      return error.stdout;
    }
    throw error;
  }
}

async function status(id: string): Promise<Status> {
  const output = await systemd("systemctl", [
    "show", "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus", id,
  ]);
  const fields = Object.fromEntries(output.trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!fields.LoadState || !fields.ActiveState) throw new Error(`Could not read systemd state for ${id}.`);
  return {
    state: fields.ActiveState, subState: fields.SubState ?? "dead",
    result: fields.Result || "success", exitCode: Number(fields.ExecMainStatus || 0),
    exists: fields.LoadState !== "not-found",
  };
}

function requireLogFile(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) throw new Error(`Expected a regular service log, not a symlink: ${path}`);
  return entry !== undefined;
}

function logs(path: string, lines: number): { logs: string; truncated: boolean } {
  if (!requireLogFile(path)) return { logs: "", truncated: false };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Expected a regular service log: ${path}`);
    const size = fstatSync(fd).size;
    const offset = Math.max(0, size - logLimit);
    const buffer = Buffer.alloc(Math.min(size, logLimit));
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    const text = stripVTControlCharacters(buffer.subarray(0, read).toString("utf8"));
    const entries = text.split("\n");
    const newline = entries.at(-1) === "";
    if (newline) entries.pop();
    return {
      logs: entries.slice(-lines).join("\n") + (newline && entries.length > 0 ? "\n" : ""),
      truncated: offset > 0 || entries.length > lines,
    };
  } finally {
    closeSync(fd);
  }
}

async function start(service: Service, id: string, logFile: string, current: Status): Promise<Status> {
  if (["active", "activating", "failed"].includes(current.state)) return current;
  if (current.state !== "inactive") throw new Error(`Service is ${current.state}; wait before starting it.`);
  ensureDirectory(join(homedir(), ".zapdev"));
  ensureDirectory(join(homedir(), ".zapdev", "services"));
  requireLogFile(logFile);
  closeSync(openSync(logFile, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600));
  const environment = Object.keys(process.env).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|NOTIFY_SOCKET|LISTEN_.*|WATCHDOG_.*)$/.test(name));
  try {
    await systemd("systemd-run", [
      "--quiet", `--unit=${id}`, "--service-type=exec", "--remain-after-exit",
      `--working-directory=${service.path}`, "--property=KillMode=control-group",
      "--property=KillSignal=SIGINT",
      "--property=TimeoutStopSec=30s", `--property=StandardOutput=append:${logFile}`,
      `--property=StandardError=append:${logFile}`,
      ...(service.stopCommand === undefined ? [] : [
        `--property=ExecStopPost=:/bin/sh -c ${JSON.stringify(service.stopCommand)}`,
      ]),
      ...environment.map(name => `--setenv=${name}`),
      "/bin/sh", "-c", service.startCommand.replaceAll("$", () => "$$"),
    ]);
  } catch (error) {
    const concurrent = await status(id);
    if (!["active", "activating", "failed"].includes(concurrent.state)) throw error;
    return concurrent;
  }
  return status(id);
}

/** Manage one isolated systemd user unit, preserving partial results and logs across MCP restarts. */
export async function runService(service: Service, action: "start" | "stop" | "logs", lines = 100): Promise<ServiceResult> {
  const hash = createHash("sha256").update(realpathSync(service.path)).update("\0").update(service.name).digest("hex").slice(0, 16);
  const id = `zapdev-${service.name}-${hash}.service`;
  const output: ServiceResult = { name: service.name, path: service.path, id };
  const directory = join(homedir(), ".zapdev", "services");
  const logFile = join(directory, `${id}.log`);
  try {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) throw new Error(`Expected a service log directory, not a symlink: ${directory}`);
    if (action === "logs") return { ...output, ...logs(logFile, lines) };
    let current = await status(id);
    if (action === "start") current = await start(service, id, logFile, current);
    else if (current.exists) {
      await systemd("systemctl", ["stop", id], 75_000);
      current = await status(id);
    }
    Object.assign(output, current);
    if (current.state === "failed" || current.result !== "success") {
      output.error = `Service ${service.name} failed (${current.result}); inspect server_logs and stop it before starting again.`;
    }
  } catch (error) {
    output.error = error instanceof Error ? error.message : String(error);
    if (action !== "logs") {
      const current = await status(id).catch(() => undefined);
      if (current) Object.assign(output, current);
    }
  }
  if (action === "stop") {
    try {
      Object.assign(output, logs(logFile, lines));
    } catch (error) {
      output.error ??= error instanceof Error ? error.message : String(error);
    }
  }
  return output;
}
