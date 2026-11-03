import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { isProcessRunning, ProcessRun } from '../../processes.ts';
import { pythonCommand } from '../../python.ts';
import { resolveElectronConfiguration } from '../../../test/automation/electron.ts';

test('real Ash development services exit after worker death or launcher loss with a stopped worker', {
	skip: process.env.ASH_ELECTRON_LAUNCH_PRODUCT_TESTS !== '1' || process.platform === 'win32', timeout: 180_000,
}, async t => {
	const repository = resolve(import.meta.dirname, '../../..');
	const directory = await realpath(await mkdtemp(join(tmpdir(), 'ash-launch-product-')));
	const runs: ProcessRun[] = [];
	t.after(async () => {
		await Promise.all(runs.map(run => run.stop('SIGTERM')));
		await rm(directory, { recursive: true, force: true });
	});
	async function freePort(): Promise<number> {
		const server = createServer();
		await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
		const port = (server.address() as import('node:net').AddressInfo).port;
		await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
		return port;
	}
	const rendererPort = await freePort();
	const cdpPort = await freePort();
	for (const stopWorker of [false, true]) {
		const configuration = resolveElectronConfiguration({ appServerMode: 'disabled', userDataDirectory: join(directory, String(stopWorker)) });
		const child = spawn(process.execPath, [resolve(repository, 'build/desktop/launch/electron.ts'), '--watch', '--dev-services',
		...configuration.args.filter(argument => argument !== repository), `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'], {
			cwd: repository, stdio: 'pipe', env: { ...configuration.env, ASH_RENDERER_URL: `http://127.0.0.1:${rendererPort}`, ASH_DEV_APP_SERVER_RELOAD: '1' },
		});
		let output = '';
		child.stdout.on('data', chunk => { output = (output + chunk).slice(-16_384); });
		child.stderr.on('data', chunk => { output = (output + chunk).slice(-16_384); });
		const run = new ProcessRun(repository, undefined, 5_000);
		runs.push(run);
		await run.own(child);
		const startupDeadline = Date.now() + 60_000;
		let targets: { url: string; }[] = [];
		while (Date.now() < startupDeadline) {
			try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1_000) })).json() as typeof targets; }
			catch { /* Electron's CDP endpoint is not listening yet. */ }
			if (targets.some(target => target.url.startsWith(`http://127.0.0.1:${rendererPort}/`))) break;
			assert.equal(child.exitCode, null, output);
			await delay(100);
		}
		assert.ok(targets.some(target => target.url.startsWith(`http://127.0.0.1:${rendererPort}/`)), output);
		const snapshot = (await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,command='])).stdout.trim().split('\n').map(line => {
			const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u)!;
			return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), command: match[4] };
		});
		const supervisor = snapshot.find(process => process.parent === child.pid && process.command.includes('/launch/supervisor.ts'))!;
		const worker = snapshot.find(process => process.parent === supervisor?.pid && process.command.includes('/launch/electron.ts'))!;
		assert.ok(worker, output);
		const owned = snapshot.filter(process => process.group === worker.pid);
		assert.ok(owned.some(process => process.command.includes('vite/bin/vite.js')), output);
		assert.ok(owned.some(process => process.command.includes('watch-app-server.ts')), output);
		assert.ok(owned.some(process => process.command.includes('Contents/MacOS/Electron') || /\/electron\s/u.test(process.command)), output);
		await run.own(child);
		if (stopWorker) {
			process.kill(worker.pid, 'SIGSTOP');
			child.kill('SIGKILL');
		} else {
			process.kill(worker.pid, 'SIGKILL');
		}
		const pids = [child.pid!, supervisor.pid, ...owned.map(process => process.pid)];
		const cleanupDeadline = Date.now() + 15_000;
		while (pids.some(isProcessRunning) && Date.now() < cleanupDeadline) await delay(50);
		for (const pid of pids) assert.equal(isProcessRunning(pid), false, `Leaked actual Ash process ${pid}: ${output}`);
		for (const port of [rendererPort, cdpPort]) {
			const server = createServer();
			await new Promise<void>((resolveReady, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolveReady));
			await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
		}
	}
});

const launchSources = ['build/source-layout.json', 'build/processes.ts', 'build/desktop/launch/electron.ts', 'build/desktop/launch/supervisor.ts', 'build/desktop/electron.ts', 'src/ash/code/common/application.ts', 'build/desktop/host.ts', 'build/desktop/paths.ts', 'build/desktop/runtimeStore.ts', 'build/desktop/appServer.ts', 'build/desktop/liveBuild.ts', 'build/python.ts', 'build/protocol/generate.ts', 'build/lib/incrementalOutput.ts', 'build/lib/watchNativeFile.ts'];

interface ObservedProcess { readonly pid: number; readonly recordedAt: number; }

async function assertProcessesExited(observed: readonly ObservedProcess[], output = ''): Promise<void> {
	if (process.platform !== 'win32') {
		for (const { pid } of observed) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
		return;
	}
	// Windows may reuse short-lived compiler/service PIDs within one test. Only
	// a process born before its fixture log can be the original instance.
	const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-Process -Id ${observed.map(process => process.pid).join(',')} -ErrorAction SilentlyContinue | ForEach-Object { @{ pid = $_.Id; started = ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 15_000 });
	const processes = JSON.parse(stdout || '[]') as { pid: number; started: number; } | { pid: number; started: number; }[];
	const started = new Map((Array.isArray(processes) ? processes : [processes]).map(process => [process.pid, process.started]));
	for (const process of observed) {
		assert.ok(!isProcessRunning(process.pid) || (started.get(process.pid) ?? -Infinity) > process.recordedAt, `Leaked fixture process ${JSON.stringify(process)}; current generation started at ${started.get(process.pid)}: ${output}`);
	}
}

for (const profile of ['default', 'custom', 'separated', 'cancelled'] as const) {
	// Each Windows compiler/restart cycle snapshots its process tree through CIM.
	test(`Electron starts once after valid compilation and restarts only after valid rebuilds (${profile} profile)`, { timeout: process.platform === 'win32' ? 240_000 : 20_000 }, async t => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-electron-')));
		const desktop = join(root, '.');
		let phaseRevision = 0;
		async function setPhase(phase: string): Promise<void> {
			const temporary = join(desktop, `phase-${phaseRevision++}.tmp`);
			await writeFile(temporary, phase);
			// Publish complete phases so the compiler cannot read a truncated file as a valid build.
			await rename(temporary, join(desktop, 'phase'));
			await appendFile(join(desktop, 'fixture.cjs'), `\n// save ${phaseRevision}\n`);
		}
		async function command(value: string): Promise<void> {
			await writeFile(join(desktop, 'command.tmp'), value);
			await rename(join(desktop, 'command.tmp'), join(desktop, 'command'));
		}
		for (const directory of ['build/desktop/launch', 'node_modules/@ash/typescript-compiler/bin', 'node_modules/electron', '.build/protocol/typescript', '.build/desktop/localization']) {
			await mkdir(join(root, directory), { recursive: true });
		}
		for (const name of launchSources) {
			await mkdir(join(root, name, '..'), { recursive: true });
			await copyFile(resolve(import.meta.dirname, '../../..', name), join(root, name));
		}
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await writeFile(join(root, 'build/desktop/host_logs.py'), '# Native host tools are outside this launcher fixture.\n');
		await symlink(resolve(import.meta.dirname, '../../../node_modules/typescript'), join(root, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
		for (const project of ['main', 'preload']) {
			await writeFile(join(root, `tsconfig.${project}.json`), JSON.stringify({ compilerOptions: { incremental: true, outDir: `.build/desktop/${project}`, tsBuildInfoFile: `.build/desktop/${project}.tsbuildinfo` }, files: ['fixture.cjs'] }));
		}
		await writeFile(join(desktop, 'package.json'), '{"main":"fixture.cjs","type":"module"}');
		await writeFile(join(desktop, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
		await writeFile(join(desktop, 'fixture.cjs'), `
      require('node:fs').appendFileSync('launches.log', JSON.stringify({ pid: process.pid, recordedAt: Date.now(), cwd: process.cwd(), args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE, launchWorker: process.env.ASH_ELECTRON_LAUNCH_WORKER, runDirectory: process.env.ASH_SMOKE_RUN_DIRECTORY, home: process.env.ASH_HOME }) + '\\n');
      if (require('node:fs').existsSync('refuse-startup')) process.exit(0);
      if (require('node:fs').existsSync('busy-startup')) {
        process.send('ash:dev:busy', () => process.exit(0));
        return;
      }
      process.send('ash:dev:ready');
      process.on('SIGTERM', () => {
        require('node:fs').appendFileSync('stops.log', process.pid + '\\n');
        setTimeout(() => process.exit(0), 750);
      });
      setInterval(() => {
        const fs = require('node:fs');
        if (!fs.existsSync('command')) return;
        const command = fs.readFileSync('command', 'utf8');
        fs.unlinkSync('command');
        if (command === 'relaunch') process.send('ash:dev:relaunch', () => process.exit(0));
        else process.exit(0);
      }, 50);
    `);
		await writeFile(join(desktop, 'node_modules/@ash/typescript-compiler/bin/tsc'), `
      const fs = require('node:fs');
      const path = require('node:path');
      if (fs.existsSync('compiler-active')) throw new Error('Concurrent Host compilers');
      fs.writeFileSync('compiler-active', String(process.pid));
      fs.appendFileSync('compilers.log', JSON.stringify({ pid: process.pid, recordedAt: Date.now(), cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
        const phase = fs.readFileSync('phase', 'utf8');
        fs.appendFileSync('started.log', phase + '\\n');
      setTimeout(() => {
        const output = '.build/desktop/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs';
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, phase === 'initial' || phase === 'invalid' ? "require('fs')" : "require('electron')");
        const browserOutput = '.build/desktop/preload/src/ash/platform/browserView/electron-browser/preload-browserView.js';
        fs.mkdirSync(path.dirname(browserOutput), { recursive: true });
        fs.writeFileSync(browserOutput, "require('electron'); // " + (phase === 'preload' ? 'updated' : 'initial'));
        const mainOutput = '.build/desktop/main/src/main.js';
        fs.mkdirSync(path.dirname(mainOutput), { recursive: true });
        fs.writeFileSync(mainOutput, 'export const version = ' + (phase.startsWith('recovered') || phase === 'preload' ? 2 : 1));
        fs.writeFileSync(mainOutput + '.map', JSON.stringify({ sourcesContent: [phase] }));
        fs.appendFileSync('phases.log', phase + '\\n');
        fs.unlinkSync('compiler-active');
        process.exitCode = phase === 'error' ? 1 : 0;
      }, phase === 'slow' ? 600 : 0);
    `);
		await setPhase('initial');
		const custom = profile === 'custom' || profile === 'separated';
		const home = join(root, custom ? 'custom-profile' : '.build/desktop/dev/profile');
		const userData = join(root, custom ? 'custom-user-data' : '.build/desktop/dev/user-data');
		const userDataArgs = profile === 'separated' ? ['--user-data-dir', userData] : [`--user-data-dir=${userData}`];
		const child = spawn(process.execPath, [join(root, 'build/desktop/launch/electron.ts'), '--watch', '--fixture', ...(custom ? userDataArgs : [])], {
			cwd: tmpdir(), windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASH_DESKTOP_UI_ONLY: '1', ASH_HOME: custom ? home : undefined },
		});
		let output = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { output += chunk; });
		const closed = new Promise(resolvePromise => child.once('close', resolvePromise));
		const run = new ProcessRun(root, undefined, 5_000);
		t.after(async () => {
			await run.stop('SIGTERM');
			await closed;
			await rm(root, { recursive: true, force: true });
		});
		await run.own(child);
		async function lines(file: string): Promise<string[]> {
			const text = await readFile(join(desktop, file), 'utf8').catch(error => {
				if (error.code !== 'ENOENT') throw error;
				return '';
			});
			return text.trim().split('\n').filter(Boolean);
		}
		async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
			const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 6_000);
			while (Date.now() < deadline) {
				if (await predicate()) return;
				assert.equal(child.exitCode, null, output);
				await delay(50);
			}
			assert.fail(output);
		}
		await until(() => output.includes('unsupported runtime imports: fs'));
		assert.deepEqual(await lines('launches.log'), []);
		await setPhase('valid');
		await until(async () => (await lines('launches.log')).length === 1);
		const compilers = (await lines('compilers.log')).map(line => JSON.parse(line));
		assert.equal(compilers.length, 2);
		for (const compiler of compilers) {
			assert.equal(compiler.cwd, desktop);
			assert.ok(!compiler.args.includes('--watch'), 'Only the input watcher owns filesystem subscriptions');
			assert.deepEqual(compiler.args.slice(0, 3), ['--build', 'tsconfig.main.json', 'tsconfig.preload.json']);
		}
		await setPhase('unchanged');
		await until(async () => (await lines('phases.log')).includes('unchanged'));
		await delay(300);
		assert.equal((await lines('launches.log')).length, 1, 'Changing only source maps must not restart Electron');
		await setPhase('slow');
		await until(async () => (await lines('started.log')).includes('slow'));
		await setPhase('valid-after-slow');
		await until(async () => (await lines('phases.log')).includes('valid-after-slow'));
		assert.equal((await lines('launches.log')).length, 1, 'A save during compilation queues a build without starting another compiler or restarting unchanged output');
		for (const phase of ['error', 'invalid']) {
			output = '';
			await setPhase(phase);
			await until(async () => (await lines('phases.log')).includes(phase));
			if (phase === 'invalid') await until(() => output.includes('unsupported runtime imports: fs'));
			await delay(300);
			assert.equal((await lines('launches.log')).length, 1);
		}
		await setPhase('recovered');
		if (process.platform === 'win32') {
			// Windows termination cannot run the fixture's POSIX signal handler.
			const [{ pid }] = (await lines('launches.log')).map(line => JSON.parse(line));
			await until(() => !isProcessRunning(pid));
		} else {
			await until(async () => (await lines('stops.log')).length === 1);
		}
		// A no-op build while the old process exits must not cancel the pending replacement.
		await setPhase('recovered-unchanged');
		await until(async () => (await lines('launches.log')).length === 2);
		await setPhase('preload');
		await until(async () => (await lines('launches.log')).length === 3);
		await command('relaunch');
		await until(async () => (await lines('launches.log')).length === 4);
		await setPhase('recovered-after-relaunch');
		await until(async () => (await lines('launches.log')).length === 5);
		await writeFile(join(desktop, 'busy-startup'), '');
		await command('relaunch');
		await until(() => output.includes('Waiting for the previous development instance'));
		await rm(join(desktop, 'busy-startup'));
		await until(async () => (await lines('launches.log')).length >= 7);
		const launches = (await lines('launches.log')).map(line => JSON.parse(line));
		const allCompilers = (await lines('compilers.log')).map(line => JSON.parse(line));
		assert.ok(allCompilers.length >= 7);
		for (const { pid, recordedAt, ...launch } of launches) {
			assert.ok(pid > 0);
			assert.deepEqual(launch, { cwd: desktop, args: ['--fixture', ...userDataArgs], home });
		}
		if (profile === 'cancelled') {
			await run.stop('SIGTERM');
		} else if (profile === 'custom') {
			// A secondary Electron can exit successfully after forwarding to the old
			// single instance. That must fail the launch, not leave a live watcher.
			await writeFile(join(desktop, 'refuse-startup'), '');
			await command('relaunch');
		} else {
			await command('quit');
		}
		await until(() => child.exitCode !== null || child.signalCode !== null);
		await closed;
		if (profile === 'cancelled') {
			if (process.platform === 'win32') assert.equal(child.signalCode, 'SIGTERM');
			else assert.equal(child.exitCode, 143, 'Stopping the launch task closes its input watcher and active processes');
		} else {
			assert.equal(child.exitCode, profile === 'custom' ? 1 : 0, output);
		}
		if (profile === 'custom') assert.match(output, /Electron exited before startup completed/u);
		await assertProcessesExited([...launches, ...allCompilers], output);
	});
}

test('cancelling startup retires the backend preparation and its compiler descendants', { timeout: process.platform === 'win32' ? 90_000 : 25_000 }, async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-electron-prepare-')));
	for (const name of launchSources) {
		await mkdir(join(root, name, '..'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, '../../..', name), join(root, name));
	}
	await mkdir(join(root, 'node_modules/electron'), { recursive: true });
	await symlink(resolve(import.meta.dirname, '../../../node_modules/typescript'), join(root, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	await writeFile(join(root, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
	await writeFile(join(root, 'build/desktop/develop.py'), `
import json, os, signal, subprocess, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, lambda *_: None)
child = subprocess.Popen([sys.executable, '-c', 'import os, signal, time; signal.signal(signal.SIGTERM, lambda *_: None); print(os.getpid(), flush=True); time.sleep(300)'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
compiler = int(child.stdout.readline())
Path('preparation.tmp').write_text(json.dumps({'parent': os.getpid(), 'compiler': compiler}))
os.replace('preparation.tmp', 'preparation.json')
print('compiler progress', file=sys.stderr, flush=True)
time.sleep(300)
`);
	const environment: NodeJS.ProcessEnv = { ...process.env, ASH_ELECTRON_LAUNCH_WORKER: '1', PYTHON: pythonCommand([]).command };
	delete environment.ASH_DESKTOP_UI_ONLY;
	// Windows termination cannot run a signal handler. Keep the real supervisor
	// so it can reclaim preparation after the launcher's IPC channel closes.
	if (process.platform === 'win32') delete environment.ASH_ELECTRON_LAUNCH_WORKER;
	const child = spawn(process.execPath, [join(root, 'build/desktop/launch/electron.ts'), '--watch'], { cwd: root, env: environment, stdio: 'pipe', detached: process.platform !== 'win32' });
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const run = new ProcessRun(root, undefined, 100);
	t.after(async () => { await run.stop('SIGTERM'); await rm(root, { recursive: true, force: true }); });
	await run.own(child);
	let preparation: { parent: number; compiler: number; } | undefined;
	const deadline = Date.now() + (process.platform === 'win32' ? 45_000 : 15_000);
	while (!preparation && Date.now() < deadline) {
		preparation = await readFile(join(root, 'preparation.json'), 'utf8').then(value => JSON.parse(value), error => { if (error.code !== 'ENOENT') throw error; });
		if (!preparation) await delay(50);
	}
	assert.ok(preparation, output);
	while (!output.includes('compiler progress') && Date.now() < deadline) await delay(50);
	assert.match(output, /Preparing the development backend/);
	assert.match(output, /compiler progress/);
	// Signal only the launcher: its cancellation owner must reclaim preparation
	// before this test's fallback ProcessRun performs cleanup.
	child.kill('SIGTERM');
	while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
	assert.ok(child.exitCode !== null || child.signalCode !== null, output);
	while ([preparation.parent, preparation.compiler].some(isProcessRunning) && Date.now() < deadline) await delay(50);
	for (const pid of [preparation.parent, preparation.compiler]) assert.equal(isProcessRunning(pid), false, `Leaked preparation process ${pid}: ${output}`);
});

test('a stale busy retry cannot replace the instance started by a concurrent rebuild', { timeout: process.platform === 'win32' ? 60_000 : 15_000 }, async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-electron-retry-')));
	for (const name of launchSources) {
		await mkdir(join(root, name, '..'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, '../../..', name), join(root, name));
	}
	await mkdir(join(root, 'node_modules/electron'), { recursive: true });
	await writeFile(join(root, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
	await writeFile(join(root, 'package.json'), '{"type":"module","main":"fixture.cjs"}');
	await writeFile(join(root, 'phase'), 'initial');
	await writeFile(join(root, 'build/desktop/host.ts'), `
import { watchFile, unwatchFile, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export async function watchHost(onReady) {
  const file = resolve(import.meta.dirname, '../../phase');
  const done = Promise.withResolvers();
  const update = () => onReady(true, readFileSync(file, 'utf8'));
  watchFile(file, { interval: 10 }, update);
  update();
  return { close: async () => { unwatchFile(file); done.resolve(); }, done: done.promise };
}
`);
	await writeFile(join(root, 'fixture.cjs'), `
const fs = require('node:fs');
if (!fs.existsSync('launches.log')) {
  fs.writeFileSync('launches.log', process.pid + '\\n');
  process.send('ash:dev:busy', () => process.exit(0));
} else {
  fs.appendFileSync('launches.log', process.pid + '\\n');
  process.send('ash:dev:ready', () => fs.writeFileSync('ready', ''));
  setInterval(() => {}, 1000);
}
`);
	const child = spawn(process.execPath, [join(root, 'build/desktop/launch/electron.ts'), '--watch'], { cwd: root, stdio: 'pipe', env: { ...process.env, ASH_DESKTOP_UI_ONLY: '1' } });
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const run = new ProcessRun(root, undefined, 100);
	t.after(async () => { await run.stop('SIGTERM'); await rm(root, { recursive: true, force: true }); });
	await run.own(child);
	async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
		const deadline = Date.now() + (process.platform === 'win32' ? 30_000 : 6_000);
		while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
		assert.fail(output);
	}
	await until(() => output.includes('Waiting for the previous development instance'));
	await writeFile(join(root, 'phase'), 'rebuilt');
	await until(() => readFile(join(root, 'ready')).then(() => true, () => false));
	// Let the original 250 ms retry expire after the rebuild has already started
	// its replacement. A stale retry used to stop that healthy process again.
	await delay(1_000);
	assert.equal(child.exitCode, null, output);
	const pids = (await readFile(join(root, 'launches.log'), 'utf8')).trim().split('\n').map(Number);
	assert.equal(pids.length, 2, output);
	assert.equal(isProcessRunning(pids[1]!), true);
});

for (const mode of ['running', 'rendererStarting', 'watcherFails', 'portBusy', 'supervisorKilled', 'supervisorKilledDuringRendererStartup', 'workerKilled', 'workerKilledDuringRendererStartup', 'workerHung', 'launcherKilledWorkerHung'] as const) {
	test(`F5 launcher owns Renderer and Rust watcher cleanup (${mode})`, { timeout: 90_000 }, async t => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-debug-services-')));
		for (const name of launchSources) {
			await mkdir(join(root, name, '..'), { recursive: true });
			await copyFile(resolve(import.meta.dirname, '../../..', name), join(root, name));
		}
		await mkdir(join(root, 'node_modules/electron'), { recursive: true });
		await mkdir(join(root, 'build/node_modules/vite/bin'), { recursive: true });
		await writeFile(join(root, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
		await writeFile(join(root, 'package.json'), '{"type":"module","main":"fixture.cjs"}');
		await writeFile(join(root, 'mode'), mode);
		await writeFile(join(root, 'build/desktop/host.ts'), `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync('supervisor.pid', JSON.stringify({ pid: process.ppid, recordedAt: Date.now() }));
export async function watchHost(onReady) {
  const done = Promise.withResolvers();
  const timer = setInterval(() => {
    if (!existsSync('hang-worker')) return;
    writeFileSync('worker-hung', '');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }, 20);
  onReady(true, 'initial');
  return { close: async () => { clearInterval(timer); done.resolve(); }, done: done.promise };
}
`);
		const record = `require('node:fs').appendFileSync('services.log', JSON.stringify({ pid: process.pid, recordedAt: Date.now() }) + '\\n');`;
		await writeFile(join(root, 'fixture.cjs'), `${record}\nprocess.send('ash:dev:ready'); setInterval(() => {}, 1000);`);
		await writeFile(join(root, 'build/node_modules/vite/bin/vite.js'), `
${record}
require('node:fs').writeFileSync('worker.pid', JSON.stringify({ pid: process.ppid, recordedAt: Date.now() }));
const net = require('node:net');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
net.createServer().listen(port, '127.0.0.1', () => {
  if (!['rendererStarting', 'supervisorKilledDuringRendererStartup', 'workerKilledDuringRendererStartup'].includes(require('node:fs').readFileSync('mode', 'utf8'))) console.log('\\x1b[32mLocal:\\x1b[0m \\x1b[36mhttp://\\x1b[1m127.0.0.1\\x1b[22m:' + port + '/');
});
`);
		await writeFile(join(root, 'build/node_modules/vite/package.json'), '{"type":"commonjs"}');
		await writeFile(join(root, 'build/desktop/watch-app-server.ts'), `
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
appendFileSync('services.log', JSON.stringify({ pid: process.pid, recordedAt: Date.now() }) + '\\n');
if (readFileSync('mode', 'utf8') === 'watcherFails') process.exit(2);
spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); ${record} setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
console.log('[app-server] Watching Rust App Server sources');
setInterval(() => {}, 1000);
`);
		const { createServer } = await import('node:net');
		const reservation = createServer();
		await new Promise<void>(resolveReady => reservation.listen(0, '127.0.0.1', resolveReady));
		const port = (reservation.address() as import('node:net').AddressInfo).port;
		await new Promise<void>((resolveClosed, reject) => reservation.close(error => error ? reject(error) : resolveClosed()));
		if (mode === 'portBusy') await new Promise<void>(resolveReady => reservation.listen(port, '127.0.0.1', resolveReady));
		const runs: ProcessRun[] = [];
		t.after(async () => { await Promise.all(runs.map(run => run.stop('SIGTERM'))); await rm(root, { recursive: true, force: true }); });
		const services = async (): Promise<ObservedProcess[]> => readFile(join(root, 'services.log'), 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []);
		const pids = async (): Promise<number[]> => (await services()).map(process => process.pid);
		const supervisorKilled = mode === 'supervisorKilled' || mode === 'supervisorKilledDuringRendererStartup';
		const rendererStarting = mode === 'rendererStarting' || mode === 'supervisorKilledDuringRendererStartup' || mode === 'workerKilledDuringRendererStartup';
		const workerKilled = mode === 'workerKilled' || mode === 'workerKilledDuringRendererStartup';
		const workerHung = mode === 'workerHung' || mode === 'launcherKilledWorkerHung';
		for (let attempt = 0; attempt < (mode === 'running' || supervisorKilled || workerKilled ? 2 : 1); attempt++) {
			const run = new ProcessRun(root, undefined, 100);
			runs.push(run);
			const previousCount = (await pids()).length;
			const child = spawn(process.execPath, [join(root, 'build/desktop/launch/electron.ts'), '--watch', '--dev-services', '--backend-prepared'], {
				cwd: root, stdio: 'pipe', env: { ...process.env, ASH_DESKTOP_UI_ONLY: undefined, ASH_DEV_APP_SERVER_RELOAD: '1', ASH_RENDERER_URL: `http://127.0.0.1:${port}` },
			});
			let output = '';
			child.stdout.on('data', chunk => { output += chunk; });
			child.stderr.on('data', chunk => { output += chunk; });
			await run.own(child);
			const startupDeadline = Date.now() + (process.platform === 'win32' ? 30_000 : 15_000);
			const expectedCount = rendererStarting || mode === 'portBusy' ? 1 : mode === 'watcherFails' ? 2 : 4;
			while ((await pids()).length < previousCount + expectedCount && Date.now() < startupDeadline) await delay(20);
			assert.equal((await pids()).length, previousCount + expectedCount, output);
			const worker = JSON.parse(await readFile(join(root, 'worker.pid'), 'utf8')) as ObservedProcess;
			const supervisor = JSON.parse(await readFile(join(root, 'supervisor.pid'), 'utf8')) as ObservedProcess;
			if (workerKilled) {
				await run.own(child);
				process.kill(worker.pid, 'SIGKILL');
			} else if (workerHung) {
				await run.own(child);
				await writeFile(join(root, 'hang-worker'), '');
				while (!await readFile(join(root, 'worker-hung')).then(() => true, () => false) && Date.now() < startupDeadline) await delay(20);
				assert.ok(await readFile(join(root, 'worker-hung')));
				if (mode === 'launcherKilledWorkerHung') child.kill('SIGKILL');
			} else if (supervisorKilled) {
				// Retain the tree for test teardown, but signal only the supervisor:
				// the worker must reclaim its own services after the IPC channel closes.
				await run.own(child);
				child.kill('SIGKILL');
			} else if (mode !== 'watcherFails' && mode !== 'portBusy') {
				if (process.platform === 'win32') await run.stop('SIGTERM');
				else child.kill('SIGTERM');
			}
			// Startup must not consume the supervisor's independent termination budget.
			const cleanupDeadline = Date.now() + (workerHung ? 50_000 : process.platform === 'win32' ? 30_000 : 15_000);
			while (child.exitCode === null && child.signalCode === null && Date.now() < cleanupDeadline) await delay(20);
			if (supervisorKilled || mode === 'launcherKilledWorkerHung') assert.equal(child.signalCode, 'SIGKILL', output);
			else if (workerKilled || workerHung) assert.equal(child.exitCode, 1, output);
			else if (mode !== 'watcherFails' && mode !== 'portBusy' && process.platform === 'win32') assert.equal(child.signalCode, 'SIGTERM', output);
			else assert.equal(child.exitCode, mode === 'watcherFails' || mode === 'portBusy' ? 1 : 143, output);
			const owned = [supervisor, worker, ...(await services()).slice(previousCount)];
			while (owned.some(process => isProcessRunning(process.pid)) && Date.now() < cleanupDeadline) await delay(20);
			await assertProcessesExited(owned, output);
			if (mode === 'workerHung') assert.match(output, /Development worker stopped responding/u);
			if (mode === 'portBusy') {
				assert.equal(reservation.listening, true, 'An unrelated port owner must survive launcher cleanup');
				await new Promise<void>((resolveClosed, reject) => reservation.close(error => error ? reject(error) : resolveClosed()));
			}
			await new Promise<void>((resolveReady, reject) => reservation.once('error', reject).listen(port, '127.0.0.1', resolveReady));
			await new Promise<void>((resolveClosed, reject) => reservation.close(error => error ? reject(error) : resolveClosed()));
		}
	});
}
