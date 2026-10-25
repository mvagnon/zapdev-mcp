import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("services return compact actions and scoped journal diagnostics", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-services-test-")));
  const root = join(directory, "repos");
  const group = join(root, "my-group");
  const first = join(group, "owner__first");
  const second = join(group, "owner__second");
  const standalone = join(root, "owner__first");
  const config = join(directory, ".zapdev", "config", "my-group");
  const parentConfig = join(config, "zapdev.json");
  const stateFile = join(directory, "units.json");
  const clients: Client[] = [];
  type Unit = {
    state: string; result: string; args: string[]; logs?: string; previousLogs?: string;
    unloaded?: boolean; journalError?: string; journalWarning?: string; exitCode?: number; statusFailures?: number;
    runCount?: number; stopError?: string; resetError?: string; retainUnit?: boolean;
    remainingPid?: number; remainingControlPid?: number; remainingTasks?: number; stopState?: string; missingPid?: boolean;
  };
  type Service = {
    id: string; name: string; path: string; state: string; exitCode?: number;
    error?: string; logs?: string; truncated?: boolean; maxRuntimeSeconds?: number;
  };
  const units = (): Record<string, Unit> => JSON.parse(readFileSync(stateFile, "utf8"));
  const timestamp = "2026-10-22T10:30:00.123456+0200";
  const logLine = (message: string): string => `${timestamp} host service[123]: ${message}\n`;
  const connect = async (cwd?: string): Promise<Client> => {
    const client = new Client({ name: "server-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), join(process.cwd(), "index.ts")],
      cwd,
      env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory, ZD_REPOS_DIR: root, TEST_UNITS: stateFile },
    }));
    return client;
  };
  try {
    writeFileSync(stateFile, "{}");
    writeFileSync(join(directory, "systemctl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = process.env.TEST_UNITS;
const units = JSON.parse(fs.readFileSync(file, "utf8"));
const id = args.at(-1);
const unit = units[id];
if (unit?.exitAt && Date.now() >= unit.exitAt && unit.state === "active") {
  unit.state = "failed";
  unit.result = "exit-code";
  unit.exitCode = 127;
  unit.logs = "expo: command not found\\n";
  fs.writeFileSync(file, JSON.stringify(units));
}
if (args.includes("show")) {
  if (unit?.statusFailures > 0) {
    unit.statusFailures--;
    fs.writeFileSync(file, JSON.stringify(units));
    console.log("LoadState=loaded");
    process.exit(0);
  }
  console.log("LoadState=" + (unit && !unit.unloaded ? "loaded" : "not-found"));
  console.log("ActiveState=" + (unit?.state ?? "inactive"));
  console.log("SubState=" + (unit?.state === "active" ? "running" : "dead"));
  console.log("Result=" + (unit?.result ?? "success"));
  console.log("ExecMainStatus=" + (unit?.exitCode ?? (unit?.result === "exit-code" ? 1 : 0)));
  const runtime = unit?.args.find(arg => arg.startsWith("--property=RuntimeMaxSec="))?.split("=").at(-1);
  console.log("RuntimeMaxUSec=" + (runtime ? Number(runtime) / 3600 + "h" : "infinity"));
  if (!unit?.missingPid) console.log("MainPID=" + (unit?.remainingPid ?? (unit?.state === "active" ? 123 : 0)));
  console.log("ControlPID=" + (unit?.remainingControlPid ?? 0));
  console.log("TasksCurrent=" + (unit?.remainingTasks ?? (unit?.state === "active" ? 2 : 0)));
  console.log("ControlGroup=" + (unit?.state === "active" || unit?.remainingTasks ? "/user.slice/" + id : ""));
  process.exit(unit && !unit.unloaded ? 0 : 4);
}
if (args.includes("stop") && unit) {
  if (unit.stopError) { console.error(unit.stopError); process.exit(1); }
  if (unit.state !== "failed") {
    unit.result = unit.args.some(arg => arg.includes("fail-stop")) ? "exit-code" : "success";
    unit.state = unit.stopState ?? (unit.result === "success" ? "inactive" : "failed");
  }
  unit.unloaded = unit.state === "inactive" && !unit.retainUnit && !unit.remainingPid && !unit.remainingControlPid && !unit.remainingTasks;
  fs.writeFileSync(file, JSON.stringify(units));
}
if (args.includes("reset-failed") && unit) {
  if (unit.resetError) { console.error(unit.resetError); process.exit(1); }
  unit.state = "inactive";
  unit.result = "success";
  unit.exitCode = 0;
  unit.unloaded = !unit.retainUnit && !unit.remainingPid && !unit.remainingControlPid && !unit.remainingTasks;
  fs.writeFileSync(file, JSON.stringify(units));
}
`, { mode: 0o755 });
    writeFileSync(join(directory, "systemd-run"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = process.env.TEST_UNITS;
const units = JSON.parse(fs.readFileSync(file, "utf8"));
const id = args.find(arg => arg.startsWith("--unit=")).slice(7);
if (units[id] && !units[id].unloaded) { console.error("Unit already exists"); process.exit(1); }
const failed = args.at(-1).includes("fail-start");
units[id] = { state: failed ? "failed" : "active", result: failed ? "exit-code" : "success", args, runCount: (units[id]?.runCount ?? 0) + 1 };
if (args.at(-1).includes("fail-later")) units[id].exitAt = Date.now() + 150;
if (failed) units[id].logs = "Backend startup failed\\n";
fs.writeFileSync(file, JSON.stringify(units));
if (failed) { console.error("Start failed"); process.exit(1); }
`, { mode: 0o755 });
    writeFileSync(join(directory, "journalctl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const units = JSON.parse(fs.readFileSync(process.env.TEST_UNITS, "utf8"));
if (args.includes("--user")) { console.error("No journal files were found."); process.exit(0); }
const id = args.find(arg => arg.startsWith("--user-unit="))?.slice(12);
if (!id) throw new Error("Missing user-unit scope");
const unit = units[id];
if (unit?.journalError) { console.error(unit.journalError); process.exit(1); }
if (unit?.journalWarning) console.error(unit.journalWarning);
const limit = Number(args.find(arg => arg.startsWith("--lines="))?.slice(8));
const previous = args.includes("--invocation=0") ? "" : (unit?.previousLogs ?? "");
const entries = (previous + (unit?.logs ?? "")).split("\\n");
if (entries.at(-1) === "") entries.pop();
const prefix = args.includes("--output=short-iso-precise") ? "${timestamp} host service[123]: " : "";
process.stdout.write(entries.slice(-limit).map(line => prefix + line).join("\\n") + (entries.length ? "\\n" : ""));
`, { mode: 0o755 });
    for (const path of [first, second, standalone]) {
      execFileSync("git", ["init", "--quiet", path]);
      writeFileSync(join(path, "AGENTS.md"), "Repository instructions");
      execFileSync("git", ["-C", path, "add", "AGENTS.md"]);
      execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial"]);
    }
    mkdirSync(join(group, "not-a-repository"));
    mkdirSync(join(config, "owner__first"), { recursive: true });
    mkdirSync(join(config, "owner__second"));
    mkdirSync(join(directory, ".zapdev", "config", "owner__first"));
    writeFileSync(join(directory, ".zapdev", "config", "owner__first", "zapdev.json"), JSON.stringify({
      services: { backend: { startCommand: "npm run standalone" } },
    }));
    writeFileSync(join(group, "AGENTS.md"), "Parent instructions");
    writeFileSync(parentConfig, JSON.stringify({
      frontUrl: "http://localhost:3000",
      services: { frontend: { startCommand: "printf 'hello $HOME %s\\n'", stopCommand: "printf 'stop $HOME'" } },
    }));
    for (const name of ["owner__first", "owner__second"]) {
      writeFileSync(join(config, name, "zapdev.json"), JSON.stringify({
        apiUrl: "http://localhost:4000",
        services: { backend: { startCommand: "npm run dev" } },
      }));
    }
    const client = await connect();
    const tools = await client.listTools();
    for (const name of ["list_services", "start_server", "stop_server", "server_logs"]) {
      const tool = tools.tools.find(tool => tool.name === name);
      assert.ok(tool, `${name}: tool must be registered`);
      assert.equal(tool.inputSchema.required?.includes("path") ?? false, false, `${name}: path must be optional`);
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(),
        name === "server_logs" ? ["lines", "path", "service"] : ["path", "service"]);
    }
    const listed = await client.callTool({ name: "list_services", arguments: { path: group } });
    assert.notEqual(listed.isError, true, JSON.stringify(listed.content));
    assert.deepEqual(listed.structuredContent, { path: group, services: [{ name: "frontend", path: group }] });
    assert.deepEqual(units(), {});
    assert.deepEqual(tools.tools.find(tool => tool.name === "list_services")?.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    const started = await client.callTool({ name: "start_server", arguments: { path: group } });
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
    assert.deepEqual(started.structuredContent, {
      path: group,
      services: [{ name: "frontend", path: group, state: "active", maxRuntimeSeconds: 10_800 }],
    });
    const details = await client.callTool({ name: "server_logs", arguments: { path: group } });
    assert.notEqual(details.isError, true, JSON.stringify(details.content));
    const output = details.structuredContent as { path: string; services: Service[] };
    assert.equal(new Set(output.services.map(({ id }) => id)).size, 1);
    const service = output.services[0]!;
    const args = units()[service.id]!.args;
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("--property=KillMode=control-group"));
    assert.ok(args.includes("--property=KillSignal=SIGINT"));
    assert.ok(args.includes("--property=SendSIGKILL=yes"));
    assert.ok(args.includes("--property=TimeoutStopSec=30s"));
    assert.ok(args.includes("--setenv=PATH"));
    assert.equal(args.at(-1), "printf 'hello $$HOME %s\\n'");
    assert.ok(args.includes(`--property=ExecStopPost=:/bin/sh -c ${JSON.stringify("printf 'stop $HOME'")}`));
    assert.ok(!args.some(arg => arg.startsWith("--property=ExecStop=")));
    assert.ok(args.includes("--property=StandardOutput=journal"));
    assert.ok(args.includes("--property=StandardError=journal"));
    assert.ok(args.includes(`--working-directory=${group}`));
    assert.ok(args.includes("--property=RuntimeMaxSec=10800"));
    assert.ok(args.includes(
      `--property=ExecStartPost=systemd-run --user --quiet --collect --unit=${service.id.slice(0, -8)}-expiry ` +
      `--on-active=10800s --timer-property=AccuracySec=1s --timer-property=RemainAfterElapse=no ` +
      `--timer-property=PartOf=${service.id} systemctl --user --no-block stop ${service.id}`,
    ));
    assert.equal(existsSync(join(directory, ".zapdev", "services")), false);

    const other = await connect();
    const repeated = await other.callTool({ name: "start_server", arguments: { path: group } });
    assert.notEqual(repeated.isError, true, JSON.stringify(repeated.content));
    assert.deepEqual(repeated.structuredContent, started.structuredContent);
    assert.deepEqual(units()[service.id]!.args, args);
    assert.equal(Object.keys(units()).length, 1);
    const legacy = units();
    legacy[service.id]!.args = args.filter(arg => !arg.startsWith("--property=RuntimeMaxSec=") &&
      !arg.startsWith("--property=ExecStartPost="));
    writeFileSync(stateFile, JSON.stringify(legacy));
    const reusedLegacy = await other.callTool({ name: "start_server", arguments: { path: group } });
    assert.deepEqual(reusedLegacy.structuredContent, {
      path: group, services: [{ name: "frontend", path: group, state: "active" }],
    });
    assert.deepEqual(units()[service.id]!.args, legacy[service.id]!.args);
    legacy[service.id]!.args = args;
    writeFileSync(stateFile, JSON.stringify(legacy));
    const groupClient = await connect(group);
    for (const input of [{}, { path: "" }]) {
      for (const name of ["list_services", "server_logs"]) {
        const response = await groupClient.callTool({ name, arguments: input });
        assert.notEqual(response.isError, true, JSON.stringify(response.content));
        assert.deepEqual((response.structuredContent?.services as Service[]).map(({ path }) => path), [group]);
      }
    }
    assert.equal((await client.callTool({
      name: "start_server", arguments: { path: first, service: "frontend" },
    })).isError, true);
    for (const expected of [first, standalone]) {
      const input = { path: expected };
      const started = await client.callTool({ name: "start_server", arguments: input });
      const selected = started.structuredContent?.services as Service[];
      assert.equal(selected.length, 1);
      assert.equal(selected[0]?.path, expected);
      for (const name of ["server_logs", "stop_server"]) {
        const response = await client.callTool({ name, arguments: input });
        assert.notEqual(response.isError, true, JSON.stringify(response.content));
        assert.deepEqual((response.structuredContent?.services as Service[]).map(({ path }) => path), [expected]);
      }
      assert.equal(units()[service.id]?.state, "active");
    }
    const workspace = join(directory, ".zapdev", "worktrees", "services-test");
    const prepared = await client.callTool({ name: "prepare_worktree", arguments: { path: group, branch: "services-test" } });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared.content));
    const workspaceFirst = join(workspace, "owner__first");
    const workspaceSecond = join(workspace, "owner__second");
    assert.deepEqual(prepared.structuredContent?.paths, [workspaceFirst, workspaceSecond]);
    for (const [path, name] of [[workspace, "frontend"], [workspaceFirst, "backend"]]) {
      const listed = await client.callTool({ name: "list_services", arguments: { path } });
      assert.notEqual(listed.isError, true, JSON.stringify(listed.content));
      assert.deepEqual(listed.structuredContent, { path, services: [{ name, path }] });
      const started = await client.callTool({ name: "start_server", arguments: { path } });
      assert.notEqual(started.isError, true, JSON.stringify(started.content));
      const details = await client.callTool({ name: "server_logs", arguments: { path } });
      const worktreeService = (details.structuredContent?.services as Service[])[0]!;
      assert.equal(worktreeService.path, path);
      assert.notEqual(worktreeService.id, service.id);
      assert.ok(units()[worktreeService.id]!.args.includes(`--working-directory=${path}`));
      assert.equal((await client.callTool({ name: "stop_server", arguments: { path } })).isError, undefined);
      assert.equal(units()[service.id]!.state, "active");
    }
    mkdirSync(join(workspaceFirst, "src"));
    const workspaceClient = await connect(join(workspaceFirst, "src"));
    const workspaceListed = await workspaceClient.callTool({ name: "list_services", arguments: {} });
    assert.deepEqual(workspaceListed.structuredContent, { path: workspaceFirst, services: [{ name: "backend", path: workspaceFirst }] });
    mkdirSync(join(first, "src"));
    const repositoryClient = await connect(join(first, "src"));
    const fromSubdirectory = await repositoryClient.callTool({ name: "start_server", arguments: {} });
    assert.notEqual(fromSubdirectory.isError, true, JSON.stringify(fromSubdirectory.content));
    assert.equal(fromSubdirectory.structuredContent?.path, first);
    assert.deepEqual((fromSubdirectory.structuredContent?.services as Service[]).map(({ path }) => path), [first]);
    assert.equal((await repositoryClient.callTool({ name: "stop_server", arguments: {} })).isError, undefined);
    await client.callTool({ name: "start_server", arguments: { path: first } });
    const childDetails = await client.callTool({ name: "server_logs", arguments: { path: first } });
    const child = (childDetails.structuredContent?.services as Service[])[0]!;
    assert.equal(child.state, "active");

    const journal = units();
    journal[service.id]!.previousLogs = "Previous invocation logs\n";
    journal[service.id]!.logs = "old\nfirst\nsecond\n";
    writeFileSync(stateFile, JSON.stringify(journal));
    const logs = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend", lines: 2 } });
    assert.notEqual(logs.isError, true, JSON.stringify(logs.content));
    assert.equal((logs.structuredContent?.services as Service[])[0]?.logs, logLine("first") + logLine("second"));
    assert.equal((logs.structuredContent?.services as Service[])[0]?.truncated, true);
    assert.equal((logs.structuredContent?.services as Service[])[0]?.state, "active");
    const latest = await other.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
    assert.equal((latest.structuredContent?.services as Service[])[0]?.logs, logLine("old") + logLine("first") + logLine("second"));
    for (const scenario of [
      { statusFailures: 1, state: "active", result: "success", expectedError: undefined },
      { statusFailures: 2, state: "active", result: "success", expectedError: /Could not read systemd state/ },
      { statusFailures: 1, state: "failed", result: "exit-code", expectedError: /Service frontend failed \(exit-code\)/ },
    ]) {
      const { expectedError, ...status } = scenario;
      Object.assign(journal[service.id]!, status);
      writeFileSync(stateFile, JSON.stringify(journal));
      const response = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
      const recovered = (response.structuredContent?.services as Service[])[0]!;
      assert.equal(response.isError, expectedError ? true : undefined, JSON.stringify(response.content));
      if (expectedError) assert.match(recovered.error ?? "", expectedError);
      else assert.equal(recovered.error, undefined);
      assert.equal(recovered.state, status.statusFailures === 2 ? undefined : status.state);
      assert.equal(recovered.logs, logLine("old") + logLine("first") + logLine("second"));
      assert.equal(units()[service.id]!.statusFailures, 0);
    }
    Object.assign(journal[service.id]!, { state: "active", result: "success", statusFailures: 0 });
    journal[service.id]!.logs = "x".repeat(500_000);
    writeFileSync(stateFile, JSON.stringify(journal));
    const bounded = await client.callTool({ name: "server_logs", arguments: { path: group } });
    assert.ok(Buffer.byteLength((bounded.structuredContent?.services as Service[])[0]!.logs!) <= 65_536);
    assert.equal((bounded.structuredContent?.services as Service[])[0]?.truncated, true);
    journal[service.id]!.logs = "Available service logs\n";
    journal[service.id]!.journalWarning = "Some archived journal files were ignored";
    writeFileSync(stateFile, JSON.stringify(journal));
    const warning = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
    assert.notEqual(warning.isError, true, JSON.stringify(warning.content));
    assert.equal((warning.structuredContent?.services as Service[])[0]?.logs, logLine("Available service logs"));
    delete journal[service.id]!.journalWarning;
    journal[service.id]!.journalError = "Permission denied reading journal";
    journal[service.id]!.statusFailures = 1;
    writeFileSync(stateFile, JSON.stringify(journal));
    const denied = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
    assert.equal(denied.isError, true);
    assert.match((denied.structuredContent?.services as Service[])[0]?.error ?? "", /Permission denied/);
    const stoppedWithoutJournal = await groupClient.callTool({ name: "stop_server", arguments: { service: "frontend" } });
    assert.deepEqual(stoppedWithoutJournal.structuredContent, { path: group, services: [{ name: "frontend", path: group, state: "inactive" }] });
    assert.notEqual(stoppedWithoutJournal.isError, true);
    assert.equal(units()[child.id]!.state, "active");
    Object.assign(journal, units());
    delete journal[service.id]!.journalError;
    journal[service.id]!.logs = "Stopped logs remain available\n";
    writeFileSync(stateFile, JSON.stringify(journal));
    const stoppedLogs = await groupClient.callTool({ name: "server_logs", arguments: { service: "frontend" } });
    assert.equal((stoppedLogs.structuredContent?.services as Service[])[0]?.state, "inactive");
    assert.equal((stoppedLogs.structuredContent?.services as Service[])[0]?.logs, logLine("Stopped logs remain available"));
    journal[service.id]!.unloaded = true;
    writeFileSync(stateFile, JSON.stringify(journal));
    const unloadedLogs = await other.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
    assert.notEqual(unloadedLogs.isError, true, JSON.stringify(unloadedLogs.content));
    assert.equal((unloadedLogs.structuredContent?.services as { exists: boolean }[])[0]?.exists, false);
    assert.equal((unloadedLogs.structuredContent?.services as Service[])[0]?.logs, logLine("Stopped logs remain available"));
    assert.notEqual((await client.callTool({ name: "stop_server", arguments: { path: group } })).isError, true);
    assert.equal((await client.callTool({ name: "server_logs", arguments: { path: group } })).isError, undefined);

    for (const config of [{}, { services: {} }, { frontUrl: "http://localhost:3000" }]) {
      writeFileSync(parentConfig, JSON.stringify(config));
      for (const name of ["list_services", "start_server", "stop_server", "server_logs"]) {
        const empty = await client.callTool({ name, arguments: { path: group } });
        assert.notEqual(empty.isError, true, JSON.stringify(empty.content));
        assert.deepEqual(empty.structuredContent, { path: group, services: [] });
        assert.equal(units()[child.id]!.state, "active");
        assert.equal((await client.callTool({ name, arguments: { path: group, service: "backend" } })).isError, true);
      }
    }
    rmSync(parentConfig);
    const beforeListing = units();
    const childrenListed = await client.callTool({ name: "list_services", arguments: { path: group, service: "backend" } });
    assert.notEqual(childrenListed.isError, true, JSON.stringify(childrenListed.content));
    assert.deepEqual(childrenListed.structuredContent, {
      path: group, services: [{ name: "backend", path: first }, { name: "backend", path: second }],
    });
    assert.deepEqual(units(), beforeListing);
    const worktreeChildren = await client.callTool({ name: "list_services", arguments: { path: workspace } });
    assert.deepEqual(worktreeChildren.structuredContent, {
      path: workspace, services: [{ name: "backend", path: workspaceFirst }, { name: "backend", path: workspaceSecond }],
    });
    for (const name of ["start_server", "server_logs", "stop_server"]) {
      const children = await client.callTool({ name, arguments: { path: group, service: "backend" } });
      assert.notEqual(children.isError, true, JSON.stringify(children.content));
      const childServices = children.structuredContent?.services as Service[];
      assert.deepEqual(childServices.map(({ path }) => path), [first, second]);
      assert.ok(childServices.every(({ state }) => state === (name === "stop_server" ? "inactive" : "active")));
    }

    writeFileSync(parentConfig, JSON.stringify({ services: {
      good: { startCommand: "npm run dev" },
      bad: { startCommand: "fail-start" },
      late: { startCommand: "fail-later" },
      cleanup: { startCommand: "npm run worker", stopCommand: "fail-stop" },
    } }));
    const partial = await client.callTool({ name: "start_server", arguments: { path: group } });
    assert.equal(partial.isError, true);
    const partialServices = partial.structuredContent?.services as Service[];
    assert.equal(partialServices.find(({ name }) => name === "good")?.state, "active");
    assert.match(partialServices.find(({ name }) => name === "bad")?.error ?? "", /Start failed/);
    assert.equal(partialServices.find(({ name }) => name === "late")?.state, "failed");
    assert.ok(partialServices.every(service => Object.keys(service).every(key => ["name", "path", "state", "error", "maxRuntimeSeconds"].includes(key))));
    const late = await client.callTool({ name: "server_logs", arguments: { path: group, service: "late" } });
    assert.equal((late.structuredContent?.services as Service[])[0]?.exitCode, 127);
    assert.match((late.structuredContent?.services as Service[])[0]?.logs ?? "", /expo: command not found/);
    const good = await client.callTool({ name: "server_logs", arguments: { path: group, service: "good" } });
    const running = (good.structuredContent?.services as Service[])[0]!;
    const runtimeFailure = units();
    Object.assign(runtimeFailure[running.id]!, { state: "failed", result: "exit-code", exitCode: 1, logs: "Backend runtime failure\n" });
    writeFileSync(stateFile, JSON.stringify(runtimeFailure));
    const failedLogs = await client.callTool({ name: "server_logs", arguments: { path: group, service: "good" } });
    assert.equal(failedLogs.isError, true);
    assert.equal((failedLogs.structuredContent?.services as Service[])[0]?.state, "failed");
    assert.equal((failedLogs.structuredContent?.services as Service[])[0]?.exitCode, 1);
    assert.equal((failedLogs.structuredContent?.services as Service[])[0]?.logs, logLine("Backend runtime failure"));
    const stoppedFailure = await client.callTool({ name: "stop_server", arguments: { path: group, service: "good" } });
    assert.notEqual(stoppedFailure.isError, true, JSON.stringify(stoppedFailure.content));
    assert.deepEqual(stoppedFailure.structuredContent, { path: group, services: [{ name: "good", path: group, state: "inactive" }] });
    assert.equal(units()[running.id]!.unloaded, true);
    const stoppedFailureLogs = await client.callTool({ name: "server_logs", arguments: { path: group, service: "good" } });
    assert.equal((stoppedFailureLogs.structuredContent?.services as Service[])[0]?.logs, logLine("Backend runtime failure"));
    const restarted = await client.callTool({ name: "start_server", arguments: { path: group, service: "good" } });
    assert.notEqual(restarted.isError, true, JSON.stringify(restarted.content));
    assert.equal((restarted.structuredContent?.services as Service[])[0]?.state, "active");
    assert.equal(units()[running.id]!.runCount, 2);
    const freshLogs = await client.callTool({ name: "server_logs", arguments: { path: group, service: "good" } });
    assert.doesNotMatch((freshLogs.structuredContent?.services as Service[])[0]?.logs ?? "", /Backend runtime failure/);
    const healthy = units()[running.id]!;
    for (const scenario of [
      { overrides: { stopState: "active" }, error: /Could not stop service good.*active/ },
      { overrides: { remainingPid: 456 }, error: /Could not stop service good.*MainPID=456/ },
      { overrides: { remainingControlPid: 789 }, error: /Could not stop service good.*ControlPID=789/ },
      { overrides: { remainingTasks: 1 }, error: /Could not stop service good.*TasksCurrent=1/ },
      { overrides: { retainUnit: true, missingPid: true }, error: /Could not verify.*MainPID/ },
      { overrides: { state: "failed", result: "exit-code", resetError: "Reset denied" }, error: /Reset denied/ },
      { overrides: { retainUnit: true }, error: /Could not release.*good/ },
      { overrides: { state: "failed", result: "exit-code", retainUnit: true }, error: /Could not release.*good/ },
      { overrides: { stopError: "Stop denied" }, error: /Stop denied/ },
    ]) {
      const state = units();
      state[running.id] = { ...healthy, ...scenario.overrides };
      writeFileSync(stateFile, JSON.stringify(state));
      const response = await client.callTool({ name: "stop_server", arguments: { path: group, service: "good" } });
      assert.equal(response.isError, true, JSON.stringify(response.content));
      assert.match((response.structuredContent?.services as Service[])[0]?.error ?? "", scenario.error);
    }
    const state = units();
    state[running.id] = healthy;
    writeFileSync(stateFile, JSON.stringify(state));
    const failedStop = await client.callTool({ name: "stop_server", arguments: { path: group, service: "cleanup" } });
    assert.equal(failedStop.isError, true);
    assert.equal((failedStop.structuredContent?.services as Service[])[0]?.state, "inactive");
    assert.match((failedStop.structuredContent?.services as Service[])[0]?.error ?? "", /stop failed.*exit-code/);
    const cleanup = Object.values(units()).find(unit => unit.args.some(arg => arg.includes("fail-stop")))!;
    assert.equal(cleanup.unloaded, true);

    for (const services of [[], { "../bad": { startCommand: "echo bad" } }, { api: { startCommand: " " } },
      { api: { startCommand: "echo ok", stopCommand: " " } }]) {
      writeFileSync(parentConfig, JSON.stringify({ services }));
      assert.equal((await client.callTool({ name: "start_server", arguments: { path: group } })).isError, true);
    }
    writeFileSync(parentConfig, "{}");
    for (const name of ["list_services", "start_server", "stop_server", "server_logs"]) {
      for (const input of [{ path: group, repo: "owner/first" }, { path: group, group: "my-group" },
        { path: group, service: "missing" }, { path: "relative" }, { path: directory }]) {
        assert.equal((await client.callTool({ name, arguments: input })).isError, true);
      }
    }
    for (const lines of [0, -1, 1.5, 1001]) {
      assert.equal((await client.callTool({ name: "server_logs", arguments: { path: group, lines } })).isError, true);
    }
    writeFileSync(parentConfig, "invalid JSON");
    assert.equal((await client.callTool({ name: "start_server", arguments: { path: group } })).isError, true);
    rmSync(parentConfig);
    symlinkSync(join(group, "AGENTS.md"), parentConfig);
    assert.equal((await client.callTool({ name: "start_server", arguments: { path: group } })).isError, true);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    rmSync(directory, { recursive: true, force: true });
  }
});
