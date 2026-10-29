import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { isProcessRunning, ProcessRun } from '../../processes.ts';
import { pythonCommand } from '../../python.ts';

const launchSources = ['build/source-layout.json', 'build/processes.ts', 'build/desktop/launch/electron.ts', 'build/desktop/electron.ts', 'src/ash/code/common/application.ts', 'build/desktop/host.ts', 'build/desktop/paths.ts', 'build/desktop/appServer.ts', 'build/desktop/liveBuild.ts', 'build/python.ts', 'build/protocol/generate.ts', 'build/lib/incrementalOutput.ts', 'build/lib/watchNativeFile.ts'];

for (const profile of ['default', 'custom', 'separated', 'cancelled'] as const) {
	test(`Electron starts once after valid compilation and restarts only after valid rebuilds (${profile} profile)`, { timeout: process.platform === 'win32' ? 60_000 : 20_000 }, async t => {
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
		await symlink(resolve(import.meta.dirname, '../../../node_modules/typescript'), join(root, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
		for (const project of ['main', 'preload']) {
			await writeFile(join(root, `tsconfig.${project}.json`), JSON.stringify({ compilerOptions: { incremental: true, outDir: `.build/desktop/${project}`, tsBuildInfoFile: `.build/desktop/${project}.tsbuildinfo` }, files: ['fixture.cjs'] }));
		}
		await writeFile(join(desktop, 'package.json'), '{"main":"fixture.cjs","type":"module"}');
		await writeFile(join(desktop, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
		await writeFile(join(desktop, 'fixture.cjs'), `
      require('node:fs').appendFileSync('launches.log', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE, launchWorker: process.env.ASH_ELECTRON_LAUNCH_WORKER, runDirectory: process.env.ASH_SMOKE_RUN_DIRECTORY, home: process.env.ASH_HOME }) + '\\n');
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
      fs.appendFileSync('compilers.log', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
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
			const deadline = Date.now() + (process.platform === 'win32' ? 15_000 : 6_000);
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
		assert.equal((await lines('launches.log')).length, 1, 'Rewriting unchanged compiler outputs must not restart Electron');
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
		for (const { pid, ...launch } of launches) {
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
		for (const { pid } of [...launches, ...allCompilers]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
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
	await writeFile(join(root, 'build/prepare.py'), `
import json, os, signal, subprocess, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, lambda *_: None)
child = subprocess.Popen([sys.executable, '-c', 'import os, signal, time; signal.signal(signal.SIGTERM, lambda *_: None); print(os.getpid(), flush=True); time.sleep(300)'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
compiler = int(child.stdout.readline())
Path('preparation.tmp').write_text(json.dumps({'parent': os.getpid(), 'compiler': compiler}))
os.replace('preparation.tmp', 'preparation.json')
time.sleep(300)
`);
	const environment: NodeJS.ProcessEnv = { ...process.env, ASH_ELECTRON_LAUNCH_WORKER: '1', PYTHON: pythonCommand([]).command };
	delete environment.ASH_DESKTOP_UI_ONLY;
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
	// Signal only the launcher: its own cancellation must reclaim the detached
	// preparation group before this test's fallback ProcessRun performs cleanup.
	child.kill('SIGTERM');
	while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
	assert.notEqual(child.exitCode, null, output);
	for (const pid of [preparation.parent, preparation.compiler]) assert.equal(isProcessRunning(pid), false, `Leaked preparation process ${pid}`);
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
