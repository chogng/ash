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
	if (watch) {
		environment.ASH_HOME ??= resolve(sourceRoot, '.build/desktop/dev/profile');
		if (!args.some(argument => argument.startsWith('--user-data-dir='))) args.push(`--user-data-dir=${resolve(sourceRoot, '.build/desktop/dev/user-data')}`);
	}

	let electronRun: ProcessRun | undefined;
	let watcher: Awaited<ReturnType<typeof watchHost>> | undefined;
	let readyOutput: string | undefined;
	let launchedOutput: string | undefined;
	let restarting = false;
	let stopped = false;

	async function launch(): Promise<void> {
		if (stopped) return;
		const run = new ProcessRun(sourceRoot, undefined, 5_000);
		electronRun = run;
		const child = spawn(executable, [sourceRoot, ...args], { cwd: sourceRoot, env: environment, stdio: 'inherit', detached: process.platform !== 'win32' });
		child.once('error', error => { console.error(error); process.exitCode = 1; void stop(); });
		child.once('exit', code => {
			if (!watch) process.exitCode = code ?? 1;
			void run.close().catch(error => { console.error(error); process.exitCode = 1; });
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
		await Promise.all([watcher?.close(), electronRun?.stop('SIGTERM')]);
	}

	process.once('SIGINT', () => { void stop(); });
	process.once('SIGTERM', () => { void stop(); });
	if (environment.ASH_DESKTOP_UI_ONLY !== '1') await prepareAppServer('host-provided-node');
	if (stopped) process.exit(1);
	if (watch) {
		watcher = await watchHost((current, output) => {
			readyOutput = current ? output : undefined;
			if (current) void restart();
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
