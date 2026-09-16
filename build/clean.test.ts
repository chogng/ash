import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("clean removes outputs and tool caches while preserving dependencies and linked directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ash-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const removed = [".build/desktop/output", "build/lib/__pycache__/cache", "scripts/ash-code/__pycache__/cache"];
  const preserved = ["build/lib/source.py", "build/node_modules/tool/__pycache__/cache", "scripts/.venv/__pycache__/cache", "external/__pycache__/cache", "ash-ts/src/ash/platform/app-server/common/generated/index.ts", "ash-ts/src/ash/base/common/productIcons.ts"];
  for (const file of [...removed, ...preserved]) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "keep");
  }
  await copyFile(join(import.meta.dirname, "clean.ts"), join(root, "build/clean.ts"));
  await symlink(join(root, "external"), join(root, "build/linked"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(root, "external"), join(root, ".build/desktop/linked"), process.platform === "win32" ? "junction" : "dir");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, [join(root, "build/clean.ts")], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const file of removed) await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
  for (const file of preserved) assert.equal(await readFile(join(root, file), "utf8"), "keep");
});
