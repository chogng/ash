import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { watchHost } from '../host.ts';
import { detachedProcess, ProcessRun, registerRunResource } from '../../processes.ts';
import { prepareAppServer } from '../appServer.ts';
import { resolveDevelopmentElectronExecutable } from '../electron.ts';
import { developmentAshPackagePath } from '../runtimeStore.ts';

async function checkDebugPorts(args: readonly string[]): Promise<void> {
	// F5 shares fixed debugger endpoints even when Vite can choose a different port.
	for (const argument of args) {
		const match = /^--(?:inspect-brk=127\.0\.0\.1:|remote-debugging-port=)([1-9]\d{0,4})$/u.exec(argument);
		if (!match) continue;
		const port = Number(match[1]);
		if (port > 65_535) continue;
		const host = '127.0.0.1';
		const probe = createServer();
		try {
			await new Promise<void>((ready, reject) => {
				probe.once('error', reject);
				probe.listen(port, host, () => probe.close(error => error ? reject(error) : ready()));
			});
		} catch (error) {
			if (error.code !== 'EADDRINUSE') throw error;
			throw new Error(`Ash desktop debug port ${host}:${port} is already in use. Stop the session using it before starting another.`);
		}
	}
}

if (process.env.ASH_ELECTRON_LAUNCH_WORKER !== '1') {
	const child = spawn(process.execPath, [resolve(import.meta.dirname, 'supervisor.ts'), ...process.argv.slice(2)], {
		cwd: resolve(import.meta.dirname, '../../..'),
		// The supervisor closes its registry on exit. A nested launch must never
		// inherit one that also owns the Ash instance running this debugger.
		env: { ...process.env, ASH_SMOKE_RUN_DIRECTORY: undefined },
		stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
		// Windows also needs the supervisor outside the launcher's kill-on-close job.
		// Its IPC disconnect handler must survive a forcibly terminated launcher.
		detached: true,
		windowsHide: true,
	});
	// A detached supervisor must write through the launcher that owns the debug terminal.
	child.stdout?.pipe(process.stdout, { end: false });
	child.stderr?.pipe(process.stderr, { end: false });
	const interrupt = (): void => { child.kill('SIGINT'); };
	const terminate = (): void => { child.kill('SIGTERM'); };
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', terminate);
	try {
		process.exitCode = await new Promise<number>((resolveExit, reject) => {
			child.once('error', reject);
			child.once('close', (code, signal) => resolveExit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code ?? 1));
		});
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
	}
} else {
	if (process.send) {
		if (!process.connected) process.exit(1);
		const disconnected = (): void => process.exit(1);
		process.once('disconnect', disconnected);
		await new Promise<void>(resolveStart => process.on('message', function start(message) {
			if (message !== 'ash:dev:start') return;
			process.off('message', start);
			resolveStart();
		}));
		process.off('disconnect', disconnected);
	}
	const sourceRoot = resolve(import.meta.dirname, '../../..');
	const executable = resolveDevelopmentElectronExecutable(sourceRoot);
	const args = process.argv.slice(2);
	const watch = args[0] === '--watch';
	if (watch) args.shift();
	const developmentServices = args[0] === '--dev-services';
	if (developmentServices) args.shift();
	if (developmentServices && !watch) throw new Error('--dev-services requires --watch');
	const backendPrepared = args[0] === '--backend-prepared';
	if (backendPrepared) args.shift();
	const environment = { ...process.env };
	const subsecond = environment.ASH_DEV_SUBSECOND === '1';
	let subsecondSession: string | undefined;
	if (subsecond) {
		if (process.platform !== 'darwin' || process.arch !== 'arm64' || !developmentServices || backendPrepared || environment.ASH_DEV_APP_SERVER_RELOAD !== '1' || environment.ASH_DESKTOP_UI_ONLY === '1' || environment.ASH_RUST_LIVE_DIRECTORY) {
			throw new Error('Subsecond development requires Apple Silicon macOS and pnpm dev:subsecond without ASH_RUST_LIVE_DIRECTORY');
		}
		if (args.some(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='))) throw new Error('Subsecond development owns its isolated user-data directory');
		const directory = resolve(sourceRoot, '.build/desktop/subsecond');
		mkdirSync(directory, { recursive: true });
		const session = mkdtempSync(resolve(directory, 'session-'));
		subsecondSession = session;
		environment.ASH_HOME = resolve(session, 'profile');
		environment.ASH_DEV_APP_SERVER_GENERATION = resolve(session, 'app-server/current.json');
		args.push(`--user-data-dir=${resolve(session, 'user-data')}`);
	}
	delete environment.ELECTRON_RUN_AS_NODE;
	// Product-launched commands must own independent supervisors and registries.
	delete environment.ASH_ELECTRON_LAUNCH_WORKER;
	delete environment.ASH_SMOKE_RUN_DIRECTORY;
	delete environment.ASH_DEV_PROCESS_SUPERVISED;
	if (watch) {
		environment.ASH_DEV_LAUNCHER = '1';
		environment.ASH_HOME ??= resolve(sourceRoot, '.build/desktop/dev/profile');
		if (!args.some(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='))) args.push(`--user-data-dir=${resolve(sourceRoot, '.build/desktop/dev/user-data')}`);
	} else {
		delete environment.ASH_DEV_LAUNCHER;
	}
	const serviceEnvironment: NodeJS.ProcessEnv = { ...environment, ASH_SMOKE_RUN_DIRECTORY: process.env.ASH_SMOKE_RUN_DIRECTORY, ASH_DEV_PROCESS_SUPERVISED: process.env.ASH_DEV_PROCESS_SUPERVISED };
	if (subsecond) {
		serviceEnvironment.ASH_ELECTRON_RUN_AS_NODE_PATH = executable;
		serviceEnvironment.ASH_USE_DEVELOPMENT_SECRETSTORAGE = '1';
	}

	let electronRun: ProcessRun | undefined;
	const servicesRun = developmentServices ? new ProcessRun(sourceRoot, undefined, 5_000) : undefined;
	let watcher: Awaited<ReturnType<typeof watchHost>> | undefined;
	let readyOutput: string | undefined;
	let launchedOutput: string | undefined;
	let restarting = false;
	let stopped = false;
	let stopping: Promise<void> | undefined;
	let busySince: number | undefined;
	let generation = 0;
	const cancellation = new AbortController();

	async function startService(name: string, arguments_: readonly string[], readyPattern: RegExp): Promise<RegExpExecArray | undefined> {
		if (stopped) return;
		const ready = Promise.withResolvers<RegExpExecArray>();
		let listening = false;
		let output = '';
		const child = spawn(process.execPath, arguments_, {
			cwd: sourceRoot,
			env: serviceEnvironment,
			stdio: ['ignore', 'pipe', 'inherit'],
			detached: detachedProcess(),
		});
		child.stdout.on('data', (chunk: Buffer) => {
			process.stdout.write(chunk);
			if (listening) return;
			output = (output + chunk.toString()).slice(-8192);
			const match = readyPattern.exec(stripVTControlCharacters(output));
			if (match) {
				listening = true;
				ready.resolve(match);
			}
		});
		child.once('error', error => ready.reject(error));
		child.once('exit', (code, signal) => {
			const error = new Error(`${name} exited${signal ? ` with ${signal}` : ` with status ${code}`} before the debug launcher stopped.`);
			if (!listening) ready.reject(error);
			else if (!stopped) fail(error);
		});
		const [, match] = await Promise.all([servicesRun!.own(child), ready.promise]);
		return match;
	}

	async function launch(): Promise<void> {
		if (stopped) return;
		const currentGeneration = ++generation;
		const run = new ProcessRun(sourceRoot, undefined, 5_000);
		electronRun = run;
		let ready = false;
		let relaunch = false;
		let busy = false;
		const electronEnvironment = { ...environment };
		// VS Code injects a Node preload for the launcher. Electron Main uses its own inspector arguments.
		delete electronEnvironment.NODE_OPTIONS;
		delete electronEnvironment.VSCODE_INSPECTOR_OPTIONS;
		const child = spawn(executable, [sourceRoot, ...args], { cwd: sourceRoot, env: electronEnvironment, stdio: watch ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', detached: detachedProcess() });
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

	function stop(): Promise<void> {
		if (stopping) return stopping;
		stopped = true;
		cancellation.abort();
		// Close Electron before retiring the backend so it cannot reconnect while
		// the supervisor is trying to clean up the isolated profile.
		const closeServices = async (): Promise<void> => {
			try { await electronRun?.stop('SIGTERM'); }
			finally { await servicesRun?.stop('SIGTERM'); }
		};
		return stopping = Promise.all([watcher?.close(), closeServices()]).then(() => undefined);
	}

	function fail(error: unknown): void {
		console.error(error);
		process.exitCode = 1;
		void stop().catch(error => { console.error(error); });
	}

	process.once('SIGINT', () => { void stop().catch(fail); });
	process.once('SIGTERM', () => { void stop().catch(fail); });
	// A debugger can kill the supervisor without delivering a termination signal
	// to this detached worker. IPC closure still retires its services and Electron.
	process.once('disconnect', () => { void stop().catch(fail); });
	process.channel?.unref();
	if (process.send && !process.connected) await stop();
	const heartbeat = process.send ? setInterval(() => {
		if (process.connected) process.send!('ash:dev:heartbeat', () => { });
	}, 1_000).unref() : undefined;
	process.once('exit', () => clearInterval(heartbeat));
	if (developmentServices && !stopped) {
		try { await checkDebugPorts(args); }
		catch (error) {
			console.error(`[host] ${error.message}`);
			await stop();
			process.exit(1);
		}
	}
	if (!stopped && !backendPrepared && environment.ASH_DESKTOP_UI_ONLY !== '1') {
		console.log('[app-server] Preparing the development backend (builds Rust binaries if needed)...');
		try { await prepareAppServer('host-provided-node', cancellation.signal, subsecond ? serviceEnvironment : undefined); }
		catch (error) { if (!stopped) throw error; }
	}
	if (stopped) { await stop(); process.exit(1); }
	if (subsecondSession) {
		// Stop the isolated daemon after its clients, even after an ordinary fallback.
		const daemon = resolve(subsecondSession, 'ash-app-server-daemon');
		copyFileSync(resolve(developmentAshPackagePath(sourceRoot), 'bin/ash-app-server-daemon'), daemon);
		await registerRunResource({ executable: daemon, profile: environment.ASH_HOME! });
	}
	if (developmentServices) {
		try {
			const renderer = new URL(environment.ASH_RENDERER_URL ?? '');
			if (renderer.protocol !== 'http:' || renderer.hostname !== '127.0.0.1' || !renderer.port
				|| renderer.pathname !== '/' || renderer.search || renderer.hash || renderer.username || renderer.password) {
				throw new Error('--dev-services requires a loopback ASH_RENDERER_URL with an explicit port');
			}
			// Only the renderer child knows which port Vite successfully bound.
			const rendererReady = await startService('Renderer', [
				resolve(sourceRoot, 'build/node_modules/vite/bin/vite.js'),
				'--config', 'build/desktop/vite/vite.config.ts',
				'--host', renderer.hostname, '--port', renderer.port, '--no-strictPort',
			], /\bLocal:[ \t]+(http:\/\/127\.0\.0\.1:\d+)\//u);
			if (rendererReady) environment.ASH_RENDERER_URL = rendererReady[1];
			if (environment.ASH_DEV_APP_SERVER_RELOAD === '1') {
				await startService('App Server watcher', ['build/desktop/watch-app-server.ts', '--skip-initial'], /\[app-server\] Watching Rust App Server sources/u);
			}
		} catch (error) {
			if (!stopped) fail(error);
		}
	}
	if (stopped) { await stop(); process.exit(1); }
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
