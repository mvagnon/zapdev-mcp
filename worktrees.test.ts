import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("prepare_worktree selects one repository or all group children and prepares them together", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-mcp-worktrees-")));
  const root = join(directory, "repos");
  const standalone = join(root, "owner__repo");
  const outside = join(directory, "outside");
  const grouped = join(root, "my-group", "owner__repo");
  const other = join(root, "my-group", "other__repo");
  const workspaceRoot = join(directory, ".zapdev", "worktrees");
  const secrets = join(directory, ".zapdev", "secrets");
  const config = join(directory, ".zapdev", "config");
  const client = new Client({ name: "worktree-test", version: "1.0.0" });
  const instructions = "Work exclusively in the returned worktree paths. Do not modify the source repositories.";
  const git = (path: string, ...args: string[]): string => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  try {
    for (const source of [standalone, grouped, other, outside]) {
      mkdirSync(source, { recursive: true });
      git(source, "init", "--quiet", "--initial-branch=main");
      git(source, "remote", "add", "origin", "git@github.com:owner/repo.git");
      writeFileSync(join(source, "tracked.txt"), "committed");
      writeFileSync(join(source, ".gitignore"), ".env\nprepared\n");
      git(source, "add", ".");
      git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial");
      writeFileSync(join(source, "tracked.txt"), "source edits must survive");
    }
    for (const group of [undefined, "my-group"]) {
      const selection = group ? [group, "owner__repo"] : ["owner__repo"];
      mkdirSync(join(secrets, ...selection), { recursive: true });
      mkdirSync(join(config, ...selection), { recursive: true });
      writeFileSync(join(secrets, ...selection, ".env"), "PRIVATE=value");
      writeFileSync(join(config, ...selection, "zapdev.json"), JSON.stringify({
        prepareCommand: "test -L .env && test -f tracked.txt && printf repository > prepared",
      }));
    }
    writeFileSync(join(secrets, "my-group", "shared.json"), "group secret");
    mkdirSync(join(secrets, "my-group", "other__repo"));
    writeFileSync(join(secrets, "my-group", "other__repo", ".env"), "OTHER=private");
    const groupConfig = join(config, "my-group", "zapdev.json");
    writeFileSync(groupConfig, JSON.stringify({
      prepareCommand: "test -L shared.json && test -L owner__repo/.env && printf group > prepared",
    }));
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts"],
      env: { PATH: process.env.PATH ?? "", HOME: directory, ZD_REPOS_DIR: root },
    }));

    const branch = "feat/isolated";
    const path = join(workspaceRoot, "feat__isolated");
    const tool = (await client.listTools()).tools.find(tool => tool.name === "prepare_worktree");
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["branch", "path"]);
    mkdirSync(workspaceRoot, { recursive: true });
    const foreign = join(workspaceRoot, "foreign");
    git(outside, "worktree", "add", "--quiet", "-b", "foreign", foreign);
    const escapedConfig = join(directory, ".zapdev", "outside");
    mkdirSync(escapedConfig);
    writeFileSync(join(escapedConfig, ".env"), "EXTERNAL=must-not-link");
    writeFileSync(join(escapedConfig, "zapdev.json"), JSON.stringify({
      prepareCommand: "printf unexpected > prepared",
      services: { external: { startCommand: "must-not-run" } },
    }));
    for (const source of [outside, foreign]) {
      for (const name of ["list_services", "start_server", "stop_server", "server_logs"]) {
        const result = await client.callTool({ name, arguments: { path: source } });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepEqual(result.structuredContent, { path: source, services: [] });
      }
      const result = await client.callTool({ name: "prepare_worktree", arguments: { path: source, branch: source === outside ? "outside-child" : "foreign-child" } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const paths = result.structuredContent?.paths as string[];
      assert.equal(paths.length, 1);
      assert.equal(git(paths[0]!, "rev-parse", "HEAD"), git(outside, "rev-parse", "HEAD"));
      assert.equal(existsSync(join(paths[0]!, ".env")), false);
      assert.equal(existsSync(join(paths[0]!, "prepared")), false);
      assert.equal(readFileSync(join(outside, "tracked.txt"), "utf8"), "source edits must survive");
    }
    const created = await client.callTool({ name: "prepare_worktree", arguments: { path: standalone, branch } });
    assert.notEqual(created.isError, true, JSON.stringify(created.content));
    assert.deepEqual(created.structuredContent, { paths: [path], instructions });
    assert.equal(existsSync(join(workspaceRoot, "feat")), false);
    assert.equal(git(path, "branch", "--show-current"), branch);
    assert.equal(git(path, "rev-parse", "HEAD"), git(standalone, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(path, "tracked.txt"), "utf8"), "committed");
    assert.equal(readlinkSync(join(path, ".env")), join(secrets, "owner__repo", ".env"));
    assert.equal(readFileSync(join(path, "prepared"), "utf8"), "repository");
    assert.equal(readFileSync(join(standalone, "tracked.txt"), "utf8"), "source edits must survive");
    assert.equal(git(standalone, "branch", "--show-current"), "main");
    assert.equal(existsSync(join(standalone, "prepared")), false);
    assert.doesNotMatch(JSON.stringify(created), /PRIVATE=value/);

    const groupedWorkspace = join(workspaceRoot, "grouped");
    const groupedPath = join(groupedWorkspace, "owner__repo");
    const groupResult = await client.callTool({ name: "prepare_worktree", arguments: { path: grouped, branch: "grouped" } });
    assert.notEqual(groupResult.isError, true, JSON.stringify(groupResult.content));
    assert.deepEqual(groupResult.structuredContent, { paths: [groupedPath], instructions });
    assert.equal(readFileSync(join(groupedWorkspace, "prepared"), "utf8"), "group");
    assert.equal(readlinkSync(join(groupedWorkspace, "shared.json")), join(secrets, "my-group", "shared.json"));
    assert.equal(readlinkSync(join(groupedPath, ".env")), join(secrets, "my-group", "owner__repo", ".env"));
    assert.equal(existsSync(join(root, "my-group", "prepared")), false);
    assert.equal(existsSync(join(groupedPath, "prepared")), false);
    assert.equal(existsSync(join(groupedWorkspace, "other__repo")), false);

    writeFileSync(groupConfig, "{}");
    const noCommand = await client.callTool({ name: "prepare_worktree", arguments: { path: groupedPath, branch: "no-command" } });
    assert.notEqual(noCommand.isError, true, JSON.stringify(noCommand.content));
    assert.equal(existsSync(join(workspaceRoot, "no-command", "owner__repo", "prepared")), false);
    rmSync(groupConfig);
    const fallback = await client.callTool({ name: "prepare_worktree", arguments: { path: grouped, branch: "fallback" } });
    assert.notEqual(fallback.isError, true, JSON.stringify(fallback.content));
    assert.equal(readFileSync(join(workspaceRoot, "fallback", "owner__repo", "prepared"), "utf8"), "repository");

    const group = join(root, "my-group");
    writeFileSync(groupConfig, JSON.stringify({
      prepareCommand: "test -L shared.json && test -L owner__repo/.env && test -L other__repo/.env && test -f other__repo/tracked.txt && printf group >> prepared",
    }));
    mkdirSync(join(group, "not-a-repo"));
    symlinkSync(standalone, join(group, "linked-repo"));
    const all = await client.callTool({ name: "prepare_worktree", arguments: { path: group, branch: "feat/all-repos" } });
    assert.notEqual(all.isError, true, JSON.stringify(all.content));
    const allPaths = ["other__repo", "owner__repo"].map(name => join(workspaceRoot, "feat__all-repos", name));
    assert.deepEqual(all.structuredContent, { paths: allPaths, instructions });
    assert.equal(readFileSync(join(workspaceRoot, "feat__all-repos", "prepared"), "utf8"), "group");
    for (const path of allPaths) {
      assert.equal(git(path, "branch", "--show-current"), "feat/all-repos");
      assert.equal(readFileSync(join(path, "tracked.txt"), "utf8"), "committed");
    }
    assert.equal(readFileSync(join(other, "tracked.txt"), "utf8"), "source edits must survive");
    assert.equal(existsSync(join(group, "prepared")), false);

    git(grouped, "branch", "group-conflict");
    const conflict = await client.callTool({ name: "prepare_worktree", arguments: { path: group, branch: "group-conflict" } });
    assert.equal(conflict.isError, true);
    assert.equal(existsSync(join(workspaceRoot, "group-conflict")), false);
    assert.equal(git(other, "branch", "--list", "--", "group-conflict"), "");

    mkdirSync(join(grouped, "nested"));
    writeFileSync(groupConfig, "{}");
    const nested = await client.callTool({ name: "prepare_worktree", arguments: { path: join(grouped, "nested"), branch: "from-subdirectory" } });
    assert.notEqual(nested.isError, true, JSON.stringify(nested.content));
    assert.deepEqual(nested.structuredContent, { paths: [join(workspaceRoot, "from-subdirectory", "owner__repo")], instructions });

    const empty = join(root, "empty");
    mkdirSync(empty);

    mkdirSync(join(workspaceRoot, "existing"));
    writeFileSync(join(workspaceRoot, "existing", "keep"), "untouched");
    symlinkSync(standalone, join(workspaceRoot, "alias__child"));
    git(standalone, "branch", "existing-branch");
    for (const input of [
      { branch: "existing" },
      { branch: "existing-branch" },
      { branch: "feat__isolated" },
      { branch: "alias/child" },
      { branch: "feat/isolated/nested" },
      { branch: "../escape" },
      { branch: "bad..branch" },
      { branch: "" },
      { path: "relative", branch: "relative" },
      { path: empty, branch: "empty-group" },
      { branch: "invalid-input", repo: "owner/repo" },
      { branch: "invalid-input", group: "my-group" },
    ]) {
      const result = await client.callTool({ name: "prepare_worktree", arguments: { path: standalone, ...input } });
      assert.equal(result.isError, true, JSON.stringify(input));
    }
    assert.equal(readFileSync(join(workspaceRoot, "existing", "keep"), "utf8"), "untouched");
    assert.equal(existsSync(join(standalone, "child")), false);
    assert.equal(git(standalone, "branch", "--list", "--", "feat__isolated"), "");

    writeFileSync(join(config, "owner__repo", "zapdev.json"), JSON.stringify({ prepareCommand: "printf failure >&2; exit 1" }));
    const failure = await client.callTool({ name: "prepare_worktree", arguments: { path: standalone, branch: "failed-prepare" } });
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.content), /failure/);
    assert.match(JSON.stringify(failure.content), /failed-prepare/);
    assert.deepEqual(failure.structuredContent?.paths, [join(workspaceRoot, "failed-prepare")]);
    assert.equal(git(join(workspaceRoot, "failed-prepare"), "branch", "--show-current"), "failed-prepare");
    git(standalone, "worktree", "remove", "--", path);
    assert.equal(existsSync(path), false);
    assert.equal(git(standalone, "branch", "--list", "--", branch), branch);
    assert.equal(readFileSync(join(secrets, "owner__repo", ".env"), "utf8"), "PRIVATE=value");
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
