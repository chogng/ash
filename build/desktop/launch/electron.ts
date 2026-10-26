import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { watchHost } from '../host.ts';
import { ProcessRun, withProcessRun } from '../../processes.ts';
import { prepareAppServer } from '../appServer.ts';
import { resolveDevelopmentElectronExecutable } from '../electron.ts';

if (process.env.ASH_ELECTRON_LAUNCH_WORKER !== '1') {
	await withProcessRun(resolve(import.meta.dirname, '../../..'), async (run, environment) => {
		process.exitCode = (await run.command(process.execPath, [process.argv[1], ...process.argv.slice(2)], { ...environment, ASH_ELECTRON_LAUNCH_WORKER: '1' })).code;
	});
} else {
	const sourceRoot = resolve(import.meta.dirname, '../../..');
	const executable = resolveDevelopmentElectronExecutable(sourceRoot);
	const args = process.argv.slice(2);
	const watch = args[0] === '--watch';
	if (watch) args.shift();
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	// Product-launched commands must own independent supervisors and registries.
	delete environment.ASH_ELECTRON_LAUNCH_WORKER;
	delete environment.ASH_SMOKE_RUN_DIRECTORY;
	if (watch) {
		environment.ASH_DEV_LAUNCHER = '1';
		environment.ASH_HOME ??= resolve(sourceRoot, '.build/desktop/dev/profile');
		if (!args.some(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='))) args.push(`--user-data-dir=${resolve(sourceRoot, '.build/desktop/dev/user-data')}`);
	} else {
		delete environment.ASH_DEV_LAUNCHER;
	}

	let electronRun: ProcessRun | undefined;
	let watcher: Awaited<ReturnType<typeof watchHost>> | undefined;
	let readyOutput: string | undefined;
	let launchedOutput: string | undefined;
	let restarting = false;
	let stopped = false;
	let busySince: number | undefined;
	let generation = 0;
	const cancellation = new AbortController();

	async function launch(): Promise<void> {
		if (stopped) return;
		const currentGeneration = ++generation;
		const run = new ProcessRun(sourceRoot, undefined, 5_000);
		electronRun = run;
		let ready = false;
		let relaunch = false;
		let busy = false;
		const child = spawn(executable, [sourceRoot, ...args], { cwd: sourceRoot, env: environment, stdio: watch ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', detached: process.platform !== 'win32' });
		child.on('message', message => {
			if (message === 'ash:dev:ready') { ready = true; busySince = undefined; }
			if (message === 'ash:dev:relaunch') relaunch = true;
			if (message === 'ash:dev:busy') busy = true;
		});
		child.once('error', fail);
		child.once('exit', code => {
			const expected = run.stopped;
			void (async () => {
				await run.close();
				if (electronRun !== run) return;
				electronRun = undefined;
				if (stopped || expected) return;
				if (watch && busy) {
					if (busySince === undefined) {
						busySince = Date.now();
						console.log('[host] Waiting for the previous development instance to release its profile...');
					}
					if (Date.now() - busySince < 10_000) {
						await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 250));
						// A valid rebuild may already have launched a newer instance while
						// this attempt waited. Its retry must not retire that replacement.
						if (stopped || currentGeneration !== generation) return;
						relaunch = true;
					}
				}
				if (watch && relaunch) {
					launchedOutput = undefined;
					await restart();
					return;
				}
				process.exitCode = watch && !ready ? 1 : code ?? 1;
				if (watch && !ready) console.error('[host] Electron exited before startup completed. Check the startup errors and whether this development profile is already running.');
				await stop();
			})().catch(fail);
		});
		await run.own(child);
	}

	async function restart(): Promise<void> {
		if (restarting) return;
		restarting = true;
		try {
			while (readyOutput !== undefined && !stopped) {
				if (electronRun && readyOutput === launchedOutput) break;
				if (electronRun) await electronRun.stop('SIGTERM');
				electronRun = undefined;
				if (readyOutput === undefined || stopped) break;
				launchedOutput = readyOutput;
				await launch();
			}
		} finally {
			restarting = false;
		}
	}

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		cancellation.abort();
		await Promise.all([watcher?.close(), electronRun?.stop('SIGTERM')]);
	}

	function fail(error: unknown): void {
		console.error(error);
		process.exitCode = 1;
		void stop().catch(error => { console.error(error); });
	}

	process.once('SIGINT', () => { void stop().catch(fail); });
	process.once('SIGTERM', () => { void stop().catch(fail); });
	if (environment.ASH_DESKTOP_UI_ONLY !== '1') {
		try { await prepareAppServer('host-provided-node', cancellation.signal); }
		catch (error) { if (!stopped) throw error; }
	}
	if (stopped) process.exit(1);
	if (watch) {
		watcher = await watchHost((current, output) => {
			readyOutput = current ? output : undefined;
			if (current) void restart().catch(fail);
		});
		if (stopped) await watcher.close();
		try {
			await watcher.done;
		} catch (error) {
			console.error(error);
			process.exitCode = 1;
			await stop();
		}
	} else {
		await launch();
	}

}
