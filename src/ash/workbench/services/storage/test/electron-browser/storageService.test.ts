import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError, errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { StorageMainService } from '../../../../../platform/storage/electron-main/storageMainService.js';
import { StorageDatabaseChannel } from '../../../../../platform/storage/electron-main/storageIpc.js';
import { NativeWorkbenchStorageService } from '../../electron-browser/storageService.js';
import { TestConfigurationService } from '../../../configuration/test/common/testServices.js';
import { TerminalCommandHistory } from '../../../../contrib/terminalContrib/history/common/history.js';

suite('Desktop window storage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('hidden command history retries failed background writes until durable and visible to another window', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-hidden-retry-'));
		const browser = new JSDOM('', { url: 'https://ash.test', pretendToBeVisual: true });
		const timers = new Map<number, () => void>();
		let sequence = 0;
		browser.window.setTimeout = ((callback: () => void, delay: number) => {
			assert.equal(delay, 5_000);
			timers.set(++sequence, callback);
			return sequence;
		}) as typeof browser.window.setTimeout;
		browser.window.clearTimeout = id => { if (id !== undefined) timers.delete(id); };
		let hidden = false;
		Object.defineProperty(browser.window.document, 'hidden', { get: () => hidden });
		const previousHandler = errorHandler.getUnexpectedErrorHandler();
		const errors: unknown[] = [];
		setUnexpectedErrorHandler(error => errors.push(error));
		try {
			const path = join(directory, 'state.json');
			using owner = new StorageMainService(path);
			await owner.initialize();
			const channel = new StorageDatabaseChannel(owner);
			let unavailable = false;
			let attempts = 0;
			let flushed = new DeferredPromise<void>();
			const failure = new Error('Injected hidden storage failure');
			using services = new InstantiationService();
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: async <T>(command: string, arg?: unknown): Promise<T> => {
						if (command === 'updateItems') {
							attempts++;
							if (unavailable) throw failure;
						}
						const result = await channel.call<T>('window:1', command, arg);
						if (command === 'flush') void flushed.complete();
						return result;
					},
					listen: (event, arg) => channel.listen('window:1', event, arg),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			const options = { ownerWindow: browser.window as unknown as Window, workspaceId: 'background' };
			using storage = services.createInstance(NativeWorkbenchStorageService, options);
			using reader = services.createInstance(NativeWorkbenchStorageService, options);
			await Promise.all([storage.initialize(), reader.initialize()]);
			using configuration = new TestConfigurationService();
			const history = new TerminalCommandHistory(configuration, storage);
			const otherHistory = new TerminalCommandHistory(configuration, reader);
			hidden = true;
			browser.window.document.dispatchEvent(new browser.window.Event('visibilitychange'));
			await flushed.p;
			await setImmediate();
			assert.equal(timers.size, 0, 'The hidden boundary save finishes before the command completes');

			unavailable = true;
			history.record('bash', 'succeeded', 'echo first', true, false);
			history.record('bash', 'succeeded', 'echo latest', true, false);
			await setImmediate();
			assert.deepEqual(errors, [failure, failure]);
			assert.equal(attempts, 2);
			assert.equal(timers.size, 1, 'Background failures share one retry timer');
			assert.deepEqual(otherHistory.getCommands('bash'), []);
			const retry = [...timers.values()][0]!;
			timers.clear();
			retry();
			await setImmediate();
			assert.equal(attempts, 3);
			assert.deepEqual(errors, [failure, failure, failure]);
			assert.equal(timers.size, 1, 'A failed retry waits for the next interval');

			unavailable = false;
			flushed = new DeferredPromise<void>();
			const recover = [...timers.values()][0]!;
			timers.clear();
			recover();
			await flushed.p;
			await setImmediate();
			assert.equal(attempts, 4);
			assert.equal(timers.size, 0, 'Successful hidden saves return to idle');
			const expected = [{ shellId: 'bash', command: 'echo latest' }, { shellId: 'bash', command: 'echo first' }];
			assert.deepEqual(otherHistory.getCommands('bash'), expected);
			using reopenedOwner = new StorageMainService(path);
			await reopenedOwner.initialize();
			const durable = await reopenedOwner.getItems({ scope: StorageScope.APPLICATION, id: 'application' });
			assert.deepEqual(JSON.parse(durable.entries['terminal.shellIntegration.commandHistory.v1']!.value).entries, [...expected].reverse());

			unavailable = true;
			history.clear();
			await setImmediate();
			assert.equal(timers.size, 1);
			assert.deepEqual(otherHistory.getCommands('bash'), expected, 'A failed removal has not reached the other window');
			unavailable = false;
			flushed = new DeferredPromise<void>();
			const removeRetry = [...timers.values()][0]!;
			timers.clear();
			removeRetry();
			await flushed.p;
			await setImmediate();
			assert.deepEqual(otherHistory.getCommands('bash'), []);
			assert.equal(timers.size, 0);
			using afterRemoval = new StorageMainService(path);
			await afterRemoval.initialize();
			assert.equal((await afterRemoval.getItems({ scope: StorageScope.APPLICATION, id: 'application' })).entries['terminal.shellIntegration.commandHistory.v1'], undefined);

			unavailable = true;
			history.record('bash', 'succeeded', 'echo disposed', true, false);
			await setImmediate();
			assert.equal(timers.size, 1);
			storage.dispose();
			assert.equal(timers.size, 0, 'Disposal cancels pending retries');
		} finally {
			setUnexpectedErrorHandler(previousHandler);
			browser.window.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	for (const started of [false, true]) {
		test(`disposal cancels automatic flush ${started ? 'in flight' : 'before dispatch'} without suppressing explicit flush errors`, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'ash-store-close-'));
			const browser = new JSDOM('', { url: 'https://ash.test' });
			const previousHandler = errorHandler.getUnexpectedErrorHandler();
			const errors: unknown[] = [];
			setUnexpectedErrorHandler(error => errors.push(error));
			try {
				using owner = new StorageMainService(join(directory, 'state.json'));
				await owner.initialize();
				const channel = new StorageDatabaseChannel(owner);
				using subscriptions = new DisposableStore();
				let flushes = 0;
				let cancelled = 0;
				const failure = new Error('Injected explicit flush failure');
				using services = new InstantiationService();
				services.registerInstance(IMainProcessService, {
					_serviceBrand: undefined,
					getChannel: () => ({
						call: <T>(command: string, arg: unknown, token?: CancellationToken): Promise<T> => {
							if (command !== 'flush') { return channel.call('window:1', command, arg); }
							flushes++;
							if (!token || token === CancellationToken.None) { return Promise.reject(failure); }
							return new Promise<T>((_resolve, reject) => {
								subscriptions.add(token.onCancellationRequested(() => { cancelled++; reject(new CancellationError()); }));
							});
						},
						listen: (event, arg) => channel.listen('window:1', event, arg),
					}),
					registerChannel: () => { throw new Error('Unexpected channel registration'); },
				});
				using storage = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, workspaceId: 'closing' });
				await storage.initialize();
				await assert.rejects(storage.flush(), error => error === failure);
				flushes = 0;
				browser.window.dispatchEvent(new browser.window.Event('pagehide'));
				if (started) { await setImmediate(); }
				storage.dispose();
				await setImmediate();
				assert.deepEqual({ flushes, cancelled, errors }, { flushes: started ? 1 : 0, cancelled: started ? 1 : 0, errors: [] });
			} finally {
				setUnexpectedErrorHandler(previousHandler);
				browser.window.close();
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
	test('retries failed mutations, preserving the latest value and removals without poisoning future flushes', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-retry-'));
		const browser = new JSDOM('', { url: 'https://ash.test' });
		const previousHandler = errorHandler.getUnexpectedErrorHandler();
		const errors: unknown[] = [];
		setUnexpectedErrorHandler(error => errors.push(error));
		try {
			using owner = new StorageMainService(join(directory, 'state.json'));
			await owner.initialize();
			const channel = new StorageDatabaseChannel(owner);
			let unavailable = false;
			const failure = new Error('Injected storage transport failure');
			using services = new InstantiationService();
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => command === 'updateItems' && unavailable ? Promise.reject(failure) : channel.call('window:1', command, arg),
					listen: (event, arg) => channel.listen('window:1', event, arg),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			using storage = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, workspaceId: 'first' });
			await storage.initialize();
			storage.store('removed', 'old', StorageScope.WORKSPACE, StorageTarget.MACHINE);
			await storage.flush();
			unavailable = true;
			storage.store('layout:sidebar', 'old', StorageScope.WORKSPACE, StorageTarget.MACHINE);
			storage.store('layout:sidebar', 'latest', StorageScope.WORKSPACE, StorageTarget.MACHINE);
			storage.remove('removed', StorageScope.WORKSPACE);
			await assert.rejects(storage.flush(), error => error === failure);
			assert.deepEqual(errors, [failure, failure, failure]);
			unavailable = false;
			await storage.flush();
			storage.store('subsequent', 'saved', StorageScope.PROFILE, StorageTarget.USER);
			await storage.flush();
			using reopened = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, workspaceId: 'first' });
			await reopened.initialize();
			assert.deepEqual([reopened.get('layout:sidebar', StorageScope.WORKSPACE), reopened.get('removed', StorageScope.WORKSPACE), reopened.get('subsequent', StorageScope.PROFILE)], ['latest', undefined, 'saved']);
		} finally {
			setUnexpectedErrorHandler(previousHandler);
			browser.window.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('two window caches converge after concurrent writes, remove and workspace switching', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		const browser = new JSDOM('', { url: 'https://ash.test' });
		try {
			using owner = new StorageMainService(join(directory, 'state.json'));
			await owner.initialize();
			const channel = new StorageDatabaseChannel(owner);
			using services = new InstantiationService();
			assert.throws(() => services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, workspaceId: 'first' }), /mainProcessService/);
			let sentWrites = 0;
			services.registerInstance(IMainProcessService, {
				_serviceBrand: undefined,
				getChannel: () => ({
					call: (command, arg) => {
						if (command === 'updateItems') { sentWrites++; }
						return channel.call('window:1', command, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)));
					},
					listen: (event, arg) => channel.listen('window:1', event, arg),
				}),
				registerChannel: () => { throw new Error('Unexpected channel registration'); },
			});
			const options = { ownerWindow: browser.window as unknown as Window, workspaceId: 'first' };
			using first = services.createInstance(NativeWorkbenchStorageService, options);
			using second = services.createInstance(NativeWorkbenchStorageService, options);
			await Promise.all([first.initialize(), second.initialize()]);
			const claims = await Promise.all([
				first.compareAndSwapApplicationSharedValue('screenshot-hint', undefined, 'first'),
				second.compareAndSwapApplicationSharedValue('screenshot-hint', undefined, 'second'),
			]);
			assert.deepEqual(claims.sort(), [false, true]);
			assert.equal(first.get('screenshot-hint', StorageScope.APPLICATION), second.get('screenshot-hint', StorageScope.APPLICATION));
			const winner = first.get('screenshot-hint', StorageScope.APPLICATION)!;
			assert.equal(await second.compareAndSwapApplicationSharedValue('screenshot-hint', 'not-the-owner', undefined), false);
			assert.equal(await first.compareAndSwapApplicationSharedValue('screenshot-hint', winner, undefined), true);

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
			browser.window.localStorage.setItem('ash.code.storage.workspace.sessions', JSON.stringify({ version: 1, entries: { draft: { value: 'retained', target: StorageTarget.MACHINE } } }));
			browser.window.localStorage.setItem('ash.code.storage.profile.code-sessions', JSON.stringify({ version: 1, entries: { sidebar: { value: 'hidden', target: StorageTarget.MACHINE } } }));
			using storage = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', profileId: 'code-sessions' });
			await storage.initialize();
			assert.deepEqual([storage.get('saved', StorageScope.APPLICATION), browser.window.localStorage.getItem(key), browser.window.localStorage.getItem('ash.storage.application')], ['yes', null, null]);
			assert.deepEqual([storage.get('draft', StorageScope.WORKSPACE), storage.get('sidebar', StorageScope.PROFILE)], ['retained', 'hidden']);
			assert.deepEqual(['ash.storage.workspace.sessions', 'ash.storage.profile.code-sessions'].map(key => browser.window.localStorage.getItem(key)), [null, null]);
			assert.ok(browser.window.localStorage.getItem('ash.storage.v1.code.application'));
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
			const identity = { scope: StorageScope.APPLICATION, id: 'application' };
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
			const key = 'ash.storage.application';
			for (const source of ['{"version":1,"entries":{"saved":{"value":1,"target":"user"}}}', '{"version":1,"entries":{"saved":{"value":"conflict","target":"user"}}}']) {
				browser.window.localStorage.setItem(key, source);
				using storage = services.createInstance(NativeWorkbenchStorageService, { ownerWindow: browser.window as unknown as Window, workspaceId: 'first' });
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
