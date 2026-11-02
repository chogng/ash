import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('aggregate, test and typecheck commands prepare inputs once and stop on preparation failure', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-lifecycle-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../../package.json'), 'utf8'));
	assert.equal(manifest.scripts['test:unit:no-compile'], 'node test/unit/run.ts');
	assert.equal(manifest.scripts['test:editor:unit:no-compile'], 'node test/unit/editor.ts');
	assert.equal(manifest.scripts['test:unit:runner'], 'node --test test/unit/impact.test.ts test/unit/mocha.test.ts');
	for (const name of ['test:unit', 'test:unit:prepared']) {
		assert.doesNotMatch(manifest.scripts[name], /mocha\.test\.ts/);
	}
	for (const name of ['test:unit', 'test:editor:unit', 'test:extensions']) {
		assert.equal(manifest.scripts[`pre${name}`], undefined, 'Selection must run before preparation');
	}
	const scripts = { ...manifest.scripts };
	for (const [name, operation] of Object.entries({
		stylelint: 'styles',
		'test:build-tools': 'tools',
		'test:unit:runner': 'unit-runner',
		'test:unit:no-compile': 'unit-reuse',
		'test:editor:unit:no-compile': 'editor-reuse',
		'test:browser:integration': 'browser',
		'test:browser:integration:prepared': 'browser',
		'test:editor:browser': 'editor-browser',
		'test:editor:browser:build': 'browser-build',
		'prepare:output': 'output',
		'prepare:extensions': 'extensions',
		'localization:generate': 'localization',
		'protocol:generate': 'protocol',
		'typecheck:protocol': 'protocol-check',
		'localization:check': 'localization-check',
		'typecheck:common': 'common',
		'icons:check': 'icons',
		'typecheck:renderer': 'renderer',
		build: 'desktop-build',
		'build:prepared': 'desktop-build',
		'prepare:desktop-addons': 'electron-dependencies',
		'prepare:electron': 'electron-runtime',
		'prepare:backend': 'backend',
		'prepare:backend:web': 'backend-web',
		'bundle:web': 'bundle-web',
		'bundle:web:full': 'bundle-web-full',
		'test:smoke:browser:no-compile': 'browser-ui-tests',
		'test:smoke:browser:full:no-compile': 'browser-connected-tests',
		'test:smoke:ui:no-compile': 'electron-ui-tests',
		'test:smoke:ui': 'electron-ui-tests',
		'test:smoke:desktop:no-compile': 'electron-connected-tests',
	}))
		scripts[name] = `node record.ts ${operation}`;
	// The direct build owns generated inputs after its addon preparation hook.
	scripts.build = 'node build/prepare.ts && node record.ts desktop-build';
	scripts['protocol:generate'] = 'node recordProtocol.ts';
	await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts }));
	await writeFile(join(directory, 'record.ts'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync('operations.jsonl', JSON.stringify(process.argv[2]) + '\\n');
    if (process.argv[2] === process.env.FAIL_OPERATION) process.exitCode = 1;
  `);
	await writeFile(join(directory, 'recordProtocol.ts'), `process.argv[2] = process.argv.includes('--no-build') ? 'protocol' : 'protocol-export'; await import('./record.ts');`);
	await mkdir(join(directory, 'build/builtin'), { recursive: true });
	await writeFile(join(directory, 'build/prepare.ts'), `
		import { spawnSync } from 'node:child_process';
		for (const operation of ['protocol', 'localization', 'common', 'extensions', 'icons']) {
			const result = spawnSync(process.execPath, ['record.ts', operation], { stdio: 'inherit' });
			if (result.status !== 0) process.exit(result.status ?? 1);
		}
	`);
	await writeFile(join(directory, 'build/builtin/extensions.ts'), `process.argv[2] = 'extensions'; await import('../../record.ts');`);
	// Exercise the real unit runner's preparation ordering with cheap child programs.
	// The surrounding pnpm lifecycle tests must not replace the runner itself.
	const root = resolve(import.meta.dirname, '../..');
	for (const path of ['test/unit/browser', 'build/desktop', 'node_modules/mocha/bin', 'node_modules/@ash/typescript-compiler/bin', '.build/desktop/test/src', 'src/ash/base/common/marked', 'src/ash/base/browser/dompurify']) {
		await mkdir(join(directory, path), { recursive: true });
	}
	for (const name of ['mocha', 'coverage']) await copyFile(join(root, `test/unit/${name}.ts`), join(directory, `test/unit/${name}.ts`));
	await copyFile(join(root, 'build/processes.ts'), join(directory, 'build/processes.ts'));
	await copyFile(join(root, '.nvmrc'), join(directory, '.nvmrc'));
	await writeFile(join(directory, 'test/unit/impactWorker.ts'), `
		export function planAffectedTests(root, base) {
			if (base === 'empty') return { files: [], full: false, reason: 'no changed inputs' };
			throw new Error('Unexpected impact analysis');
		}
	`);
	await writeFile(join(directory, 'test/unit/browser/server.ts'), `export function startBrowserUnitServer() { throw new Error('Unexpected browser launch'); }`);
	await writeFile(join(directory, 'test/unit/prepare.ts'), '');
	for (const preload of ['ignore-css-imports', 'theme-resources']) await writeFile(join(directory, `test/unit/${preload}.ts`), '');
	for (const asset of ['src/ash/base/common/marked/marked.js', 'src/ash/base/browser/dompurify/dompurify.js']) await writeFile(join(directory, asset), '');
	await writeFile(join(directory, 'build/desktop/build.ts'), `process.argv[2] = 'output'; await import('../../record.ts');`);
	await writeFile(join(directory, 'node_modules/@ash/typescript-compiler/bin/tsc'), `process.argv[2] = 'compile-tests'; await import('../../../../record.ts');`);
	await writeFile(join(directory, 'node_modules/mocha/package.json'), '{"type":"module"}');
	await writeFile(join(directory, 'node_modules/mocha/bin/mocha.js'), `
		import { writeFileSync } from 'node:fs';
		import { basename } from 'node:path';
		writeFileSync(process.argv.find(value => value.startsWith('countFile=')).slice('countFile='.length), '1');
		process.argv[2] = basename(process.argv.at(-1), '.test.js');
		await import('../../../record.ts');
	`);
	for (const [entry, operation] of [['run', 'unit'], ['editor', 'editor'], ['extensions', 'extension-tests']]) {
		await writeFile(join(directory, 'src', `${operation}.test.ts`), 'export {};');
		await writeFile(join(directory, '.build/desktop/test/src', `${operation}.test.js`), '');
		await writeFile(join(directory, `test/unit/${entry}.ts`), `import { runUnitTests } from './mocha.ts'; await runUnitTests(['src/${operation}.test.js'], false);`);
	}
	await mkdir(join(directory, 'node_modules/.bin'), { recursive: true });
	const checker = join(directory, 'node_modules/.bin/bun');
	await writeFile(checker, `#!/usr/bin/env node\nprocess.exitCode = require('node:child_process').spawnSync(process.execPath, ['record.ts', 'automation'], { stdio: 'inherit' }).status;\n`);
	await chmod(checker, 0o755);
	await writeFile(`${checker}.cmd`, `@"${process.execPath}" "%~dp0../../record.ts" automation\r\n`);
	const pnpm = process.env.npm_execpath;
	assert.ok(pnpm, 'Run through the owning pnpm test script');
	const script = /\.[cm]?js$/.test(pnpm);
	const executable = script ? process.execPath : pnpm;
	const prefix = script ? [pnpm] : [];
	for (const [args, status, diagnostic] of [
		[['--plan', '--run', 'src/unit.test.ts'], 0, /Unit test plan: 1 files/u],
		[['--affected', 'empty'], 0, /Unit tests skipped: no affected test files/u],
		[['--runGlob', '**/absent.test.js'], 1, /No unit tests matched/u],
		[['--grep', ''], 1, /Missing value for --grep/u],
	] as const) {
		await writeFile(join(directory, 'operations.jsonl'), '');
		const result = spawnSync(executable, [...prefix, 'run', 'test:unit', ...args], {
			cwd: directory, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, status, result.stdout + result.stderr);
		assert.match(result.stdout + result.stderr, diagnostic);
		assert.equal(await readFile(join(directory, 'operations.jsonl'), 'utf8'), '', 'Planning, skipping and invalid filters must not prepare or compile');
	}
	for (const [command, expected, failure] of [
		['build', ['electron-runtime', 'electron-dependencies', 'protocol', 'localization', 'common', 'extensions', 'icons', 'desktop-build'], ''],
		['build', ['electron-runtime'], 'electron-runtime'],
		['build', ['electron-runtime', 'electron-dependencies'], 'electron-dependencies'],
		['test:main', ['styles', 'tools', 'output', 'protocol', 'localization', 'common', 'extensions', 'icons', 'compile-tests', 'unit', 'unit-runner'], ''],
		['test:main', ['styles', 'tools', 'output', 'protocol', 'localization', 'common', 'extensions', 'icons', 'compile-tests', 'unit'], 'unit'],
		['test:main', ['styles'], 'styles'],
		['test:browser:integration', ['protocol'], 'protocol'],
		['test:unit', ['output', 'protocol', 'localization', 'common', 'extensions', 'icons', 'compile-tests', 'unit'], ''],
		['test:unit', ['output', 'protocol'], 'protocol'],
		['test:unit', ['output', 'protocol', 'localization', 'common', 'extensions', 'icons', 'compile-tests'], 'compile-tests'],
		['test:unit:prepared', ['compile-tests', 'unit'], ''],
		['test:unit:no-compile', ['unit-reuse'], ''],
		['test:unit:no-compile', ['unit-reuse'], 'unit-reuse'],
		['test:editor:unit:no-compile', ['editor-reuse'], ''],
		['build:prepared', ['desktop-build'], ''],
		['test:editor:unit', ['output', 'protocol', 'localization', 'common', 'extensions', 'icons', 'compile-tests', 'editor'], ''],
		['test:extensions', ['output', 'protocol', 'localization', 'common', 'extensions', 'icons', 'compile-tests', 'extension-tests'], ''],
		['test:browser:integration', ['protocol', 'localization', 'common', 'extensions', 'icons', 'browser'], ''],
		['test:editor:browser', ['protocol', 'localization', 'common', 'extensions', 'icons', 'editor-browser'], ''],
		['test:editor:browser:build', ['protocol', 'localization', 'common', 'extensions', 'icons', 'browser-build'], ''],
		['test:smoke:ui', ['electron-runtime', 'electron-dependencies', 'protocol', 'localization', 'common', 'extensions', 'icons', 'desktop-build', 'automation', 'electron-ui-tests'], ''],
		['prepare:extensions', ['protocol', 'localization', 'extensions'], ''],
		['typecheck:protocol', ['protocol', 'protocol-check'], ''],
		['localization:check', ['protocol', 'localization-check'], ''],
		['typecheck:common', ['protocol', 'localization', 'common'], ''],
		['test:browser:integration', ['protocol', 'localization'], 'localization'],
		['test:main', ['styles', 'tools', 'output', 'protocol', 'localization', 'common'], 'common'],
		['prepare:generated', ['protocol', 'localization', 'common', 'extensions'], 'extensions'],
	] as const) {
		await writeFile(join(directory, 'operations.jsonl'), '');
		const result = spawnSync(executable, [...prefix, 'run', command], {
			cwd: directory,
			env: { ...process.env, FAIL_OPERATION: failure },
			encoding: 'utf8',
			windowsHide: true,
			timeout: 30_000,
		});
		assert.equal(result.error, undefined);
		if (failure) assert.notEqual(result.status, 0);
		else assert.equal(result.status, 0, result.stdout + result.stderr);
		const operations = (await readFile(join(directory, 'operations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.deepEqual(operations, expected, command);
	}

	const workflow = await readFile(resolve(import.meta.dirname, '../../.github/workflows/frontend.yml'), 'utf8');
	const smokeSteps = workflow.slice(workflow.indexOf('      - name: Check sources and build Desktop and Web on every platform')).split('      - name: ');
	const checkedBuild = ['protocol-export', 'protocol', 'localization', 'common', 'extensions', 'icons', 'renderer', 'automation', 'electron-runtime', 'electron-dependencies', 'desktop-build', 'bundle-web'];
	for (const [surface, failure, expected] of [
		['browser', '', [...checkedBuild, 'browser', 'browser-ui-tests', 'bundle-web-full', 'backend-web', 'browser-connected-tests']],
		// CI invokes connected Electron smoke tests separately for the general suite and mock Agent Task coverage.
		['electron', '', [...checkedBuild, 'electron-ui-tests', 'bundle-web-full', 'backend', 'electron-connected-tests', 'electron-connected-tests']],
		['browser', 'renderer', ['protocol-export', 'protocol', 'localization', 'common', 'extensions', 'icons', 'renderer']],
		['electron', 'backend', [...checkedBuild, 'electron-ui-tests', 'bundle-web-full', 'backend']],
		['electron', 'electron-connected-tests', [...checkedBuild, 'electron-ui-tests', 'bundle-web-full', 'backend', 'electron-connected-tests']],
	] as const) {
		await writeFile(join(directory, 'operations.jsonl'), '');
		const commands = smokeSteps.filter(step => step.startsWith('Check sources and build Desktop and Web on every platform') || step.includes(`if: matrix.surface == '${surface}'`)).flatMap(step => {
			const run = step.match(/^        run: (.+)$/m)?.[1];
			assert.ok(run, step);
			return run === '|' ? [...step.matchAll(/^          ((?:pnpm |node |\.\/node_modules\/\.bin\/bun ).+)$/gm)].map(match => match[1]) : [run];
		});
		let status: number | null = 0;
		for (const command of commands) {
			// CI's direct generator/checker invocations participate in the same
			// ordering and failure checks as its pnpm lifecycle commands.
			const pnpmCommand = command.startsWith('pnpm ');
			const args = pnpmCommand ? [...prefix, ...command.split(' ').slice(1)]
				: command.startsWith('node ') ? command.split(' ').slice(1)
					: ['record.ts', command.includes('tsconfig.renderer.json') ? 'renderer' : 'automation'];
			const result = spawnSync(pnpmCommand ? executable : process.execPath, args, {
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
