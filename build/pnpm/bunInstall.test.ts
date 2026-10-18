import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const repository = resolve(import.meta.dirname, "../..");
const version = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).devDependencies.bun as string;
const installer = readFileSync(join(repository, "node_modules/bun/install.js"), "utf8");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ash-bun-install-"));
	const packageRoot = join(root, "node_modules/bun");
	const platformRoot = join(root, "node_modules/@oven/bun-windows-x64");
	mkdirSync(join(packageRoot, "bin"), { recursive: true });
	mkdirSync(join(platformRoot, "bin"), { recursive: true });
	writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "@oven/bun-windows-x64", version }));
	return {
		root, packageRoot,
		platformExecutable: join(platformRoot, "bin/bun.exe"),
		installedExecutable: join(packageRoot, "bin/bun.exe"),
		[Symbol.dispose]() { rmSync(root, { recursive: true, force: true }); },
	};
}

async function install(current: ReturnType<typeof fixture>) {
	const require = createRequire(join(current.packageRoot, "install.js"));
	const commands: string[] = [];
	let downloads = 0;
	let exitCode = 0;
	const errors: unknown[][] = [];
	// Run the dependency's actual installer against isolated package directories. Only
	// process execution and the registry are simulated; no real install or download runs.
	// Preserve CommonJS scope so the installer's local fetch helper cannot replace
	// globalThis.fetch, and await the postinstall promise before inspecting results.
	const entry = installer.replace("\nimportBun().then(", "\nreturn importBun().then(");
	await runInNewContext(`(function () {\n${entry}\n})()`, {
		__dirname: current.packageRoot,
		require: Object.assign((name: string) => name === "child_process" ? {
			spawnSync(command: string, args: string[]) {
				commands.push(command);
				if (command === "npm") return { status: null, error: new Error("spawnSync npm ENOENT"), stdout: null, stderr: null };
				assert.deepEqual(Array.from(args), ["--version"]);
				return existsSync(command)
					? { status: 0, stdout: readFileSync(command, "utf8"), stderr: "" }
					: { status: null, stdout: null, stderr: null };
			},
		} : require(name), { resolve: require.resolve }),
		process: {
			platform: "win32", arch: "x64", env: { RUNNER_TEMP: current.root },
			exit(code: number) { exitCode = code; },
		},
		console: { error(...values: unknown[]) { errors.push(values); } },
		async fetch(url: string) {
			downloads++;
			assert.equal(url, `https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-${version}.tgz`);
			throw new Error("Offline test registry");
		},
	});
	return { commands, downloads, exitCode, errors };
}

test("Bun installation retains the Windows platform executable across repeated runs", async () => {
	using current = fixture();
	writeFileSync(current.platformExecutable, `${version}\n`);
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = await install(current);
		assert.equal(result.exitCode, 0, JSON.stringify(result.errors));
		assert.equal(result.downloads, 0);
		assert.equal(result.commands.includes("npm"), false);
		assert.equal(readFileSync(current.platformExecutable, "utf8"), `${version}\n`);
		assert.equal(readFileSync(current.installedExecutable, "utf8"), `${version}\n`);
		assert.equal(readFileSync(join(current.packageRoot, "bin/bunx.exe"), "utf8"), `${version}\n`);
	}
});

test("Bun installation reuses the pinned executable after an older installer moved it", async () => {
	using current = fixture();
	writeFileSync(current.installedExecutable, `${version}\n`);
	const result = await install(current);
	assert.equal(result.exitCode, 0, JSON.stringify(result.errors));
	assert.equal(result.downloads, 0);
	assert.equal(result.commands.includes("npm"), false);
	assert.equal(readFileSync(current.installedExecutable, "utf8"), `${version}\n`);
});

test("Bun installation rejects a stale executable and reaches download fallback when npm cannot start", async () => {
	using current = fixture();
	writeFileSync(current.installedExecutable, "0.0.0\n");
	const result = await install(current);
	assert.equal(result.exitCode, 1);
	assert.equal(result.commands.includes("npm"), true);
	assert.equal(result.downloads, 1);
	assert.equal(readFileSync(current.installedExecutable, "utf8"), "0.0.0\n");
});
