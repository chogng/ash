import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EnvironmentVariableService, deserializeEnvironmentVariableCollection } from '../../common/environmentVariableService.js';
import type { IEnvironmentVariableCollectionWithPersistence } from '../../common/environmentVariable.js';

function collection(value: string, persistent = true): IEnvironmentVariableCollectionWithPersistence {
	return { persistent, map: new Map([['PATH', { type: 2, value }]]) };
}

function create(owner: DisposableStore, persisted = new Map<string, string>()) {
	const changes = owner.add(new Emitter<void>());
	const storage = { get: (key: string) => persisted.get(key), store: (key: string, value: string) => { persisted.set(key, value); } } as unknown as IStorageService;
	const workspace = { onDidChangeWorkspace: changes.event } as unknown as IWorkspaceContextService;
	const service = owner.add(new EnvironmentVariableService(storage, workspace));
	return { service, changes, persisted };
}

suite('Terminal environment collections', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('merges extension mutations against execution-host values without copying inherited keys', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		service.set('b', collection(':b'));
		service.set('a', { persistent: true, map: new Map([
			['PATH', { type: 3, value: '${prefix}:' }], ['MODE', { type: 1, value: 'extension' }], ['REMOVED', { type: 2, value: ':new' }],
		]) });
		const env: Record<string, string | null> = { Path: 'caller', REMOVED: null };
		await service.mergedCollection.applyToProcessEnvironment(env, { PATH: 'host', HOME: '/host', REMOVED: 'old' }, false, async value => value.replace('${prefix}', 'resolved'));
		assert.deepEqual(env, { Path: 'resolved:caller:b', MODE: 'extension', REMOVED: ':new' });
	});

	test('persists only persistent snapshots and restores before a provider activates', async () => {
		using owner = new DisposableStore();
		const { service, persisted } = create(owner);
		service.set('durable', collection(':durable'));
		service.set('transient', collection(':transient', false));
		const restored = create(owner, persisted).service;
		assert.deepEqual([...restored.collections.keys()], ['durable']);
		const env = {};
		await restored.mergedCollection.applyToProcessEnvironment(env, { PATH: 'host' }, true, async value => value);
		assert.deepEqual(env, { PATH: 'host:durable' });
	});

	test('a retired incarnation cannot replace the next provider snapshot', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		let release!: (value: IEnvironmentVariableCollectionWithPersistence) => void;
		const first = owner.add(service.registerCollectionProvider('extension', () => new Promise(resolve => { release = resolve; })));
		const pending = service.refreshCollections();
		first.dispose();
		owner.add(service.registerCollectionProvider('extension', async () => collection(':new')));
		await service.refreshCollections();
		release(collection(':old'));
		await pending;
		assert.equal(service.collections.get('extension')?.map.get('PATH')?.value, ':new');
	});

	test('removing one profile keeps another live provider for the same extension', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		owner.add(service.registerCollectionProvider('extension', async () => collection(':first')));
		const second = owner.add(service.registerCollectionProvider('extension', async () => collection(':second')));
		await service.refreshCollections();
		second.dispose();
		await service.refreshCollections();
		assert.equal(service.collections.get('extension')?.map.get('PATH')?.value, ':first');
	});

	test('workspace replacement prevents a pending callback from persisting into the next workspace', async () => {
		using owner = new DisposableStore();
		const { service, changes } = create(owner);
		let release!: (value: IEnvironmentVariableCollectionWithPersistence) => void;
		owner.add(service.registerCollectionProvider('extension', () => new Promise(resolve => { release = resolve; })));
		const pending = service.refreshCollections();
		changes.fire();
		release(collection(':old-workspace'));
		await pending;
		assert.equal(service.collections.size, 0);
	});

	test('rejects invalid callback entries before they reach a process', () => {
		for (const value of [[['BAD=KEY', { type: 1, value: 'x' }]], [['PATH', { type: 4, value: 'x' }]], [['PATH', { type: 1, value: '\0' }]], [['PATH', { type: 1, value: 'x', unexpected: true }]]]) {
			assert.throws(() => deserializeEnvironmentVariableCollection(value), TypeError);
		}
	});
});
