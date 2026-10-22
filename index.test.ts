import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("prepare_repo uses flat checkout names and optional safe group directories", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-mcp-test-")));
  const root = join(directory, "repos");
  const source = join(directory, "source");
  const client = new Client({ name: "prepare-repo-test", version: "1.0.0" });
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", source]);
    writeFileSync(join(source, "AGENTS.md"), "Repository instructions");
    execFileSync("git", ["-C", source, "add", "AGENTS.md"]);
    execFileSync("git", [
      "-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-m", "Initial commit",
    ]);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        ZD_REPOS_DIR: root,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/owner/repo.git",
      },
    }));

    for (const group of [undefined, "my-group", "other-group"]) {
      const expected = join(root, ...(group ? [group] : []), "owner-repo");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({
          name: "prepare_repo",
          arguments: { repo: "Owner/Repo.git", ...(group && { group }) },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepEqual(result.structuredContent, {
          path: expected,
        });
        assert.ok(existsSync(join(expected, ".git")));
        assert.equal(existsSync(join(root, ...(group ? [group] : []), "owner")), false);
      }
    }

    const secrets = join(directory, ".zapdev", "secrets");
    const groupSecrets = join(secrets, "my-group");
    const repoSecrets = join(groupSecrets, "owner-repo");
    mkdirSync(join(repoSecrets, "nested"), { recursive: true });
    mkdirSync(join(groupSecrets, "other-repo"));
    mkdirSync(join(secrets, "owner-repo"));
    writeFileSync(join(groupSecrets, "config.json"), '{"group":true}');
    writeFileSync(join(groupSecrets, "other-repo", ".env"), "OTHER=private");
    writeFileSync(join(repoSecrets, ".env"), "GROUP=private");
    writeFileSync(join(repoSecrets, "nested", "key.pem"), "nested private key");
    writeFileSync(join(secrets, "owner-repo", ".env.local"), "LOCAL=private");
    writeFileSync(join(root, "my-group", "config.json"), "old copied secret");

    for (const group of [undefined, "my-group", "other-group"]) {
      const expected = join(root, ...(group ? [group] : []), "owner-repo");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({
          name: "prepare_repo",
          arguments: { repo: "owner/repo", ...(group && { group }) },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.equal(existsSync(join(expected, ".env.local")), group === undefined);
        assert.equal(existsSync(join(expected, ".env")), group === "my-group");
        if (group === undefined) {
          assert.equal(readFileSync(join(expected, ".env.local"), "utf8"), "LOCAL=private");
          assert.equal(readlinkSync(join(expected, ".env.local")), join(secrets, "owner-repo", ".env.local"));
        }
        if (group === "my-group") {
          assert.equal(readFileSync(join(root, group, "config.json"), "utf8"), '{"group":true}');
          assert.equal(readFileSync(join(expected, ".env"), "utf8"), "GROUP=private");
          assert.equal(readFileSync(join(expected, "nested", "key.pem"), "utf8"), "nested private key");
          assert.equal(readlinkSync(join(root, group, "config.json")), join(groupSecrets, "config.json"));
          assert.equal(readlinkSync(join(expected, ".env")), join(repoSecrets, ".env"));
          assert.equal(readlinkSync(join(expected, "nested", "key.pem")), join(repoSecrets, "nested", "key.pem"));
          assert.equal(existsSync(join(root, group, "other-repo")), false);
          writeFileSync(join(repoSecrets, ".env"), "GROUP=updated");
          assert.equal(readFileSync(join(expected, ".env"), "utf8"), "GROUP=updated");
          writeFileSync(join(expected, ".env"), "GROUP=private");
          assert.equal(readFileSync(join(repoSecrets, ".env"), "utf8"), "GROUP=private");
        }
        assert.doesNotMatch(JSON.stringify(result), /GROUP=private|LOCAL=private|nested private key/);
      }
    }

    const config = join(directory, ".zapdev", "config");
    const standaloneConfig = join(config, "owner-repo", "zapdev.json");
    const parentConfig = join(config, "my-group", "zapdev.json");
    const childConfig = join(config, "my-group", "owner-repo", "zapdev.json");
    mkdirSync(join(config, "owner-repo"), { recursive: true });
    mkdirSync(join(config, "my-group", "owner-repo"), { recursive: true });
    writeFileSync(standaloneConfig, JSON.stringify({
      prepareCommand: "test -L .env.local && test -f AGENTS.md && printf standalone > prepared",
    }));
    writeFileSync(parentConfig, JSON.stringify({
      prepareCommand: "test -L owner-repo/.env && test -f owner-repo/AGENTS.md && printf parent > prepared",
    }));
    writeFileSync(childConfig, JSON.stringify({
      prepareCommand: "test -L .env && printf child > prepared",
    }));
    for (const group of [undefined, "my-group"]) {
      const parent = join(root, ...(group ? [group] : []));
      const path = join(parent, "owner-repo");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({
          name: "prepare_repo", arguments: { repo: "owner/repo", ...(group && { group }) },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepEqual(result.structuredContent, { path });
        assert.equal(readFileSync(join(group ? parent : path, "prepared"), "utf8"), group ? "parent" : "standalone");
        if (group) assert.equal(existsSync(join(path, "prepared")), false);
      }
    }

    writeFileSync(parentConfig, '{"frontUrl":"http://localhost:3000"}');
    const fallback = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.notEqual(fallback.isError, true, JSON.stringify(fallback.content));
    assert.equal(readFileSync(join(root, "my-group", "owner-repo", "prepared"), "utf8"), "child");

    writeFileSync(childConfig, JSON.stringify({ prepareCommand: "printf 'prepare failed' >&2; exit 1" }));
    const failedPreparation = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.equal(failedPreparation.isError, true);
    assert.match(JSON.stringify(failedPreparation.content), /prepare failed/);
    writeFileSync(childConfig, "{}");
    const recovered = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.notEqual(recovered.isError, true, JSON.stringify(recovered.content));

    const groupConfig = join(root, "my-group", "config.json");
    const outside = join(directory, "outside.json");
    writeFileSync(outside, "untouched");
    rmSync(groupConfig);
    symlinkSync(outside, groupConfig);
    const unsafeDestination = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.equal(unsafeDestination.isError, true);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    rmSync(groupConfig);

    mkdirSync(join(repoSecrets, ".git"));
    writeFileSync(join(repoSecrets, ".git", "config"), "invalid git config");
    const unsafeMetadata = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.equal(unsafeMetadata.isError, true);
    execFileSync("git", ["-C", join(root, "my-group", "owner-repo"), "rev-parse", "HEAD"]);

    for (const group of ["", ".", "..", "../outside", "/absolute", "nested/group", "nested\\group", "bad\0name"]) {
      const result = await client.callTool({
        name: "prepare_repo",
        arguments: { repo: "owner/repo", group },
      });
      assert.equal(result.isError, true, `Expected rejection for ${JSON.stringify(group)}`);
    }

    symlinkSync(source, join(root, "linked-group"));
    const result = await client.callTool({
      name: "prepare_repo",
      arguments: { repo: "owner/repo", group: "linked-group" },
    });
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(source, "owner-repo")), false);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("start_server applies command arrays, parent context, and branch updates before launching", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-mcp-test-")));
  const root = join(directory, "repos");
  const group = join(root, "my-group");
  const first = join(group, "owner-first");
  const second = join(group, "owner-second");
  const config = join(directory, ".zapdev", "config", "my-group");
  const source = join(directory, "source");
  const client = new Client({ name: "server-test", version: "1.0.0" });
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", source]);
    writeFileSync(join(source, "AGENTS.md"), "Repository instructions");
    execFileSync("git", ["-C", source, "add", "AGENTS.md"]);
    execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-m", "Initial commit"]);
    for (const path of [first, second]) {
      execFileSync("git", ["clone", "--quiet", source, path]);
    }
    mkdirSync(join(group, "not-a-repository"));
    mkdirSync(join(config, "owner-first"), { recursive: true });
    mkdirSync(join(config, "owner-second"));
    writeFileSync(join(group, "AGENTS.md"), "Parent instructions take priority");
    const parentConfig = join(config, "zapdev.json");
    writeFileSync(parentConfig, JSON.stringify({
      frontUrl: "http://localhost:3000",
      startCommand: ["printf parent > started", "printf parent > started-second"],
    }));
    writeFileSync(join(config, "owner-first", "zapdev.json"), JSON.stringify({
      frontUrl: "http://localhost:3001",
      apiUrl: "http://localhost:4000",
      startCommand: ["printf child > started", "printf child > started-second"],
    }));
    writeFileSync(join(config, "owner-second", "zapdev.json"), JSON.stringify({
      dbUrl: "postgresql://localhost:5432/app",
      startCommand: ["printf child > started"],
    }));
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts"],
      env: { PATH: process.env.PATH ?? "", HOME: directory, ZD_REPOS_DIR: root },
    }));

    const started = await client.callTool({ name: "start_server", arguments: { group: "my-group" } });
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
    const output = started.structuredContent as {
      path: string; agents_md: string; frontUrl: string;
      repositories: Array<{ path: string; agents_md: string; frontUrl: string; apiUrl?: string; dbUrl?: string }>;
      commands: Array<{ path: string; pid: number }>;
    };
    assert.equal(output.path, group);
    assert.equal(output.agents_md, "Parent instructions take priority");
    assert.equal(output.frontUrl, "http://localhost:3000");
    assert.deepEqual(output.repositories, [
      { path: first, agents_md: "Repository instructions", frontUrl: "http://localhost:3000", apiUrl: "http://localhost:4000" },
      { path: second, agents_md: "Repository instructions", frontUrl: "http://localhost:3000", dbUrl: "postgresql://localhost:5432/app" },
    ]);
    assert.deepEqual(output.commands.map(({ path }) => path), [group, group]);
    assert.equal(new Set(output.commands.map(({ pid }) => pid)).size, 2);
    assert.ok(output.commands.every(({ pid }) => Number.isInteger(pid) && pid > 0));
    assert.equal(existsSync(join(first, "started")), false);
    assert.equal(existsSync(join(second, "started")), false);

    assert.equal((await client.listTools()).tools.some(({ name }) => name === "stop_server"), false);

    writeFileSync(parentConfig, "{}");
    const children = await client.callTool({ name: "start_server", arguments: { group: "my-group" } });
    assert.notEqual(children.isError, true, JSON.stringify(children.content));
    const childCommands = (children.structuredContent as typeof output).commands;
    assert.deepEqual(childCommands.map(({ path }) => path), [first, first, second]);
    assert.equal(new Set(childCommands.map(({ pid }) => pid)).size, 3);

    rmSync(join(config, "owner-first", "zapdev.json"));
    const single = await client.callTool({ name: "start_server", arguments: { repo: "Owner/First.git", group: "my-group" } });
    assert.notEqual(single.isError, true);
    assert.deepEqual(single.structuredContent, {
      path: first, agents_md: "Repository instructions",
      parent: { path: group, agents_md: "Parent instructions take priority" },
    });

    execFileSync("git", ["init", "--quiet", join(root, "owner-alone")]);
    const alone = await client.callTool({ name: "start_server", arguments: { repo: "owner/alone" } });
    assert.deepEqual(alone.structuredContent, { path: join(root, "owner-alone") });

    execFileSync("git", ["-C", source, "switch", "--quiet", "-c", "feature/remote"]);
    writeFileSync(join(source, "AGENTS.md"), "Remote branch instructions");
    execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-am", "Remote branch"]);
    const remote = await client.callTool({
      name: "start_server", arguments: { group: "my-group", branch: "feature/remote" },
    });
    assert.notEqual(remote.isError, true, JSON.stringify(remote.content));
    assert.ok((remote.structuredContent as typeof output).repositories.every(({ agents_md }) => agents_md === "Remote branch instructions"));
    for (const path of [first, second]) {
      assert.equal(execFileSync("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "feature/remote");
      assert.equal(execFileSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8" }).trim(), "origin/feature/remote");
    }
    writeFileSync(join(source, "AGENTS.md"), "Updated instructions");
    execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-am", "Update instructions"]);
    const pulled = await client.callTool({ name: "start_server", arguments: { group: "my-group" } });
    assert.notEqual(pulled.isError, true, JSON.stringify(pulled.content));
    assert.ok((pulled.structuredContent as typeof output).repositories.every(({ agents_md }) => agents_md === "Updated instructions"));
    const created = await client.callTool({
      name: "start_server", arguments: { group: "my-group", branch: "feature/new" },
    });
    assert.notEqual(created.isError, true, JSON.stringify(created.content));
    for (const path of [first, second]) {
      assert.equal(execFileSync("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "feature/new");
      assert.equal(execFileSync("git", ["-C", path, "for-each-ref", "--format=%(upstream)", "refs/heads/feature/new"], { encoding: "utf8" }).trim(), "");
    }
    const existing = await client.callTool({
      name: "start_server", arguments: { repo: "owner/first", group: "my-group", branch: "main" },
    });
    assert.notEqual(existing.isError, true, JSON.stringify(existing.content));
    assert.equal(execFileSync("git", ["-C", first, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
    assert.equal(execFileSync("git", ["-C", second, "branch", "--show-current"], { encoding: "utf8" }).trim(), "feature/new");

    execFileSync("git", ["-C", source, "switch", "--quiet", "main"]);
    writeFileSync(join(source, "AGENTS.md"), "Updated main instructions");
    execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-am", "Update main"]);
    writeFileSync(join(first, "AGENTS.md"), "Local edits to preserve");
    const dirty = await client.callTool({
      name: "start_server", arguments: { repo: "owner/first", group: "my-group" },
    });
    assert.equal(dirty.isError, true);
    assert.equal(readFileSync(join(first, "AGENTS.md"), "utf8"), "Local edits to preserve");
    writeFileSync(join(first, "AGENTS.md"), "Repository instructions");
    execFileSync("git", ["-C", first, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "--allow-empty", "-m", "Local commit"]);
    const localHead = execFileSync("git", ["-C", first, "rev-parse", "HEAD"], { encoding: "utf8" });
    const divergent = await client.callTool({
      name: "start_server", arguments: { repo: "owner/first", group: "my-group" },
    });
    assert.equal(divergent.isError, true);
    assert.equal(execFileSync("git", ["-C", first, "rev-parse", "HEAD"], { encoding: "utf8" }), localHead);

    for (const args of [{}, { group: "../outside" }, { repo: "owner/missing" }, { group: "not-found" },
      { group: "my-group", branch: "bad..branch" }, { group: "my-group", branch: "" },
      { group: "my-group", branch: "@{-1}" }]) {
      assert.equal((await client.callTool({ name: "start_server", arguments: args })).isError, true);
    }
    for (const startCommand of [42, "echo legacy", [""], ["  "], [42]]) {
      writeFileSync(parentConfig, JSON.stringify({ startCommand }));
      assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
    }
    writeFileSync(parentConfig, JSON.stringify({ startCommand: [] }));
    const empty = await client.callTool({ name: "start_server", arguments: { group: "my-group", branch: "feature/new" } });
    assert.notEqual(empty.isError, true, JSON.stringify(empty.content));
    assert.equal(empty.structuredContent?.commands, undefined);
    writeFileSync(parentConfig, "invalid JSON");
    assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
    rmSync(parentConfig);
    symlinkSync(join(group, "AGENTS.md"), parentConfig);
    assert.equal((await client.callTool({ name: "start_server", arguments: { group: "my-group" } })).isError, true);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("commit and pr validate inputs and invoke zapdev through npx without prompts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zapdev-mcp-test-"));
  const client = new Client({ name: "commit-test", version: "1.0.0" });
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    writeFileSync(
      join(directory, "npx"),
      `#!${process.execPath}
if (process.argv.includes("--branch=fail")) {
  console.error("commit failed");
  process.exit(1);
}
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
console.error("scan warning");
`,
      { mode: 0o755 },
    );
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts"],
      env: { PATH: `${directory}:${process.env.PATH}` },
    }));

    for (const type of [undefined, "auto", "fix!"]) {
      const result = await client.callTool({
        name: "commit",
        arguments: { path: directory, branch: "feat/example", ...(type && { type }) },
      });
      assert.notEqual(result.isError, true);
      const output = result.structuredContent as { stdout: string; stderr: string };
      assert.deepEqual(JSON.parse(output.stdout), {
        args: [
          "--yes", "zapdev", "commit", "--yes", "--pull", "--no-push",
          ...(type === "fix!" ? ["--type=fix!"] : []),
          "--branch=feat/example",
        ],
        cwd: realpathSync(directory),
      });
      assert.equal(output.stderr, "scan warning");
    }

    for (const input of [
      { branch: "bad..branch" },
      { type: "invalid" },
      { branch: "fail" },
    ]) {
      const result = await client.callTool({
        name: "commit",
        arguments: { path: directory, branch: "feat/example", ...input },
      });
      assert.equal(result.isError, true);
      if (input.branch === "fail") {
        assert.match(JSON.stringify(result.content), /commit failed/);
      }
    }

    for (const input of [
      {},
      { branch: "develop" },
      { closes: "https://trello.com/c/abc/task" },
      { branch: "develop", closes: "https://github.com/owner/repo/issues/123" },
    ]) {
      const result = await client.callTool({
        name: "pr",
        arguments: { path: directory, ...input },
      });
      assert.notEqual(result.isError, true);
      const output = result.structuredContent as { stdout: string; stderr: string };
      assert.deepEqual(JSON.parse(output.stdout), {
        args: [
          "--yes", "zapdev", "pr", "--yes",
          ...(input.closes ? [`--closes=${input.closes}`] : []),
          ...(input.branch ? [`--branch=${input.branch}`] : []),
        ],
        cwd: realpathSync(directory),
      });
      assert.equal(output.stderr, "scan warning");
    }

    for (const input of [
      { branch: "bad..branch" },
      { branch: "" },
      { closes: "not-a-url" },
      { closes: "file:///etc/passwd" },
      { path: "relative/path" },
      { branch: "fail" },
    ]) {
      const result = await client.callTool({
        name: "pr",
        arguments: { path: directory, ...input },
      });
      assert.equal(result.isError, true);
      if (input.branch === "fail") {
        assert.match(JSON.stringify(result.content), /commit failed/);
      }
    }
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
