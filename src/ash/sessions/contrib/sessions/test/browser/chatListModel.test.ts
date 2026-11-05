import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { groupChatList, type ChatListEntry } from '../../browser/views/chatListModel.js';

suite('Ash chat list model', () => {
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
