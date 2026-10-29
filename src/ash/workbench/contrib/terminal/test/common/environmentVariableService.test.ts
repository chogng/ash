import { MergedEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariableCollection.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { EnvironmentVariableService } from '../../common/environmentVariableService.js';
import { deserializeEnvironmentVariableCollection, serializeEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariableShared.js';
import type { IEnvironmentVariableCollectionWithPersistence } from '../../common/environmentVariable.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { CancellationError } from '../../../../../base/common/errors.js';

function collection(value: string, persistent = true): IEnvironmentVariableCollectionWithPersistence {
	return { persistent, map: new Map([['PATH', { variable: 'PATH', type: 2, value }]]) };
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

	test('phase options survive snapshots and persistence, with post-RC edits kept out of process values', async () => {
		using owner = new DisposableStore();
		const { service, persisted } = create(owner);
		const options = { applyAtProcessCreation: false, applyAtShellIntegration: true };
		service.set('extension', {
			persistent: true, map: new Map([
				['STAGE', { variable: 'STAGE', type: 2, value: ':${value}\\literal', options }],
				['DISABLED', { variable: 'DISABLED', type: 1, value: '${invalid}', options: {} }],
			])
		});
		const snapshot = service.mergedCollection;
		options.applyAtProcessCreation = true;
		const env: Record<string, string | undefined> = { STAGE: 'process' };
		let resolves = 0;
		await snapshot.applyToProcessEnvironment(env, undefined, async value => { resolves++; return value.replace('${value}', 'resolved'); });
		assert.equal(resolves, 1);
		assert.deepEqual(env, { STAGE: 'process', VSCODE_ENV_APPEND: 'STAGE=\\x3aresolved\\\\literal' });
		const restored = create(owner, persisted).service;
		assert.deepEqual(restored.collections.get('extension')!.map.get('STAGE')!.options, { applyAtProcessCreation: false, applyAtShellIntegration: true });
		assert.throws(() => deserializeEnvironmentVariableCollection([['STAGE', { variable: 'STAGE', type: 1, value: '', options: { applyAtShellIntegration: 'yes' } }]]));
	});

	test('scoped shell replacement cancels prior global appends and phase changes participate in diff', async () => {
		const folder = { uri: URI.file('/workspace/a'), name: 'a', index: 0 };
		const scope = { workspaceFolder: folder };
		const options = { applyAtShellIntegration: true };
		const make = (creation: boolean) => new MergedEnvironmentVariableCollection(new Map([['extension', {
			map: new Map([
				['global', { variable: 'VALUE', type: 2 as const, value: 'global', options }],
				['scoped', { variable: 'VALUE', type: 1 as const, value: 'scoped:literal', scope, options: { applyAtShellIntegration: !creation, applyAtProcessCreation: creation } }],
			])
		}]]));
		const shell = make(false);
		const env: Record<string, string | undefined> = { VALUE: 'process' };
		await shell.applyToProcessEnvironment(env, scope);
		assert.deepEqual(env, { VALUE: 'process', VSCODE_ENV_REPLACE: 'VALUE=scoped\\x3aliteral' });
		assert.equal(shell.diff(make(true), scope)!.changed.get('VALUE')!.length, 1);
	});

	test('merges extension mutations against execution-host values without copying inherited keys', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		service.set('b', collection(':b'));
		service.set('a', {
			persistent: true, map: new Map([
				['PATH', { variable: 'PATH', type: 3, value: '${prefix}:' }], ['MODE', { variable: 'MODE', type: 1, value: 'extension' }], ['REMOVED', { variable: 'REMOVED', type: 2, value: ':new' }],
			])
		});
		const env = { Path: 'caller', REMOVED: undefined };
		await new MergedEnvironmentVariableCollection(service.collections, false).applyToProcessEnvironment(env, undefined, async value => value.replace('${prefix}', 'resolved'));
		assert.deepEqual(env, { Path: 'resolved:caller:b', MODE: 'extension', REMOVED: ':new' });
	});

	test('persists only persistent snapshots and restores before a provider activates', async () => {
		using owner = new DisposableStore();
		const { service, persisted } = create(owner);
		service.set('durable', collection(':durable'));
		service.set('transient', collection(':transient', false));
		const restored = create(owner, persisted).service;
		assert.deepEqual([...restored.collections.keys()], ['durable']);
		const env = { PATH: 'host' };
		await restored.mergedCollection.applyToProcessEnvironment(env, undefined, async value => value);
		assert.deepEqual(env, { PATH: 'host:durable' });
	});

	test('scoped mutations and descriptions survive persistence and isolate sibling folders', async () => {
		using owner = new DisposableStore();
		const { service, persisted } = create(owner);
		const folder = { uri: URI.file('/workspace/a'), name: 'a', index: 0 };
		const scope = { workspaceFolder: folder };
		service.set('extension', {
			persistent: true,
			map: deserializeEnvironmentVariableCollection([
				['PATH', { variable: 'PATH', type: 2, value: ':global' }],
				['scoped:PATH', { variable: 'PATH', type: 2, value: ':a', scope }],
			]),
			descriptionMap: new Map([['', { description: 'global' }], ['a', { description: 'folder a', scope }]]),
		});
		const restored = create(owner, persisted).service.mergedCollection;
		const env = { PATH: 'host' };
		await restored.applyToProcessEnvironment(env, scope);
		assert.deepEqual(env, { PATH: 'host:global:a' });
		assert.equal(restored.getDescriptionMap(scope).get('extension'), 'folder a');
		const sibling = { PATH: 'host' };
		await restored.applyToProcessEnvironment(sibling, { workspaceFolder: { ...folder, uri: URI.file('/workspace/b') } });
		assert.deepEqual(sibling, { PATH: 'host:global' });
		assert.equal(restored.getDescriptionMap(undefined).get('extension'), 'global');
		const previous = service.mergedCollection;
		service.set('extension', collection(':changed'));
		const diff = previous.diff(service.mergedCollection, scope)!;
		assert.equal(diff.changed.get('PATH')?.[0]?.value, ':changed');
		assert.equal(diff.removed.get('PATH')?.[0]?.value, ':a');
		assert.equal(previous.diff(restored, scope), undefined);
	});

	test('an accepted launch snapshot survives provider updates and mutable callback data', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		const mutator = { variable: 'PATH', type: 2, value: ':accepted' };
		service.set('extension', { persistent: false, map: new Map([['PATH', mutator]]) });
		const accepted = service.mergedCollection;
		mutator.value = ':mutated';
		service.set('extension', collection(':replacement', false));
		const env = { PATH: 'host' };
		await accepted.applyToProcessEnvironment(env, undefined, async value => value);
		assert.deepEqual(env, { PATH: 'host:accepted' });
	});

	test('an earlier extension Replace hides lower priority edits and their diffs', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		service.set('first', { persistent: false, map: new Map([['opaque-key', { variable: 'MODE', type: 1, value: 'first' }]]) });
		service.set('second', { persistent: false, map: new Map([['MODE', { variable: 'MODE', type: 1, value: 'second' }]]) });
		const accepted = service.mergedCollection;
		const env = { MODE: 'inherited' };
		await accepted.applyToProcessEnvironment(env, undefined);
		assert.deepEqual(env, { MODE: 'first' });
		service.set('second', { persistent: false, map: new Map([['MODE', { variable: 'MODE', type: 2, value: ':hidden' }]]) });
		assert.equal(accepted.diff(service.mergedCollection, undefined), undefined);
	});

	test('failed variable resolution leaves launch overrides intact', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		service.set('extension', {
			persistent: false, map: new Map([
				['PATH', { variable: 'PATH', type: 2, value: ':resolved' }],
				['MODE', { variable: 'MODE', type: 1, value: '${missing}' }],
			])
		});
		const env = { PATH: 'caller', REMOVED: undefined };
		await assert.rejects(service.mergedCollection.applyToProcessEnvironment(env, undefined, async value => {
			if (value === '${missing}') throw new Error('Unresolved variable');
			return value;
		}), /Unresolved variable/);
		assert.deepEqual(env, { PATH: 'caller', REMOVED: undefined });
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

	test('launch reads follow a provider replaced while its old runtime cancels', async () => {
		using owner = new DisposableStore();
		const { service } = create(owner);
		let cancel!: (reason: unknown) => void;
		const first = owner.add(service.registerCollectionProvider('extension', () => new Promise((_resolve, reject) => { cancel = reject; })));
		const pending = service.refreshCollections();
		first.dispose();
		owner.add(service.registerCollectionProvider('extension', async () => collection(':replacement')));
		cancel(new CancellationError());
		await pending;
		assert.equal(service.collections.get('extension')?.map.get('PATH')?.value, ':replacement');
	});

	test('launch reads still report a current provider cancellation or failure', async () => {
		for (const error of [new CancellationError(), new Error('extension failed')]) {
			using owner = new DisposableStore();
			const { service } = create(owner);
			owner.add(service.registerCollectionProvider('extension', async () => { throw error; }));
			await assert.rejects(service.refreshCollections(), candidate => candidate === error);
			assert.equal(service.collections.size, 0);
		}
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

	test('legacy snapshots normalize once and persistence writes the standard variable field', () => {
		const decoded = deserializeEnvironmentVariableCollection([['PATH', { type: 2, value: ':legacy' }]]);
		const serialized = serializeEnvironmentVariableCollection(decoded);
		assert.deepEqual(serialized, [['PATH', { variable: 'PATH', type: 2, value: ':legacy' }]]);
		assert.deepEqual(deserializeEnvironmentVariableCollection(serialized), decoded);
		assert.throws(() => deserializeEnvironmentVariableCollection([['PATH', { variable: 'OTHER=KEY', type: 2, value: ':bad' }]]), TypeError);
		using owner = new DisposableStore();
		const { service, persisted } = create(owner);
		service.set('extension', { persistent: true, map: decoded });
		assert.deepEqual(JSON.parse(persisted.get('terminal.integrated.environmentVariableCollections.v1')!), [['extension', serialized, []]]);
	});

	test('platform callback validation preserves the Chinese error message', () => {
		setNlsMessages('zh-cn', { ash: { 'terminal.environment.invalidCollection': '终端环境变量集合无效。' } });
		try {
			assert.throws(() => deserializeEnvironmentVariableCollection([['BAD=KEY', { type: 1, value: 'x' }]]), {
				name: 'TypeError', message: '终端环境变量集合无效。',
			});
		} finally {
			resetNlsResolver();
		}
	});
});
