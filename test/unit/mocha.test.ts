import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';

const desktopDirectory = resolve(import.meta.dirname, '../..');
// Runner fixtures belong to this self-test, outside the shared compiler cleanup.
const outputDirectory = mkdtempSync(join(desktopDirectory, '.build/desktop/runner-fixtures-'));
cpSync(resolve(desktopDirectory, '.build/desktop/test'), outputDirectory, { recursive: true });
const runnerEnvironment = { ...process.env, ASH_UNIT_TEST_OUTPUT_DIRECTORY: outputDirectory };
const parent = join(outputDirectory, 'test/unit');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'runner-'));
after(() => rmSync(outputDirectory, { recursive: true, force: true }));
writeFileSync(join(directory, 'first.test.js'), `import { test } from 'mocha';
test('selected behavior', () => {});
test('deliberate failure', () => { throw new Error('runner regression sentinel'); });
test.skip('pending behavior', () => {});
`);
writeFileSync(join(directory, 'second.test.js'), `import { test } from 'mocha';
test('other behavior', () => {});
`);
const first = relative(outputDirectory, join(directory, 'first.test.js')).replaceAll('\\', '/');
const second = relative(outputDirectory, join(directory, 'second.test.js')).replaceAll('\\', '/');
const requiredRunner = join(directory, 'required.ts');
const runnerImport = relative(directory, resolve(desktopDirectory, 'test/unit/mocha.ts')).replaceAll('\\', '/');
writeFileSync(requiredRunner, `import { runUnitTests } from ${JSON.stringify(runnerImport)};
await runUnitTests(${JSON.stringify([first, 'test/unit/missing-required.test.js'])}, false);
`);

function run(args: readonly string[], entrypoint = 'test/unit/run.ts'): { status: number | null; output: string; } {
	const result = spawnSync(process.execPath, [entrypoint, ...args], {
		cwd: desktopDirectory, encoding: 'utf8', timeout: 15_000, windowsHide: true, env: runnerEnvironment,
	});
	if (result.error) { throw result.error; }
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

test('invalid unit filters fail without starting the selected file', () => {
	for (const args of [['--grep', ''], ['--grep', '   '], ['--grepp', 'selected'], ['--', '--grep', 'selected']]) {
		const result = run(['--run', first, ...args]);
		assert.equal(result.status, 1, result.output);
		assert.doesNotMatch(result.output, /tests executed|runner regression sentinel/);
	}
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
	writeFileSync(waiting, `
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'mocha';
test('retains a dependency loaded after cleanup', async () => {
 writeFileSync(${JSON.stringify(ready)}, 'ready');
 while (!existsSync(${JSON.stringify(release)})) await setTimeout(25);
 assert.equal((await import('./snapshot-dependency.js')).value, 42);
});
`);
	const child = spawn(process.execPath, ['test/unit/run.ts', '--run', relative(outputDirectory, waiting).replaceAll('\\', '/')], { cwd: desktopDirectory, env: runnerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const stopped = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
	t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped; });
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

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
	test(`${signal} stops Mocha descendants and prevents the next file from starting`, { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
		const marker = join(directory, `ready-${signal}`);
		const later = join(directory, `later-${signal}`);
		const waiting = join(directory, `00-waiting-${signal}.test.js`);
		const following = join(directory, `01-following-${signal}.test.js`);
		writeFileSync(waiting, `
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
`);
		writeFileSync(following, `import { test } from 'mocha'; import { writeFileSync } from 'node:fs'; test('must not start', () => writeFileSync(${JSON.stringify(later)}, 'ran'));`);
		const paths = [waiting, following].map(path => relative(outputDirectory, path).replaceAll('\\', '/'));
		const child = spawn(process.execPath, ['test/unit/run.ts', '--run', paths[0], '--run', paths[1]], { cwd: desktopDirectory, env: runnerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { output += chunk; });
		const stopped = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
		let pids: number[] = [];
		t.after(async () => {
			for (const pid of [child.pid, ...pids]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
			await stopped;
		});
		const deadline = Date.now() + 10_000;
		while (!existsSync(marker) && Date.now() < deadline) {
			await new Promise(resolveWait => setTimeout(resolveWait, 25));
			if (child.exitCode !== null) throw new Error(output);
		}
		pids = JSON.parse(await readFile(marker, 'utf8'));
		child.kill(signal);
		assert.equal(await stopped, code, output);
		assert.equal(existsSync(later), false, 'Another test file started after cancellation');
		for (const pid of pids) {
			const result = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat=']).catch(error => { if (error.code === 1) return { stdout: '' }; throw error; });
			assert.ok(!result.stdout.trim() || result.stdout.trim().startsWith('Z'), `Leaked Mocha PID ${pid}`);
		}
	});
}
