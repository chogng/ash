import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'mocha';
import { DisposableStore, DisposableTracker, installDisposableTracker, toDisposable } from '../../../../base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../app-server/common/appServerApi.js';
import { AppServerDaemonLauncher, createAppServerDaemonLauncher } from '../../electron-main/appServerDaemonLauncher.js';
import { DevelopmentAppServerReloader, readDevelopmentAppServerGeneration } from '../../electron-main/developmentAppServerReloader.js';

const oldRuntime = resolve('/test/old');
const newRuntime = resolve('/test/new');

function connection(name: string, events: string[], initial: AppServerConnectionState = 'ready') {
	const launcher = new AppServerDaemonLauncher({ executable: resolve('/test/daemon'), args: ['connect-selected'], environment: { ASH_DEV_RUNTIME_ROOT: oldRuntime, ASH_APP_SERVER_PATH: resolve(oldRuntime, 'bin/ash-app-server') }, fileExists: () => true });
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
	return resources.add(new DevelopmentAppServerReloader({ generationFile: resolve('/test/current.json'), watchGeneration: () => toDisposable(() => {}), readGeneration, restartDaemon, log: () => {} }));
}

test('development generation resolves a complete declared runtime and rejects escaping paths', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-generation-'));
	try {
		const runtimePath = `generations/${'a'.repeat(64)}`;
		const runtime = join(directory, runtimePath);
		for (const name of ['bin', 'ash-path', 'ash-resources']) await mkdir(join(runtime, name), { recursive: true });
		for (const name of ['ash-development.json', `bin/ash-app-server${process.platform === 'win32' ? '.exe' : ''}`, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`]) await writeFile(join(runtime, name), 'file');
		const file = join(directory, 'current.json');
		await writeFile(file, JSON.stringify({ version: 3, runtime: runtimePath }));
		assert.equal(await readDevelopmentAppServerGeneration(file), runtime);
		const connection = createAppServerDaemonLauncher({
			packageLocation: { appPath: directory, isPackaged: false, platform: process.platform, resourcesPath: '' },
			sourceEnvironment: { ASH_DEV_APP_SERVER_RELOAD: '1', ASH_DEV_APP_SERVER_GENERATION: file, ASH_DEV_RUNTIME_ROOT: '/ignored' },
			profileRoot: join(directory, 'profile'), electronExecutable: process.execPath, role: 'agents',
		});
		assert.equal(connection.launcher.environment.ASH_DEV_RUNTIME_ROOT, runtime);
		assert.equal(connection.launcher.environment.ASH_APP_SERVER_CONNECTION_ROLE, 'agents');
		assert.equal(connection.launcher.executable, join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`));
		for (const invalid of [{ version: 3, runtime: `../${runtimePath}` }, { version: 2, package: runtimePath }, { version: 3, runtime: runtimePath, extra: true }]) {
			await writeFile(file, JSON.stringify(invalid));
			await assert.rejects(readDevelopmentAppServerGeneration(file), /invalid/u);
		}
		await writeFile(file, JSON.stringify({ version: 3, runtime: `generations/${'b'.repeat(64)}` }));
		await assert.rejects(readDevelopmentAppServerGeneration(file), /ENOENT/u);
		assert.equal(await readDevelopmentAppServerGeneration(join(directory, 'absent.json')), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('Workbench and Agents stop together, restart one daemon, and reconnect without leaks', async () => {
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	const resources = new DisposableStore();
	try {
		const events: string[] = [];
		const workbench = connection('workbench', events);
		const agents = connection('agents', events);
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

test('a generation waits for every window to finish initialization', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection('agents', events, 'initializing');
	const reloader = coordinator(resources, async () => { events.push('restart'); });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await reloader.reloadNow();
	assert.deepEqual(events, []);
	window.setState('ready');
	await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
	assert.deepEqual(events, ['stop:agents', 'restart', 'start:agents']);
});

test('closed windows unregister listeners and are not restarted', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection('agents', events);
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
	const window = connection('agents', events);
	let registration: ReturnType<DevelopmentAppServerReloader['registerConnection']>;
	const reloader = coordinator(resources, async () => { events.push('restart'); registration.dispose(); });
	registration = resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await reloader.reloadNow();
	assert.deepEqual(events, ['stop:agents', 'restart']);
});

test('new window startup waits for the shared daemon restart', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection('workbench', events);
	let signalRestart!: () => void;
	let finishRestart!: () => void;
	const restarting = new Promise<void>(resolvePromise => { signalRestart = resolvePromise; });
	const proceed = new Promise<void>(resolvePromise => { finishRestart = resolvePromise; });
	const reloader = coordinator(resources, async () => { signalRestart(); await proceed; });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	const reload = reloader.reloadNow();
	await restarting;
	const agents = connection('agents', events, 'stopped');
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
	const window = connection('agents', events);
	const reloader = coordinator(resources, async () => { events.push('restart'); }, async () => { throw new Error('invalid generation'); });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await assert.rejects(reloader.reloadNow(), /invalid generation/u);
	assert.deepEqual(events, []);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, oldRuntime);
});

test('a failed restart reports the selected generation failure without a second daemon restart', async () => {
	using resources = new DisposableStore();
	const events: string[] = [];
	const window = connection('agents', events);
	const reloader = coordinator(resources, async () => { events.push('restart'); throw new Error('restart failed'); });
	resources.add(reloader.registerConnection(window.launcher, window.supervisor));
	await assert.rejects(reloader.reloadNow(), /restart failed/u);
	assert.deepEqual(events, ['stop:agents', 'restart']);
	assert.equal(window.launcher.environment.ASH_DEV_RUNTIME_ROOT, newRuntime);
});
