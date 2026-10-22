import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";

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
type Logs = { logs: string; truncated: boolean; error?: string };

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

function tailLogs(buffer: Buffer, lines: number, truncated = false): Logs {
  let offset = Math.max(0, buffer.length - logLimit);
  while (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) offset++;
  const text = stripVTControlCharacters(buffer.subarray(offset).toString("utf8"));
  const entries = text.split("\n");
  const newline = entries.at(-1) === "";
  if (newline) entries.pop();
  return {
    logs: entries.slice(-lines).join("\n") + (newline && entries.length > 0 ? "\n" : ""),
    truncated: truncated || offset > 0 || entries.length > lines,
  };
}

async function journalLogs(id: string, lines: number): Promise<Logs> {
  return new Promise(resolve => {
    const child = spawn("journalctl", [
      `--user-unit=${id}`, "--quiet", "--no-pager", "--output=cat", `--lines=${lines + 1}`,
    ], { timeout: 15_000, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C", SYSTEMD_COLORS: "0", SYSTEMD_URLIFY: "0" } });
    let buffer = Buffer.alloc(0);
    let truncated = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const combined = Buffer.concat([buffer, chunk]);
      truncated ||= combined.length > logLimit;
      buffer = combined.subarray(Math.max(0, combined.length - logLimit));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
    child.once("error", error => resolve({ logs: "", truncated: false, error: `Could not read service journal: ${error.message}` }));
    child.once("close", (code, signal) => {
      const output = tailLogs(buffer, lines, truncated);
      const error = code !== 0 ? stderr.trim() || `journalctl failed (${signal ?? code}).` : undefined;
      resolve({ ...output, ...(error && { error: `Could not read service journal: ${error}` }) });
    });
  });
}

async function start(service: Service, id: string, current: Status): Promise<Status> {
  if (["active", "activating", "failed"].includes(current.state)) return current;
  if (current.state !== "inactive") throw new Error(`Service is ${current.state}; wait before starting it.`);
  const environment = Object.keys(process.env).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|NOTIFY_SOCKET|LISTEN_.*|WATCHDOG_.*)$/.test(name));
  try {
    await systemd("systemd-run", [
      "--quiet", `--unit=${id}`, "--service-type=exec", "--remain-after-exit",
      `--working-directory=${service.path}`, "--property=KillMode=control-group",
      "--property=KillSignal=SIGINT",
      "--property=TimeoutStopSec=30s", "--property=StandardOutput=journal",
      "--property=StandardError=journal",
      ...(service.stopCommand === undefined ? [] : [
        `--property=ExecStopPost=:/bin/sh -c ${JSON.stringify(service.stopCommand)}`,
      ]),
      ...environment.map(name => `--setenv=${name}`),
      "/bin/sh", "-c", service.startCommand.replaceAll("$", () => "$$"),
    ]);
  } catch (error) {
    const concurrent = await status(id);
    if (!["active", "activating"].includes(concurrent.state)) throw error;
    return concurrent;
  }
  let observed = await status(id);
  const deadline = Date.now() + 1_000;
  while (["active", "activating"].includes(observed.state) && observed.subState !== "exited" && Date.now() < deadline) {
    await delay(100);
    observed = await status(id);
  }
  return observed;
}

/** Manage one isolated systemd user unit, preserving partial results and logs across MCP restarts. */
export async function runService(service: Service, action: "start" | "stop" | "logs", lines = 100): Promise<ServiceResult> {
  const hash = createHash("sha256").update(realpathSync(service.path)).update("\0").update(service.name).digest("hex").slice(0, 16);
  const id = `zapdev-${service.name}-${hash}.service`;
  const output: ServiceResult = { name: service.name, path: service.path, id };
  try {
    let current = await status(id);
    if (action === "start") current = await start(service, id, current);
    else if (action === "stop" && current.exists) {
      await systemd("systemctl", ["stop", id], 75_000);
      current = await status(id);
    }
    Object.assign(output, current);
    if (current.state === "failed" || current.result !== "success") {
      output.error = `Service ${service.name} failed (${current.result}); inspect server_logs and stop it before starting again.`;
    }
  } catch (error) {
    output.error = error instanceof Error ? error.message : String(error);
    const current = await status(id).catch(() => undefined);
    if (current) Object.assign(output, current);
  }
  if (action === "logs") {
    try {
      const { error, ...logs } = await journalLogs(id, lines);
      Object.assign(output, logs);
      if (error) output.error = [output.error, error].filter(Boolean).join("\n");
    } catch (error) {
      output.error = [output.error, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n");
    }
  }
  return output;
}
