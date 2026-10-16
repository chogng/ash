import assert from 'node:assert/strict';
import { test } from 'mocha';
import { mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CommandRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ExtensionHostFleetSnapshot, IExtensionHostApi, JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { SCMService } from '../../../contrib/scm/common/scmService.js';
import { SCMViewService } from '../../../contrib/scm/browser/scmViewService.js';
import { QuickDiffService } from '../../../contrib/scm/common/quickDiffService.js';
import type { IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { MultiDiffSourceResolverService } from '../../../contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { MainThreadSCM } from '../../browser/mainThreadSCM.js';

const source = { extensionId: 'ash.git', activationGeneration: 1, incarnation: 1 };
const provider = (value = 'draft', inputRevision = 0): JsonValue => ({ id: 'repo', providerId: 'git', label: 'Repository', rootUri: 'file:///workspace', selected: true, groups: [], input: { value, enabled: true, canAccept: true, placeholder: 'Message', buttonLabel: 'Commit', buttonTooltip: 'Commit changes' }, inputRevision, statusBarCommands: [], activeRepositoryName: 'main', statusMessage: '', isBusy: false, historyRevision: 1, hasHistory: false, hasMerge: false, multiDiff: null });
function fleet(providers: JsonValue[] = [provider()]): ExtensionHostFleetSnapshot {
	return { generation: 1, extensions: [{ id: 'ash.git', version: '1.0.0', packageDigest: 'sha256:' + 'a'.repeat(64), runtimeApiVersion: 1, ...source, lifecycle: 'ready', failure: undefined, registrations: [{ kind: 'sourceControl', registrationId: 'ash.scm', revision: 1, providers }], stderr: '', outputEvents: [] }] };
}
function fixture(invoke: IExtensionHostApi['invoke'], providers?: JsonValue[]) {
	const lifetime = new DisposableStore();
	const scm = lifetime.add(new SCMService()); const view = lifetime.add(new SCMViewService(scm));
	const quickDiff = lifetime.add(new QuickDiffService()); const resolvers = lifetime.add(new MultiDiffSourceResolverService());
	const decorationProviders = new Set<IDecorationsProvider>(); const errors: unknown[] = [];
	const decorations = { registerDecorationsProvider(value: IDecorationsProvider) { decorationProviders.add(value); return { dispose: () => decorationProviders.delete(value) }; } } as unknown as IDecorationsService;
	const contexts = lifetime.add(new ContextKeyService());
	const commands = new CommandRegistry();
	const bridge = lifetime.add(new MainThreadSCM(10_000, error => errors.push(error), commands, { invoke } as IExtensionHostApi, scm, view, {} as ICommandService, resolvers, quickDiff, decorations, contexts));
	bridge.update(fleet(providers));
	return { lifetime, scm, view, bridge, decorationProviders, errors, contexts, commands };
}

test('SCM resource groups survive input-only snapshots and retire changed resources', () => {
	const snapshot: Record<string, JsonValue> = { ...(provider() as Record<string, JsonValue>), groups: [{ id: 'changes', label: 'Changes', actions: [], resources: [] }] };
	const value = fixture(async () => null, [snapshot]);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const groups = repository.provider.groups;
	assert.strictEqual(repository.provider.groups, groups);
	assert.ok(repository.provider.groups.includes(groups[0]!));
	value.bridge.set(source, 'ash.scm', 2, [{ ...snapshot, input: { ...(snapshot.input as Record<string, JsonValue>), placeholder: 'Updated placeholder' } }]);
	assert.strictEqual(repository.provider.groups, groups);
	value.bridge.set(source, 'ash.scm', 3, [{ ...snapshot, groups: [{ id: 'changes', label: 'Updated changes', actions: [], resources: [] }] }]);
	assert.notStrictEqual(repository.provider.groups, groups);
	assert.ok(!repository.provider.groups.includes(groups[0]!));
});

test('SCM history command contexts revive only the owning live repository', async () => {
	const value = fixture(async () => null);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const item = { id: 'abc', parentIds: ['parent'], subject: 'Commit', message: 'Commit', remoteLinks: [{ name: 'origin', uri: URI.parse('https://example.com/abc') }] };
	const encoded = await value.bridge.prepareCommandArguments('ash.git', [{ type: 'historyItemViewModel', repository, historyItemViewModel: { historyItem: item } }]);
	const [revived] = value.bridge.reviveCommandArguments(source, encoded) as Array<{ repository: typeof repository; historyItemViewModel: { historyItem: typeof item; }; }>;
	assert.strictEqual(revived.repository, repository);
	assert.deepEqual(revived.historyItemViewModel.historyItem.remoteLinks, item.remoteLinks);
	assert.throws(() => value.bridge.reviveCommandArguments({ ...source, extensionId: 'other.extension' }, encoded), /foreign repository/);
	assert.throws(() => value.bridge.reviveCommandArguments({ ...source, incarnation: 2 }, encoded), /retired/);
	value.bridge.update({ generation: 2, extensions: [] });
	assert.throws(() => value.bridge.reviveCommandArguments(source, encoded), /retired/);
});

test('SCM extension receives captured repository and history arguments and the current draft', async () => {
	const calls: JsonValue[] = [];
	const value = fixture(async request => { calls.push(request.payload); return null; }); using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	repository.provider.input.value = 'edited';
	const history = { type: 'historyItemViewModel', repository, historyItemViewModel: { historyItem: { id: 'abc', remoteLinks: [{ name: 'origin', uri: URI.parse('https://example.com/abc') }] } } };
	assert.deepEqual(JSON.parse(JSON.stringify(await value.bridge.prepareCommandArguments('ash.git', [repository, history]))), [
		{ repositoryId: 'repo', provider: { id: 'repo', providerId: 'git' } },
		{ type: 'historyItemViewModel', repository: { repositoryId: 'repo', provider: { id: 'repo', providerId: 'git' } }, historyItemViewModel: { historyItem: { id: 'abc', remoteLinks: [{ name: 'origin', uri: 'https://example.com/abc' }] } }, references: null },
	]);
	assert.ok(calls.some(call => typeof call === 'object' && call !== null && 'method' in call && call.method === 'setInput' && 'value' in call && call.value === 'edited' && 'inputRevision' in call && call.inputRevision === 1));
	value.bridge.set(source, 'ash.scm', 2, [provider('obsolete', 0)]);
	assert.equal(repository.provider.input.value, 'edited');
	value.bridge.set(source, 'ash.scm', 3, [provider('amended', 1)]);
	assert.equal(repository.provider.input.value, 'amended');
});

test('SCM input completion preserves a draft edited while the command was running', async () => {
	const completion = new DeferredPromise<JsonValue>();
	const value = fixture(async request => (request.payload as { method: string; }).method === 'acceptInput' ? completion.p : null); using cleanup = value.lifetime;
	const input = value.scm.getRepository('repo')!.provider.input;
	const accepting = input.accept(); input.value = 'next commit'; completion.complete({ result: 'committed', value: '' });
	assert.equal(await accepting, 'committed'); assert.equal(input.value, 'next commit');
});

test('SCM refresh keeps newer drafts separate from its asynchronous callback', async () => {
	const started = new DeferredPromise<void>();
	const completion = new DeferredPromise<JsonValue>();
	const calls: JsonValue[] = [];
	const value = fixture(async request => {
		calls.push(request.payload);
		if ((request.payload as { method: string; }).method === 'refresh') {
			started.complete();
			return completion.p;
		}
		return null;
	});
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	repository.provider.input.value = 'first draft';
	const refreshing = repository.provider.refresh();
	await started.p;
	repository.provider.input.value = 'newer draft';
	value.bridge.set(source, 'ash.scm', 2, [provider('first draft', 1)]);
	assert.equal(repository.provider.input.value, 'newer draft');
	const callback = calls.find(call => (call as { method: string; }).method === 'refresh') as Record<string, JsonValue>;
	assert.equal('value' in callback, false);
	completion.complete(null);
	await refreshing;
	assert.equal(repository.provider.input.value, 'newer draft');
});

test('SCM resource refreshes preserve the current selection until a new selection request', () => {
	const first = { ...(provider() as Record<string, JsonValue>), selectionRevision: 1 };
	const second = { ...first, id: 'other', selected: false, selectionRevision: 0 };
	const value = fixture(async () => null, [first, second]); using cleanup = value.lifetime;
	value.view.selectRepository('other');
	value.bridge.set(source, 'ash.scm', 2, [{ ...first, statusMessage: 'Background refresh' }, second]);
	assert.equal(value.view.activeRepository?.id, 'other');
	value.bridge.set(source, 'ash.scm', 3, [{ ...first, selectionRevision: 2 }, second]);
	assert.equal(value.view.activeRepository?.id, 'repo');
});

test('SCM retirement revokes callbacks and unregisters its repositories and decorations', async () => {
	const pending = new DeferredPromise<JsonValue>(); let signal: AbortSignal | undefined;
	const value = fixture(async (request, requestSignal) => { if ((request.payload as { method: string; }).method === 'refresh') { signal = requestSignal; return pending.p; } return null; }); using cleanup = value.lifetime;
	const refresh = value.scm.getRepository('repo')!.provider.refresh();
	value.bridge.update({ generation: 2, extensions: [] });
	assert.equal(signal?.aborted, true); assert.deepEqual([...value.scm.repositories], []); assert.equal(value.decorationProviders.size, 0);
	assert.throws(() => value.bridge.set(source, 'ash.scm', 2, [provider()]), /retired/);
	pending.complete(null); await assert.rejects(refresh);
});

test('SCM rejects a malformed replacement before removing existing repositories', () => {
	const value = fixture(async () => null);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const invalid = { ...(provider() as Record<string, JsonValue>), id: 'replacement', multiDiff: { resourcePrefix: 'ash-scm://another.extension/repository', sourceActions: [], repositoryActions: [] } };
	assert.throws(() => value.bridge.set(source, 'ash.scm', 2, [invalid]), /belong to its extension/);
	assert.equal(value.scm.getRepository('repo'), repository);
	assert.equal(value.scm.getRepository('replacement'), undefined);
	assert.equal(value.decorationProviders.size, 1);
	value.bridge.set(source, 'ash.scm', 2, [provider('valid replacement')]);
	assert.equal(repository.provider.input.value, 'valid replacement');
});

test('SCM cannot take over another extension repository or change its registered identity', () => {
	const value = fixture(async () => null);
	using cleanup = value.lifetime;
	const otherProvider = { ...(provider() as Record<string, JsonValue>), id: 'other' };
	const otherRuntime = { ...fleet([otherProvider]).extensions[0], id: 'ash.other' };
	value.bridge.update({ generation: 2, extensions: [...fleet().extensions, otherRuntime] });
	const repository = value.scm.getRepository('repo')!;
	const otherRepository = value.scm.getRepository('other')!;
	assert.throws(() => value.bridge.set(source, 'ash.scm', 2, [otherProvider]), /already registered/);
	assert.throws(() => value.bridge.set(source, 'ash.scm', 2, [{ ...(provider() as Record<string, JsonValue>), rootUri: 'file:///other' }]), /identity cannot change/);
	assert.equal(value.scm.getRepository('repo'), repository);
	assert.equal(value.scm.getRepository('other'), otherRepository);
});

test('SCM bridge forwards reference-only HEAD moves once without invalidating history', () => {
	const initial = { ...(provider() as Record<string, JsonValue>), hasHistory: true };
	const value = fixture(async () => null, [initial]);
	using cleanup = value.lifetime;
	const history = value.scm.getRepository('repo')!.provider.historyProvider!;
	let invalidations = 0;
	let headChanges = 0;
	using headChanged = history.historyItemRef.onDidChange(() => headChanges++);
	const updates: Array<readonly import('../../../contrib/scm/common/history.js').ISCMHistoryItem[]> = [];
	using full = history.onDidChange(() => invalidations++);
	using refs = history.onDidChangeHistoryItemRefs!(items => {
		assert.equal(history.historyItemRef.get()?.revision, 'older');
		updates.push(items);
	});
	const changed = {
		...initial,
		historyRef: { id: 'localBranch:topic', name: 'topic', revision: 'older', category: 'localBranch' },
		historyRefsRevision: 1,
		historyRefsItems: [{ id: 'older', parentIds: [], subject: 'Older commit', message: 'Older commit', references: [{ id: 'localBranch:topic', name: 'topic', revision: 'older', category: 'localBranch', canDelete: false }] }],
	};
	value.bridge.set(source, 'ash.scm', 2, [changed]);
	value.bridge.set(source, 'ash.scm', 3, [changed]);
	assert.equal(invalidations, 0);
	assert.equal(updates.length, 1);
	assert.equal(headChanges, 1, 'Unchanged HEAD in resource snapshots does not redraw history');
	assert.equal(updates[0]?.[0]?.references?.[0]?.canDelete, false);
	value.bridge.set(source, 'ash.scm', 4, [{ ...changed, historyRevision: 2, historyRefsRevision: 2, historyRefsItems: [] }]);
	assert.equal(invalidations, 1, 'Commit-set changes take precedence over ref decoration snapshots');
	assert.equal(updates.length, 1);
	assert.throws(() => value.bridge.set(source, 'ash.scm', 5, [{ ...changed, historyRefsRevision: -1 }]), /history refs revision/);
});

test('SCM bridges advertised reference filters, upstream changes and immutable binary bytes', async () => {
	const ref = { id: 'remoteBranch:origin/main', name: 'origin/main', revision: 'remote', category: 'remoteBranch' };
	const snapshot = { ...(provider() as Record<string, JsonValue>), hasHistory: true, hasHistoryItemRefs: true, hasHistoryMergeBase: true, historyRemoteRef: ref, historyBaseRef: { ...ref, id: 'remoteBranch:origin/base', name: 'origin/base' } };
	const calls: Array<Record<string, JsonValue>> = [];
	let bytes: JsonValue = [0, 1, 255];
	const value = fixture(async request => {
		const payload = request.payload as Record<string, JsonValue>;
		calls.push(payload);
		switch (payload.methodName) {
			case 'provideHistoryItemRefs': return [ref];
			case 'resolveHistoryItemRefsCommonAncestor': return 'base';
			case 'resolveHistoryItemChangeContents': return { original: { kind: 'binary', bytes }, modified: { kind: 'missing' } };
			default: return null;
		}
	}, [snapshot]);
	using lifetime = value.lifetime;
	const history = value.scm.getRepository('repo')!.provider.historyProvider!;
	assert.deepEqual(await history.provideHistoryItemRefs!([ref.id]), [{ ...ref, description: undefined, upstream: undefined, canDelete: false, color: undefined }]);
	assert.deepEqual(calls.at(-1)!.arguments, [[ref.id]]);
	assert.equal(await history.resolveHistoryItemRefsCommonAncestor!(['head', 'remote']), 'base');
	assert.deepEqual(calls.at(-1)!.arguments, [['head', 'remote']]);
	assert.equal(history.historyItemRemoteRef!.get()!.revision, 'remote');
	assert.equal(history.historyItemBaseRef!.get()!.name, 'origin/base');
	let baseChanges = 0;
	using baseListener = history.historyItemBaseRef!.onDidChange(() => baseChanges++);
	let upstreamChanges = 0;
	using listener = history.historyItemRemoteRef!.onDidChange(() => upstreamChanges++);
	value.bridge.set(source, 'ash.scm', 2, [{ ...snapshot, historyRemoteRef: { ...ref, revision: 'new-remote' } }]);
	assert.equal(upstreamChanges, 1);
	value.bridge.set(source, 'ash.scm', 3, [{ ...snapshot, historyBaseRef: { ...ref, id: 'remoteBranch:origin/release', name: 'origin/release' } }]);
	assert.equal(baseChanges, 1);
	assert.equal(history.historyItemBaseRef!.get()!.name, 'origin/release');
	const change = { uri: URI.parse('git:/image.bin'), path: 'image.bin', status: 'modified' };
	const result = await history.resolveHistoryItemChangeContents('head', change);
	assert.deepEqual(result.original, { kind: 'binary', bytes: new Uint8Array([0, 1, 255]) });
	assert.deepEqual(result.modified, { kind: 'missing' });
	bytes = [256];
	await assert.rejects(history.resolveHistoryItemChangeContents('head', change), /Invalid SCM binary bytes/u);
	bytes = null;
	assert.deepEqual((await history.resolveHistoryItemChangeContents('head', change)).original, { kind: 'binary' });
});


test('SCM status command availability survives the extension bridge', async () => {
	const calls: JsonValue[] = [];
	const command = { id: 'git.sync', text: '3↓ 0↑', ariaLabel: 'Sync', tooltip: 'Sync', priority: 800, enabled: false };
	const snapshot = { ...(provider() as Record<string, JsonValue>), statusBarCommands: [command] };
	const value = fixture(async request => { calls.push(request.payload); return null; }, [snapshot]);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const statusCommands = () => repository.provider.statusBarCommands;
	assert.equal(statusCommands()[0]?.run, undefined);
	value.bridge.set(source, 'ash.scm', 2, [{ ...snapshot, statusBarCommands: [{ ...command, enabled: true }] }]);
	await statusCommands()[0]?.run?.();
	assert.ok(calls.some(call => typeof call === 'object' && call !== null && 'method' in call && call.method === 'statusBar' && call.commandId === 'git.sync'));
});

const settleCallbacks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('SCM decoration bursts leave invocation slots available for refresh and return every result', async () => {
	const pending: DeferredPromise<JsonValue>[] = [];
	let active = 0;
	let maximum = 0;
	let refreshes = 0;
	const value = fixture(async request => {
		const method = (request.payload as { method: string; }).method;
		if (method === 'refresh') refreshes++;
		if (method !== 'decoration') return null;
		active++;
		maximum = Math.max(maximum, active);
		const completion = new DeferredPromise<JsonValue>();
		pending.push(completion);
		try { return await completion.p; }
		finally { active--; }
	});
	using cleanup = value.lifetime;
	const decorationProvider = [...value.decorationProviders][0]!;
	const queries = Array.from({ length: 80 }, (_, index) => decorationProvider.provideDecorations(URI.file(`/workspace/file-${index}`), CancellationToken.None));
	await value.scm.getRepository('repo')!.provider.refresh();
	assert.equal(refreshes, 1);
	assert.equal(pending.length, 4);
	for (let completed = 0; completed < queries.length;) {
		const batch = pending.splice(0);
		assert.ok(batch.length > 0);
		for (const completion of batch) completion.complete(null);
		await Promise.all(queries.slice(completed, completed + batch.length));
		completed += batch.length;
	}
	assert.equal(maximum, 4);
	assert.equal(active, 0);
	assert.deepEqual(await Promise.all(queries), Array(80).fill(undefined));
	assert.deepEqual(value.errors, []);
});

test('SCM skips cancelled queued decoration queries and retiring a registration cannot send them', async () => {
	const pending: DeferredPromise<JsonValue>[] = [];
	let requests = 0;
	const value = fixture(async request => {
		if ((request.payload as { method: string; }).method !== 'decoration') return null;
		requests++;
		const completion = new DeferredPromise<JsonValue>();
		pending.push(completion);
		return completion.p;
	});
	using cleanup = value.lifetime;
	const decorationProvider = [...value.decorationProviders][0]!;
	const queries = Array.from({ length: 20 }, (_, index) => decorationProvider.provideDecorations(URI.file(`/workspace/file-${index}`), CancellationToken.None));
	const results = Promise.allSettled(queries);
	assert.equal(requests, 4);
	value.bridge.update({ generation: 2, extensions: [] });
	for (const completion of pending) completion.complete(null);
	assert.ok((await results).every(result => result.status === 'rejected'));
	assert.equal(requests, 4);
	assert.notEqual(value.contexts.getValue('scm.providerState.ash.git'), 'ready');
});

test('SCM retries failed initialization and only reports an empty repository after successful discovery', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let attempts = 0;
		const value = fixture(async request => {
			if ((request.payload as { method: string; }).method === 'initialize' && ++attempts < 3) throw new Error('Transient admission failure');
			return null;
		}, []);
		using cleanup = value.lifetime;
		const state = () => value.contexts.getValue('scm.providerState.ash.git');
		await settleCallbacks();
		assert.equal(state(), 'initializing');
		assert.equal(attempts, 1);
		mock.timers.tick(250);
		await settleCallbacks();
		assert.equal(state(), 'initializing');
		assert.equal(attempts, 2);
		mock.timers.tick(1000);
		await settleCallbacks();
		assert.equal(state(), 'ready');
		assert.equal(attempts, 3);
		assert.equal(value.errors.length, 2);
		assert.deepEqual([...value.scm.repositories], []);
	} finally { mock.timers.reset(); }
});

test('SCM initialization failure stays distinct from no repository and exposes a working retry command', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let available = false;
		let attempts = 0;
		const value = fixture(async request => {
			if ((request.payload as { method: string; }).method === 'initialize') {
				attempts++;
				if (!available) throw new Error('Provider unavailable');
			}
			return null;
		}, []);
		using cleanup = value.lifetime;
		await settleCallbacks();
		mock.timers.tick(250);
		await settleCallbacks();
		mock.timers.tick(1000);
		await settleCallbacks();
		assert.equal(value.contexts.getValue('scm.providerState.ash.git'), 'failed');
		assert.equal(attempts, 3);
		available = true;
		const retry = value.commands.getCommand('workbench.scm.action.retryInitialization')!;
		await retry({} as ServicesAccessor);
		assert.equal(value.contexts.getValue('scm.providerState.ash.git'), 'ready');
		assert.equal(attempts, 4);
	} finally { mock.timers.reset(); }
});

test('SCM retiring an initializer cancels delayed retries and cannot overwrite its replacement state', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let attempts = 0;
		const value = fixture(async () => { attempts++; throw new Error('Transient failure'); }, []);
		using cleanup = value.lifetime;
		await settleCallbacks();
		value.bridge.update({ generation: 2, extensions: [] });
		mock.timers.tick(5000);
		await settleCallbacks();
		assert.equal(attempts, 1);
		assert.notEqual(value.contexts.getValue('scm.providerState.ash.git'), 'failed');
	} finally { mock.timers.reset(); }
});

test('Git welcome predicates distinguish scanning, failure, disconnected and confirmed empty states in English and Chinese', async () => {
	const root = process.cwd();
	const manifest = JSON.parse(await readFile(`${root}/extensions/git/package.json`, 'utf8'));
	using contexts = new ContextKeyService();
	const folders = contexts.createKey<number>('workspaceFolderCount', 1);
	const connected = contexts.createKey<boolean>('appServerAvailable', true);
	const state = contexts.createKey<string>('scm.providerState.ash.git', 'initializing');
	const visible = () => manifest.contributes.viewsWelcome.filter((entry: { when: string; }) => ContextKeyExpr.deserialize(entry.when)!.evaluate(contexts)).map((entry: { contents: string; }) => entry.contents);
	for (const locale of ['package.nls.json', 'package.nls.zh-CN.json']) {
		const messages = JSON.parse(await readFile(`${root}/extensions/git/${locale}`, 'utf8'));
		for (const [status, key] of [['initializing', 'initializing'], ['failed', 'failed'], ['ready', 'noRepository']]) {
			state.set(status!);
			const content = visible().join('\n').replace(/%([^%]+)%/g, (_: string, key: string) => messages[key]);
			assert.ok(content.includes(messages[`git.welcome.${key}`]));
			assert.equal(content.includes(messages['git.welcome.initialize']), status === 'ready');
			assert.equal(content.includes(messages['git.welcome.retry']), status === 'failed');
		}
	}
	connected.set(false);
	assert.deepEqual(visible(), ['%git.welcome.unavailable%']);
	folders.set(0);
	assert.ok(!visible().some((content: string) => /noRepository|failed|initializing|unavailable/.test(content)));
});
