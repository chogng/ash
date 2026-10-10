import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';

const desktopDirectory = resolve(import.meta.dirname, '../..');
const outputDirectory = resolve(desktopDirectory, '.build/desktop/test');
const parent = join(outputDirectory, 'test/unit');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'runner-'));
after(() => rmSync(directory, { recursive: true, force: true }));
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
runUnitTests(${JSON.stringify([first, 'test/unit/missing-required.test.js'])}, false);
`);

function run(args: readonly string[], entrypoint = 'test/unit/run.ts'): { status: number | null; output: string; } {
	const result = spawnSync(process.execPath, [entrypoint, ...args], {
		cwd: desktopDirectory, encoding: 'utf8', timeout: 15_000, windowsHide: true,
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
