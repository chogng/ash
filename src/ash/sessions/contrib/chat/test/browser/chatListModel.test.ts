import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { type IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ISessionsListModelService, SessionsListModelService } from '../../../../services/sessions/browser/sessionsListModelService.js';
import { ChatListCatalog, groupChatList, type ChatListEntry, type ChatListSource } from '../../browser/chatListModel.js';

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
});
