import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

    const preparation = (await client.listTools()).tools.find(tool => tool.name === "prepare_repo")!;
    for (const name of ["repo", "group"]) {
      const schema = preparation.inputSchema.properties?.[name] as Record<string, unknown>;
      assert.equal(schema.type, "string", `${name} must render as a plain text input`);
      assert.equal(schema.anyOf, undefined);
      assert.equal(schema.oneOf, undefined);
      assert.equal(preparation.inputSchema.required?.includes(name) ?? false, name === "repo");
    }

    for (const group of [undefined, "my-group", "other-group"]) {
      const expected = join(root, ...(group ? [group] : []), "owner__repo");
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

    const rootWithEmptyGroup = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "" },
    });
    assert.notEqual(rootWithEmptyGroup.isError, true, JSON.stringify(rootWithEmptyGroup.content));
    assert.deepEqual(rootWithEmptyGroup.structuredContent, { path: join(root, "owner__repo") });

    const secrets = join(directory, ".zapdev", "secrets");
    const groupSecrets = join(secrets, "my-group");
    const repoSecrets = join(groupSecrets, "owner__repo");
    mkdirSync(join(repoSecrets, "nested"), { recursive: true });
    mkdirSync(join(groupSecrets, "other__repo"));
    mkdirSync(join(secrets, "owner__repo"));
    writeFileSync(join(groupSecrets, "config.json"), '{"group":true}');
    writeFileSync(join(groupSecrets, "other__repo", ".env"), "OTHER=private");
    writeFileSync(join(repoSecrets, ".env"), "GROUP=private");
    writeFileSync(join(repoSecrets, "nested", "key.pem"), "nested private key");
    writeFileSync(join(secrets, "owner__repo", ".env.local"), "LOCAL=private");
    writeFileSync(join(root, "my-group", "config.json"), "old copied secret");

    for (const group of [undefined, "my-group", "other-group"]) {
      const expected = join(root, ...(group ? [group] : []), "owner__repo");
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
          assert.equal(readlinkSync(join(expected, ".env.local")), join(secrets, "owner__repo", ".env.local"));
        }
        if (group === "my-group") {
          assert.equal(readFileSync(join(root, group, "config.json"), "utf8"), "old copied secret");
          assert.equal(existsSync(join(expected, "config.json")), false);
          assert.equal(readFileSync(join(expected, ".env"), "utf8"), "GROUP=private");
          assert.equal(readFileSync(join(expected, "nested", "key.pem"), "utf8"), "nested private key");
          assert.equal(readlinkSync(join(expected, ".env")), join(repoSecrets, ".env"));
          assert.equal(readlinkSync(join(expected, "nested", "key.pem")), join(repoSecrets, "nested", "key.pem"));
          assert.equal(existsSync(join(root, group, "other__repo")), false);
          writeFileSync(join(repoSecrets, ".env"), "GROUP=updated");
          assert.equal(readFileSync(join(expected, ".env"), "utf8"), "GROUP=updated");
          writeFileSync(join(expected, ".env"), "GROUP=private");
          assert.equal(readFileSync(join(repoSecrets, ".env"), "utf8"), "GROUP=private");
        }
        assert.doesNotMatch(JSON.stringify(result), /GROUP=private|LOCAL=private|nested private key/);
      }
    }

    const config = join(directory, ".zapdev", "config");
    const standaloneConfig = join(config, "owner__repo", "zapdev.json");
    const parentConfig = join(config, "my-group", "zapdev.json");
    const childConfig = join(config, "my-group", "owner__repo", "zapdev.json");
    mkdirSync(join(config, "owner__repo"), { recursive: true });
    mkdirSync(join(config, "my-group", "owner__repo"), { recursive: true });
    writeFileSync(standaloneConfig, JSON.stringify({
      prepareCommand: "test -L .env.local && test -f AGENTS.md && printf standalone > prepared",
    }));
    writeFileSync(parentConfig, JSON.stringify({
      prepareCommand: "test -L 'owner__repo/.env' && test -f 'owner__repo/AGENTS.md' && printf parent > prepared",
    }));
    writeFileSync(childConfig, JSON.stringify({
      prepareCommand: "test -L .env && printf child > prepared",
    }));
    for (const group of [undefined, "my-group"]) {
      const parent = join(root, ...(group ? [group] : []));
      const path = join(parent, "owner__repo");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.callTool({
          name: "prepare_repo", arguments: { repo: "owner/repo", ...(group && { group }) },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepEqual(result.structuredContent, { path });
        assert.equal(readFileSync(join(path, "prepared"), "utf8"), group ? "child" : "standalone");
        if (group) assert.equal(existsSync(join(parent, "prepared")), false);
      }
    }

    const groupPath = join(root, "my-group");
    writeFileSync(parentConfig, "invalid JSON");
    for (const config of [{}, { services: {} }, { frontUrl: "http://localhost:3000" }]) {
      writeFileSync(childConfig, JSON.stringify(config));
      const response = await client.callTool({
        name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      assert.equal(existsSync(join(groupPath, "owner__repo", "prepared")), false);
    }
    rmSync(childConfig);
    writeFileSync(parentConfig, JSON.stringify({ prepareCommand: "printf parent > prepared; printf 'group prepare failed' >&2; exit 1" }));
    const failedGroup = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.equal(failedGroup.isError, true);
    assert.match(JSON.stringify(failedGroup.content), /group prepare failed/);
    assert.equal(existsSync(join(groupPath, "owner__repo", "prepared")), false);
    writeFileSync(parentConfig, "invalid JSON");
    assert.equal((await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    })).isError, true);
    rmSync(parentConfig);
    writeFileSync(childConfig, JSON.stringify({ prepareCommand: "printf child > prepared" }));
    const fallback = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.notEqual(fallback.isError, true, JSON.stringify(fallback.content));
    assert.equal(readFileSync(join(root, "my-group", "owner__repo", "prepared"), "utf8"), "child");

    writeFileSync(join(groupPath, "owner__repo", "AGENTS.md"), "Grouped changes must stay untouched");
    mkdirSync(join(root, "empty"));
    for (const input of [
      {},
      { repo: "" },
      { repo: "", group: "" },
      { repo: "", group: "my-group" },
      { group: "my-group" },
      { group: "empty" },
      { group: "missing" },
      { repo: "invalid", group: "my-group" },
    ]) {
      assert.equal((await client.callTool({ name: "prepare_repo", arguments: input })).isError, true);
    }
    assert.equal(readFileSync(join(groupPath, "owner__repo", "AGENTS.md"), "utf8"), "Grouped changes must stay untouched");
    assert.equal(readFileSync(join(groupPath, "prepared"), "utf8"), "parent");

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
    const savedSecrets = join(directory, "saved-secrets");
    renameSync(repoSecrets, savedSecrets);
    const unsafeDestination = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.equal(unsafeDestination.isError, true);
    assert.equal(readFileSync(outside, "utf8"), "untouched");
    rmSync(groupConfig);
    const parentSecrets = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.notEqual(parentSecrets.isError, true, JSON.stringify(parentSecrets.content));
    assert.equal(readlinkSync(groupConfig), join(groupSecrets, "config.json"));
    assert.equal(existsSync(join(groupPath, "owner__repo", ".env")), false);
    renameSync(savedSecrets, repoSecrets);

    mkdirSync(join(repoSecrets, ".git"));
    writeFileSync(join(repoSecrets, ".git", "config"), "invalid git config");
    const unsafeMetadata = await client.callTool({
      name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
    });
    assert.equal(unsafeMetadata.isError, true);
    execFileSync("git", ["-C", join(root, "my-group", "owner__repo"), "rev-parse", "HEAD"]);

    for (const group of [".", "..", "../outside", "/absolute", "nested/group", "nested\\group", "bad\0name"]) {
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
    assert.equal(existsSync(join(source, "owner__repo")), false);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const local of [false, true]) test(`commit and pr validate inputs and invoke ${local ? "local zapdev" : "npx"} without prompts`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "zapdev-mcp-test space-"));
  const clone = join(directory, "zapdev clone");
  const entry = join(clone, "dist", "index.js");
  const prefix = local ? [] : ["--yes", "zapdev"];
  const root = join(directory, "repos");
  const repository = join(root, "repo");
  const group = join(directory, "group");
  const outside = join(directory, "outside");
  const worktree = join(directory, "external-worktree");
  const client = new Client({ name: "commit-test", version: "1.0.0" });
  try {
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", ["init", "--quiet", outside]);
    execFileSync("git", ["-C", outside, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--allow-empty", "-m", "Initial commit"]);
    execFileSync("git", ["-C", outside, "worktree", "add", "--quiet", "-b", "external", worktree]);
    mkdirSync(join(outside, "src"));
    mkdirSync(join(directory, "empty"));
    symlinkSync(outside, join(root, "escape"));
    if (local) {
      mkdirSync(join(clone, "dist"), { recursive: true });
      writeFileSync(join(directory, "npx"), `#!${process.execPath}\nthrow new Error("Unexpected npx fallback");\n`, { mode: 0o755 });
    }
    writeFileSync(
      local ? entry : join(directory, "npx"),
      `#!${process.execPath}
if (process.argv.includes("--branch=fail")) {
  console.error("commit failed");
  process.exit(1);
}
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), ...(process.argv.includes("--json") && { pullRequests: [] }) }));
console.error("scan warning");
`,
      { mode: 0o755 },
    );
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts", ...(local ? ["--zapdev-path", clone] : [])],
      env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory, ZD_REPOS_DIR: local ? join(directory, "missing-root") : root },
    }));

    for (const name of ["prepare_worktree", "list_services", "start_server", "stop_server", "server_logs"]) {
      const rejected = await client.callTool({ name, arguments: { path: join(root, "escape"), ...(name === "prepare_worktree" && { branch: "outside" }) } });
      assert.equal(rejected.isError, true, `${name} must reject directory symlinks`);
      const result = await client.callTool({ name, arguments: { path: outside, ...(name === "prepare_worktree" && { branch: "outside" }) } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      if (name !== "prepare_worktree") assert.deepEqual(result.structuredContent, { path: realpathSync(outside), services: [] });
    }

    for (const name of ["commit", "pr"]) {
      for (const path of [join(root, "escape"), join(directory, "empty"), join(directory, "missing")]) {
        const result = await client.callTool({ name, arguments: { path } });
        assert.equal(result.isError, true, `${name} must reject ${path}`);
      }
      for (const path of [outside, join(outside, "src"), worktree]) {
        const result = await client.callTool({ name, arguments: { path } });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        const output = result.structuredContent as { stdout: string };
        assert.deepEqual(JSON.parse(output.stdout).args, [
          ...prefix, name, realpathSync(path === worktree ? worktree : outside), "--yes",
          ...(name === "pr" ? ["--cleanup-worktrees", "--json"] : ["--no-push"]),
        ]);
      }
    }

    for (const { type, branch, pull, push } of [
      { type: undefined, branch: undefined },
      { type: "auto", branch: "feat/example" },
      { type: "fix!", branch: undefined },
      { type: "fix!", branch: "feat/example" },
      { type: "fix!", branch: "feat/example", pull: false },
      { type: "fix!", branch: "feat/example", pull: true },
      { push: false },
      { push: true },
      { type: "fix!", branch: "feat/example", pull: true, push: true },
    ]) {
      const result = await client.callTool({
        name: "commit",
        arguments: { path: repository, ...(branch && { branch }), ...(type && { type }), ...(pull !== undefined && { pull }), ...(push !== undefined && { push }) },
      });
      assert.notEqual(result.isError, true);
      const output = result.structuredContent as { stdout: string; stderr: string };
      assert.deepEqual(JSON.parse(output.stdout), {
        args: [
          ...prefix, "commit", realpathSync(repository), "--yes", push ? "--push" : "--no-push",
          ...(pull ? ["--pull"] : []),
          ...(type === "fix!" ? ["--type=fix!"] : []),
          ...(branch ? [`--branch=${branch}`] : []),
        ],
        cwd: realpathSync(process.cwd()),
      });
      assert.equal(output.stderr, "scan warning");
    }

    for (const input of [
      { branch: "bad..branch" },
      { branch: "" },
      { type: "invalid" },
      { pull: "true" },
      { push: "true" },
      { branch: "fail" },
    ]) {
      const result = await client.callTool({
        name: "commit",
        arguments: { path: repository, branch: "feat/example", ...input },
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
        arguments: { path: repository, ...input },
      });
      assert.notEqual(result.isError, true);
      const output = result.structuredContent as { stdout: string; stderr: string };
      assert.deepEqual(JSON.parse(output.stdout), {
        args: [
          ...prefix, "pr", realpathSync(repository), "--yes", "--cleanup-worktrees", "--json",
          ...(input.closes ? [`--closes=${input.closes}`] : []),
          ...(input.branch ? [`--branch=${input.branch}`] : []),
        ],
        cwd: realpathSync(process.cwd()),
        pullRequests: [],
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
        arguments: { path: repository, ...input },
      });
      assert.equal(result.isError, true);
      if (input.branch === "fail") {
        assert.match(JSON.stringify(result.content), /commit failed/);
      }
    }
    for (const repo of ["front", "back"]) execFileSync("git", ["init", "--quiet", join(group, repo)]);
    for (const name of ["commit", "pr"]) {
      const result = await client.callTool({ name, arguments: { path: group } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const output = result.structuredContent as { stdout: string };
      assert.deepEqual(JSON.parse(output.stdout), {
        args: [...prefix, name, realpathSync(group), "--yes", ...(name === "pr" ? ["--cleanup-worktrees", "--json"] : ["--no-push"])],
        cwd: realpathSync(process.cwd()),
        ...(name === "pr" && { pullRequests: [] }),
      });
    }
    if (local) {
      rmSync(entry);
      for (const name of ["commit", "pr"]) {
        const result = await client.callTool({ name, arguments: { path: repository } });
        assert.equal(result.isError, true);
        assert.match(result.structuredContent?.error as string, /local zapdev build.*npm run build/i);
        assert.equal(result.structuredContent?.stdout, "");
        assert.doesNotMatch(result.structuredContent?.error as string, /Unexpected npx fallback/);
      }
    }
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pr exposes deleted and skipped worktrees, including partial failures", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-mcp-pr-")));
  const repository = join(directory, "repo");
  const client = new Client({ name: "pr-result-test", version: "1.0.0" });
  const pullRequests = [{
    repo: repository,
    branch: "feat/example",
    url: "https://github.com/owner/repo/pull/1",
    deletedWorktrees: [join(directory, "deleted worktree")],
    skippedWorktrees: [{ path: join(directory, "retained worktree"), reason: "contains untracked files" }],
  }];
  try {
    execFileSync("git", ["init", "--quiet", repository]);
    writeFileSync(join(directory, "npx"), `#!${process.execPath}
const branch = process.argv.find(arg => arg.startsWith("--branch="))?.slice(9);
const pullRequests = ${JSON.stringify(pullRequests)};
const error = branch === "partial" ? "second repository: creation failed" : undefined;
console.log(JSON.stringify({ pullRequests: branch === "empty" ? [] : pullRequests, ...(error && { error }) }));
console.error("cleanup diagnostic");
if (error || branch === "nonzero") process.exit(1);
`, { mode: 0o755 });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "index.ts"],
      env: { PATH: `${directory}:${process.env.PATH}`, ZD_REPOS_DIR: directory },
    }));

    for (const branch of ["success", "partial", "empty", "nonzero"]) {
      const result = await client.callTool({ name: "pr", arguments: { path: repository, branch } });
      assert.equal(result.isError === true, branch === "partial" || branch === "nonzero");
      const output = result.structuredContent!;
      assert.deepEqual(output.pullRequests, branch === "empty" ? [] : pullRequests);
      assert.equal(output.stderr, "cleanup diagnostic");
      assert.deepEqual(JSON.parse(output.stdout as string).pullRequests, output.pullRequests);
      assert.match(output.instructions as string, /deleted.*worktree/i);
      assert.match(output.instructions as string, /skipped.*worktree/i);
      if (branch === "partial") assert.equal(output.error, "second repository: creation failed");
      if (branch === "nonzero") assert.equal(typeof output.error, "string");
      assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(output) }]);
    }

    for (const stdout of ["not JSON", JSON.stringify({ pullRequests: [{ ...pullRequests[0], skippedWorktrees: ["missing reason"] }] })]) {
      writeFileSync(join(directory, "npx"), `#!${process.execPath}\nconsole.log(${JSON.stringify(stdout)});\n`, { mode: 0o755 });
      const invalid = await client.callTool({ name: "pr", arguments: { path: repository } });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent?.stdout, stdout);
      assert.equal(invalid.structuredContent?.pullRequests, undefined);
      assert.match(JSON.stringify(invalid.content), /invalid.*JSON/i);
    }
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
