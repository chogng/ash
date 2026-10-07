import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("clean removes outputs and tool caches while preserving dependencies and linked directories", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ash-clean-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const removed = [".build/desktop/output", "target/debug/output", "dist/package", "test/integration/browser/dist/index.html", "__pycache__/cache", ".pytest_cache/cache", ".ruff_cache/cache", "node_modules/.vite/deps/cache", "node_modules/.vite-temp/config.mjs", "build/lib/__pycache__/cache", "build/code/__pycache__/cache", "scripts/__pycache__/cache", "scripts/.pytest_cache/cache", "build/.ruff_cache/cache"];
	const preserved = ["build/lib/source.py", "node_modules/tool/index.js", "build/node_modules/tool/__pycache__/cache", "scripts/.venv/__pycache__/cache", "external/__pycache__/cache", ".ash/config.json", "third_party/.cache/runtime", "src/ash/platform/app-server/common/generated/index.ts", "src/ash/base/common/productIcons.ts"];
	for (const file of [...removed, ...preserved]) {
		await mkdir(join(root, file, ".."), { recursive: true });
		await writeFile(join(root, file), "keep");
	}
	await copyFile(join(import.meta.dirname, "clean.ts"), join(root, "build/clean.ts"));
	await symlink(join(root, "external"), join(root, "build/linked"), process.platform === "win32" ? "junction" : "dir");
	await symlink(join(root, "external"), join(root, ".build/linked"), process.platform === "win32" ? "junction" : "dir");
	await symlink(join(root, "external"), join(root, ".build/desktop/linked"), process.platform === "win32" ? "junction" : "dir");
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = spawnSync(process.execPath, [join(root, "build/clean.ts")], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
		assert.equal(result.status, 0, result.stderr);
	}
	for (const file of removed) await assert.rejects(readFile(join(root, file)), { code: "ENOENT" });
	for (const file of preserved) assert.equal(await readFile(join(root, file), "utf8"), "keep");
});

test("clean unlinks output and cache roots without cleaning shared dependencies", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ash-clean-links-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "build"));
	await mkdir(join(root, "scripts"));
	await mkdir(join(root, "external/.vite"), { recursive: true });
	await writeFile(join(root, "external/.vite/cache"), "keep");
	await copyFile(join(import.meta.dirname, "clean.ts"), join(root, "build/clean.ts"));
	for (const directory of [".build", "target", "dist", ".pytest_cache", ".ruff_cache", "node_modules"]) {
		await symlink(join(root, "external"), join(root, directory), process.platform === "win32" ? "junction" : "dir");
	}
	const result = spawnSync(process.execPath, [join(root, "build/clean.ts")], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(await readFile(join(root, "node_modules/.vite/cache"), "utf8"), "keep");
	for (const directory of [".build", "target", "dist", ".pytest_cache", ".ruff_cache"]) {
		await assert.rejects(readFile(join(root, directory, ".vite/cache")), { code: "ENOENT" });
	}
});
