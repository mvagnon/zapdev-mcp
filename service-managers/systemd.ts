import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import type { Service, ServiceAction, ServiceResult } from "../service-manager.js";

const exec = promisify(execFile);
const logLimit = 65_536;
const maxRuntimeHours = 3;
const maxRuntimeSeconds = maxRuntimeHours * 60 * 60;
const stopTimeoutSeconds = 30;

type Status = {
  state: string; subState: string; result: string; exitCode: number; exists: boolean;
  mainPid?: number; controlPid?: number; tasks?: number; controlGroup?: string; maxRuntimeSeconds?: number;
};
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
    "show", "--all", "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID,ControlPID,TasksCurrent,ControlGroup,RuntimeMaxUSec", id,
  ]);
  const fields = Object.fromEntries(output.trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (!fields.LoadState || !fields.ActiveState) throw new Error(`Could not read systemd state for ${id}.`);
  const exists = fields.LoadState !== "not-found";
  const tasks = Number(fields.TasksCurrent);
  return {
    state: fields.ActiveState, subState: fields.SubState ?? "dead",
    result: fields.Result || "success", exitCode: Number(fields.ExecMainStatus || 0),
    exists,
    mainPid: exists ? (fields.MainPID === undefined ? undefined : Number(fields.MainPID)) : 0,
    controlPid: exists ? (fields.ControlPID === undefined ? undefined : Number(fields.ControlPID)) : 0,
    tasks: Number.isSafeInteger(tasks) && tasks >= 0 ? tasks : undefined,
    controlGroup: exists ? fields.ControlGroup : "",
    ...(exists && fields.RuntimeMaxUSec === `${maxRuntimeHours}h` && { maxRuntimeSeconds }),
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
      `--user-unit=${id}`, "--invocation=0", "--quiet", "--no-pager", "--output=short-iso-precise", `--lines=${lines + 1}`,
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
  if (["active", "activating"].includes(current.state)) throw new Error(`Service ${service.name} is already running (${current.state}).`);
  if (current.state === "failed") return current;
  if (current.state !== "inactive") throw new Error(`Service is ${current.state}; wait before starting it.`);
  const environment = Object.keys(process.env).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|NOTIFY_SOCKET|LISTEN_.*|WATCHDOG_.*)$/.test(name));
  await systemd("systemd-run", [
    "--quiet", `--unit=${id}`, "--service-type=exec", "--remain-after-exit",
    `--working-directory=${service.path}`, "--property=KillMode=control-group",
    "--property=KillSignal=SIGINT", "--property=SendSIGKILL=yes",
    `--property=TimeoutStopSec=${stopTimeoutSeconds}s`, "--property=StandardOutput=journal",
    "--property=StandardError=journal",
    `--property=RuntimeMaxSec=${maxRuntimeSeconds}`,
    `--property=ExecStartPost=systemd-run --user --quiet --collect --unit=${id.slice(0, -8)}-expiry ` +
      `--on-active=${maxRuntimeSeconds}s --timer-property=AccuracySec=1s --timer-property=RemainAfterElapse=no ` +
      `--timer-property=PartOf=${id} systemctl --user --no-block stop ${id}`,
    ...(service.stopCommand === undefined ? [] : [
      `--property=ExecStopPost=:/bin/sh -c ${JSON.stringify(service.stopCommand)}`,
    ]),
    ...environment.map(name => `--setenv=${name}`),
    "/bin/sh", "-c", service.startCommand.replaceAll("$", () => "$$"),
  ]);
  let observed = await status(id);
  const deadline = Date.now() + 1_000;
  while (["active", "activating"].includes(observed.state) && observed.subState !== "exited" && Date.now() < deadline) {
    await delay(100);
    observed = await status(id);
  }
  return observed;
}

async function stop(service: Service, id: string, current: Status): Promise<Status> {
  if (!current.exists) return current;
  await systemd("systemctl", ["stop", id], 75_000);
  let stopped = await status(id);
  if (stopped.exists && (!Number.isSafeInteger(stopped.mainPid) || !Number.isSafeInteger(stopped.controlPid) ||
    stopped.controlGroup === undefined || (stopped.controlGroup !== "" && stopped.tasks === undefined))) {
    throw new Error(`Could not verify stop for service ${service.name}: missing or invalid MainPID, ControlPID, TasksCurrent or ControlGroup.`);
  }
  if (!["inactive", "failed"].includes(stopped.state) || stopped.mainPid !== 0 || stopped.controlPid !== 0 ||
    (stopped.tasks ?? 0) > 0) {
    throw new Error(`Could not stop service ${service.name}: state=${stopped.state}, MainPID=${stopped.mainPid}, ControlPID=${stopped.controlPid}, TasksCurrent=${stopped.tasks ?? "unknown"}; processes may remain.`);
  }
  const failure = current.state !== "failed" && (stopped.state === "failed" || stopped.result !== "success")
    ? `Service ${service.name} stop failed (${stopped.result}); unit released, inspect server_logs for shutdown or stopCommand diagnostics.` : undefined;
  if (stopped.exists && stopped.state === "failed") await systemd("systemctl", ["reset-failed", id]);
  const deadline = Date.now() + 2_000;
  while (stopped.exists && Date.now() < deadline) {
    await delay(100);
    stopped = await status(id);
  }
  if (stopped.exists || stopped.state !== "inactive" || stopped.mainPid !== 0 || stopped.controlPid !== 0 || stopped.controlGroup !== "") {
    throw new Error(`Could not release systemd unit for service ${service.name} (${id}): state=${stopped.state}, MainPID=${stopped.mainPid}, ControlPID=${stopped.controlPid}, ControlGroup=${stopped.controlGroup ?? "unknown"}; stop is not verified and restart is not safe.`);
  }
  if (failure) throw new Error(failure);
  return stopped;
}

/** Manage one isolated systemd user unit with a native expiry timer and post-stop cleanup. */
export async function runSystemdService(service: Service, action: ServiceAction, lines: number): Promise<ServiceResult> {
  const hash = createHash("sha256").update(realpathSync(service.path)).update("\0").update(service.name).digest("hex").slice(0, 16);
  const id = `zapdev-${service.name}-${hash}.service`;
  const output: ServiceResult = { name: service.name, path: service.path, id };
  let current: Status | undefined;
  try {
    current = await status(id);
    if (action === "start") current = await start(service, id, current);
    else if (action === "stop") current = await stop(service, id, current);
  } catch (error) {
    current = await status(id).catch(() => undefined);
    if (action !== "logs" || !current) output.error = error instanceof Error ? error.message : String(error);
  }
  if (current) {
    Object.assign(output, current);
    if (current.state === "failed" || current.result !== "success") {
      output.error ??= `Service ${service.name} failed (${current.result}); inspect server_logs and stop it before starting again.`;
    }
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
