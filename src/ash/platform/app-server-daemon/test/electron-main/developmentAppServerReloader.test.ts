import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'mocha';
import { DisposableStore, DisposableTracker, installDisposableTracker, toDisposable } from '../../../../base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../agentHost/common/appServerApi.js';
import { AppServerDaemonLauncher } from '../../electron-main/appServerDaemonLauncher.js';
import { DevelopmentAppServerReloader } from '../../electron-main/developmentAppServerReloader.js';
import { readDevelopmentAppServerGeneration } from '../../node/developmentAppServerGeneration.js';
import type { IDevelopmentAppServerRuntime } from '../../electron-main/developmentAppServerRuntime.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { LogService } from '../../../log/common/logServiceImpl.js';
import type { LogEntry } from '../../../log/common/log.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { DeferredPromise, disposableTimeout } from '../../../../base/common/async.js';

const oldRuntime = resolve('/test/old');
const newRuntime = resolve('/test/new');

test('development reloader creation requires the registered log service', () => {
	using services = new InstantiationService(new ServiceCollection());
	assert.throws(() => services.createInstance(DevelopmentAppServerReloader, { generationFile: resolve('/test/current.json') }), /logService/);
});

for (const scenario of ['completed', 'failed', 'invalid', 'superseded'] as const) {
	test(`development ${scenario} restart records its cause and version transition`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-reload-log-'));
		try {
			using resources = new DisposableStore();
			const entries: LogEntry[] = [];
			using logs = new LogService({ sinks: [{ log: entry => entries.push(entry) }] });
			const buildId = '11111111-1111-4111-8111-111111111111';
			const runtime = join(directory, 'generations', 'b'.repeat(64));
			const publication = {
				version: 1, buildId, reason: 'source-change', files: ['crates/app-server/src/startup.rs'], omittedFileCount: 0,
				timestampMillis: Date.now(), previousRuntime: `generations/${'a'.repeat(64)}`,
				runtime: `generations/${(scenario === 'superseded' ? 'c' : 'b').repeat(64)}`, buildLog: join(directory, 'build.log'),
			};
			await writeFile(join(directory, 'publication.json'), scenario === 'invalid' ? '{' : JSON.stringify(publication));
			const window = connection(resources, 'workbench', []);
			const reloader = resources.add(new DevelopmentAppServerReloader({
				generationFile: join(directory, 'current.json'), watchGeneration: () => toDisposable(() => { }),
				readGeneration: async () => runtime,
				acquireGeneration: async () => Object.assign(toDisposable(() => { }), { runtime, assertActive() { } }),
				preflight: async () => { }, restartDaemon: async () => { if (scenario === 'failed') { throw new Error('injected restart failure'); } },
			}, logs));
			resources.add(reloader.registerConnection(window.launcher, window.supervisor));
			if (scenario === 'failed') { await assert.rejects(reloader.reloadNow(), /injected restart failure/); }
			else { await reloader.reloadNow(); }
			await logs.flush();

			const restart = entries.filter(entry => entry.message.startsWith('Development runtime restart'));
			assert.equal(restart.length, 2);
			const [started, result] = restart.map(entry => JSON.parse(entry.message.slice(entry.message.indexOf('{'), entry.message.lastIndexOf('}') + 1)));
			assert.equal(result.restartId, started.restartId);
			assert.deepEqual(result.previousRuntimes, ['old']);
			assert.equal(result.runtime, 'b'.repeat(64));
			assert.equal(typeof result.durationMillis, 'number');
			if (scenario === 'invalid' || scenario === 'superseded') {
				assert.equal(result.reason, 'runtime-publication');
				assert.equal(result.publicationMetadata, scenario);
				assert.equal(result.buildId, undefined);
			} else {
				assert.equal(result.reason, 'source-change');
				assert.equal(result.buildId, buildId);
				assert.deepEqual(result.files, ['crates/app-server/src/startup.rs']);
				assert.equal(result.buildLog, publication.buildLog);
			}
			assert.equal(restart[1].level, scenario === 'failed' ? 'error' : 'information');
			if (scenario === 'failed') {
				assert.equal(result.phase, 'restarting-daemon');
				assert.match(String(restart[1].error), /injected restart failure/);
			}
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}

function connection(resources: DisposableStore, name: string, events: string[], initial: AppServerConnectionState = 'ready') {
	const launcher = resources.add(new AppServerDaemonLauncher({ executable: resolve('/test/daemon'), args: ['connect-selected'], environment: { ASH_DEV_RUNTIME_ROOT: oldRuntime, ASH_APP_SERVER_PATH: resolve(oldRuntime, 'bin/ash-app-server') }, fileExists: () => true }));
	const listeners = new Set<(state: AppServerConnectionState) => void>();
	let state = initial;
	const supervisor = {
		get state() { return state; },
		onStateChange(listener: (state: AppServerConnectionState) => void) { listeners.add(listener); return toDisposable(() => { listeners.delete(listener); }); },
		stop: async () => { events.push(`stop:${name}`); state = 'stopped'; },
		start: async () => { await launcher.validate(); events.push(`start:${name}`); state = 'ready'; },
	};
	return { launcher, supervisor, listeners, setState(value: AppServerConnectionState) { state = value; for (const listener of listeners) listener(value); } };
}

function coordinator(resources: DisposableStore, restartDaemon: (launcher: AppServerDaemonLauncher) => Promise<void>, readGeneration: () => Promise<string | undefined> = async () => newRuntime) {
	return resources.add(new DevelopmentAppServerReloader({ generationFile: resolve('/test/current.json'), watchGeneration: () => toDisposable(() => { }), readGeneration, acquireGeneration: async () => Object.assign(toDisposable(() => { }), { runtime: (await readGeneration())!, assertActive: () => { } }), preflight: async () => { }, restartDaemon }, new NullLoggerService()));
}

test('development change notifications validate pointers without opening collected runtime files', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-generation-'));
	try {
		const runtimePath = `generations/${'a'.repeat(64)}`;
		const runtime = join(directory, runtimePath);
		for (const name of ['bin', 'ash-path', 'ash-resources']) await mkdir(join(runtime, name), { recursive: true });
		for (const name of ['ash-development.json', `bin/ash-app-server${process.platform === 'win32' ? '.exe' : ''}`, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`]) await writeFile(join(runtime, name), 'file');
		const file = join(directory, 'current.json');
		await writeFile(file, JSON.stringify({ version: 3, runtime: runtimePath }));
		assert.equal(await readDevelopmentAppServerGeneration(file), runtime);
		for (const invalid of [{ version: 3, runtime: `../${runtimePath}` }, { version: 2, package: runtimePath }, { version: 3, runtime: runtimePath, extra: true }]) {
			await writeFile(file, JSON.stringify(invalid));
			await assert.rejects(readDevelopmentAppServerGeneration(file), /invalid/u);
		}
		await writeFile(file, JSON.stringify({ version: 3, runtime: `generations/${'b'.repeat(64)}` }));
		assert.equal(await readDevelopmentAppServerGeneration(file), join(directory, 'generations', 'b'.repeat(64)));
		assert.equal(await readDevelopmentAppServerGeneration(join(directory, 'absent.json')), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('atomic runtime pointer replacement reaches the profile reloader without native watch events', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-generation-notification-'));
	try {
		using resources = new DisposableStore();
		const generationFile = join(directory, 'current.json');
		const first = `generations/${'a'.repeat(64)}`;
		const second = `generations/${'b'.repeat(64)}`;
		await writeFile(generationFile, JSON.stringify({ version: 3, runtime: first }));
		const events: string[] = [];
		const window = connection(resources, 'workbench', events);
		const completed = new DeferredPromise<void>();
		const cleanup = new DeferredPromise<void>();

		const logger = new NullLoggerService();
		logger.info = (_category, message) => { if (message === 'Development runtime restart completed') void completed.complete(); };
		logger.error = (_category, _message, ...args) => { void completed.error(args.at(-1)); };
		const reloader = resources.add(new DevelopmentAppServerReloader({
			generationFile,
			acquireGeneration: async () => Object.assign(toDisposable(() => { }), {
				runtime: (await readDevelopmentAppServerGeneration(generationFile))!, assertActive() { },
			}),
			preflight: async () => ({ cleanup: cleanup.p }), restartDaemon: async launcher => {
				assert.equal(launcher.environment.ASH_DEV_RUNTIME_ROOT, join(directory, second));
				events.push('restart');
			},
		}, logger));
		resources.add(reloader.registerConnection(window.launcher, window.supervisor));
		await window.launcher.validate();
		assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, join(directory, first));
		const replacement = join(directory, 'next.json');
		await writeFile(replacement, JSON.stringify({ version: 3, runtime: second }));
		using timeout = disposableTimeout(() => { void completed.error(new Error('Runtime pointer replacement was not observed')); }, 5_000);
		await rename(replacement, generationFile);
		try {
			await completed.p;
			assert.deepEqual(events, ['stop:workbench', 'restart', 'start:workbench']);
		} finally { await cleanup.complete(); }
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('Workbench and Agents stop together, restart one daemon, and reconnect without leaks', async () => {
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	const resources = new DisposableStore();
	try {
		const events: string[] = [];
		const workbench = connection(resources, 'workbench', events);
		const agents = connection(resources, 'agents', events);
		const reloader = coordinator(resources, async launcher => { assert.equal(launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime); events.push('restart'); });
		resources.add(reloader.registerConnection(workbench.launcher, workbench.supervisor));
		resources.add(reloader.registerConnection(agents.launcher, agents.supervisor));
		await reloader.reloadNow();
		await reloader.reloadNow();
		assert.deepEqual(events, ['stop:workbench', 'stop:agents', 'restart', 'start:workbench', 'start:agents']);
		assert.equal(agents.launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
	} finally { resources.dispose(); }
	tracker.assertNoLeaks();
});

test('an older runtime acquisition cannot roll back a newer completed reload', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events);
	const newestRuntime = resolve('/test/newest');
	let runtime = newRuntime;
	let acquisitions = 0;
	let staleReleased = false;
	const stale = Object.assign(toDisposable(() => { staleReleased = true; }), { runtime: newRuntime, assertActive() { assert.equal(staleReleased, false); } });
	const newest = Object.assign(toDisposable(() => { }), { runtime: newestRuntime, assertActive() { } });
	const acquiring = new DeferredPromise<void>();
	const acquired = new DeferredPromise<IDevelopmentAppServerRuntime>();
	const reloader = resources.add(new DevelopmentAppServerReloader({
		generationFile: resolve('/test/current.json'),
		watchGeneration: () => toDisposable(() => { }),
		readGeneration: async () => runtime,
		acquireGeneration: async () => {
			if (++acquisitions === 1) { void acquiring.complete(); return acquired.p; }
			return newest;
		},
		preflight: async () => { }, restartDaemon: async () => { events.push('restart'); },
	}, new NullLoggerService()));
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	const pending = reloader.reloadNow();
	await acquiring.p;
	runtime = newestRuntime;
	await reloader.reloadNow();
	void acquired.complete(stale);
	await pending;
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, newestRuntime);
	assert.equal(staleReleased, true);
	assert.deepEqual(events, ['stop:workbench', 'restart', 'start:workbench']);
});

test('a pending runtime remains leased while old connections stop and releases after replacement', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events);
	let finishStop!: () => void;
	let stopped!: () => void;
	const stopping = new Promise<void>(resolvePromise => { stopped = resolvePromise; });
	window.supervisor.stop = async () => { stopped(); await new Promise<void>(resolvePromise => { finishStop = resolvePromise; }); };
	let released = false;
	const lease: IDevelopmentAppServerRuntime = Object.assign(toDisposable(() => { released = true; }), { runtime: newRuntime, assertActive: () => { assert.equal(released, false); } });
	const reloader = resources.add(new DevelopmentAppServerReloader({ generationFile: resolve('/test/current.json'), watchGeneration: () => toDisposable(() => { }), readGeneration: async () => newRuntime, acquireGeneration: async () => lease, preflight: async () => { }, restartDaemon: async launcher => { assert.equal(launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime); assert.equal(released, false); } }, new NullLoggerService()));
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	const reload = reloader.reloadNow();
	await stopping;
	assert.equal(released, false);
	finishStop();
	await reload;
	assert.equal(released, false);
	reloader.dispose();
	assert.equal(released, true);
});

test('closing the runtime owner during startup releases a lease that arrives afterward', async () => {
	using resources = new DisposableStore();
	const window = connection(resources, 'agents', [], 'stopped');
	let finishSelection!: (lease: IDevelopmentAppServerRuntime) => void;
	const selected = new Promise<IDevelopmentAppServerRuntime>(resolvePromise => { finishSelection = resolvePromise; });
	let released = false;
	const lease = Object.assign(toDisposable(() => { released = true; }), { runtime: oldRuntime, assertActive: () => { } });
	const reloader = resources.add(new DevelopmentAppServerReloader({ generationFile: resolve('/test/current.json'), watchGeneration: () => toDisposable(() => { }), acquireGeneration: async () => selected }, new NullLoggerService()));
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	const startup = window.launcher.validate();
	await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
	reloader.dispose();
	finishSelection(lease);
	await assert.rejects(startup, /disposed/u);
	assert.equal(released, true);
});

test('a generation waits for every window to finish initialization', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'agents', events, 'initializing');
	const restarted = new DeferredPromise<void>();
	const start = window.supervisor.start;
	window.supervisor.start = async () => { await start(); void restarted.complete(); };
	const reloader = coordinator(resources, async () => { events.push('restart'); });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await reloader.reloadNow();
	assert.deepEqual(events, []);
	using timeout = disposableTimeout(() => { void restarted.error(new Error('The ready window was not restarted')); }, 5_000);
	window.setState('ready');
	await restarted.p;
	assert.deepEqual(events, ['stop:agents', 'restart', 'start:agents']);
});

test('returning to the running generation cancels a queued replacement', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events, 'initializing');
	let runtime = oldRuntime;
	const reloader = coordinator(resources, async () => { events.push('restart'); }, async () => runtime);
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await window.launcher.validate();
	runtime = newRuntime;
	await reloader.reloadNow();
	runtime = oldRuntime;
	await reloader.reloadNow();
	window.setState('ready');
	await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
	assert.deepEqual(events, []);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, oldRuntime);
});

test('a stopped window still switches the profile daemon before its next connection', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events, 'stopped');
	let runtime = oldRuntime;
	const reloader = coordinator(resources, async launcher => {
		assert.equal(launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
		events.push('restart');
	}, async () => runtime);
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await window.launcher.validate();
	runtime = newRuntime;
	await reloader.reloadNow();
	assert.deepEqual(events, ['restart']);
	assert.equal(window.supervisor.state, 'stopped');
	await window.launcher.validate();
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
});

test('a new window catches publications made while the profile had no connections', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events, 'stopped');
	let runtime = oldRuntime;
	const reloader = coordinator(resources, async launcher => {
		assert.equal(launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
		events.push('restart');
	}, async () => runtime);
	const registration = resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await window.launcher.validate();
	registration.dispose();
	runtime = newRuntime;
	await reloader.reloadNow();
	assert.deepEqual(events, []);
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await window.launcher.validate();
	assert.deepEqual(events, ['restart']);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
});

test('closed windows unregister listeners and are not restarted', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'agents', events);
	const reloader = coordinator(resources, async () => { events.push('restart'); });
	const registration = reloader.registerConnection(window.launcher, window.supervisor);
	registration.dispose();
	await reloader.reloadNow();
	assert.equal(window.listeners.size, 0);
	assert.deepEqual(events, []);
});

test('windows closed during daemon restart are not reconnected', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'agents', events);
	let registration: ReturnType<DevelopmentAppServerReloader['registerConnection']>;
	const reloader = coordinator(resources, async () => { events.push('restart'); registration.dispose(); });
	registration = resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await reloader.reloadNow();
	assert.deepEqual(events, ['stop:agents', 'restart']);
});

test('new window startup waits for the shared daemon restart', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events);
	let signalRestart!: () => void;
	let finishRestart!: () => void;
	const restarting = new Promise<void>(resolvePromise => { signalRestart = resolvePromise; });
	const proceed = new Promise<void>(resolvePromise => { finishRestart = resolvePromise; });
	const reloader = coordinator(resources, async () => { signalRestart(); await proceed; });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	const reload = reloader.reloadNow();
	await restarting;
	const agents = connection(resources, 'agents', events, 'stopped');
	resources.add(reloader.registerConnection(agents.launcher, agents.supervisor));
	const startup = agents.supervisor.start();
	await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
	assert.deepEqual(events, ['stop:workbench']);
	finishRestart();
	await Promise.all([reload, startup]);
	assert.equal(agents.launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
	assert.ok(events.includes('start:agents'));
});

test('a rejected generation leaves every running window untouched', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'agents', events);
	const reloader = coordinator(resources, async () => { events.push('restart'); }, async () => { throw new Error('invalid generation'); });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await assert.rejects(reloader.reloadNow(), /invalid generation/u);
	assert.deepEqual(events, []);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, oldRuntime);
});

test('failed preflight keeps the active lease and the next publication reconnects', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'workbench', events);
	const nextRuntime = resolve('/test/next');
	const released: string[] = [];
	let runtime = oldRuntime;
	const reloader = resources.add(new DevelopmentAppServerReloader({
		generationFile: resolve('/test/current.json'),
		watchGeneration: () => toDisposable(() => { }),
		readGeneration: async () => runtime,
		acquireGeneration: async () => {
			const candidate = runtime;
			return Object.assign(toDisposable(() => { released.push(candidate); }), { runtime: candidate, assertActive() { assert.ok(!released.includes(candidate)); } });
		},
		preflight: async (launcher, lease) => {
			await launcher.validate();
			assert.equal(launcher.environment.ASH_DEV_RUNTIME_ROOT, oldRuntime);
			if (lease.runtime === newRuntime) throw new Error('candidate failed initialize');
		},
		restartDaemon: async launcher => { events.push(`restart:${launcher.environment.ASH_DEV_RUNTIME_ROOT}`); },
	}, new NullLoggerService()));
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await window.launcher.validate();
	runtime = newRuntime;
	await assert.rejects(reloader.reloadNow(), /candidate failed initialize/u);
	assert.deepEqual(events, []);
	assert.deepEqual(released, [newRuntime]);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, oldRuntime);
	runtime = nextRuntime;
	await reloader.reloadNow();
	assert.deepEqual(events, ['stop:workbench', `restart:${nextRuntime}`, 'start:workbench']);
	assert.deepEqual(released, [newRuntime, oldRuntime]);
});

test('a failure after preflight rolls back to the leased runtime and reconnects the window', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection(resources, 'agents', events);
	let runtime = oldRuntime;
	const reloader = coordinator(resources, async launcher => {
		events.push(`restart:${launcher.environment.ASH_DEV_RUNTIME_ROOT}`);
		if (launcher.environment.ASH_DEV_RUNTIME_ROOT === newRuntime) throw new Error('restart failed');
	}, async () => runtime);
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await window.launcher.validate();
	runtime = newRuntime;
	await assert.rejects(reloader.reloadNow(), /restart failed/u);
	assert.deepEqual(events, ['stop:agents', `restart:${newRuntime}`, `restart:${oldRuntime}`, 'start:agents']);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, oldRuntime);
});
