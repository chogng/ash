import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import type { IChatListItem } from '../../../browser/widget/chatListItems.js';
import { registerChatPromptNavigationActions } from '../../../browser/actions/chatPromptNavigationActions.js';

registerChatPromptNavigationActions();

suite('Chat prompt navigation commands', () => {
	function setup() {
		const items: IChatListItem[] = [
			{ id: 'a', type: 'userMessage', text: 'first', transient: false },
			{ id: 'reply-a', type: 'agentMessage', text: 'answer', transient: false },
			{ id: 'tool', type: 'toolCall', text: 'evidence', transient: false },
			{ id: 'b', type: 'userMessage', text: 'second', transient: false },
			{ id: 'reply-b', type: 'agentMessage', text: 'answer', transient: false },
		];
		let focused: IChatListItem | undefined;
		const calls: string[] = [];
		const widget = {
			visible: true,
			getFocus: () => focused,
			getSibling: (item, direction) => {
				if (!item) { return direction === 'next' ? items[0] : items.at(-1); }
				return items[items.indexOf(item) + (direction === 'next' ? 1 : -1)];
			},
			focus: item => { focused = item; calls.push(`focus:${item.id}`); },
			reveal: item => { calls.push(`reveal:${item.id}`); },
		} as IChatWidget;
		const services = new InstantiationService();
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as IChatWidgetService);
		const run = async (direction: 'next' | 'previous'): Promise<void> => {
			await services.invokeFunction(CommandsRegistry.getCommand(`workbench.action.chat.${direction}UserPrompt`)!);
		};
		return { services, items, widget, calls, run, setFocus: (id?: string) => { focused = items.find(item => item.id === id); } };
	}

	test('starts at the appropriate boundary, skips non-request rows and clamps without refocusing', async () => {
		const f = setup();
		using services = f.services;
		await f.run('next');
		await f.run('previous');
		await f.run('next');
		await f.run('next');
		await f.run('previous');
		assert.deepEqual(f.calls, ['focus:a', 'reveal:a', 'focus:b', 'reveal:b', 'focus:a', 'reveal:a']);
		f.calls.length = 0;
		f.setFocus();
		await f.run('previous');
		assert.deepEqual(f.calls, ['focus:b', 'reveal:b']);
	});

	test('responses and evidence anchor to their preceding request', async () => {
		const f = setup();
		using services = f.services;
		f.setFocus('tool');
		await f.run('next');
		f.setFocus('reply-b');
		await f.run('previous');
		assert.deepEqual(f.calls, ['focus:b', 'reveal:b', 'focus:a', 'reveal:a']);
	});

	test('hidden and empty widgets cannot move focus', async () => {
		const f = setup();
		using services = f.services;
		Object.assign(f.widget, { visible: false });
		await f.run('next');
		Object.assign(f.widget, { visible: true });
		f.items.length = 0;
		await f.run('previous');
		assert.deepEqual(f.calls, []);
	});
});
