import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
await runUnitTests(${JSON.stringify([first, 'test/unit/missing-required.test.js'])}, false);
`);

function run(args: readonly string[], entrypoint = 'test/unit/run.ts'): { status: number | null; output: string; } {
	const result = spawnSync(process.execPath, [entrypoint, ...args], {
		cwd: desktopDirectory, encoding: 'utf8', timeout: 15_000, windowsHide: true,
	});
	if (result.error) { throw result.error; }
	return { status: result.status, output: result.stdout + result.stderr };
}

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

test('concurrent files retain assertion failures and executed counts', () => {
	const result = run(['--run', first, '--run', second, '--jobs', '2']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /runner regression sentinel/);
	assert.match(result.output, /3 tests executed across 2 files; 1 failed files/);
});

test('files run concurrently within the requested process limit', () => {
	const parallel = mkdtempSync(join(directory, 'parallel-'));
	const events = join(parallel, 'events.txt');
	const sources: string[] = [];
	for (let index = 0; index < 3; index++) {
		const file = join(parallel, `${index}.test.js`);
		writeFileSync(file, `import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'mocha';
test('process barrier ${index}', async () => {
  appendFileSync(${JSON.stringify(events)}, 'start ${index}\\n');
  writeFileSync(${JSON.stringify(join(parallel, `started-${index}`))}, 'started');
  ${index < 2 ? `
  const deadline = Date.now() + 5000;
  while (!existsSync(${JSON.stringify(join(parallel, `started-${1 - index}`))})) {
    assert.ok(Date.now() < deadline, 'both isolated processes must reach the barrier');
    await setTimeout(10);
  }
  assert.equal(existsSync(${JSON.stringify(join(parallel, 'started-2'))}), false, 'a third process must remain queued');
  writeFileSync(${JSON.stringify(join(parallel, `checked-${index}`))}, 'checked');
  while (!existsSync(${JSON.stringify(join(parallel, `checked-${1 - index}`))})) {
    assert.ok(Date.now() < deadline, 'both processes must verify the limit before either exits');
    await setTimeout(10);
  }
  ` : ''}
  appendFileSync(${JSON.stringify(events)}, 'end ${index}\\n');
});
`);
		sources.push(relative(outputDirectory, file).replaceAll('\\', '/'));
	}
	const result = run([...sources.flatMap(file => ['--run', file]), '--jobs', '2']);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /3 tests executed across 3 files; 0 failed files/);
	const recorded = readFileSync(events, 'utf8').trim().split('\n');
	assert.deepEqual(recorded.slice(0, 2).sort(), ['start 0', 'start 1']);
	assert.ok(recorded.findIndex(event => event.startsWith('end ')) < recorded.indexOf('start 2'));
});

test('invalid process limits fail before executing tests', () => {
	for (const jobs of ['0', '-1', '1.5', 'NaN']) {
		const result = run(['--run', second, '--jobs', jobs]);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /Invalid test jobs/);
		assert.doesNotMatch(result.output, /Mocha: .*tests executed/);
	}
});

test('a missing file is rejected before any concurrent process starts', () => {
	const result = run(['--run', second, '--run', 'test/unit/missing.test.js', '--jobs', '2']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /Compiled unit test does not exist/);
	assert.doesNotMatch(result.output, /other behavior/);
});
