import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("get_repo uses flat checkout names and optional safe group directories", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "zapdev-mcp-test-")));
  const root = join(directory, "repos");
  const source = join(directory, "source");
  const client = new Client({ name: "get-repo-test", version: "1.0.0" });
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
          name: "get_repo",
          arguments: { repo: "Owner/Repo.git", ...(group && { group }) },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        assert.deepEqual(result.structuredContent, {
          path: expected,
          agents_md: "Repository instructions",
        });
        assert.ok(existsSync(join(expected, ".git")));
        assert.equal(existsSync(join(root, ...(group ? [group] : []), "owner")), false);
      }
    }

    for (const group of ["", ".", "..", "../outside", "/absolute", "nested/group", "nested\\group", "bad\0name"]) {
      const result = await client.callTool({
        name: "get_repo",
        arguments: { repo: "owner/repo", group },
      });
      assert.equal(result.isError, true, `Expected rejection for ${JSON.stringify(group)}`);
    }

    symlinkSync(source, join(root, "linked-group"));
    const result = await client.callTool({
      name: "get_repo",
      arguments: { repo: "owner/repo", group: "linked-group" },
    });
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(source, "owner-repo")), false);
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
