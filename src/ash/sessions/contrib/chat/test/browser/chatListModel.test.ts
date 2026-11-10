import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { constObservable, derived, observableValue } from '../../../../../base/common/observable.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget, type IStorageValueChangeEvent } from '../../../../../platform/storage/common/storage.js';
import { ISessionsListModelService, SessionsListModelService } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { ChatListCatalog, groupChatList, type ChatListEntry, type ChatListForkEvidence, type ChatListForkReference, type ChatListSnapshot, type ChatListSource } from '../../browser/chatListModel.js';
import { ChatListForks } from '../../browser/chatListForks.js';

function forkRecoveryRow(id: string, title: string, loadForkEvidence: NonNullable<ChatListEntry['loadForkEvidence']>): ChatListEntry {
	return { id, title, preferenceKey: id, defaultIcon: Lxicon.chatSession, selected: false, open: async () => { }, loadForkEvidence };
}

function forkRecoveryStorage() {
	const values = new Map<string, string>();
	const storage = {
		onDidChangeValue: Event.None,
		get: (key: string) => values.get(key),
		store: (key: string, value: string) => values.set(key, value),
	} as unknown as IStorageService;
	return { storage, values };
}

async function advanceRecoveryClock(milliseconds: number): Promise<void> {
	mock.timers.tick(milliseconds);
	await new Promise<void>(resolve => setImmediate(resolve));
}

suite('Ash chat list model', () => {
	test('owns catalog icon storage and moves an icon when a source replaces an identity', () => {
		using retired = new Emitter<{ key: string; replacementKey?: string; }>();
		class Source implements ChatListSource {
			readonly snapshot = constObservable({ entries: [] });
			readonly onDidRetirePreferenceIdentity = retired.event;
		}
		const values = new Map([['sessions.chatgpt.icon:opaque-original', 'folder']]);
		const storage = {
			get: (key: string) => values.get(key),
			store: (key: string, value: string | undefined) => value === undefined ? values.delete(key) : values.set(key, value),
			onDidChangeValue: Event.None,
		} as unknown as IStorageService;
		const list = new SessionsListModelService(storage);
		using services = new InstantiationService();
		services.registerInstance(ISessionsListModelService, list);
		services.registerInstance(IStorageService, storage);
		using catalog = services.createInstance(ChatListCatalog, [new SyncDescriptor(Source)]);

		assert.equal(list.getRowIcon('opaque-original', 'catalog'), 'folder');
		retired.fire({ key: 'opaque-original', replacementKey: 'opaque-replacement' });
		assert.equal(list.getRowIcon('opaque-original', 'catalog'), undefined);
		assert.equal(list.getRowIcon('opaque-replacement', 'catalog'), 'folder');
		list.setRowIcon('opaque-next', 'chat', 'catalog');
		retired.fire({ key: 'opaque-replacement', replacementKey: 'opaque-next' });
		assert.equal(list.getRowIcon('opaque-next', 'catalog'), 'chat');
	});

	test('groups records by membership and pin state regardless of which catalog supplied them', () => {
		const row = (id: string, projectId?: string, pinned = false): ChatListEntry => ({
			id, title: id, projectId, pinned, selected: false, defaultIcon: Lxicon.chat,
			open: async () => { }, getActions: () => [],
		});
		const history = { state: 'idle', load: () => { } } as const;
		const snapshots = [
			{
				entries: [row('opaque-a', 'research'), row('opaque-b', 'research', true), row('opaque-c', 'unknown')],
			},
			{
				projects: [
					{ id: 'research', title: 'Field notes', history },
					{ id: 'empty', title: 'New project', history },
				],
				entries: [row('opaque-d', 'research'), row('opaque-e', undefined, true), row('opaque-f')],
			},
		];
		const groups = groupChatList(snapshots);
		assert.deepEqual(groups.map(group => [group.key, group.rows.map(row => row.id)]), [
			['pinned', ['opaque-b', 'opaque-e']],
			['recent', ['opaque-f']],
		]);
		const projects = groupChatList(snapshots, 'projects');
		assert.equal(projects[0]?.title, 'Field notes');
		assert.equal(projects[1]?.project?.history, history);
		assert.deepEqual(projects.map(group => [group.key, group.rows.map(row => row.id)]), [
			['research', ['opaque-a', 'opaque-b', 'opaque-d']],
			['empty', []],
			['other', ['opaque-c']],
		]);
	});

	test('owns confirmed and recovered fork sources in the Ash catalog', async () => {
		using changes = new Emitter<IStorageValueChangeEvent>();
		using created = new Emitter<{ key: string; parent: ChatListForkReference; }>();
		const values = new Map<string, string>();
		const storage = {
			onDidChangeValue: changes.event,
			get: (key: string) => values.get(key),
			store: (key: string, value: string) => {
				values.set(key, value);
				changes.fire({ key, scope: StorageScope.PROFILE, target: StorageTarget.MACHINE, external: false });
			},
		} as unknown as IStorageService;
		const opened: string[] = [];
		const row = (id: string, title: string, createdAt: number, hasMarker: boolean, messages: readonly [string, number][]): ChatListEntry => ({
			id, title, preferenceKey: `scope:${id}`, defaultIcon: Lxicon.chatSession, selected: false,
			open: async () => { opened.push(id); },
			loadForkEvidence: async () => ({ createdAt, hasMarker, messages: new Map(messages) }),
		});
		const entries = [
			row('root', 'Root', 1, false, [['shared-root', 2]]),
			row('fork', 'Branch · Root', 3, true, [['shared-root', 2], ['shared-fork', 4]]),
			row('nested', 'Branch · Branch · Root', 5, true, [['shared-root', 2], ['shared-fork', 4]]),
			row('lookalike', 'Note · Root', 6, false, [['shared-root', 2]]),
			row('new', 'Renamed fork', 7, false, []),
		];
		const source = { snapshot: constObservable({ entries }), onDidCreateFork: created.event };
		using forks = new ChatListForks([source], storage);
		const projected = derived(reader => forks.project(entries, reader));
		const recovered = new DeferredPromise<void>();
		using subscription = projected.onDidChange(rows => {
			if (rows[2]?.forkSource) void recovered.complete();
		});
		created.fire({ key: 'scope:new', parent: { id: 'fork', preferenceKey: 'scope:fork' } });
		await recovered.p;
		assert.deepEqual(projected.get().map(row => row.forkSource?.id), [undefined, 'root', 'fork', undefined, 'fork']);
		await projected.get()[2]!.forkSource!.open!(new AbortController().signal);
		assert.deepEqual(opened, ['fork']);
		using restored = new ChatListForks([], storage);
		assert.equal(derived(reader => restored.project(entries, reader)).get()[2]?.forkSource?.title, 'Branch · Root');
	});

	test('continues recovery in batches and retries a failed pair on a stable catalog', async () => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
		try {
			const { storage } = forkRecoveryStorage();
			const attempts: string[] = [];
			const parent = forkRecoveryRow('root', 'Root', async () => ({ hasMarker: false, messages: new Map() }));
			const children = Array.from({ length: 6 }, (_, index) => {
				const id = `fork-${index}`;
				return forkRecoveryRow(id, `Branch ${index} · Root`, async () => {
					attempts.push(id);
					if (attempts.length === 1) throw new Error('History temporarily unavailable');
					return { source: { id: parent.id, preferenceKey: parent.preferenceKey }, hasMarker: true, messages: new Map() };
				});
			});
			const entries = [parent, ...children];
			using forks = new ChatListForks([{ snapshot: constObservable({ entries }) }], storage);

			await advanceRecoveryClock(0);
			assert.deepEqual(attempts, children.slice(0, 4).map(child => child.id));
			await advanceRecoveryClock(1);
			assert.deepEqual(attempts, children.map(child => child.id));
			await advanceRecoveryClock(59_998);
			assert.deepEqual(attempts, children.map(child => child.id));
			await advanceRecoveryClock(1);
			assert.deepEqual(attempts, [...children.map(child => child.id), 'fork-0']);
			const projected = derived(reader => forks.project(children, reader)).get();
			assert.deepEqual(projected.map(row => row.forkSource?.id), children.map(() => parent.id));
		} finally {
			mock.timers.reset();
		}
	});

	test('cancels queued recovery when the catalog becomes unavailable and aborts active recovery on disposal', async () => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
		try {
			const { storage, values } = forkRecoveryStorage();
			const pending = new DeferredPromise<ChatListForkEvidence>();
			const signals: AbortSignal[] = [];
			const parent = forkRecoveryRow('root', 'Root', async () => ({ hasMarker: false, messages: new Map() }));
			const child = forkRecoveryRow('fork', 'Branch · Root', async signal => {
				signals.push(signal);
				if (signals.length === 1) throw new Error('History temporarily unavailable');
				return pending.p;
			});
			const entries = [parent, child];
			const snapshot = observableValue<ChatListSnapshot>('catalog', { entries });
			using forks = new ChatListForks([{ snapshot }], storage);

			await advanceRecoveryClock(0);
			assert.equal(signals.length, 1);
			snapshot.set({ entries: [] }, undefined);
			await advanceRecoveryClock(60_000);
			assert.equal(signals.length, 1);

			snapshot.set({ entries }, undefined);
			await advanceRecoveryClock(0);
			assert.equal(signals.length, 2);
			snapshot.set({ entries: [] }, undefined);
			assert.equal(signals[1]?.aborted, true);
			snapshot.set({ entries }, undefined);
			await advanceRecoveryClock(0);
			await advanceRecoveryClock(0);
			assert.equal(signals.length, 3);
			forks.dispose();
			assert.equal(signals[2]?.aborted, true);
			await pending.complete({ source: { id: parent.id }, hasMarker: true, messages: new Map() });
			await advanceRecoveryClock(60_000);
			assert.equal(signals.length, 3);
			assert.equal(values.size, 0);
		} finally {
			mock.timers.reset();
		}
	});
});
