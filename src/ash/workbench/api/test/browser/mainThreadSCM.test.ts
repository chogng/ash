import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
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
	const bridge = lifetime.add(new MainThreadSCM(10_000, error => errors.push(error), { invoke } as IExtensionHostApi, scm, view, {} as ICommandService, resolvers, quickDiff, decorations));
	bridge.update(fleet(providers));
	return { lifetime, scm, view, bridge, decorationProviders, errors };
}

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
