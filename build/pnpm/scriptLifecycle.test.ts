import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("aggregate, test and typecheck commands prepare inputs once and stop on preparation failure", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "ash-lifecycle-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"));
	const scripts = { ...manifest.scripts };
	for (const [name, operation] of Object.entries({
		"stylelint": "styles",
		"test:build-tools": "tools",
		"test:unit": "unit",
		"test:unit:prepared": "unit",
		"test:editor:unit": "editor",
		"test:extensions": "extension-tests",
		"test:browser:integration": "browser",
		"test:browser:integration:prepared": "browser",
		"test:editor:browser": "editor-browser",
		"test:editor:browser:build": "browser-build",
		"prepare:output": "output",
		"prepare:extensions": "extensions",
		"localization:generate": "localization",
		"protocol:generate": "protocol",
		"typecheck:protocol": "protocol-check",
		"localization:check": "localization-check",
		"typecheck:common": "common",
		"icons:check": "icons",
		"typecheck:renderer": "renderer",
		"build": "desktop-build",
		"build:prepared": "desktop-build",
		"rebuild:native": "electron-dependencies",
		"prepare:backend": "backend",
		"prepare:backend:web": "backend-web",
		"bundle:web": "bundle-web",
		"bundle:web:full": "bundle-web-full",
		"test:smoke:browser:no-compile": "browser-ui-tests",
		"test:smoke:browser:full:no-compile": "browser-connected-tests",
		"test:smoke:ui:no-compile": "electron-ui-tests",
		"test:smoke:desktop:no-compile": "electron-connected-tests",
	})) scripts[name] = `node record.ts ${operation}`;
	// The direct build owns preparation after its dependency rebuild lifecycle hook.
	scripts.build = 'node build/prepare.ts && node record.ts desktop-build';
	await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", scripts }));
	await writeFile(join(directory, "record.ts"), `
    import { appendFileSync } from 'node:fs';
    appendFileSync('operations.jsonl', JSON.stringify(process.argv[2]) + '\\n');
    if (process.argv[2] === process.env.FAIL_OPERATION) process.exitCode = 1;
  `);
	await mkdir(join(directory, 'build/builtin'), { recursive: true });
	await writeFile(join(directory, 'build/prepare.ts'), `
		import { spawnSync } from 'node:child_process';
		for (const operation of ['protocol', 'localization', 'common', 'extensions', 'icons']) {
			const result = spawnSync(process.execPath, ['record.ts', operation], { stdio: 'inherit' });
			if (result.status !== 0) process.exit(result.status ?? 1);
		}
	`);
	await writeFile(join(directory, 'build/builtin/extensions.ts'), `process.argv[2] = 'extensions'; await import('../../record.ts');`);
	await mkdir(join(directory, 'node_modules/.bin'), { recursive: true });
	const checker = join(directory, 'node_modules/.bin/bun');
	await writeFile(checker, `#!/usr/bin/env node\nprocess.exitCode = require('node:child_process').spawnSync(process.execPath, ['record.ts', 'automation'], { stdio: 'inherit' }).status;\n`);
	await chmod(checker, 0o755);
	await writeFile(`${checker}.cmd`, `@"${process.execPath}" "%~dp0../../record.ts" automation\r\n`);
	const pnpm = process.env.npm_execpath;
	assert.ok(pnpm, "Run through the owning pnpm test script");
	const script = /\.[cm]?js$/.test(pnpm);
	const executable = script ? process.execPath : pnpm;
	const prefix = script ? [pnpm] : [];
	for (const [command, expected, failure] of [
		["test:main", ["styles", "tools", "output", "protocol", "localization", "common", "extensions", "icons", "unit"], ""],
		["test:main", ["styles"], "styles"],
		["test:browser:integration", ["protocol"], "protocol"],
		["test:unit", ["output", "protocol", "localization", "common", "extensions", "icons", "unit"], ""],
		["test:unit:prepared", ["unit"], ""],
		["build:prepared", ["desktop-build"], ""],
		["test:editor:unit", ["output", "protocol", "localization", "common", "extensions", "icons", "editor"], ""],
		["test:extensions", ["output", "protocol", "localization", "common", "extensions", "icons", "extension-tests"], ""],
		["test:browser:integration", ["protocol", "localization", "common", "extensions", "icons", "browser"], ""],
		["test:editor:browser", ["protocol", "localization", "common", "extensions", "icons", "editor-browser"], ""],
		["test:editor:browser:build", ["protocol", "localization", "common", "extensions", "icons", "browser-build"], ""],
		["prepare:extensions", ["protocol", "localization", "extensions"], ""],
		["typecheck:protocol", ["protocol", "protocol-check"], ""],
		["localization:check", ["protocol", "localization-check"], ""],
		["typecheck:common", ["protocol", "localization", "common"], ""],
		["test:browser:integration", ["protocol", "localization"], "localization"],
		["test:main", ["styles", "tools", "output", "protocol", "localization", "common"], "common"],
		["prepare:generated", ["protocol", "localization", "common", "extensions"], "extensions"],
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

	const workflow = await readFile(resolve(import.meta.dirname, '../../.github/workflows/frontend.yml'), 'utf8');
	const smokeSteps = workflow.slice(workflow.indexOf('      - name: Check sources and build Desktop and Web on every platform')).split('      - name: ');
	const checkedBuild = ['protocol', 'localization', 'common', 'extensions', 'icons', 'renderer', 'automation', 'electron-dependencies', 'desktop-build', 'bundle-web'];
	for (const [surface, failure, expected] of [
		['browser', '', [...checkedBuild, 'browser', 'browser-ui-tests', 'bundle-web-full', 'backend-web', 'browser-connected-tests']],
		// CI invokes connected Electron smoke tests separately for the general suite and mock Agent Task coverage.
		['electron', '', [...checkedBuild, 'backend', 'electron-ui-tests', 'bundle-web-full', 'electron-connected-tests', 'electron-connected-tests']],
		['browser', 'renderer', ['protocol', 'localization', 'common', 'extensions', 'icons', 'renderer']],
		['electron', 'backend', [...checkedBuild, 'backend']],
		['electron', 'electron-connected-tests', [...checkedBuild, 'backend', 'electron-ui-tests', 'bundle-web-full', 'electron-connected-tests']],
	] as const) {
		await writeFile(join(directory, 'operations.jsonl'), '');
		const commands = smokeSteps.filter(step => step.startsWith('Check sources and build Desktop and Web on every platform') || step.includes(`if: matrix.surface == '${surface}'`)).flatMap(step => {
			const run = step.match(/^        run: (.+)$/m)?.[1];
			assert.ok(run, step);
			return run === '|' ? [...step.matchAll(/^          (pnpm .+)$/gm)].map(match => match[1]) : [run];
		});
		let status: number | null = 0;
		for (const command of commands) {
			assert.match(command, /^pnpm (run|exec) /);
			const result = spawnSync(executable, [...prefix, ...command.split(' ').slice(1)], {
				cwd: directory, env: { ...process.env, FAIL_OPERATION: failure }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
			});
			assert.equal(result.error, undefined);
			status = result.status;
			if (status !== 0) break;
		}
		assert.equal(status, failure ? 1 : 0);
		const operations = (await readFile(join(directory, 'operations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.deepEqual(operations, expected, `${surface} smoke preparation (${failure || 'success'})`);
	}
});
