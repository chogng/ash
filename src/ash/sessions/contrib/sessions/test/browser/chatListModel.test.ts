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
		const groups = groupChatList([
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
		]);
		assert.deepEqual(groups.map(group => [group.key, group.rows.map(row => row.id)]), [
			['pinned', ['opaque-b', 'opaque-e']],
			['research', ['opaque-a', 'opaque-d']],
			['empty', []],
			['other', ['opaque-c']],
			['recent', ['opaque-f']],
		]);
		assert.equal(groups[1]?.title, 'Field notes');
		assert.equal(groups[2]?.project?.history, history);
	});
});
