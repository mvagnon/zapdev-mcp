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
          assert.equal(readFileSync(join(root, group, "config.json"), "utf8"), '{"group":true}');
          assert.equal(readlinkSync(join(root, group, "config.json")), join(groupSecrets, "config.json"));
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
      prepareCommand: "test -L .env && test -L ../config.json && printf child > prepared",
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
        assert.equal(readFileSync(join(group ? parent : path, "prepared"), "utf8"), group ? "parent" : "standalone");
        if (group) assert.equal(existsSync(join(path, "prepared")), false);
      }
    }

    const groupPath = join(root, "my-group");
    writeFileSync(childConfig, "invalid JSON");
    for (const config of [{}, { services: {} }, { frontUrl: "http://localhost:3000" }]) {
      writeFileSync(parentConfig, JSON.stringify(config));
      const response = await client.callTool({
        name: "prepare_repo", arguments: { repo: "owner/repo", group: "my-group" },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      assert.equal(existsSync(join(groupPath, "owner__repo", "prepared")), false);
    }
    writeFileSync(childConfig, JSON.stringify({ prepareCommand: "printf child > prepared" }));
    writeFileSync(parentConfig, JSON.stringify({ prepareCommand: "printf 'group prepare failed' >&2; exit 1" }));
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

    for (const { type, branch, pull } of [
      { type: undefined, branch: undefined },
      { type: "auto", branch: "feat/example" },
      { type: "fix!", branch: undefined },
      { type: "fix!", branch: "feat/example" },
      { type: "fix!", branch: "feat/example", pull: false },
      { type: "fix!", branch: "feat/example", pull: true },
    ]) {
      const result = await client.callTool({
        name: "commit",
        arguments: { path: directory, ...(branch && { branch }), ...(type && { type }), ...(pull !== undefined && { pull }) },
      });
      assert.notEqual(result.isError, true);
      const output = result.structuredContent as { stdout: string; stderr: string };
      assert.deepEqual(JSON.parse(output.stdout), {
        args: [
          "--yes", "zapdev", "commit", "--yes", "--no-push",
          ...(pull ? ["--pull"] : []),
          ...(type === "fix!" ? ["--type=fix!"] : []),
          ...(branch ? [`--branch=${branch}`] : []),
        ],
        cwd: realpathSync(directory),
      });
      assert.equal(output.stderr, "scan warning");
    }

    for (const input of [
      { branch: "bad..branch" },
      { branch: "" },
      { type: "invalid" },
      { pull: "true" },
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
