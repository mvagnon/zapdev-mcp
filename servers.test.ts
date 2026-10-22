import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const config = join(directory, ".zapdev", "config", "my-group");
  const parentConfig = join(config, "zapdev.json");
  const stateFile = join(directory, "units.json");
  const clients: Client[] = [];
  type Unit = { state: string; result: string; args: string[] };
  type Service = { id: string; name: string; path: string; state: string; error?: string; logs?: string; truncated?: boolean };
  const units = (): Record<string, Unit> => JSON.parse(readFileSync(stateFile, "utf8"));
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: "server-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts"],
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
if (args.includes("show")) {
  console.log("LoadState=" + (unit ? "loaded" : "not-found"));
  console.log("ActiveState=" + (unit?.state ?? "inactive"));
  console.log("SubState=" + (unit?.state === "active" ? "running" : "dead"));
  console.log("Result=" + (unit?.result ?? "success"));
  console.log("ExecMainStatus=" + (unit?.result === "exit-code" ? 1 : 0));
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
fs.writeFileSync(file, JSON.stringify(units));
if (failed) { console.error("Start failed"); process.exit(1); }
`, { mode: 0o755 });
    for (const path of [first, second]) {
      execFileSync("git", ["init", "--quiet", path]);
      writeFileSync(join(path, "AGENTS.md"), "Repository instructions");
    }
    mkdirSync(join(group, "not-a-repository"));
    mkdirSync(join(config, "owner-first"), { recursive: true });
    mkdirSync(join(config, "owner-second"));
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
    const started = await client.callTool({ name: "start_server", arguments: { group: "my-group" } });
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
    assert.equal(output.services.length, 1);
    const service = output.services[0]!;
    assert.equal(service.name, "frontend");
    assert.equal(service.path, group);
    assert.equal(service.state, "active");
    const args = units()[service.id]!.args;
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("--property=KillMode=control-group"));
    assert.ok(args.includes("--property=TimeoutStopSec=30s"));
    assert.ok(args.includes("--setenv=PATH"));
    assert.equal(args.at(-1), "printf 'hello $$HOME %s\\n'");
    assert.ok(args.includes(`--property=ExecStop=:/bin/sh -c ${JSON.stringify("printf 'stop $HOME'")}`));
    const logArg = args.find(arg => arg.startsWith("--property=StandardOutput=append:"))!;
    const logPath = logArg.slice("--property=StandardOutput=append:".length);
    assert.ok(logPath.startsWith(join(directory, ".zapdev", "services")));

    const other = await connect();
    const repeated = await other.callTool({ name: "start_server", arguments: { group: "my-group" } });
    assert.notEqual(repeated.isError, true, JSON.stringify(repeated.content));
    assert.deepEqual(units()[service.id]!.args, args);
    assert.equal(Object.keys(units()).length, 1);
    const single = await client.callTool({
      name: "start_server", arguments: { repo: "owner/first", group: "my-group" },
    });
    assert.deepEqual(single.structuredContent?.parent, { path: group, agents_md: "Parent instructions", frontUrl: "http://localhost:3000" });
    assert.equal((single.structuredContent?.services as Service[])[0]?.id, service.id);

    writeFileSync(logPath, "old\nfirst\nsecond\n");
    const logs = await client.callTool({ name: "server_logs", arguments: { group: "my-group", service: "frontend", lines: 2 } });
    assert.notEqual(logs.isError, true, JSON.stringify(logs.content));
    assert.equal((logs.structuredContent?.services as Service[])[0]?.logs, "first\nsecond\n");
    assert.equal((logs.structuredContent?.services as Service[])[0]?.truncated, true);
    writeFileSync(logPath, "x".repeat(200_000));
    const bounded = await client.callTool({ name: "server_logs", arguments: { group: "my-group" } });
    assert.ok(Buffer.byteLength((bounded.structuredContent?.services as Service[])[0]!.logs!) <= 65_536);
    assert.equal((bounded.structuredContent?.services as Service[])[0]?.truncated, true);
    rmSync(logPath);
    symlinkSync(join(group, "AGENTS.md"), logPath);
    assert.equal((await client.callTool({ name: "server_logs", arguments: { group: "my-group" } })).isError, true);
    rmSync(logPath);
    writeFileSync(logPath, "Stopped logs remain available\n");
    const stopped = await other.callTool({ name: "stop_server", arguments: { group: "my-group", service: "frontend" } });
    assert.notEqual(stopped.isError, true, JSON.stringify(stopped.content));
    assert.equal((stopped.structuredContent?.services as Service[])[0]?.state, "inactive");
    assert.notEqual((await client.callTool({ name: "stop_server", arguments: { group: "my-group" } })).isError, true);
    assert.equal((await client.callTool({ name: "server_logs", arguments: { group: "my-group" } })).isError, undefined);

    writeFileSync(parentConfig, "{}");
    const children = await client.callTool({ name: "start_server", arguments: { group: "my-group", service: "backend" } });
    assert.notEqual(children.isError, true, JSON.stringify(children.content));
    const childServices = children.structuredContent?.services as Service[];
    assert.deepEqual(childServices.map(({ path }) => path), [first, second]);
    assert.equal(new Set(childServices.map(({ id }) => id)).size, 2);
    assert.ok(childServices.every(({ id }) => !units()[id]!.args.some(arg => arg.startsWith("--property=ExecStop="))));
    writeFileSync(parentConfig, JSON.stringify({ services: {} }));
    const empty = await client.callTool({ name: "start_server", arguments: { group: "my-group" } });
    assert.deepEqual(empty.structuredContent?.services, []);

    writeFileSync(parentConfig, JSON.stringify({ services: {
      good: { startCommand: "npm run dev" },
      bad: { startCommand: "fail-start" },
      cleanup: { startCommand: "npm run worker", stopCommand: "fail-stop" },
    } }));
    const partial = await client.callTool({ name: "start_server", arguments: { group: "my-group" } });
    assert.equal(partial.isError, true);
    const partialServices = partial.structuredContent?.services as Service[];
    assert.equal(partialServices.find(({ name }) => name === "good")?.state, "active");
    assert.match(partialServices.find(({ name }) => name === "bad")?.error ?? "", /failed/i);
    const failedStop = await client.callTool({ name: "stop_server", arguments: { group: "my-group", service: "cleanup" } });
    assert.equal(failedStop.isError, true);
    assert.equal((failedStop.structuredContent?.services as Service[])[0]?.state, "failed");

    for (const services of [[], { "../bad": { startCommand: "echo bad" } }, { api: { startCommand: " " } },
      { api: { startCommand: "echo ok", stopCommand: " " } }, { api: { startCommand: ["echo legacy"] } }]) {
      writeFileSync(parentConfig, JSON.stringify({ services }));
      assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
    }
    writeFileSync(parentConfig, JSON.stringify({ startCommand: ["echo legacy"] }));
    assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
    writeFileSync(parentConfig, "{}");
    for (const name of ["start_server", "stop_server", "server_logs"]) {
      for (const input of [{}, { group: "../outside" }, { repo: "owner/missing" }, { group: "my-group", service: "missing" },
        { group: "my-group", branch: "main" }]) {
        assert.equal((await client.callTool({ name, arguments: input })).isError, true);
      }
    }
    for (const lines of [0, -1, 1.5, 1001]) {
      assert.equal((await client.callTool({ name: "server_logs", arguments: { group: "my-group", lines } })).isError, true);
    }
    writeFileSync(parentConfig, "invalid JSON");
    assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
    rmSync(parentConfig);
    symlinkSync(join(group, "AGENTS.md"), parentConfig);
    assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    rmSync(directory, { recursive: true, force: true });
  }
});
