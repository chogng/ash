import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("product build and launch tools have one owner while repository scripts remain shared", () => {
	for (const directory of ["src/scripts", "scripts/desktop", "scripts/code", "build/remote", "app-rs", "app-ts", "ash-rs", "ash-cli", "code"]) {
		const path = join(repositoryRoot, directory);
		assert.equal(existsSync(path), false, `${directory} must not own product tooling`);
	}
	assert.equal(existsSync(join(repositoryRoot, "cli/Cargo.toml")), true);
	for (const category of ["desktop", "code", "runtime", "download", "lib", "pnpm", "darwin", "win32", "linux", "resources"]) {
		assert.equal(existsSync(join(import.meta.dirname, category)), true, category);
	}
	assert.equal(existsSync(join(repositoryRoot, "crates/tui/Cargo.toml")), true);
	for (const entry of ["cargo.py", "format.py", "test-python.py"]) {
		assert.equal(existsSync(join(repositoryRoot, "scripts", entry)), true, entry);
	}
	for (const entry of ["electron.ts", "web.ts", "electron.test.ts"]) {
		assert.equal(existsSync(join(import.meta.dirname, "desktop/launch", entry)), true, entry);
		assert.equal(existsSync(join(repositoryRoot, "scripts", entry)), false, entry);
	}
	assert.equal(existsSync(join(repositoryRoot, "test/unit/mocha.ts")), true);
	for (const entry of ["code/build.py", "runtime/build.py", "runtime/prepare.py"]) {
		assert.equal(existsSync(join(import.meta.dirname, entry)), true, entry);
	}
	for (const entry of ["run.py", "run_package.py", "install.sh", "install.ps1"]) {
		assert.equal(existsSync(join(import.meta.dirname, "code", entry)), true, entry);
	}
	assert.equal(existsSync(join(import.meta.dirname, "code/package.py")), true);
	assert.equal(existsSync(join(import.meta.dirname, "code/update-sign/Cargo.toml")), true);
	assert.equal(existsSync(join(import.meta.dirname, "runtime/update-sign")), false);
	for (const retiredEntry of ["cargo_with_v8.py", "lib/just_shell.py", "compile.ts", "watch.ts", "vite", "lib/compilation.ts", "lib/appServer.ts", "lib/web.ts"]) {
		assert.equal(existsSync(join(import.meta.dirname, retiredEntry)), false, retiredEntry);
	}
	for (const entry of ["build.ts", "host.ts", "watch-app-server.ts", "appServer.ts", "web.ts", "vite/vite.config.ts"]) {
		assert.equal(existsSync(join(import.meta.dirname, "desktop", entry)), true, entry);
	}
	for (const entry of ["compile.ts", "compilation.ts", "watch.ts"]) {
		assert.equal(existsSync(join(import.meta.dirname, "desktop", entry)), false, entry);
	}
});

test("frontend Node tools and backend package builders have separate language owners", () => {
	for (const directory of ["desktop", "pnpm", "protocol", "resources"]) {
		assert.deepEqual(walk(join(import.meta.dirname, directory)).filter(path => extname(path) === ".py"), [], directory);
	}
	for (const directory of ["runtime", "code", "download", "lib", "darwin", "win32", "linux"]) {
		const files = walk(join(import.meta.dirname, directory)).filter(path => extname(path) === ".ts");
		const cssTooling = new Set([
			join(import.meta.dirname, 'lib/stylelint/validateVariableNames.ts'),
			join(import.meta.dirname, 'lib/stylelint/validateHasSelectors.ts'),
			join(import.meta.dirname, 'lib/stylelint/validateDesignTokens.ts'),
			join(import.meta.dirname, 'lib/test/stylelint.test.ts'),
		]);
		assert.deepEqual(files.filter(path => !cssTooling.has(path)), [], directory);
	}
	const scripts = join(repositoryRoot, "scripts");
	assert.deepEqual(readdirSync(scripts, { withFileTypes: true }).filter(entry => entry.isFile() && extname(entry.name) === ".ts").map(entry => entry.name), []);
});

test("Node build and repository command sources do not use runtime JavaScript", () => {
	const javaScriptExtensions = new Set([".cjs", ".js", ".mjs", ".mts"]);
	const files = [...walk(import.meta.dirname), ...walk(join(repositoryRoot, "scripts"))];
	assert.deepEqual(files.filter((path) => javaScriptExtensions.has(extname(path))), []);
});

test("build tools do not import repository command implementations", () => {
	for (const path of walk(import.meta.dirname).filter((path) => extname(path) === ".py")) {
		assert.doesNotMatch(readFileSync(path, "utf8"), /^\s*(?:from scripts(?:\.|\s)|import scripts(?:\.|\s|$))/m, path);
	}
	for (const path of walk(import.meta.dirname).filter(path => extname(path) === '.ts' && !path.endsWith('.test.ts'))) {
		assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s*|import\s*\()\s*["'][^"']*\/scripts\//u, path);
	}
	const runtime = join(repositoryRoot, 'src/ash/platform/app-server/node');
	for (const path of walk(runtime).filter(path => extname(path) === '.ts')) {
		assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s*|import\s*\()\s*["'][^"']*\/(?:build|scripts)\//u, path);
	}
});

function walk(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name === ".venv") return [];
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}


test('build product identity loads without frontend runtime or settings migration modules', () => {
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ load(url, context, nextLoad) {
      if (url.includes('/src/')) loaded.push(url);
      return nextLoad(url, context);
    } });
    const { AshSessionsRendererEntry } = await import('./src/ash/code/common/application.ts');
    assert.equal(AshSessionsRendererEntry, 'sessions-code');
    assert.deepEqual(loaded.map(url => url.split('/').at(-1)), ['application.ts']);
  `], { cwd: repositoryRoot, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
});
