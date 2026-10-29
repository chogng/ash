import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const repository = resolve(import.meta.dirname, '..');
const execute = promisify(execFile);

test('pnpm file and title filters survive both supported argument forms', async () => {
	const packageManager = process.env.npm_execpath;
	assert.ok(packageManager, 'Run through pnpm run test:smoke:runner.');
	const isScript = /\.[cm]?js$/u.test(packageManager);
	for (const separator of [[], ['--']]) {
		const result = await execute(isScript ? process.execPath : packageManager, [
			...(isScript ? [packageManager] : []), 'run', 'smoketest-no-compile', ...separator,
			'test/smoke/areas/windows/remote-extension.spec.ts', '--grep', 'product SSH resolver', '--max-failures=1', '--list',
		], { cwd: repository, timeout: 30_000 });
		assert.match(result.stdout, /Total: 1 test in 1 file/u);
		assert.match(result.stdout, /remote-extension\.spec\.ts.*product SSH resolver/u);
	}
});

test('bad and unmatched filters fail before any test runs', async t => {
	const fixture = await createFixture(`
import { test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
test('selected', async () => { await writeFile(process.env.ASH_RUNNER_MARKER, 'ran'); });
`);
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	for (const args of [
		['--grep='], ['--grep', ''], ['--grep', '--list'],
		['--grepp', 'selected'], ['--grep', '['],
		['selected.spec.ts', '--', '--grep', 'selected'],
		['--grep', 'does-not-exist'], ['absent-file.spec.ts'],
		['--pass-with-no-tests', '--grep', 'absent'],
		['--ui'],
	]) {
		const result = await invoke(fixture, args);
		assert.notEqual(result.code, 0, JSON.stringify(args) + result.output);
		await assert.rejects(readFile(fixture.marker), { code: 'ENOENT' });
	}
});

test('the collected selection executes only matching tests and honors max failures', async t => {
	const fixture = await createFixture(`
import { test } from '@playwright/test';
import { appendFile } from 'node:fs/promises';
test('selected', async () => { await appendFile(process.env.ASH_RUNNER_MARKER, 'selected\\n'); });
test('unrelated', async () => { await appendFile(process.env.ASH_RUNNER_MARKER, 'unrelated\\n'); });
test('failure first', async () => { throw new Error('intentional runner regression failure'); });
test('failure second', async () => { await appendFile(process.env.ASH_RUNNER_MARKER, 'second\\n'); });
`);
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	const matched = await invoke(fixture, ['--grep', 'selected$']);
	assert.equal(matched.code, 0, matched.output);
	assert.match(matched.output, /Test selection: 1 tests/u);
	assert.equal(await readFile(fixture.marker, 'utf8'), 'selected\n');
	const failed = await invoke(fixture, ['--grep', 'failure', '--max-failures=1']);
	assert.equal(failed.code, 1, failed.output);
	assert.match(failed.output, /intentional runner regression failure/u);
	assert.equal(await readFile(fixture.marker, 'utf8'), 'selected\n');
});

test('target selection excludes unsupported scenarios before expensive fixtures, including custom configs', async t => {
	const fixture = await createFixture(`
import { test as base } from ${JSON.stringify(join(repository, 'test/automation/test.ts'))};
import { appendFile } from 'node:fs/promises';
const test = base.extend({ runningApplication: async ({}, use) => {
  await appendFile(process.env.ASH_RUNNER_MARKER, 'launched\\n');
  await use({ driver: { workbench: {} } });
} });
test('supported', { tag: '@electron-ui' }, async ({ workbench }) => {
  await appendFile(process.env.ASH_RUNNER_MARKER, 'supported\\n');
});
test('backend only', { tag: '@electron-app-server' }, async ({ workbench }) => {
  throw new Error('Unsupported scenario ran');
});
test('other OS', { tag: ${JSON.stringify(process.platform === 'darwin' ? '@win32' : '@darwin')} }, async ({ workbench }) => {
  throw new Error('Unsupported platform ran');
});
`);
	t.after(() => rm(fixture.directory, { recursive: true, force: true }));
	await writeFile(join(fixture.directory, 'playwright.config.ts'), `
import { testTargetExclusions } from ${JSON.stringify(join(repository, 'test/automation/testTarget.ts'))};
export default { testDir: '.', testMatch: '*.spec.ts', outputDir: ${JSON.stringify(join(fixture.directory, 'results'))}, workers: 1, reporter: 'list', projects: [
  { name: 'electron-ui', grepInvert: testTargetExclusions('electron-ui', process.platform) }
] };
`);
	const selection = await invoke(fixture, ['--list']);
	assert.equal(selection.code, 0, selection.output);
	assert.match(selection.output, /Total: 1 test in 1 file/u);
	await assert.rejects(readFile(fixture.marker), { code: 'ENOENT' });
	// A custom config may omit collection filtering; applicability still precedes setup.
	const configurationPath = join(fixture.directory, 'playwright.config.ts');
	await writeFile(configurationPath, (await readFile(configurationPath, 'utf8')).replace("grepInvert: testTargetExclusions('electron-ui', process.platform)", ''));
	const guarded = await invoke(fixture, ['--grep', 'supported|backend only|other OS']);
	assert.equal(guarded.code, 0, guarded.output);
	assert.match(guarded.output, /2 skipped/u);
	assert.match(guarded.output, /1 passed/u);
	assert.equal(await readFile(fixture.marker, 'utf8'), 'launched\nsupported\n');
});

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
	test(`${signal} stops the runner and detached resource descendants without stopping unrelated processes`, { skip: process.platform === 'win32', timeout: 75_000 }, async t => {
		const fixture = await createFixture(`
import { test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { registerRunResource } from ${JSON.stringify(join(repository, 'build/processes.ts'))};
test('running', async () => {
  const resource = await registerRunResource();
  const source = ${JSON.stringify(`
    const { spawn } = require('node:child_process');
    process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', pid => process.send({ parent: process.pid, child: pid }));
    setInterval(() => {}, 1000);
  `)};
  const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = new Promise(resolveReady => child.once('message', resolveReady));
  await resource.process(child);
  const pids = await ready;
  await writeFile(process.env.ASH_RUNNER_MARKER, JSON.stringify(pids));
  await new Promise(() => {});
});
`, 120_000);
		const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
		const child = start(fixture, []);
		const result = completion(child);
		let pids: { parent: number; child: number; } | undefined;
		t.after(async () => {
			for (const pid of [child.pid, sentinel.pid, pids?.parent, pids?.child]) {
				if (pid) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
			}
			await result;
			await rm(fixture.directory, { recursive: true, force: true });
		});
		pids = JSON.parse(await waitForFile(fixture.marker));
		child.kill(signal);
		const stopped = await result;
		assert.equal(stopped.code, exitCode, stopped.output);
		for (const pid of [pids!.parent, pids!.child]) assert.equal(await alive(pid), false, `Leaked test PID ${pid}`);
		assert.equal(await alive(sentinel.pid!), true, 'Unrelated process was stopped');
	});
}

test('interrupting again stops a Playwright teardown that refuses to finish', { skip: process.platform === 'win32', timeout: 75_000 }, async t => {
	const fixture = await createFixture(`
import { test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
test.afterAll(async () => {
  await writeFile(process.env.ASH_RUNNER_MARKER + '.teardown', 'blocked teardown');
  await new Promise(() => {});
});
test('running', async () => {
  await writeFile(process.env.ASH_RUNNER_MARKER, JSON.stringify([process.pid, process.ppid]));
  await new Promise(() => {});
});
`, 120_000);
	const child = start(fixture, []);
	const result = completion(child);
	let pids: number[] = [];
	t.after(async () => {
		for (const pid of [child.pid, ...pids]) if (pid && await alive(pid)) process.kill(pid, 'SIGKILL');
		await result;
		await rm(fixture.directory, { recursive: true, force: true });
	});
	pids = JSON.parse(await waitForFile(fixture.marker));
	child.kill('SIGINT');
	assert.equal(await waitForFile(fixture.marker + '.teardown'), 'blocked teardown');
	child.kill('SIGINT');
	const stopped = await result;
	assert.equal(stopped.code, 130, stopped.output);
	for (const pid of pids) assert.equal(await alive(pid), false, `Leaked Playwright PID ${pid}`);
});

for (const surface of ['Electron', 'Web']) {
	test(`stopping a runner closes ${surface} and its managed backend after the worker exits`, {
		skip: !process.env.ASH_SMOKE_RUNNER_PRODUCT_TESTS || process.platform === 'win32', timeout: 90_000,
	}, async t => {
		// The worker intentionally dies without closing its launcher. This covers the
		// registry fallback instead of merely checking a normal fixture teardown.
		const fixture = await createFixture(directory => `
import { test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ${surface === 'Electron' ? 'launchElectron' : 'launchWeb'} } from ${JSON.stringify(join(repository, `test/automation/playwright${surface}.ts`))};
test('running product', async () => {
  ${surface === 'Electron' ? `const running = await launchElectron({ appServerMode: 'required', userDataDirectory: ${JSON.stringify(join(directory, 'home'))} }); const root = running.application.process().pid;` : `await launchWeb(${JSON.stringify(directory)}); const root = process.pid;`}
  const directory = process.env.ASH_SMOKE_RUN_DIRECTORY;
  const resources = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  const daemon = resources.find(resource => resource.daemon).daemon;
  const result = await promisify(execFile)(daemon.executable, ['version'${surface === 'Web' ? ", '--product-services', join(daemon.profile, 'product-services.json')" : ''}], { env: { ...process.env, ASH_HOME: daemon.profile } });
  const daemonPid = JSON.parse(result.stdout).pid;
  if (!daemonPid) throw new Error('Test backend did not become ready');
  const snapshot = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=']);
  const processes = snapshot.stdout.trim().split('\\n').map(line => line.trim().split(/\\s+/).map(Number));
  const pids = new Set([root, daemonPid]);
  let size;
  do { size = pids.size; for (const [pid, parent] of processes) if (pids.has(parent)) pids.add(pid); } while (size !== pids.size);
  await writeFile(process.env.ASH_RUNNER_MARKER, JSON.stringify({ pids: [...pids], daemon }));
  await new Promise(() => {});
});
`);
		const child = start(fixture, []);
		const result = completion(child);
		let state: { pids: number[]; daemon: { executable: string; profile: string; }; } | undefined;
		t.after(async () => {
			if (child.pid && await alive(child.pid)) child.kill('SIGKILL');
			if (state) {
				await execute(state.daemon.executable, ['stop'], { env: { ...process.env, ASH_HOME: state.daemon.profile }, timeout: 30_000 });
				for (const pid of state.pids) if (await alive(pid)) process.kill(pid, 'SIGKILL');
			}
			await result;
			await rm(fixture.directory, { recursive: true, force: true });
		});
		try { state = JSON.parse(await waitForFile(fixture.marker)); }
		catch (error) { child.kill('SIGINT'); throw new Error((await result).output, { cause: error }); }
		child.kill('SIGINT');
		const stopped = await result;
		assert.equal(stopped.code, 130, stopped.output);
		for (const pid of state!.pids) assert.equal(await alive(pid), false, `Leaked product PID ${pid}`);
	});
}

interface Fixture { directory: string; marker: string; }

async function createFixture(source: string | ((directory: string) => string), timeout = 10_000): Promise<Fixture> {
	const directory = await mkdtemp(join(repository, 'test/.smoke-runner-'));
	await writeFile(join(directory, 'playwright.config.ts'), `export default { testDir: '.', testMatch: '*.spec.ts', outputDir: ${JSON.stringify(join(directory, 'results'))}, timeout: ${timeout}, workers: 1, reporter: 'list', projects: [{ name: 'electron-ui' }] };`);
	await writeFile(join(directory, 'selected.spec.ts'), typeof source === 'function' ? source(directory) : source);
	return { directory, marker: join(directory, 'marker') };
}

function start(fixture: Fixture, args: string[]): ChildProcess {
	return spawn(process.execPath, ['test/smoke/run.ts', 'electron-ui', '--config', join(fixture.directory, 'playwright.config.ts'), ...args], {
		cwd: repository, env: { ...process.env, ASH_RUNNER_MARKER: fixture.marker }, stdio: ['ignore', 'pipe', 'pipe'],
	});
}

async function invoke(fixture: Fixture, args: string[]): Promise<{ code: number | null; output: string; }> {
	return completion(start(fixture, args));
}

function completion(child: ChildProcess): Promise<{ code: number | null; output: string; }> {
	let output = '';
	child.stdout!.on('data', data => { output += data.toString(); });
	child.stderr!.on('data', data => { output += data.toString(); });
	return new Promise((resolveExit, reject) => {
		child.once('error', reject);
		child.once('close', code => resolveExit({ code, output }));
	});
}

async function waitForFile(path: string): Promise<string> {
	const deadline = Date.now() + 20_000;
	while (true) {
		try {
			// writeFile creates the marker before writing its contents. Under load
			// the reader can observe that intermediate empty file.
			const value = await readFile(path, 'utf8');
			if (value) return value;
			if (Date.now() >= deadline) throw new Error(`Marker remained empty: ${path}`);
		}
		catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; }
		await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 50));
	}
}

async function alive(pid: number): Promise<boolean> {
	try {
		const result = await execute('ps', ['-o', 'stat=', '-p', String(pid)]);
		return !!result.stdout.trim() && !result.stdout.trim().startsWith('Z');
	} catch (error) { if (error.code === 1) return false; throw error; }
}
