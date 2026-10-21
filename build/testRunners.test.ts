import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseRunnerOptions } from '../test/scenario/src/options.ts';
import { seedScenarioProfile } from '../test/scenario/src/profileFixture.ts';
import { collectTests } from './playwright.ts';
import { withProcessRun } from './processes.ts';

const repository = resolve(import.meta.dirname, '..');
const execute = promisify(execFile);

test('scenario cold-start fixtures copy only declared synthetic persistence', async t => {
	const root = join(repository, '.build/ash-playwright-mcp');
	await mkdir(root, { recursive: true });
	const fixture = await mkdtemp(join(root, 'profile-fixture-test-'));
	const destination = join(fixture, 'isolated-profile');
	t.after(() => rm(fixture, { recursive: true, force: true }));
	await writeFile(join(fixture, 'fixture.json'), JSON.stringify({ format: 'ash-ui-profile-fixture-v1', synthetic: true }));
	for (const file of ['state.sqlite3', 'config.toml', 'settings.json', 'secrets']) await writeFile(join(fixture, file), file);
	await seedScenarioProfile(fixture, destination);
	assert.equal(await readFile(join(destination, 'state.sqlite3'), 'utf8'), 'state.sqlite3');
	await assert.rejects(readFile(join(destination, 'secrets')), { code: 'ENOENT' });
	await rm(join(fixture, 'settings.json'));
	await symlink(join(fixture, 'secrets'), join(fixture, 'settings.json'));
	await assert.rejects(seedScenarioProfile(fixture, destination), /regular file/);
	await writeFile(join(fixture, 'fixture.json'), JSON.stringify({ format: 'ash-ui-profile-fixture-v1', synthetic: false }));
	await assert.rejects(seedScenarioProfile(fixture, destination), /declare synthetic/);
	await assert.rejects(seedScenarioProfile(repository, destination), /inside .build/);
});

test('large browser collections retain their count without executing test bodies', { timeout: 15_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.integration-runner-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = join(directory, 'playwright.config.ts');
	await writeFile(config, `export default { testDir: '.', projects: [{ name: 'chromium' }] };`);
	await writeFile(join(directory, 'large.spec.ts'), `import { test } from '@playwright/test'; for (let i = 0; i < 2000; i++) test(i + ': ' + 'long title '.repeat(30), () => { throw Error('collection must not execute tests'); });`);
	await withProcessRun(repository, async (run, environment) => {
		assert.equal(await collectTests(run, ['node_modules/@playwright/test/cli.js', 'test', '--config', config], [], environment), true);
	});
});

test('scenario foreground mode is explicit and rejects Web targets', () => {
	assert.equal(parseRunnerOptions([]).activeWindow, false);
	assert.equal(parseRunnerOptions(['--active-window']).activeWindow, true);
	assert.throws(() => parseRunnerOptions(['--web', '--active-window']), /requires a Desktop scenario/);
	assert.throws(() => parseRunnerOptions(['--active-windows']), /Unknown option/);
});

test('browser integration preserves filters and rejects discarded or empty selection arguments', { timeout: 30_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.integration-runner-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = join(directory, 'playwright.config.ts');
	await writeFile(config, `export default { testDir: '.', projects: [{ name: 'chromium' }] };`);
	await writeFile(join(directory, 'selected.spec.ts'), `import { test } from '@playwright/test'; test('selected', () => { throw Error('collection must not execute tests'); }); test('unrelated', () => {});`);
	const cli = ['test/integration/browser/run.ts'];
	for (const prefix of [[], ['--']]) {
		const result = await execute(process.execPath, [...cli, ...prefix, '--config', config, '--list', '--grep', 'selected$'], { cwd: repository, timeout: 10_000 });
		assert.match(result.stdout, /Total: 1 test in 1 file/);
		assert.doesNotMatch(result.stdout, /Browser integration server/);
	}
	for (const args of [
		['--list', '--', '--grep', 'selected'], ['--list', '--grep='],
		['--list', '--grepp', 'selected'], ['--list', '--grep', 'absent'],
		['--list', '--pass-with-no-tests'], ['--ui'],
	]) {
		await assert.rejects(execute(process.execPath, [...cli, '--config', config, ...args], { cwd: repository, timeout: 10_000 }), error => {
			assert.ok(error instanceof Error);
			const failure = error as Error & { stdout: string; code: number; };
			assert.doesNotMatch(failure.stdout, /Browser integration server/);
			return failure.code !== 0;
		});
	}
});

test('editor browser prepares a selected Rust Git fixture before building or launching the browser', { timeout: 20_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.integration-runner-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = join(directory, 'playwright.config.ts');
	await writeFile(config, `export default { testDir: '.', outputDir: './results', projects: [{ name: 'chromium' }], reporter: 'list' };`);
	await writeFile(join(directory, 'diff.integration.spec.ts'), `import { test } from '@playwright/test'; test('requires Rust Git', () => { throw Error('must not run before Git preparation'); });`);
	const missingPython = join(directory, 'missing-python');
	for (const prefix of [[], ['--editor']]) {
		await assert.rejects(execute(process.execPath, ['test/integration/browser/run.ts', ...prefix, '--config', config, 'diff.integration.spec.ts'], {
			cwd: repository, env: { ...process.env, PYTHON: missingPython }, timeout: 10_000,
		}), error => {
			assert.ok(error instanceof Error);
			const failure = error as Error & { stdout: string; stderr: string; };
			assert.match(failure.stdout, /Test selection: 1 tests/);
			assert.ok((failure.stdout + failure.stderr).includes(`spawn ${missingPython} ENOENT`), failure.stdout + failure.stderr);
			assert.doesNotMatch(failure.stdout, /Browser integration server|Running 1 test/);
			return true;
		});
	}
});

test('CI rejects exclusive tests during collection before browser or smoke launches', { timeout: 20_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.exclusive-runner-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, 'exclusive.spec.ts'), `import { test } from '@playwright/test'; test.only('exclusive', () => { throw Error('must not execute'); }); test('sibling', () => {});`);
	for (const [name, source, entrypoint] of [
		['integration', 'test/integration/browser/playwright.config.ts', ['test/integration/browser/run.ts']],
		['smoke', 'playwright.config.ts', ['test/smoke/run.ts', 'electron-ui']],
	] as const) {
		const config = join(directory, `${name}.config.ts`);
		await writeFile(config, `import config from ${JSON.stringify(join(repository, source))}; export default { ...config, testDir: '.', testMatch: '*.spec.ts', webServer: undefined, reporter: 'list' };`);
		await assert.rejects(execute(process.execPath, [...entrypoint, '--config', config, '--list'], { cwd: repository, env: { ...process.env, CI: 'true' }, timeout: 10_000 }), error => {
			assert.ok(error instanceof Error);
			const failure = error as Error & { stdout: string; stderr: string; code: number; };
			assert.match(failure.stdout + failure.stderr, /\.only.*forbidOnly/);
			assert.doesNotMatch(failure.stdout, /Browser integration server|Running \d+ tests?/);
			return failure.code === 1;
		});
	}
});

test('the combined editor target rejects filters before starting either suite', async () => {
	await assert.rejects(execute(process.execPath, ['test/editor.ts', '--grep', 'selected'], { cwd: repository, timeout: 5_000 }), error => {
		assert.ok(error instanceof Error);
		const failure = error as Error & { stdout: string; stderr: string; code: number; };
		assert.match(failure.stderr, /takes no filters/);
		assert.doesNotMatch(failure.stdout, /Mocha|Running.*tests/);
		return failure.code === 1;
	});
});

test('scenario cancellation owns resources even while scenario loading never settles', { skip: process.platform === 'win32', timeout: 25_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.scenario-runner-'));
	const marker = join(directory, 'marker');
	const scenario = join(directory, 'scenario.mjs');
	await writeFile(scenario, `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { registerRunResource } from ${JSON.stringify(join(repository, 'build/processes.ts'))};
const resource = await registerRunResource();
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
await resource.process(child);
await writeFile(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
await new Promise(() => {});
`);
	const child = spawn(process.execPath, ['test/scenario/out/runScenario.js', scenario], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
	const result = completion(child);
	let pids: number[] = [];
	t.after(async () => {
		for (const pid of [child.pid, ...pids]) if (pid && await alive(pid)) process.kill(pid, 'SIGKILL');
		await result;
		await rm(directory, { recursive: true, force: true });
	});
	pids = JSON.parse(await waitForFile(marker, result));
	child.kill('SIGTERM');
	const stopped = await result;
	assert.equal(stopped.code, 143, stopped.output);
	for (const pid of pids) assert.equal(await alive(pid), false, `Leaked scenario PID ${pid}`);
});

function completion(child: ChildProcess): Promise<{ code: number | null; output: string; }> {
	let output = '';
	child.stdout!.on('data', chunk => { output += chunk; });
	child.stderr!.on('data', chunk => { output += chunk; });
	return new Promise((resolveExit, reject) => {
		child.once('error', reject);
		child.once('close', code => resolveExit({ code, output }));
	});
}

async function waitForFile(path: string, result: Promise<{ code: number | null; output: string; }>): Promise<string> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try { return await readFile(path, 'utf8'); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		const exited = await Promise.race([result, new Promise<undefined>(resolveWait => setTimeout(resolveWait, 25))]);
		if (exited) throw new Error(`Runner exited before readiness: ${exited.output}`);
	}
	throw new Error(`Runner never wrote ${path}`);
}

async function alive(pid: number): Promise<boolean> {
	try { const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'stat=']); return !stdout.trim().startsWith('Z'); }
	catch (error) { if (error.code === 1) return false; throw error; }
}

test('macOS package verification forwards the title filter without launching the package', { skip: process.platform !== 'darwin', timeout: 15_000 }, async () => {
	const { stdout } = await execute(process.execPath, ['build/desktop/verify-darwin.ts', '--', '--list', '--grep', 'macOS package launches'], { cwd: repository, timeout: 10_000 });
	assert.match(stdout, /Total: 1 test in 1 file/);
	assert.doesNotMatch(stdout, /Windows package saves/);
});

test('legacy performance commands explain their supported scope before any launch', async () => {
	for (const script of ['chat-memory-smoke.mts', 'chat-session-switch-smoke.mts']) {
		const path = `.agents/skills/auto-perf-optimize/scripts/${script}`;
		const help = await execute(process.execPath, [path, '--help'], { cwd: repository, timeout: 5_000 });
		assert.match(help.stdout, /unavailable for Ash.*scenario/);
		await assert.rejects(execute(process.execPath, [path], { cwd: repository, timeout: 5_000 }), error => {
			assert.ok(error instanceof Error);
			assert.match((error as Error & { stderr: string; }).stderr, /not an Ash runner/);
			return true;
		});
	}
	await assert.rejects(execute(process.execPath, ['.agents/skills/auto-perf-optimize/scripts/workbench-css-performance.mts'], { cwd: repository, timeout: 5_000 }), error => {
		assert.ok(error instanceof Error);
		assert.match((error as Error & { stderr: string; }).stderr, /requires --code-root/);
		return true;
	});
});
