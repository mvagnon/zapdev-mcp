import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("named services preserve parent context and support start, stop, and bounded logs", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-services-test-")));
  const root = join(directory, "repos");
  const group = join(root, "my-group");
  const first = join(group, "owner-first");
  const second = join(group, "owner-second");
  const standalone = join(root, "owner-first");
  const config = join(directory, ".zapdev", "config", "my-group");
  const parentConfig = join(config, "zapdev.json");
  const stateFile = join(directory, "units.json");
  const clients: Client[] = [];
  type Unit = { state: string; result: string; args: string[]; logs?: string; journalError?: string; exitCode?: number };
  type Service = {
    id: string; name: string; path: string; state: string; exitCode?: number;
    error?: string; logs?: string; truncated?: boolean; logSource?: string;
  };
  const units = (): Record<string, Unit> => JSON.parse(readFileSync(stateFile, "utf8"));
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
  console.log("LoadState=" + (unit ? "loaded" : "not-found"));
  console.log("ActiveState=" + (unit?.state ?? "inactive"));
  console.log("SubState=" + (unit?.state === "active" ? "running" : "dead"));
  console.log("Result=" + (unit?.result ?? "success"));
  console.log("ExecMainStatus=" + (unit?.exitCode ?? (unit?.result === "exit-code" ? 1 : 0)));
  console.log("StandardOutput=" + (unit?.args.find(arg => arg.startsWith("--property=StandardOutput="))?.slice(26).split(":")[0] ?? "journal"));
  process.exit(unit ? 0 : 4);
}
if (args.includes("stop") && unit) {
  unit.result = unit.args.some(arg => arg.includes("fail-stop")) ? "exit-code" : "success";
  unit.state = unit.result === "success" ? "inactive" : "failed";
  fs.writeFileSync(file, JSON.stringify(units));
}
`, { mode: 0o755 });
    writeFileSync(join(directory, "systemd-run"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = process.env.TEST_UNITS;
const units = JSON.parse(fs.readFileSync(file, "utf8"));
const id = args.find(arg => arg.startsWith("--unit=")).slice(7);
if (units[id]?.state === "active") process.exit(1);
const failed = args.at(-1).includes("fail-start");
units[id] = { state: failed ? "failed" : "active", result: failed ? "exit-code" : "success", args };
if (args.at(-1).includes("fail-later")) units[id].exitAt = Date.now() + 150;
if (failed) units[id].logs = "Backend startup failed\\n";
fs.writeFileSync(file, JSON.stringify(units));
if (failed) { console.error("Start failed"); process.exit(1); }
`, { mode: 0o755 });
    writeFileSync(join(directory, "journalctl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const units = JSON.parse(fs.readFileSync(process.env.TEST_UNITS, "utf8"));
const id = args.find(arg => arg.startsWith("--unit="))?.slice(7);
const unit = units[id];
if (unit?.journalError) { console.error(unit.journalError); process.exit(0); }
const limit = Number(args.find(arg => arg.startsWith("--lines="))?.slice(8));
const entries = (unit?.logs ?? "").split("\\n");
if (entries.at(-1) === "") entries.pop();
process.stdout.write(entries.slice(-limit).join("\\n") + (entries.length ? "\\n" : ""));
`, { mode: 0o755 });
    for (const path of [first, second, standalone]) {
      execFileSync("git", ["init", "--quiet", path]);
      writeFileSync(join(path, "AGENTS.md"), "Repository instructions");
    }
    mkdirSync(join(group, "not-a-repository"));
    mkdirSync(join(config, "owner-first"), { recursive: true });
    mkdirSync(join(config, "owner-second"));
    mkdirSync(join(directory, ".zapdev", "config", "owner-first"));
    writeFileSync(join(directory, ".zapdev", "config", "owner-first", "zapdev.json"), JSON.stringify({
      services: { backend: { startCommand: "npm run standalone" } },
    }));
    writeFileSync(join(group, "AGENTS.md"), "Parent instructions");
    writeFileSync(parentConfig, JSON.stringify({
      frontUrl: "http://localhost:3000",
      services: { frontend: { startCommand: "printf 'hello $HOME %s\\n'", stopCommand: "printf 'stop $HOME'" } },
    }));
    for (const name of ["owner-first", "owner-second"]) {
      writeFileSync(join(config, name, "zapdev.json"), JSON.stringify({
        apiUrl: "http://localhost:4000",
        services: { backend: { startCommand: "npm run dev" } },
      }));
    }
    const client = await connect();
    const tools = await client.listTools();
    for (const name of ["prepare_repo", "start_server", "stop_server", "server_logs"]) {
      const tool = tools.tools.find(tool => tool.name === name)!;
      assert.equal(tool.inputSchema.required?.includes("path") ?? false, false, `${name}: path must be optional`);
      if (name === "prepare_repo") {
        assert.equal(tool.inputSchema.required?.includes("repo") ?? false, false, "prepare_repo: repo must be optional");
        assert.equal(tool.inputSchema.required?.includes("group") ?? false, false, "prepare_repo: group must be optional");
      } else {
        assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(),
          name === "server_logs" ? ["lines", "path", "service"] : ["path", "service"]);
      }
    }
    const started = await client.callTool({ name: "start_server", arguments: { path: group } });
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
    const output = started.structuredContent as {
      path: string; agents_md: string; frontUrl: string;
      repositories: Array<{ path: string; agents_md: string; frontUrl: string; apiUrl: string }>;
      services: Service[];
    };
    assert.equal(output.path, group);
    assert.equal(output.agents_md, "Parent instructions");
    assert.equal(output.frontUrl, "http://localhost:3000");
    assert.deepEqual(output.repositories, [first, second].map(path => ({
      path, agents_md: "Repository instructions", frontUrl: "http://localhost:3000", apiUrl: "http://localhost:4000",
    })));
    assert.ok(Array.isArray(output.services), "Expected named service results instead of PIDs");
    assert.equal(output.services.length, 3);
    assert.deepEqual(output.services.map(({ path }) => path), [group, first, second]);
    const service = output.services[0]!;
    assert.equal(service.name, "frontend");
    assert.equal(service.path, group);
    assert.equal(service.state, "active");
    const args = units()[service.id]!.args;
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("--property=KillMode=control-group"));
    assert.ok(args.includes("--property=KillSignal=SIGINT"));
    assert.ok(args.includes("--property=TimeoutStopSec=30s"));
    assert.ok(args.includes("--setenv=PATH"));
    assert.equal(args.at(-1), "printf 'hello $$HOME %s\\n'");
    assert.ok(args.includes(`--property=ExecStopPost=:/bin/sh -c ${JSON.stringify("printf 'stop $HOME'")}`));
    assert.ok(!args.some(arg => arg.startsWith("--property=ExecStop=")));
    assert.ok(args.includes("--property=StandardOutput=journal"));
    assert.ok(args.includes("--property=StandardError=journal"));
    assert.equal(service.logSource, "journal");
    const logPath = join(directory, ".zapdev", "services", `${service.id}.log`);
    assert.equal(existsSync(logPath), false);

    const other = await connect();
    const repeated = await other.callTool({ name: "start_server", arguments: { path: group } });
    assert.notEqual(repeated.isError, true, JSON.stringify(repeated.content));
    assert.deepEqual(units()[service.id]!.args, args);
    assert.equal(Object.keys(units()).length, 3);
    const groupClient = await connect(group);
    for (const name of ["start_server", "server_logs"]) {
      for (const input of [{}, { path: "" }, { path: group }]) {
        const response = await groupClient.callTool({ name, arguments: input });
        assert.notEqual(response.isError, true, JSON.stringify(response.content));
        assert.equal(response.structuredContent?.path, group);
        assert.deepEqual((response.structuredContent?.services as Service[]).map(({ path }) => path), [group, first, second]);
      }
    }
    const single = await client.callTool({
      name: "start_server", arguments: { path: first },
    });
    assert.deepEqual(single.structuredContent?.parent, { path: group, agents_md: "Parent instructions", frontUrl: "http://localhost:3000" });
    assert.deepEqual((single.structuredContent?.services as Service[]).map(({ path }) => path), [first]);
    assert.equal((single.structuredContent?.services as Service[])[0]?.id, output.services[1]?.id);
    assert.equal((await client.callTool({
      name: "start_server", arguments: { path: first, service: "frontend" },
    })).isError, true);
    for (const { input, expected } of [
      { input: { path: first }, expected: first },
      { input: { path: standalone }, expected: standalone },
    ]) {
      const started = await client.callTool({ name: "start_server", arguments: input });
      const selected = started.structuredContent?.services as Service[];
      assert.equal(selected.length, 1);
      assert.equal(selected[0]?.path, expected);
      assert.notEqual(selected[0]?.id, service.id);
      for (const name of ["server_logs", "stop_server"]) {
        const response = await client.callTool({ name, arguments: input });
        assert.notEqual(response.isError, true, JSON.stringify(response.content));
        assert.deepEqual((response.structuredContent?.services as Service[]).map(({ id }) => id), [selected[0]?.id]);
      }
      assert.equal(units()[service.id]?.state, "active");
      assert.equal(units()[output.services[2]!.id]?.state, "active");
    }
    mkdirSync(join(first, "src"));
    const repositoryClient = await connect(join(first, "src"));
    const fromSubdirectory = await repositoryClient.callTool({ name: "start_server", arguments: {} });
    assert.notEqual(fromSubdirectory.isError, true, JSON.stringify(fromSubdirectory.content));
    assert.equal(fromSubdirectory.structuredContent?.path, first);
    assert.deepEqual((fromSubdirectory.structuredContent?.services as Service[]).map(({ path }) => path), [first]);
    assert.equal((await repositoryClient.callTool({ name: "stop_server", arguments: {} })).isError, undefined);

    const journal = units();
    journal[service.id]!.logs = "old\nfirst\nsecond\n";
    writeFileSync(stateFile, JSON.stringify(journal));
    const logs = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend", lines: 2 } });
    assert.notEqual(logs.isError, true, JSON.stringify(logs.content));
    assert.equal((logs.structuredContent?.services as Service[])[0]?.logs, "first\nsecond\n");
    assert.equal((logs.structuredContent?.services as Service[])[0]?.truncated, true);
    assert.equal((logs.structuredContent?.services as Service[])[0]?.state, "active");
    journal[service.id]!.logs = "x".repeat(500_000);
    writeFileSync(stateFile, JSON.stringify(journal));
    const bounded = await client.callTool({ name: "server_logs", arguments: { path: group } });
    assert.ok(Buffer.byteLength((bounded.structuredContent?.services as Service[])[0]!.logs!) <= 65_536);
    assert.equal((bounded.structuredContent?.services as Service[])[0]?.truncated, true);
    journal[service.id]!.journalError = "Permission denied reading journal";
    writeFileSync(stateFile, JSON.stringify(journal));
    const denied = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
    assert.equal(denied.isError, true);
    assert.match((denied.structuredContent?.services as Service[])[0]?.error ?? "", /Permission denied/);
    delete journal[service.id]!.journalError;
    journal[service.id]!.logs = "";
    journal[service.id]!.args = args.map(arg => arg === "--property=StandardOutput=journal" ? `--property=StandardOutput=append:${logPath}` : arg);
    writeFileSync(stateFile, JSON.stringify(journal));
    mkdirSync(join(directory, ".zapdev", "services"), { recursive: true });
    writeFileSync(logPath, "Legacy logs remain available\n");
    const legacy = await client.callTool({ name: "server_logs", arguments: { path: group, service: "frontend" } });
    assert.notEqual(legacy.isError, true, JSON.stringify(legacy.content));
    assert.equal((legacy.structuredContent?.services as Service[])[0]?.logs, "Legacy logs remain available\n");
    assert.equal((legacy.structuredContent?.services as Service[])[0]?.logSource, "file");
    rmSync(logPath);
    symlinkSync(join(group, "AGENTS.md"), logPath);
    assert.equal((await client.callTool({ name: "server_logs", arguments: { path: group } })).isError, true);
    rmSync(logPath);
    writeFileSync(logPath, "Stopped logs remain available\n");
    const stopped = await groupClient.callTool({ name: "stop_server", arguments: { service: "frontend" } });
    assert.notEqual(stopped.isError, true, JSON.stringify(stopped.content));
    assert.equal((stopped.structuredContent?.services as Service[])[0]?.state, "inactive");
    assert.equal((stopped.structuredContent?.services as Service[])[0]?.logs, "Stopped logs remain available\n");
    assert.notEqual((await client.callTool({ name: "stop_server", arguments: { path: group } })).isError, true);
    assert.equal((await client.callTool({ name: "server_logs", arguments: { path: group } })).isError, undefined);

    writeFileSync(parentConfig, "{}");
    const children = await client.callTool({ name: "start_server", arguments: { path: group, service: "backend" } });
    assert.notEqual(children.isError, true, JSON.stringify(children.content));
    const childServices = children.structuredContent?.services as Service[];
    assert.deepEqual(childServices.map(({ path }) => path), [first, second]);
    assert.equal(new Set(childServices.map(({ id }) => id)).size, 2);
    assert.ok(childServices.every(({ id }) => units()[id]!.args.includes("--property=KillSignal=SIGINT")));
    assert.ok(childServices.every(({ id }) => !units()[id]!.args.some(arg => arg.startsWith("--property=ExecStop"))));
    writeFileSync(parentConfig, JSON.stringify({ services: {} }));
    const empty = await client.callTool({ name: "start_server", arguments: { path: group } });
    assert.deepEqual((empty.structuredContent?.services as Service[]).map(({ path }) => path), [first, second]);

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
    assert.match(partialServices.find(({ name }) => name === "bad")?.error ?? "", /failed/i);
    assert.match(partialServices.find(({ name }) => name === "bad")?.error ?? "", /Start failed/);
    assert.equal(partialServices.find(({ name }) => name === "bad")?.logs, "Backend startup failed\n");
    assert.equal(partialServices.find(({ name }) => name === "late")?.state, "failed");
    assert.equal(partialServices.find(({ name }) => name === "late")?.exitCode, 127);
    assert.match(partialServices.find(({ name }) => name === "late")?.logs ?? "", /expo: command not found/);
    const running = partialServices.find(({ name }) => name === "good")!;
    const runtimeFailure = units();
    Object.assign(runtimeFailure[running.id]!, { state: "failed", result: "exit-code", exitCode: 1, logs: "Backend runtime failure\n" });
    writeFileSync(stateFile, JSON.stringify(runtimeFailure));
    const failedLogs = await client.callTool({ name: "server_logs", arguments: { path: group, service: "good" } });
    assert.equal(failedLogs.isError, true);
    assert.equal((failedLogs.structuredContent?.services as Service[])[0]?.state, "failed");
    assert.equal((failedLogs.structuredContent?.services as Service[])[0]?.exitCode, 1);
    assert.equal((failedLogs.structuredContent?.services as Service[])[0]?.logs, "Backend runtime failure\n");
    const failedStop = await client.callTool({ name: "stop_server", arguments: { path: group, service: "cleanup" } });
    assert.equal(failedStop.isError, true);
    assert.equal((failedStop.structuredContent?.services as Service[])[0]?.state, "failed");

    for (const services of [[], { "../bad": { startCommand: "echo bad" } }, { api: { startCommand: " " } },
      { api: { startCommand: "echo ok", stopCommand: " " } }, { api: { startCommand: ["echo legacy"] } }]) {
      writeFileSync(parentConfig, JSON.stringify({ services }));
      assert.equal((await client.callTool({ name: "start_server", arguments: { path: group } })).isError, true);
    }
    writeFileSync(parentConfig, JSON.stringify({ startCommand: ["echo legacy"] }));
    assert.equal((await client.callTool({ name: "start_server", arguments: { path: group } })).isError, true);
    writeFileSync(parentConfig, "{}");
    for (const name of ["start_server", "stop_server", "server_logs"]) {
      for (const input of [{}, { path: group, repo: "", group: "" }, { path: group, repo: "owner/first" },
        { path: group, group: "my-group" }, { path: join(group, "owner-missing") }, { path: group, service: "missing" },
        { path: group, branch: "main" }, { path: "relative" }, { path: directory }]) {
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
