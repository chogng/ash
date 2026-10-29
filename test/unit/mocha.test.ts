import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import ts from 'typescript';

const desktopDirectory = resolve(import.meta.dirname, '../..');
// Keep synthetic fixtures independent of compiler output size and cleanup.
const outputDirectory = mkdtempSync(join(desktopDirectory, '.build/desktop/runner-fixtures-'));
const compiledDirectory = resolve(desktopDirectory, '.build/desktop/test');
const copiedModules = new Set<string>();
// The real theme preload still needs its emitted module closure in each snapshot.
for (const module of [
	'src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js',
	'src/ash/platform/extensions/common/extensionApi.js',
	'src/ash/base/common/buffer.js',
	'src/ash/workbench/services/extensions/browser/extensionColorThemeService.js',
])
	copyBootstrapModule(resolve(compiledDirectory, module));

function copyBootstrapModule(source: string): void {
	if (copiedModules.has(source)) return;
	copiedModules.add(source);
	const target = resolve(outputDirectory, relative(compiledDirectory, source));
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(source, target);
	const module = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
	for (const statement of module.statements) {
		if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
		const specifier = statement.moduleSpecifier;
		if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
			copyBootstrapModule(resolve(dirname(source), specifier.text));
		}
	}
}

const runnerEnvironment = { ...process.env, ASH_UNIT_TEST_OUTPUT_DIRECTORY: outputDirectory };
const parent = join(outputDirectory, 'test/unit');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'runner-'));
after(() => rmSync(outputDirectory, { recursive: true, force: true }));
writeFileSync(
	join(directory, 'first.test.js'),
	`import { test } from 'mocha';
test('selected behavior', () => {});
test('deliberate failure', () => { throw new Error('runner regression sentinel'); });
test.skip('pending behavior', () => {});
`,
);
writeFileSync(
	join(directory, 'second.test.js'),
	`import { test } from 'mocha';
test('other behavior', () => {});
`,
);
const first = relative(outputDirectory, join(directory, 'first.test.js')).replaceAll('\\', '/');
const second = relative(outputDirectory, join(directory, 'second.test.js')).replaceAll('\\', '/');
const requiredRunner = join(directory, 'required.ts');
const runnerImport = relative(directory, resolve(desktopDirectory, 'test/unit/mocha.ts')).replaceAll('\\', '/');
writeFileSync(
	requiredRunner,
	`import { runUnitTests } from ${JSON.stringify(runnerImport)};
await runUnitTests(${JSON.stringify([first, 'test/unit/missing-required.test.js'])}, false);
`,
);

function run(args: readonly string[], entrypoint = 'test/unit/run.ts', compiledOutput = outputDirectory): { status: number | null; output: string } {
	const result = spawnSync(process.execPath, [entrypoint, ...args], {
		cwd: desktopDirectory,
		encoding: 'utf8',
		timeout: 15_000,
		windowsHide: true,
		env: { ...runnerEnvironment, ASH_UNIT_TEST_OUTPUT_DIRECTORY: compiledOutput },
	});
	if (result.error) {
		throw result.error;
	}
	return { status: result.status, output: result.stdout + result.stderr };
}

test('unit runner sources use syntax supported by Node type stripping', () => {
	// The typecheck also follows frontend type imports whose implementations are
	// compiled separately. Node's syntax restriction belongs to the runner files.
	for (const file of readdirSync(import.meta.dirname).filter(file => file.endsWith('.ts'))) {
		assert.doesNotThrow(() => stripTypeScriptTypes(readFileSync(join(import.meta.dirname, file), 'utf8')), file);
	}
});

test('a missing required file fails even when another required file exists', () => {
	const result = run([], requiredRunner);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /No compiled unit tests matched the required pattern: test\/unit\/missing-required.test.js/);
	assert.doesNotMatch(result.output, /Mocha: .*tests executed/);
});

test('a filter may select a test in only one of multiple isolated files', () => {
	const result = run(['--run', first, '--run', second, '--grep', '^selected behavior$']);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /1 tests executed across 2 files; 0 failed files/);
});

test('default discovery and source filters include extension-owned units alongside host and architecture units', () => {
	const paths = ['src/ash/base/test/common/discovery.test.js', 'test/architecture/discovery.test.js', 'extensions/fixture/test/common/discovery.test.js'];
	for (const path of paths) {
		const target = join(outputDirectory, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `import { test } from 'mocha'; test('owner discovery', () => {});`);
	}
	const discovered = run([]);
	assert.equal(discovered.status, 0, discovered.output);
	assert.match(discovered.output, /3 tests executed across 3 files; 0 failed files/);
	const selected = run(['--run', paths[2].replace(/\.js$/u, '.ts')]);
	assert.equal(selected.status, 0, selected.output);
	assert.match(selected.output, /1 tests executed across 1 files; 0 failed files/);
	const affected = run(['--affected', 'HEAD']);
	assert.equal(affected.status, 0, affected.output);
	assert.match(affected.output, /Unit test impact: full suite;/u);
	assert.match(affected.output, /3 tests executed across 3 files; 0 failed files/u);
});

test('invalid unit filters fail before copying outputs or starting the selected file', () => {
	for (const args of [
		['--grep', ''],
		['--grep', '   '],
		['--grepp', 'selected'],
		['--', '--grep', 'selected'],
		['--workers', '0'],
		['--workers', '-1'],
		['--workers', '1.5'],
		['--workers', 'NaN'],
	]) {
		const result = run(['--run', first, ...args], 'test/unit/run.ts', join(directory, 'missing-compiler-output'));
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /Missing value for --grep|nonempty pattern|Unsupported unit test option|Invalid worker count/);
		assert.doesNotMatch(result.output, /tests executed|runner regression sentinel/);
	}
});

test('affected selection rejects conflicting filters and incomplete revisions before copying outputs', () => {
	for (const args of [
		['--affected', 'HEAD', '--run', first],
		['--affected', 'HEAD', '--runGlob', '**/*.js'],
		['--affected', ''],
		['--affected', '--grep', 'x'],
		['--affected', 'HEAD', '--affected', 'HEAD'],
	]) {
		const result = run(args, 'test/unit/run.ts', join(directory, 'missing-compiler-output'));
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /--affected (?:requires|cannot)|Missing value for --affected/u);
		assert.doesNotMatch(result.output, /tests executed|runner regression sentinel/);
	}
});

test('exclusive tests fail instead of silently dropping their siblings', () => {
	const exclusive = join(directory, 'exclusive.test.js');
	writeFileSync(exclusive, `import { test } from 'mocha'; test.only('exclusive', () => {}); test('sibling', () => { throw Error('missed sibling'); });`);
	const result = run(['--run', relative(outputDirectory, exclusive).replaceAll('\\', '/')]);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /ERR_MOCHA_FORBIDDEN_EXCLUSIVITY/);
});

test('all selected paths are validated before any test starts', () => {
	const result = run(['--run', first, '--run', 'test/unit/missing.test.js']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /Compiled unit test does not exist/);
	assert.doesNotMatch(result.output, /runner regression sentinel|tests executed/);
});

test('workers overlap isolated files without starting beyond their limit', { timeout: 20_000 }, async t => {
	const release = join(directory, 'pool-release');
	const fixtures = [0, 1, 2].map(index => {
		const path = join(directory, `pool-${index}.test.js`);
		writeFileSync(
			path,
			`
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'mocha';
test('isolated file ${index}', async () => {
 assert.equal(globalThis.unitPoolOwner, undefined);
 globalThis.unitPoolOwner = ${index};
 writeFileSync(${JSON.stringify(join(directory, `pool-ready-${index}`))}, 'ready');
 while (!existsSync(${JSON.stringify(release)})) await setTimeout(25);
 assert.equal(globalThis.unitPoolOwner, ${index});
});
`,
		);
		return relative(outputDirectory, path).replaceAll('\\', '/');
	});
	const child = spawn(process.execPath, ['test/unit/run.ts', '--workers', '2', ...fixtures.flatMap(path => ['--run', path])], {
		cwd: desktopDirectory,
		env: runnerEnvironment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.on('data', chunk => {
		output += chunk;
	});
	child.stderr.on('data', chunk => {
		output += chunk;
	});
	const stopped = new Promise<number | null>((resolveExit, reject) => {
		child.once('error', reject);
		child.once('close', resolveExit);
	});
	t.after(async () => {
		if (child.exitCode === null) child.kill('SIGTERM');
		await stopped;
	});
	const deadline = Date.now() + 10_000;
	while (![0, 1].every(index => existsSync(join(directory, `pool-ready-${index}`))) && Date.now() < deadline) {
		await new Promise(resolveWait => setTimeout(resolveWait, 25));
		if (child.exitCode !== null) throw new Error(output);
	}
	assert.ok(
		[0, 1].every(index => existsSync(join(directory, `pool-ready-${index}`))),
		output,
	);
	assert.equal(existsSync(join(directory, 'pool-ready-2')), false, 'A third file exceeded the two-worker limit');
	writeFileSync(release, 'continue');
	assert.equal(await stopped, 0, output);
	assert.match(output, /3 tests executed across 3 files; 0 failed files/);
});

test('a filter matching no tests fails the run', () => {
	const result = run(['--run', first, '--grep', '^missing behavior$']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /No unit tests executed/);
});

test('an executed assertion failure fails the run and retains its diagnostic', () => {
	const result = run(['--run', first, '--grep', '^deliberate failure$']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /runner regression sentinel/);
	assert.match(result.output, /1 tests executed across 1 files; 1 failed files/);
});

for (const origin of ['page', 'popup', 'teardown'] as const) {
	test(`browser ${origin} exceptions fail teardown, retain a trace and leave sibling suites clean`, () => {
		const fixture = join(directory, `browser-errors-${origin}.test.js`);
		const results = join(directory, `browser-errors-${origin}`);
		writeFileSync(
			fixture,
			`
import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { useBrowserTests } from ${JSON.stringify(pathToFileURL(resolve(desktopDirectory, 'test/unit/browser/context.ts')).href)};
process.env.ASH_BROWSER_UNIT_BASE_URL = 'http://127.0.0.1:1';
process.env.ASH_BROWSER_UNIT_RESULTS = ${JSON.stringify(results)};
suite('browser exception', () => {
 const browser = useBrowserTests();
 async function provoke() {
  const page = ${origin === 'popup' ? 'await browser.context.newPage()' : 'browser.page'};
  const error = page.waitForEvent('pageerror');
  await page.evaluate(() => { setTimeout(() => { throw new Error('browser ${origin} sentinel'); }, 0); });
  assert.equal((await error).message, 'browser ${origin} sentinel');
 }
 ${origin === 'teardown' ? 'teardown(provoke);' : ''}
 test('reaches the deliberate exception', async () => {
  ${origin === 'teardown' ? '' : 'await provoke();'}
 });
});
suite('clean sibling', () => {
 const browser = useBrowserTests();
 test('has no inherited exceptions', async () => {
  await browser.page.setContent('<button>Clean sibling</button>');
  assert.equal(await browser.page.locator('button').textContent(), 'Clean sibling');
 });
});
`,
		);
		const result = run(['--ui', 'tdd', '--timeout', '10000', fixture], 'node_modules/mocha/bin/mocha.js');
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, new RegExp(`browser ${origin} sentinel`));
		assert.match(result.output, /Unhandled browser errors/);
		assert.match(result.output, /has no inherited exceptions/);
		assert.match(result.output, /1 failing/);
		assert.equal(readdirSync(results, { recursive: true }).filter(path => path.toString().endsWith('trace.zip')).length, 1);
	});
}

test('a selection containing only skipped tests fails the run', () => {
	const result = run(['--run', first, '--grep', '^pending behavior$']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /No unit tests executed/);
});

test('a running suite retains its modules after the shared compiler output is cleaned', { timeout: 20_000 }, async t => {
	const ready = join(directory, 'snapshot-ready');
	const release = join(directory, 'snapshot-release');
	const waiting = join(directory, 'snapshot.test.js');
	const dependency = join(directory, 'snapshot-dependency.js');
	writeFileSync(dependency, 'export const value = 42;');
	writeFileSync(
		waiting,
		`
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'mocha';
test('retains a dependency loaded after cleanup', async () => {
 writeFileSync(${JSON.stringify(ready)}, 'ready');
 while (!existsSync(${JSON.stringify(release)})) await setTimeout(25);
 assert.equal((await import('./snapshot-dependency.js')).value, 42);
});
`,
	);
	const child = spawn(process.execPath, ['test/unit/run.ts', '--run', relative(outputDirectory, waiting).replaceAll('\\', '/')], {
		cwd: desktopDirectory,
		env: runnerEnvironment,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.on('data', chunk => {
		output += chunk;
	});
	child.stderr.on('data', chunk => {
		output += chunk;
	});
	const stopped = new Promise<number | null>((resolveExit, reject) => {
		child.once('error', reject);
		child.once('close', resolveExit);
	});
	t.after(async () => {
		if (child.exitCode === null) child.kill('SIGTERM');
		await stopped;
	});
	const deadline = Date.now() + 10_000;
	while (!existsSync(ready) && Date.now() < deadline) {
		await new Promise(resolveWait => setTimeout(resolveWait, 25));
		if (child.exitCode !== null) throw new Error(output);
	}
	assert.ok(existsSync(ready), output);
	rmSync(waiting);
	rmSync(dependency);
	writeFileSync(release, 'continue');
	assert.equal(await stopped, 0, output);
	assert.match(output, /1 tests executed across 1 files; 0 failed files/);
});

for (const [signal, code] of [
	['SIGINT', 130],
	['SIGTERM', 143],
] as const) {
	test(`${signal} stops all concurrent Mocha descendants and leaves queued files unstarted`, { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
		const markers = [0, 1].map(index => join(directory, `ready-${signal}-${index}`));
		const later = join(directory, `later-${signal}`);
		const waiting = [0, 1].map(index => join(directory, `0${index}-waiting-${signal}.test.js`));
		const following = join(directory, `02-following-${signal}.test.js`);
		for (const [index, path] of waiting.entries()) {
			const marker = markers[index];
			writeFileSync(
				path,
				`
import { test } from 'mocha';
import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
test('waiting', async function() {
 this.timeout(120000);
 const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
 await new Promise(resolveReady => child.once('message', resolveReady));
 // The parent polls for existence; expose the marker only after its JSON is complete.
 await writeFile(${JSON.stringify(marker + '.tmp')}, JSON.stringify([process.pid, child.pid]));
 await rename(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)});
 await new Promise(() => {});
});
`,
			);
		}
		writeFileSync(following, `import { test } from 'mocha'; import { writeFileSync } from 'node:fs'; test('must not start', () => writeFileSync(${JSON.stringify(later)}, 'ran'));`);
		const paths = [...waiting, following].map(path => relative(outputDirectory, path).replaceAll('\\', '/'));
		const child = spawn(process.execPath, ['test/unit/run.ts', '--workers', '2', ...paths.flatMap(path => ['--run', path])], {
			cwd: desktopDirectory,
			env: runnerEnvironment,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		child.stdout.on('data', chunk => {
			output += chunk;
		});
		child.stderr.on('data', chunk => {
			output += chunk;
		});
		const stopped = new Promise<number | null>((resolveExit, reject) => {
			child.once('error', reject);
			child.once('close', resolveExit);
		});
		let pids: number[] = [];
		t.after(async () => {
			for (const pid of [child.pid, ...pids])
				if (pid)
					try {
						process.kill(pid, 'SIGKILL');
					} catch (error) {
						if (error.code !== 'ESRCH') throw error;
					}
			await stopped;
		});
		const deadline = Date.now() + 10_000;
		while (!markers.every(marker => existsSync(marker)) && Date.now() < deadline) {
			await new Promise(resolveWait => setTimeout(resolveWait, 25));
			if (child.exitCode !== null) throw new Error(output);
		}
		assert.ok(
			markers.every(marker => existsSync(marker)),
			output,
		);
		pids = (await Promise.all(markers.map(async marker => JSON.parse(await readFile(marker, 'utf8')) as number[]))).flat();
		child.kill(signal);
		assert.equal(await stopped, code, output);
		assert.equal(existsSync(later), false, 'Another test file started after cancellation');
		for (const pid of pids) {
			const result = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat=']).catch(error => {
				if (error.code === 1) return { stdout: '' };
				throw error;
			});
			assert.ok(!result.stdout.trim() || result.stdout.trim().startsWith('Z'), `Leaked Mocha PID ${pid}`);
		}
	});
}
