import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("aggregate and standalone unit commands prepare inputs once and stop on preparation failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ash-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../../ash-ts/package.json"), "utf8"));
  const scripts = { ...manifest.scripts };
  for (const [name, operation] of Object.entries({
    "test:build-tools": "tools",
    "test:unit": "unit",
    "test:editor:unit": "editor",
    "prepare:output": "output",
    "protocol:generate": "protocol",
    "icons:check": "icons",
  })) scripts[name] = `node record.ts ${operation}`;
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", scripts }));
  await writeFile(join(directory, "record.ts"), `
    import { appendFileSync } from 'node:fs';
    appendFileSync('operations.jsonl', JSON.stringify(process.argv[2]) + '\\n');
    if (process.argv[2] === process.env.FAIL_OPERATION) process.exitCode = 1;
  `);
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, "Run through the owning pnpm test script");
  const executable = pnpm.endsWith(".exe") ? pnpm : process.execPath;
  const prefix = pnpm.endsWith(".exe") ? [] : [pnpm];
  for (const [command, expected, failure] of [
    ["test:main", ["tools", "output", "protocol", "icons", "unit"], ""],
    ["test:unit", ["output", "protocol", "icons", "unit"], ""],
    ["test:editor:unit", ["output", "protocol", "icons", "editor"], ""],
    ["test:main", ["tools", "output", "protocol"], "protocol"],
  ] as const) {
    await writeFile(join(directory, "operations.jsonl"), "");
    const result = spawnSync(executable, [...prefix, "run", command], {
      cwd: directory,
      env: { ...process.env, FAIL_OPERATION: failure },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    if (failure) assert.notEqual(result.status, 0);
    else assert.equal(result.status, 0, result.stdout + result.stderr);
    const operations = (await readFile(join(directory, "operations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(operations, expected, command);
  }
});
