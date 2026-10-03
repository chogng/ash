import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { StorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { StorageDatabaseChannel } from '../../../../../platform/storage/electron-main/storageIpc.js';
import { NativeWorkbenchStorageService } from '../../electron-browser/storageService.js';

suite('Desktop window storage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('two window caches converge after concurrent writes, remove and workspace switching', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		const browser = new JSDOM('', { url: 'https://ash.test' });
		try {
			using owner = new StorageMainService(join(directory, 'state.json'));
			await owner.initialize();
			const channel = new StorageDatabaseChannel(owner);
			using services = new InstantiationService();
			assert.throws(() => services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, applicationId: 'code', workspaceId: 'first' }), /mainProcessService/);
			let sentWrites = 0;
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => {
						if (command === 'updateItems') { sentWrites++; }
						return channel.call('window:1', command, arg);
					},
					listen: (event, arg) => channel.listen('window:1', event, arg),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			const options = { ownerWindow: browser.window as unknown as Window, applicationId: 'code', workspaceId: 'first' };
			using first = services.createInstance(NativeWorkbenchStorageService, options);
			using second = services.createInstance(NativeWorkbenchStorageService, options);
			await Promise.all([first.initialize(), second.initialize()]);
			assert.equal(first.get('constructor', StorageScope.APPLICATION), undefined);
			first.store('__proto__', 'ordinary-key', StorageScope.APPLICATION, StorageTarget.USER);
			first.store('first', 'one', StorageScope.APPLICATION, StorageTarget.USER);
			second.store('second', 'two', StorageScope.APPLICATION, StorageTarget.MACHINE);
			first.store('first', 'latest', StorageScope.APPLICATION, StorageTarget.USER);
			assert.equal(sentWrites, 4, 'All mutations are sent before any reply is awaited');
			await Promise.all([first.flush(), second.flush()]);
			assert.equal(second.get('__proto__', StorageScope.APPLICATION), 'ordinary-key');
			assert.deepEqual([first.get('first', StorageScope.APPLICATION), second.get('first', StorageScope.APPLICATION), first.get('second', StorageScope.APPLICATION)], ['latest', 'latest', 'two']);
			second.remove('first', StorageScope.APPLICATION);
			await second.flush();
			assert.equal(first.get('first', StorageScope.APPLICATION), undefined);
			first.store('layout', 'first-workspace', StorageScope.WORKSPACE, StorageTarget.MACHINE);
			await first.switchWorkspace('next');
			assert.equal(first.get('layout', StorageScope.WORKSPACE), undefined);
			await first.switchWorkspace('first');
			assert.equal(first.get('layout', StorageScope.WORKSPACE), 'first-workspace');
		} finally {
			browser.window.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('removes legacy browser entries only after importing them to the Desktop owner', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		const browser = new JSDOM('', { url: 'https://ash.test' });
		try {
			using owner = new StorageMainService(join(directory, 'state.json'));
			await owner.initialize();
			const channel = new StorageDatabaseChannel(owner);
			using services = new InstantiationService();
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => channel.call('window:1', command, arg),
					listen: (event, arg) => channel.listen('window:1', event, arg),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			const key = 'ash.code.storage.application';
			browser.window.localStorage.setItem(key, JSON.stringify({ version: 1, entries: { saved: { value: 'yes', target: StorageTarget.USER } } }));
			using storage = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, applicationId: 'code', workspaceId: 'first' });
			await storage.initialize();
			assert.deepEqual([storage.get('saved', StorageScope.APPLICATION), browser.window.localStorage.getItem(key)], ['yes', null]);
		} finally {
			browser.window.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('invalid and conflicting migration input remains intact while the durable target is preserved', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		const browser = new JSDOM('', { url: 'https://ash.test' });
		try {
			using owner = new StorageMainService(join(directory, 'state.json'));
			await owner.initialize();
			const identity = { applicationId: 'code', scope: StorageScope.APPLICATION, id: 'application' };
			const entries = { saved: { value: 'durable', target: StorageTarget.USER } };
			await owner.getItems(identity, entries);
			const channel = new StorageDatabaseChannel(owner);
			using services = new InstantiationService();
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => channel.call('window:1', command, arg),
					listen: (event, arg) => channel.listen('window:1', event, arg),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			const key = 'ash.code.storage.application';
			for (const source of ['{"version":1,"entries":{"saved":{"value":1,"target":"user"}}}', '{"version":1,"entries":{"saved":{"value":"conflict","target":"user"}}}']) {
				browser.window.localStorage.setItem(key, source);
				using storage = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, applicationId: 'code', workspaceId: 'first' });
				await assert.rejects(storage.initialize(), /Invalid storage entry|migration conflict/);
				assert.equal(browser.window.localStorage.getItem(key), source);
				assert.deepEqual({ ...(await owner.getItems(identity)).entries }, entries);
			}
		} finally {
			browser.window.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
