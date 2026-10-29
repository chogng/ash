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
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import type {
	ExtensionHostFleetSnapshot,
	IExtensionHostApi,
	JsonValue,
} from '../../../../platform/agentHost/common/extensionHostApi.js';
import { SCMService } from '../../../contrib/scm/common/scmService.js';
import { SCMViewService } from '../../../contrib/scm/browser/scmViewService.js';
import { QuickDiffService } from '../../../contrib/scm/common/quickDiffService.js';
import type { IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { MultiDiffSourceResolverService } from '../../../contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { MainThreadSCM } from '../../browser/mainThreadSCM.js';
import { TimelineService } from '../../../contrib/timeline/common/timelineService.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { NullLoggerService } from '../../../../platform/log/common/log.js';
import type { IViewsService } from '../../../services/views/common/viewsService.js';

const source = { extensionId: 'ash.git', activationGeneration: 1, incarnation: 1 };
const provider = (value = 'draft', inputRevision = 0): JsonValue => ({
	id: 'repo',
	providerId: 'git',
	label: 'Repository',
	rootUri: 'file:///workspace',
	selected: true,
	groups: [],
	input: {
		value,
		enabled: true,
		canAccept: true,
		placeholder: 'Message',
		buttonLabel: 'Commit',
		buttonTooltip: 'Commit changes',
	},
	inputRevision,
	statusBarCommands: [],
	activeRepositoryName: 'main',
	statusMessage: '',
	isBusy: false,
	historyRevision: 1,
	hasHistory: false,
	hasMerge: false,
	multiDiff: null,
});
function fleet(providers: JsonValue[] = [provider()]): ExtensionHostFleetSnapshot {
	return {
		generation: 1,
		extensions: [
			{
				id: 'ash.git',
				version: '1.0.0',
				packageDigest: 'sha256:' + 'a'.repeat(64),
				runtimeApiVersion: 1,
				...source,
				lifecycle: 'ready',
				failure: undefined,
				registrations: [{ kind: 'sourceControl', registrationId: 'ash.scm', revision: 1, providers }],
				stderr: '',
				outputEvents: [],
			},
		],
	};
}
function fixture(
	invoke: IExtensionHostApi['invoke'],
	providers?: JsonValue[],
	reconcile?: IExtensionHostApi['reconcile'],
) {
	const lifetime = new DisposableStore();
	const scm = lifetime.add(new SCMService());
	const view = lifetime.add(new SCMViewService(scm));
	const quickDiff = lifetime.add(new QuickDiffService());
	const resolvers = lifetime.add(new MultiDiffSourceResolverService());
	const decorationProviders = new Set<IDecorationsProvider>();
	const errors: unknown[] = [];
	const decorations = {
		registerDecorationsProvider(value: IDecorationsProvider) {
			decorationProviders.add(value);
			return { dispose: () => decorationProviders.delete(value) };
		},
	} as unknown as IDecorationsService;
	const contexts = lifetime.add(new ContextKeyService());
	const commands = new CommandRegistry();
	const timeline = lifetime.add(new TimelineService(contexts, {} as IViewsService, new NullLoggerService()));
	const bridge = lifetime.add(
		new MainThreadSCM(
			10_000,
			error => errors.push(error),
			commands,
			{ invoke, reconcile } as IExtensionHostApi,
			scm,
			view,
			{} as ICommandService,
			resolvers,
			quickDiff,
			decorations,
			contexts,
			timeline,
			{ activeGroup: { inputs: [] } } as unknown as IEditorPart,
		),
	);
	bridge.update(fleet(providers));
	return { lifetime, scm, view, bridge, quickDiff, decorationProviders, errors, contexts, commands, timeline };
}

test('SCM file timeline bridges scoped history, paging, open commands and meaningful changes', async () => {
	const calls: JsonValue[] = [];
	const snapshot: Record<string, JsonValue> = {
		...(provider() as Record<string, JsonValue>),
		hasHistory: true,
		timeline: { label: 'Git History', resetKey: 'committed' },
	};
	const value = fixture(
		async (request): Promise<JsonValue> => {
			calls.push(JSON.parse(JSON.stringify(request.payload)));
			if ((request.payload as Record<string, JsonValue>).methodName === 'provide') {
				return {
					items: [
						{
							historyItem: {
								id: 'commit-id',
								parentIds: [],
								subject: 'Rename file',
								message: 'Rename file',
							},
							id: 'commit-id',
							handle: 'commit:old-name',
							label: 'Rename file',
							description: 'Author, yesterday',
							timestamp: 1000,
							icon: 'git-commit',
						},
						{ handle: 'changes', label: 'Uncommitted changes', timestamp: 2000, tooltip: 'Working tree' },
					],
					cursor: 'commit:old-name',
				};
			}
			if ((request.payload as Record<string, JsonValue>).methodName === 'resolveHistoryItemDetails')
				return {
					authorName: 'Author',
					authorEmail: '',
					timestamp: 1000,
					message: 'Rename file',
					statistics: { files: 1, additions: 1, deletions: 0 },
				};
			return null;
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const id = 'scm:ash.git:repo';
	const uri = URI.file('/workspace/new-name.txt');
	assert.deepEqual(value.timeline.getSources(), [{ id, label: 'Git History' }]);
	using token = new CancellationTokenSource();
	const result = await value.timeline.getTimeline(id, uri, { limit: 1 }, token)!.result;
	assert.equal(result?.items[0]?.label, 'Rename file');
	assert.equal(result?.items[0]?.icon?.id, 'git-commit');
	assert.equal(result?.items[0]?.sourceControl?.repositoryId, 'repo');
	assert.equal(result?.items[0]?.sourceControl?.historyItem.id, 'commit-id');
	assert.equal(result?.items[0]?.sourceControl?.historyItem.tooltip?.authorName, 'Author');
	assert.equal(result?.items[1]?.sourceControl, undefined, 'Uncommitted entries keep their ordinary tooltip');
	assert.equal(result?.items[1]?.tooltip, 'Working tree');
	assert.equal(
		calls.filter(call => (call as Record<string, JsonValue>).methodName === 'resolveHistoryItemDetails').length,
		1,
		'The item is published with its tooltip already prepared',
	);
	assert.equal(
		calls.filter(call => (call as Record<string, JsonValue>).methodName === 'provideHistoryItems').length,
		0,
		'Timeline summaries do not need per-item graph queries',
	);
	assert.equal(result?.paging?.cursor, 'commit:old-name');
	assert.deepEqual(
		calls.find(call => (call as Record<string, JsonValue>).methodName === 'provide'),
		{
			method: 'timeline',
			providerId: 'repo',
			methodName: 'provide',
			resource: uri.toString(),
			options: { limit: 1 },
		},
	);
	const command = result!.items[0]!.command!;
	await value.commands.getCommand(command.id)!({} as ServicesAccessor, ...command.arguments!);
	assert.deepEqual(calls.at(-1), {
		method: 'timeline',
		providerId: 'repo',
		methodName: 'open',
		resource: uri.toString(),
		handle: 'commit:old-name',
	});
	const count = calls.length;
	assert.equal(await value.timeline.getTimeline(id, URI.file('/other/file.txt'), {}, token)!.result, undefined);
	assert.equal(calls.length, count, 'Out-of-scope resources never enter the extension');
	let changes = 0;
	using listener = value.timeline.onDidChangeTimeline(() => changes++);
	value.bridge.set(source, 'ash.scm', 2, [
		{ ...snapshot, inputRevision: 1, input: { ...(snapshot.input as Record<string, JsonValue>), value: 'typing' } },
	]);
	assert.equal(changes, 0, 'Commit drafts and blame updates do not reload file history');
	value.bridge.set(source, 'ash.scm', 3, [{ ...snapshot, historyRevision: 2 }]);
	assert.equal(changes, 1);
	value.bridge.set(source, 'ash.scm', 4, [
		{ ...snapshot, historyRevision: 2, timeline: { label: 'Git History', resetKey: 'authored' } },
	]);
	assert.equal(changes, 2, 'Timeline policy changes invalidate the visible history');
	value.bridge.set(source, 'ash.scm', 5, []);
	assert.deepEqual(value.timeline.getSources(), []);
	assert.equal(value.commands.getCommand(command.id), undefined, 'A retired entry loses its command');
	value.bridge.set(source, 'ash.scm', 6, [snapshot]);
	assert.equal(
		value.commands.getCommand(command.id),
		undefined,
		'Reusing a repository ID cannot restore a stale entry',
	);
});

test('SCM retiring a timeline provider cancels its in-flight extension request', async () => {
	const started = new DeferredPromise<void>();
	const pending = new DeferredPromise<JsonValue>();
	let signal: AbortSignal | undefined;
	const snapshot: Record<string, JsonValue> = {
		...(provider() as Record<string, JsonValue>),
		timeline: { label: 'Git History' },
	};
	const value = fixture(
		async (request, requestSignal) => {
			if ((request.payload as Record<string, JsonValue>).methodName === 'provide') {
				signal = requestSignal;
				started.complete();
				return pending.p;
			}
			return null;
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	using token = new CancellationTokenSource();
	const request = value.timeline.getTimeline('scm:ash.git:repo', URI.file('/workspace/file.txt'), {}, token)!;
	await started.p;
	value.bridge.set(source, 'ash.scm', 2, []);
	assert.equal(signal?.aborted, true);
	assert.equal(await request.result, undefined);
	pending.complete({ items: [{ handle: 'late', label: 'Stale', timestamp: 1 }] });
});

test('SCM graph and timeline publish complete tooltips before the first hover and share preparation', async () => {
	const item = { id: 'commit-id', subject: 'Shared commit', message: 'Shared commit', parentIds: [], references: [] };
	const details = {
		authorName: 'Author',
		authorEmail: 'author@example.invalid',
		timestamp: 1000,
		message: 'Shared commit\n\nBody',
		statistics: { files: 1, additions: 2, deletions: 1 },
	};
	const pending = new DeferredPromise<JsonValue>();
	const detailStarted = new DeferredPromise<void>();
	let detailReads = 0;
	const snapshot: Record<string, JsonValue> = {
		...(provider() as Record<string, JsonValue>),
		hasHistory: true,
		timeline: { label: 'Git History' },
	};
	const value = fixture(
		async (request): Promise<JsonValue> => {
			const payload = request.payload as Record<string, JsonValue>;
			if (payload.methodName === 'provideHistoryItems') return [item];
			if (payload.methodName === 'provide')
				return {
					items: [
						{ id: item.id, handle: 'commit:file', label: item.subject, timestamp: 1000, historyItem: item },
					],
				};
			if (payload.methodName === 'resolveHistoryItemDetails') {
				detailReads++;
				detailStarted.complete();
				return pending.p;
			}
			return null;
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const history = value.scm.getRepository('repo')!.provider.historyProvider!;
	let graphPublished = false;
	let timelinePublished = false;
	const graphPage = history.provideHistoryItems({ limit: 25 }).then(items => {
		graphPublished = true;
		return items;
	});
	using token = new CancellationTokenSource();
	const timelinePage = value.timeline
		.getTimeline('scm:ash.git:repo', URI.file('/workspace/file.txt'), {}, token)!
		.result.then(items => {
			timelinePublished = true;
			return items;
		});
	await detailStarted.p;
	assert.equal(graphPublished, false);
	assert.equal(timelinePublished, false);
	pending.complete(details);
	const [graph, timeline] = await Promise.all([graphPage, timelinePage]);
	assert.deepEqual(graph?.[0].tooltip, details);
	assert.equal(timeline?.items[0].sourceControl?.historyItem.tooltip, graph?.[0].tooltip);
	assert.equal(detailReads, 1, 'Both producers share the same preparation request');
	assert.deepEqual((await history.provideHistoryItems({ limit: 25 }))?.[0].tooltip, details);
	assert.equal(detailReads, 1, 'Refreshing metadata reuses immutable tooltip data');
});

test('SCM page preparation bounds detail reads and publishes no partial items', async () => {
	const items = Array.from({ length: 40 }, (_, index) => ({
		id: `commit-${index}`,
		parentIds: [],
		subject: `Commit ${index}`,
		message: `Commit ${index}`,
	}));
	const gates = items.map(() => new DeferredPromise<JsonValue>());
	const admitted = new DeferredPromise<void>();
	let active = 0;
	let peak = 0;
	let reads = 0;
	let published = false;
	const snapshot: Record<string, JsonValue> = { ...(provider() as Record<string, JsonValue>), hasHistory: true };
	const value = fixture(
		async (request): Promise<JsonValue> => {
			const payload = request.payload as Record<string, JsonValue>;
			if (payload.methodName === 'provideHistoryItems') return items;
			if (payload.methodName !== 'resolveHistoryItemDetails') return null;
			const index = Number((payload.arguments as string[])[0].slice('commit-'.length));
			reads++;
			peak = Math.max(peak, ++active);
			if (active === 4) admitted.complete();
			try {
				return await gates[index].p;
			} finally {
				active--;
			}
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const reading = value.scm
		.getRepository('repo')!
		.provider.historyProvider!.provideHistoryItems({ limit: 40 })
		.then(page => {
			published = true;
			return page;
		});
	await admitted.p;
	assert.equal(reads, 4);
	assert.equal(published, false);
	for (const [index, gate] of gates.entries())
		gate.complete({
			authorName: 'Author',
			authorEmail: '',
			timestamp: 1000,
			message: `Commit ${index}`,
			statistics: { files: 1, additions: 1, deletions: 0 },
		});
	const page = await reading;
	assert.equal(page?.length, 40);
	assert.ok(page?.every((item, index) => item.tooltip?.message === `Commit ${index}`));
	assert.equal(peak, 4);
	assert.equal(reads, 40);
});

test('SCM eager tooltip preparation retries failures and releases a retired repository cache', async () => {
	const item = { id: 'commit-id', parentIds: [], subject: 'Commit', message: 'Commit' };
	const details = {
		authorName: 'Author',
		authorEmail: '',
		timestamp: 1000,
		message: 'Body',
		statistics: { files: 1, additions: 1, deletions: 0 },
	};
	let reads = 0;
	const snapshot: Record<string, JsonValue> = { ...(provider() as Record<string, JsonValue>), hasHistory: true };
	const value = fixture(
		async (request): Promise<JsonValue> => {
			const payload = request.payload as Record<string, JsonValue>;
			if (payload.methodName === 'provideHistoryItems') return [item];
			if (payload.methodName === 'resolveHistoryItemDetails') {
				if (++reads === 1) throw new Error('Fixture detail read failed');
				return details;
			}
			return null;
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const history = value.scm.getRepository('repo')!.provider.historyProvider!;
	await assert.rejects(history.provideHistoryItems({}), /Fixture detail read failed/);
	assert.deepEqual((await history.provideHistoryItems({}))?.[0].tooltip, details);
	assert.equal(reads, 2);
	value.bridge.set(source, 'ash.scm', 2, []);
	value.bridge.set(source, 'ash.scm', 3, [snapshot]);
	assert.deepEqual(
		(await value.scm.getRepository('repo')!.provider.historyProvider!.provideHistoryItems({}))?.[0].tooltip,
		details,
	);
	assert.equal(reads, 3);
});

test('SCM resource groups survive input-only snapshots and retire changed resources', () => {
	const snapshot: Record<string, JsonValue> = {
		...(provider() as Record<string, JsonValue>),
		groups: [{ id: 'changes', label: 'Changes', actions: [], resources: [] }],
	};
	const value = fixture(async () => null, [snapshot]);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const groups = repository.provider.groups;
	assert.strictEqual(repository.provider.groups, groups);
	assert.ok(repository.provider.groups.includes(groups[0]!));
	value.bridge.set(source, 'ash.scm', 2, [
		{
			...snapshot,
			input: { ...(snapshot.input as Record<string, JsonValue>), placeholder: 'Updated placeholder' },
		},
	]);
	assert.strictEqual(repository.provider.groups, groups);
	value.bridge.set(source, 'ash.scm', 3, [
		{ ...snapshot, groups: [{ id: 'changes', label: 'Updated changes', actions: [], resources: [] }] },
	]);
	assert.notStrictEqual(repository.provider.groups, groups);
	assert.ok(!repository.provider.groups.includes(groups[0]!));
});

test('SCM reconciles resources by group and ID while replacing changed actions and removed identities', async () => {
	const resource = (id: string, enabled = true): JsonValue => ({
		id,
		sourceUri: `file:///workspace/${id}.txt`,
		path: `${id}.txt`,
		decorations: { badge: 'M', tooltip: 'Modified', kind: 'modified' },
		openLabel: `Open ${id}`,
		actions: [{ id: `stage:${id}`, label: 'Stage', tooltip: 'Stage', enabled }],
	});
	const group = (id: string, resources: JsonValue[]): JsonValue => ({ id, label: id, actions: [], resources });
	const snapshot = (groups: JsonValue[]): JsonValue => ({ ...(provider() as Record<string, JsonValue>), groups });
	const calls: JsonValue[] = [];
	const first = resource('first'),
		second = resource('second');
	const value = fixture(
		async request => {
			calls.push(request.payload);
			return null;
		},
		[snapshot([group('changes', [first, second]), group('staged', [first])])],
	);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const before = repository.provider.groups;
	value.bridge.set(source, 'ash.scm', 2, [
		snapshot([group('staged', [first]), group('changes', [resource('added'), first, resource('second', false)])]),
	]);
	const after = repository.provider.groups;
	assert.strictEqual(after[0], before[1], 'An unchanged group survives reordering');
	assert.strictEqual(
		after[1]!.resources[1],
		before[0]!.resources[0],
		'An unchanged resource survives insertion before it',
	);
	assert.notStrictEqual(after[1]!.resources[2], before[0]!.resources[1]);
	assert.equal(after[1]!.resources[2]!.actions[0]!.enabled, false);
	await after[1]!.resources[1]!.open({}, false);
	assert.equal((calls.at(-1) as Record<string, JsonValue>).resourceId, 'first');
	value.bridge.set(source, 'ash.scm', 3, [snapshot([group('changes', [second])])]);
	assert.equal(repository.provider.groups.length, 1);
	assert.notStrictEqual(
		repository.provider.groups[0]!.resources[0],
		before[0]!.resources[1],
		'The new action state replaces the disabled action',
	);
});

test('SCM cancels obsolete previews while retained opens survive later selections', async () => {
	const started = new DeferredPromise<void>();
	const pinnedResult = new DeferredPromise<JsonValue>();
	const signals: AbortSignal[] = [];
	const snapshot = {
		...(provider() as Record<string, JsonValue>),
		groups: [
			{
				id: 'changes',
				label: 'Changes',
				actions: [],
				resources: [
					{
						id: 'first',
						sourceUri: 'file:///workspace/first',
						path: 'first',
						decorations: { badge: 'M', tooltip: 'Modified', kind: 'modified' },
						openLabel: 'First',
						actions: [],
					},
					{
						id: 'second',
						sourceUri: 'file:///workspace/second',
						path: 'second',
						decorations: { badge: 'M', tooltip: 'Modified', kind: 'modified' },
						openLabel: 'Second',
						actions: [],
					},
				],
			},
		],
	};
	const value = fixture(
		async (request, signal) => {
			if ((request.payload as Record<string, JsonValue>).method !== 'open') return null;
			signals.push(signal!);
			if (signals.length === 1) started.complete();
			if (
				((request.payload as Record<string, JsonValue>).options as Record<string, JsonValue> | undefined)
					?.pinned
			)
				return pinnedResult.p;
			return new Promise((_resolve, reject) =>
				signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
			);
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const resources = value.scm.getRepository('repo')!.provider.groups[0]!.resources;
	const first = resources[0]!.open({}, false);
	await started.p;
	const second = resources[1]!.open({}, false);
	await first;
	assert.equal(signals[0].aborted, true);
	assert.equal(signals[1].aborted, false);
	const pinned = resources[0]!.open({ pinned: true }, false);
	await second;
	assert.equal(signals[1].aborted, true);
	const third = resources[1]!.open({}, false);
	assert.equal(signals[2].aborted, false, 'Retained opens are independent of the preview request');
	pinnedResult.complete(null);
	await pinned;
	cleanup.dispose();
	await third;
	assert.equal(signals[3].aborted, true);
});

test('SCM decorates collapsed ancestors from current changes and respects provider bubbling', async () => {
	const resource = URI.file('/workspace/src/sample.txt');
	const snapshot = {
		...(provider() as Record<string, JsonValue>),
		groups: [
			{
				id: 'changes',
				label: 'Changes',
				actions: [],
				resources: [
					{
						id: 'sample',
						sourceUri: resource.toString(),
						path: 'src/sample.txt',
						decorations: { badge: 'D', tooltip: 'Deleted', kind: 'deleted' },
						openLabel: 'Open change',
						actions: [],
					},
				],
			},
		],
	};
	let enabled = true;
	let bubble = true;
	let directFolder = false;
	const queries: string[] = [];
	const value = fixture(
		async (request): Promise<JsonValue> => {
			const payload = request.payload as Record<string, JsonValue>;
			if (payload.method !== 'decoration') return null;
			queries.push(payload.resource as string);
			if (directFolder && payload.resource === 'file:///workspace/src')
				return { color: 'description.foreground', letter: '!', tooltip: 'Folder status' };
			return enabled && payload.resource === resource.toString()
				? {
						color: 'gitDecoration.deletedResourceForeground',
						letter: 'D',
						tooltip: 'Deleted',
						weight: 10,
						bubble,
						strikethrough: true,
					}
				: null;
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const decorations = [...value.decorationProviders][0]!;
	const folder = URI.file('/workspace/src');
	const fileDecoration = await decorations.provideDecorations(resource, CancellationToken.None);
	assert.equal(fileDecoration?.letter, 'D');
	assert.equal(fileDecoration?.strikethrough, true);
	const folderDecoration = await decorations.provideDecorations(folder, CancellationToken.None);
	assert.equal(folderDecoration?.color, fileDecoration?.color);
	assert.equal(folderDecoration?.letter, '●');
	assert.equal(folderDecoration?.strikethrough, false);
	assert.equal(queries.at(-1), resource.toString());
	assert.equal(await decorations.provideDecorations(URI.file('/workspace/sr'), CancellationToken.None), undefined);
	bubble = false;
	assert.equal(await decorations.provideDecorations(folder, CancellationToken.None), undefined);
	directFolder = true;
	assert.equal((await decorations.provideDecorations(folder, CancellationToken.None))?.letter, '!');
	directFolder = false;
	bubble = true;
	enabled = false;
	assert.equal(await decorations.provideDecorations(folder, CancellationToken.None), undefined);
	enabled = true;
	value.bridge.set(source, 'ash.scm', 2, [{ ...snapshot, groups: [] }]);
	assert.equal(await decorations.provideDecorations(folder, CancellationToken.None), undefined);
	assert.equal(queries.at(-1), folder.toString());
});

test('SCM history command contexts revive only the owning live repository', async () => {
	const value = fixture(async () => null);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const item = {
		id: 'abc',
		parentIds: ['parent'],
		subject: 'Commit',
		message: 'Commit',
		remoteLinks: [{ name: 'origin', uri: URI.parse('https://example.com/abc') }],
	};
	const encoded = await value.bridge.prepareCommandArguments('ash.git', [
		{ type: 'historyItemViewModel', repository, historyItemViewModel: { historyItem: item } },
	]);
	const [revived] = value.bridge.reviveCommandArguments(source, encoded) as Array<{
		repository: typeof repository;
		historyItemViewModel: { historyItem: typeof item };
	}>;
	assert.strictEqual(revived.repository, repository);
	assert.deepEqual(revived.historyItemViewModel.historyItem.remoteLinks, item.remoteLinks);
	assert.throws(
		() => value.bridge.reviveCommandArguments({ ...source, extensionId: 'other.extension' }, encoded),
		/foreign repository/,
	);
	assert.throws(() => value.bridge.reviveCommandArguments({ ...source, incarnation: 2 }, encoded), /retired/);
	value.bridge.update({ generation: 2, extensions: [] });
	assert.throws(() => value.bridge.reviveCommandArguments(source, encoded), /retired/);
});

test('SCM extension receives captured repository and history arguments and the current draft', async () => {
	const calls: JsonValue[] = [];
	const value = fixture(async request => {
		calls.push(request.payload);
		return null;
	});
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	repository.provider.input.value = 'edited';
	const history = {
		type: 'historyItemViewModel',
		repository,
		historyItemViewModel: {
			historyItem: { id: 'abc', remoteLinks: [{ name: 'origin', uri: URI.parse('https://example.com/abc') }] },
		},
	};
	assert.deepEqual(
		JSON.parse(JSON.stringify(await value.bridge.prepareCommandArguments('ash.git', [repository, history]))),
		[
			{ repositoryId: 'repo', provider: { id: 'repo', providerId: 'git' } },
			{
				type: 'historyItemViewModel',
				repository: { repositoryId: 'repo', provider: { id: 'repo', providerId: 'git' } },
				historyItemViewModel: {
					historyItem: { id: 'abc', remoteLinks: [{ name: 'origin', uri: 'https://example.com/abc' }] },
				},
				references: null,
			},
		],
	);
	assert.ok(
		calls.some(
			call =>
				typeof call === 'object' &&
				call !== null &&
				'method' in call &&
				call.method === 'setInput' &&
				'value' in call &&
				call.value === 'edited' &&
				'inputRevision' in call &&
				call.inputRevision === 1,
		),
	);
	value.bridge.set(source, 'ash.scm', 2, [provider('obsolete', 0)]);
	assert.equal(repository.provider.input.value, 'edited');
	value.bridge.set(source, 'ash.scm', 3, [provider('amended', 1)]);
	assert.equal(repository.provider.input.value, 'amended');
});

test('SCM input completion preserves a draft edited while the command was running', async () => {
	const completion = new DeferredPromise<JsonValue>();
	const value = fixture(async request =>
		(request.payload as { method: string }).method === 'acceptInput' ? completion.p : null,
	);
	using cleanup = value.lifetime;
	const input = value.scm.getRepository('repo')!.provider.input;
	const accepting = input.accept();
	input.value = 'next commit';
	completion.complete({ result: 'committed', value: '' });
	assert.equal(await accepting, 'committed');
	assert.equal(input.value, 'next commit');
});

test('SCM refresh keeps newer drafts separate from its asynchronous callback', async () => {
	const started = new DeferredPromise<void>();
	const completion = new DeferredPromise<JsonValue>();
	const calls: JsonValue[] = [];
	const value = fixture(async request => {
		calls.push(request.payload);
		if ((request.payload as { method: string }).method === 'refresh') {
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
	const callback = calls.find(call => (call as { method: string }).method === 'refresh') as Record<string, JsonValue>;
	assert.equal('value' in callback, false);
	completion.complete(null);
	await refreshing;
	assert.equal(repository.provider.input.value, 'newer draft');
});

test('SCM resource refreshes preserve the current selection until a new selection request', () => {
	const first = { ...(provider() as Record<string, JsonValue>), selectionRevision: 1 };
	const second = { ...first, id: 'other', selected: false, selectionRevision: 0 };
	const value = fixture(async () => null, [first, second]);
	using cleanup = value.lifetime;
	value.view.selectRepository('other');
	value.bridge.set(source, 'ash.scm', 2, [{ ...first, statusMessage: 'Background refresh' }, second]);
	assert.equal(value.view.activeRepository?.id, 'other');
	value.bridge.set(source, 'ash.scm', 3, [{ ...first, selectionRevision: 2 }, second]);
	assert.equal(value.view.activeRepository?.id, 'repo');
});

test('SCM retirement revokes callbacks and unregisters its repositories and decorations', async () => {
	const pending = new DeferredPromise<JsonValue>();
	let signal: AbortSignal | undefined;
	const started = new DeferredPromise<void>();
	const value = fixture(async (request, requestSignal) => {
		if ((request.payload as { method: string }).method === 'refresh') {
			signal = requestSignal;
			started.complete();
			return pending.p;
		}
		return null;
	});
	using cleanup = value.lifetime;
	const refresh = value.scm.getRepository('repo')!.provider.refresh();
	await started.p;
	value.bridge.update({ generation: 2, extensions: [] });
	assert.equal(signal?.aborted, true);
	assert.deepEqual([...value.scm.repositories], []);
	assert.equal(value.decorationProviders.size, 0);
	assert.throws(() => value.bridge.set(source, 'ash.scm', 2, [provider()]), /retired/);
	pending.complete(null);
	await assert.rejects(refresh);
});

test('SCM rejects a malformed replacement before removing existing repositories', () => {
	const value = fixture(async () => null);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const invalid = {
		...(provider() as Record<string, JsonValue>),
		id: 'replacement',
		multiDiff: {
			resourcePrefix: 'ash-scm://another.extension/repository',
			sourceActions: [],
			repositoryActions: [],
		},
	};
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
	assert.throws(
		() =>
			value.bridge.set(source, 'ash.scm', 2, [
				{ ...(provider() as Record<string, JsonValue>), rootUri: 'file:///other' },
			]),
		/identity cannot change/,
	);
	assert.equal(value.scm.getRepository('repo'), repository);
	assert.equal(value.scm.getRepository('other'), otherRepository);
});

test('SCM history and reference updates leave Changes quiet while working-tree controls still update', () => {
	const initial: Record<string, JsonValue> = { ...(provider() as Record<string, JsonValue>), hasHistory: true };
	const value = fixture(async () => null, [initial]);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	let resources = 0;
	let history = 0;
	let diff = 0;
	using diffListener = value.quickDiff.onDidChange(() => diff++);
	using resourceListener = repository.provider.onDidChangeResources(() => resources++);
	using historyListener = repository.provider.historyProvider!.onDidChange(() => history++);
	const groups = repository.provider.groups;
	const changed = {
		...initial,
		historyRevision: 2,
		historyRef: { id: 'refs/heads/main', name: 'main', revision: 'new-commit' },
	};
	value.bridge.set(source, 'ash.scm', 2, [changed]);
	value.bridge.set(source, 'ash.scm', 3, [changed]);
	assert.equal(history, 1);
	assert.equal(diff, 1, 'A moved HEAD invalidates the original diff without refreshing Changes');
	assert.equal(resources, 0, 'History-only and identical snapshots do not refresh Changes');
	assert.equal(repository.provider.groups, groups);
	value.bridge.set(source, 'ash.scm', 4, [{ ...changed, isBusy: true }]);
	assert.equal(resources, 1, 'Operation state still updates Commit and resource actions');
	value.bridge.set(source, 'ash.scm', 5, [
		{ ...changed, input: { ...(initial.input as Record<string, JsonValue>), value: 'new draft' } },
	]);
	assert.equal(resources, 2);
	assert.equal(diff, 2, 'Completing an index operation can change diff content without changing path statuses');
	assert.equal(repository.provider.input.value, 'new draft');
	value.bridge.set(source, 'ash.scm', 6, [
		{ ...changed, groups: [{ id: 'working', label: 'Changes', resources: [], actions: [] }] },
	]);
	assert.equal(resources, 3, 'Actual working-tree changes still reach Changes');
	assert.equal(diff, 3);
	assert.notEqual(repository.provider.groups, groups);
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
		historyRefsItems: [
			{
				id: 'older',
				parentIds: [],
				subject: 'Older commit',
				message: 'Older commit',
				references: [
					{
						id: 'localBranch:topic',
						name: 'topic',
						revision: 'older',
						category: 'localBranch',
						canDelete: false,
					},
				],
			},
		],
	};
	value.bridge.set(source, 'ash.scm', 2, [changed]);
	value.bridge.set(source, 'ash.scm', 3, [changed]);
	assert.equal(invalidations, 0);
	assert.equal(updates.length, 1);
	assert.equal(headChanges, 1, 'Unchanged HEAD in resource snapshots does not redraw history');
	assert.equal(updates[0]?.[0]?.references?.[0]?.canDelete, false);
	value.bridge.set(source, 'ash.scm', 4, [
		{ ...changed, historyRevision: 2, historyRefsRevision: 2, historyRefsItems: [] },
	]);
	assert.equal(invalidations, 1, 'Commit-set changes take precedence over ref decoration snapshots');
	assert.equal(updates.length, 1);
	assert.throws(
		() => value.bridge.set(source, 'ash.scm', 5, [{ ...changed, historyRefsRevision: -1 }]),
		/history refs revision/,
	);
});

test('SCM bridges advertised reference filters, upstream changes and immutable binary bytes', async () => {
	const ref = { id: 'remoteBranch:origin/main', name: 'origin/main', revision: 'remote', category: 'remoteBranch' };
	const snapshot = {
		...(provider() as Record<string, JsonValue>),
		hasHistory: true,
		hasHistoryItemRefs: true,
		hasHistoryMergeBase: true,
		historyRemoteRef: ref,
		historyBaseRef: { ...ref, id: 'remoteBranch:origin/base', name: 'origin/base' },
	};
	const calls: Array<Record<string, JsonValue>> = [];
	let bytes: JsonValue = [0, 1, 255];
	const value = fixture(
		async request => {
			const payload = request.payload as Record<string, JsonValue>;
			calls.push(payload);
			switch (payload.methodName) {
				case 'provideHistoryItemRefs':
					return [ref];
				case 'resolveHistoryItemRefsCommonAncestor':
					return 'base';
				case 'resolveHistoryItemChangeContents':
					return { original: { kind: 'binary', bytes }, modified: { kind: 'missing' } };
				default:
					return null;
			}
		},
		[snapshot],
	);
	using lifetime = value.lifetime;
	const history = value.scm.getRepository('repo')!.provider.historyProvider!;
	assert.deepEqual(await history.provideHistoryItemRefs!([ref.id]), [
		{ ...ref, description: undefined, upstream: undefined, canDelete: false, color: undefined },
	]);
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
	value.bridge.set(source, 'ash.scm', 3, [
		{ ...snapshot, historyBaseRef: { ...ref, id: 'remoteBranch:origin/release', name: 'origin/release' } },
	]);
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

test('SCM status command availability and placement survive the extension bridge', async () => {
	const calls: JsonValue[] = [];
	const command = {
		id: 'git.blame',
		text: 'Author (1 day ago)',
		ariaLabel: 'Line author',
		tooltip: 'Open commit',
		alignment: 'right',
		priority: 30,
		enabled: false,
	};
	const snapshot = { ...(provider() as Record<string, JsonValue>), statusBarCommands: [command] };
	const value = fixture(
		async request => {
			calls.push(request.payload);
			return null;
		},
		[snapshot],
	);
	using cleanup = value.lifetime;
	const repository = value.scm.getRepository('repo')!;
	const statusCommands = () => repository.provider.statusBarCommands;
	assert.equal(statusCommands()[0]?.run, undefined);
	assert.equal(statusCommands()[0]?.alignment, 'right');
	assert.throws(
		() =>
			value.bridge.set(source, 'ash.scm', 2, [
				{ ...snapshot, statusBarCommands: [{ ...command, alignment: 'center' }] },
			]),
		/Invalid SCM status command alignment/u,
	);
	value.bridge.set(source, 'ash.scm', 2, [{ ...snapshot, statusBarCommands: [{ ...command, enabled: true }] }]);
	await statusCommands()[0]?.run?.();
	assert.ok(
		calls.some(
			call =>
				typeof call === 'object' &&
				call !== null &&
				'method' in call &&
				call.method === 'statusBar' &&
				call.commandId === 'git.blame',
		),
	);
	const { alignment: _alignment, ...defaultCommand } = command;
	value.bridge.set(source, 'ash.scm', 3, [{ ...snapshot, statusBarCommands: [defaultCommand] }]);
	assert.equal(statusCommands()[0]?.alignment, 'left');
});

const settleCallbacks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('SCM decoration bursts leave invocation slots available for refresh and return every result', async () => {
	const pending: DeferredPromise<JsonValue>[] = [];
	let active = 0;
	let maximum = 0;
	let refreshes = 0;
	const value = fixture(async request => {
		const method = (request.payload as { method: string }).method;
		if (method === 'refresh') refreshes++;
		if (method !== 'decoration') return null;
		active++;
		maximum = Math.max(maximum, active);
		const completion = new DeferredPromise<JsonValue>();
		pending.push(completion);
		try {
			return await completion.p;
		} finally {
			active--;
		}
	});
	using cleanup = value.lifetime;
	const decorationProvider = [...value.decorationProviders][0]!;
	const queries = Array.from({ length: 80 }, (_, index) =>
		decorationProvider.provideDecorations(URI.file(`/workspace/file-${index}`), CancellationToken.None),
	);
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
	const admitted = new DeferredPromise<void>();
	const value = fixture(async request => {
		if ((request.payload as { method: string }).method !== 'decoration') return null;
		requests++;
		const completion = new DeferredPromise<JsonValue>();
		pending.push(completion);
		if (requests === 4) admitted.complete();
		return completion.p;
	});
	using cleanup = value.lifetime;
	const decorationProvider = [...value.decorationProviders][0]!;
	const queries = Array.from({ length: 20 }, (_, index) =>
		decorationProvider.provideDecorations(URI.file(`/workspace/file-${index}`), CancellationToken.None),
	);
	const results = Promise.allSettled(queries);
	await admitted.p;
	assert.equal(requests, 4);
	value.bridge.update({ generation: 2, extensions: [] });
	for (const completion of pending) completion.complete(null);
	assert.ok((await results).every(result => result.status === 'rejected'));
	assert.equal(requests, 4);
	assert.notEqual(value.contexts.getValue('scm.providerState.ash.git'), 'ready');
});

test('SCM history reads wait for repository initialization before crossing the extension boundary', async () => {
	const initialized = new DeferredPromise<JsonValue>();
	const calls: string[] = [];
	const value = fixture(
		async request => {
			const method = (request.payload as { method: string }).method;
			calls.push(method);
			return method === 'initialize' ? initialized.p : [];
		},
		[{ ...(provider() as Record<string, JsonValue>), hasHistory: true }],
	);
	using cleanup = value.lifetime;
	const reading = value.scm
		.getRepository('repo')!
		.provider.historyProvider!.provideHistoryItems({ skip: 0, limit: 1 });
	try {
		assert.deepEqual(calls, ['initialize']);
		initialized.complete(null);
		assert.deepEqual(await reading, []);
		assert.deepEqual(calls, ['initialize', 'history']);
	} finally {
		initialized.complete(null);
		await Promise.resolve(reading).catch(() => undefined);
	}
});

test('retiring SCM cancels reads waiting for initialization without admitting another request', async () => {
	const initialized = new DeferredPromise<JsonValue>();
	const calls: string[] = [];
	const value = fixture(
		async request => {
			const method = (request.payload as { method: string }).method;
			calls.push(method);
			return method === 'initialize' ? initialized.p : [];
		},
		[{ ...(provider() as Record<string, JsonValue>), hasHistory: true }],
	);
	using cleanup = value.lifetime;
	const reading = value.scm
		.getRepository('repo')!
		.provider.historyProvider!.provideHistoryItems({ skip: 0, limit: 1 });
	value.bridge.update({ generation: 2, extensions: [] });
	try {
		await assert.rejects(Promise.resolve(reading), /cancel|abort|retired/iu);
	} finally {
		initialized.complete(null);
	}
	assert.deepEqual(calls, ['initialize']);
});

test('SCM retries failed initialization and only reports an empty repository after successful discovery', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let attempts = 0;
		const value = fixture(async request => {
			if ((request.payload as { method: string }).method === 'initialize' && ++attempts < 3)
				throw new Error('Transient admission failure');
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
	} finally {
		mock.timers.reset();
	}
});

test('SCM initialization failure stays distinct from no repository and exposes a working retry command', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let available = false;
		let attempts = 0;
		const value = fixture(async request => {
			if ((request.payload as { method: string }).method === 'initialize') {
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
	} finally {
		mock.timers.reset();
	}
});

test('SCM retiring an initializer cancels delayed retries and cannot overwrite its replacement state', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		let attempts = 0;
		const value = fixture(async () => {
			attempts++;
			throw new Error('Transient failure');
		}, []);
		using cleanup = value.lifetime;
		await settleCallbacks();
		value.bridge.update({ generation: 2, extensions: [] });
		mock.timers.tick(5000);
		await settleCallbacks();
		assert.equal(attempts, 1);
		assert.notEqual(value.contexts.getValue('scm.providerState.ash.git'), 'failed');
	} finally {
		mock.timers.reset();
	}
});

test('SCM reports activation failure before registration and retries through the fleet owner', async () => {
	const modes: string[] = [];
	const ready = fleet([]);
	const value = fixture(
		async () => null,
		[],
		async mode => {
			modes.push(mode);
			return ready;
		},
	);
	using cleanup = value.lifetime;
	await settleCallbacks();
	const runtime = ready.extensions[0]!;
	for (const lifecycle of ['failed', 'crashLoop', 'stopped'] as const) {
		value.bridge.update({ generation: 2, extensions: [{ ...runtime, lifecycle, registrations: [] }] });
		assert.equal(value.contexts.getValue('scm.providerState.ash.git'), 'failed');
		assert.equal([...value.scm.repositories].length, 0);
	}
	await value.commands.getCommand('workbench.scm.action.retryInitialization')!({} as ServicesAccessor);
	assert.deepEqual(modes, ['restartFailed']);
	value.bridge.update({ generation: 3, extensions: [{ ...runtime, lifecycle: 'dormant', registrations: [] }] });
	assert.equal(value.contexts.getValue('scm.providerState.ash.git'), 'initializing');
	value.bridge.update(ready);
	await settleCallbacks();
	assert.equal(value.contexts.getValue('scm.providerState.ash.git'), 'ready');
	value.bridge.clear();
	assert.notEqual(value.contexts.getValue('scm.providerState.ash.git'), 'ready');
});

test('SCM initialization completion preserves another runtime activation failure until it is retired', async () => {
	const initialized = new DeferredPromise<JsonValue>();
	const value = fixture(() => initialized.p, []);
	using cleanup = value.lifetime;
	const ready = fleet([]);
	value.bridge.update({
		generation: 2,
		extensions: [
			...ready.extensions,
			{ ...ready.extensions[0]!, id: 'test.failed', lifecycle: 'failed', registrations: [] },
		],
	});
	await initialized.complete(null);
	await settleCallbacks();
	assert.equal(value.contexts.getValue('scm.providerState.test.failed'), 'failed');
	value.bridge.update(ready);
	assert.notEqual(value.contexts.getValue('scm.providerState.test.failed'), 'failed');
});

test('Git welcome predicates distinguish scanning, failure, disconnected and confirmed empty states in English and Chinese', async () => {
	const root = process.cwd();
	const manifest = JSON.parse(await readFile(`${root}/extensions/git/package.json`, 'utf8'));
	using contexts = new ContextKeyService();
	const folders = contexts.createKey<number>('workspaceFolderCount', 1);
	const connected = contexts.createKey<boolean>('appServerAvailable', true);
	const state = contexts.createKey<string>('scm.providerState.ash.git', 'initializing');
	const visible = () =>
		manifest.contributes.viewsWelcome
			.filter((entry: { when: string }) => ContextKeyExpr.deserialize(entry.when)!.evaluate(contexts))
			.map((entry: { contents: string }) => entry.contents);
	for (const locale of ['package.nls.json', 'package.nls.zh-CN.json']) {
		const messages = JSON.parse(await readFile(`${root}/extensions/git/${locale}`, 'utf8'));
		for (const [status, key] of [
			['initializing', 'initializing'],
			['failed', 'failed'],
			['ready', 'noRepository'],
		]) {
			state.set(status!);
			const content = visible()
				.join('\n')
				.replace(/%([^%]+)%/g, (_: string, key: string) => messages[key]);
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

test('SCM action button retains grouped commands and rejects malformed availability at the extension boundary', async () => {
	const descriptor = {
		command: { id: 'git.commit', title: '$(check) Commit', arguments: ['repo'] },
		enabled: false,
		secondaryCommands: [
			[{ id: 'git.commitAll', title: 'Commit All', arguments: ['repo'] }],
			[{ id: 'git.commitAmend', title: 'Commit (Amend)' }],
		],
	};
	const value = fixture(
		async () => null,
		[{ ...(provider() as Record<string, JsonValue>), actionButton: descriptor }],
	);
	try {
		const button = value.scm.getRepository('repo')!.provider.actionButton!;
		assert.equal(button.enabled, false);
		assert.equal(button.command.title, '$(check) Commit');
		assert.deepEqual(
			button.secondaryCommands?.map(group => group.map(command => [command.id, command.arguments])),
			[[['git.commitAll', ['repo']]], [['git.commitAmend', undefined]]],
		);
		const malformed = {
			...(provider() as Record<string, JsonValue>),
			actionButton: { ...descriptor, enabled: 'yes' },
		};
		assert.throws(
			() => value.bridge.set(source, 'ash.scm', 2, [malformed]),
			/Invalid SCM action button availability/u,
		);
	} finally {
		value.lifetime.dispose();
	}
});
