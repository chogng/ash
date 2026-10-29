import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Session } from 'electron/main';
import { suite, test } from 'mocha';
import { StorageScope, StorageTarget } from '../../../storage/common/storage.js';
import { IApplicationStorageMainService, StorageMainService } from '../../../storage/electron-main/storageMainService.js';
import { ILogService, NullLoggerService } from '../../../log/common/log.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { BrowserSession } from '../../electron-main/browserSession.js';
import { BrowserSessionHistory } from '../../electron-main/browserSessionHistory.js';
import { BrowserViewStorageScope } from '../../common/browserView.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

const applicationStorage = { scope: StorageScope.APPLICATION, id: 'application' };
const icon = 'data:image/png;base64,aWNvbg==';
const entry = (value: string) => ({ value, target: StorageTarget.MACHINE });

suite('Persistent browser session history', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('history construction requires the application storage registration', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(BrowserSessionHistory, session('missing', BrowserViewStorageScope.Global)), /applicationStorageMainService/);
	});

	test('actual process restart restores visits and images; deleting and clearing survive the next restart', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-browser-history-'));
		try {
			const file = join(directory, 'state.json');
			const run = (mode: string) => runProcess(file, mode);
			const written = await run('write');
			const restored = await run('read');
			assert.deepEqual(restored, written);
			assert.deepEqual(restored.items.map((item: { title: string; }) => item.title), ['First', 'Second']);
			assert.deepEqual(Object.values(restored.favicons), [icon]);
			await run('delete');
			assert.deepEqual((await run('read')).items.map((item: { title: string; }) => item.title), ['Second']);
			await run('clear');
			assert.deepEqual(await run('read'), { items: [], favicons: {} });
			const document = JSON.parse(await readFile(file, 'utf8'));
			const values = document.storages.find((scope: { identity: { scope: string; }; }) => scope.identity.scope === 'application').entries;
			assert.deepEqual(Object.keys(values), ['unrelated']);
		} finally { assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
	});

	test('global and workspace identities restore independently; ephemeral and agent scopes never write history', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-browser-history-'));
		try {
			const file = join(directory, 'state.json');
			using storage = new StorageMainService(file);
			await storage.initialize();
			using services = createServices(storage);
			for (const [id, scope] of [['global', BrowserViewStorageScope.Global], ['workspace-one', BrowserViewStorageScope.Workspace], ['workspace-two', BrowserViewStorageScope.Workspace], ['temporary', BrowserViewStorageScope.Ephemeral], ['agent', BrowserViewStorageScope.Agent]] as const) {
				using history = services.createInstance(BrowserSessionHistory, session(id, scope));
				await history.initialize();
				history.add(`https://${id}.test/`, id, icon);
				await history.flushNow();
			}
			await storage.close();
			using restartedStorage = new StorageMainService(file);
			await restartedStorage.initialize();
			using restarted = createServices(restartedStorage);
			for (const [id, scope] of [['global', BrowserViewStorageScope.Global], ['workspace-one', BrowserViewStorageScope.Workspace], ['workspace-two', BrowserViewStorageScope.Workspace]] as const) {
				using history = restarted.createInstance(BrowserSessionHistory, session(id, scope));
				await history.initialize();
				assert.deepEqual(history.entries.items.map(item => item.title), [id]);
			}
			const snapshot = await restartedStorage.getItems(applicationStorage);
			assert.ok(!Object.keys(snapshot.entries).some(key => key.includes('temporary') || key.includes('agent')));
			await restartedStorage.close();
		} finally { assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
	});

	test('restoration validates persisted values, discards unsafe suggestions and does not rewrite hydrated data', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-browser-history-'));
		try {
			using storage = new StorageMainService(join(directory, 'state.json'));
			await storage.initialize();
			await storage.getItems(applicationStorage);
			await storage.updateItems(applicationStorage, 'browser.history.entries.corrupt', entry(JSON.stringify({
				items: [
					{ id: 1, url: 'https://valid.test/', title: 'Valid', time: 1, icon: 'missing' },
					{ id: 2, url: 'javascript:alert(1)', title: 'Unsafe', time: 2 },
					{ id: 1, url: 'https://duplicate.test/', title: 'Duplicate', time: 3 },
					{ id: 'wrong', url: 'https://wrong.test/', title: 'Wrong id', time: 4 },
				]
			})));
			await storage.updateItems(applicationStorage, 'browser.history.favicons.corrupt', entry('{bad json'));
			const before = await storage.getItems(applicationStorage);
			using services = createServices(storage);
			using history = services.createInstance(BrowserSessionHistory, session('corrupt', BrowserViewStorageScope.Workspace));
			await history.initialize();
			assert.deepEqual(history.entries.items, [{ id: 1, url: 'https://valid.test/', time: 1, title: 'Valid' }]);
			assert.deepEqual(history.favicons.serialize(), { map: {} });
			await storage.flush();
			assert.equal((await storage.getItems(applicationStorage)).revision, before.revision);
			const added = history.add('https://next.test/', 'Next');
			assert.equal(added.id, 2);
			await storage.close();
		} finally { assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
	});

	test('changes share a two-second deadline and title-only edits do not rewrite the favicon map', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		const directory = await mkdtemp(join(tmpdir(), 'ash-browser-history-'));
		try {
			using storage = new StorageMainService(join(directory, 'state.json'));
			await storage.initialize();
			using services = createServices(storage);
			using history = services.createInstance(BrowserSessionHistory, session('timing', BrowserViewStorageScope.Global));
			await history.initialize();
			const writes: string[] = [];
			const update = storage.updateItems.bind(storage);
			storage.updateItems = (identity, key, value) => { writes.push(key); return update(identity, key, value); };
			const handle = history.add('https://first.test/', 'First', icon);
			mock.timers.tick(1999);
			history.add('https://second.test/', 'Second', icon);
			assert.deepEqual(writes, []);
			mock.timers.tick(1);
			assert.deepEqual(writes.sort(), ['browser.history.entries.timing', 'browser.history.favicons.timing']);
			await storage.flush();
			writes.length = 0;
			handle.update({ title: 'Renamed' });
			mock.timers.tick(2000);
			assert.deepEqual(writes, ['browser.history.entries.timing']);
			await storage.close();
		} finally { mock.timers.reset(); assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
	});

	test('failed writes remain retryable without poisoning the next flush', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-browser-history-'));
		try {
			using storage = new StorageMainService(join(directory, 'state.json'));
			await storage.initialize();
			using services = createServices(storage);
			using history = services.createInstance(BrowserSessionHistory, session('retry', BrowserViewStorageScope.Workspace));
			await history.initialize();
			const update = storage.updateItems.bind(storage);
			storage.updateItems = async () => { throw new Error('Deliberate write failure'); };
			history.add('https://retry.test/', 'Retry');
			await assert.rejects(history.flushNow(), /Deliberate write failure/);
			storage.updateItems = update;
			await history.flushNow();
			const snapshot = await storage.getItems(applicationStorage);
			assert.equal(JSON.parse(snapshot.entries[history.storageKeys.history!]!.value).items[0].title, 'Retry');
			await storage.close();
		} finally { assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); }
	});
});

function session(id: string, scope: BrowserViewStorageScope): BrowserSession {
	const electronSession = Object.assign(new EventEmitter(), {
		setPermissionCheckHandler: () => { }, setPermissionRequestHandler: () => { }, setDevicePermissionHandler: () => { },
	}) as unknown as Session;
	return BrowserSession.getOrCreate(id, scope, electronSession);
}

function createServices(storage: IApplicationStorageMainService): InstantiationService {
	const services = new InstantiationService();
	services.registerInstance(IApplicationStorageMainService, storage);
	services.registerInstance(ILogService, new NullLoggerService());
	return services;
}

async function runProcess(file: string, mode: string): Promise<{ items: Array<{ id: number; title: string; }>; favicons: Record<string, string>; }> {
	const script = `
		import { StorageMainService, IApplicationStorageMainService } from ${JSON.stringify(new URL('../../../storage/electron-main/storageMainService.js', import.meta.url).href)};
		import { ILogService, NullLoggerService } from ${JSON.stringify(new URL('../../../log/common/log.js', import.meta.url).href)};
		import { InstantiationService } from ${JSON.stringify(new URL('../../../instantiation/common/instantiationService.js', import.meta.url).href)};
		import { BrowserSessionHistory } from ${JSON.stringify(new URL('../../electron-main/browserSessionHistory.js', import.meta.url).href)};
		const storage = new StorageMainService(process.argv[1]);
		await storage.initialize();
		const services = new InstantiationService();
		services.registerInstance(IApplicationStorageMainService, storage);
		services.registerInstance(ILogService, new NullLoggerService());
		const history = services.createInstance(BrowserSessionHistory, { id: 'restart', storageScope: 'workspace' });
		await history.initialize();
		const mode = process.argv[2];
		if (mode === 'write') {
			await storage.updateItems({ scope: 'application', id: 'application' }, 'unrelated', { value: 'keep', target: 'machine' });
			history.add('https://first.test/', 'First', ${JSON.stringify(icon)}, true);
			history.add('https://second.test/', 'Second', ${JSON.stringify(icon)});
		} else if (mode === 'delete') { await history.delete([history.entries.items[0].id]); }
		else if (mode === 'clear') { await history.delete(); }
		const result = { items: history.entries.items, favicons: history.favicons.serialize().map };
		// A real process exits immediately after the application's close barrier, before the throttle deadline.
		await storage.close();
		history.dispose(); services.dispose(); storage.dispose();
		console.log(JSON.stringify(result));
	`;
	const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, file, mode]);
	return JSON.parse(result.stdout);
}
