import assert from 'node:assert/strict';
import { suiteTeardown, test } from 'mocha';
import { Event } from '../../../../../../base/common/event.js';
import { Selection } from '../../../../../../editor/common/core/selection.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';
import { IQuickChatService, type IQuickChatOpenOptions } from '../../../browser/chat.js';
import { ASK_QUICK_QUESTION_ACTION_ID, registerQuickChatActions } from '../../../browser/actions/chatQuickInputActions.js';

registerQuickChatActions();
suiteTeardown(() => initializeTestLocalization('en'));

test('Quick Chat commands preserve partial queries, multiline selections and explicit open semantics', async () => {
	using services = new InstantiationService();
	const calls: { readonly operation: string; readonly options?: IQuickChatOpenOptions; }[] = [];
	services.registerInstance(IQuickChatService, {
		enabled: true, focused: false, sessionResource: undefined, onDidClose: Event.None,
		open: options => calls.push({ operation: 'open', options }),
		toggle: options => calls.push({ operation: 'toggle', options }),
		close: () => calls.push({ operation: 'close' }),
		focus: () => calls.push({ operation: 'focus' }),
		openInChatView: async () => { calls.push({ operation: 'reveal' }); },
	});
	await CommandsRegistry.getCommand(ASK_QUICK_QUESTION_ACTION_ID)!(services, { query: 'first\nsecond', isPartialQuery: true });
	await CommandsRegistry.getCommand('workbench.action.openQuickChat')!(services, 'Ask this');
	await CommandsRegistry.getCommand('workbench.action.quickchat.close')!(services);
	await CommandsRegistry.getCommand('workbench.action.quickchat.openInChatView')!(services);
	assert.deepEqual(calls, [
		{ operation: 'toggle', options: { query: 'first\nsecond', isPartialQuery: true, selection: new Selection(2, 7, 2, 7) } },
		{ operation: 'open', options: { query: 'Ask this', selection: new Selection(1, 9, 1, 9) } },
		{ operation: 'close' },
		{ operation: 'reveal' },
	]);
});

test('Quick Chat validates command arguments and localizes its rejection in Chinese', async () => {
	initializeTestLocalization('zh-CN');
	try {
		using services = new InstantiationService();
		for (const value of [42, null, {}, { query: 'question', isPartialQuery: 'yes' }]) {
			await assert.rejects(async () => CommandsRegistry.getCommand(ASK_QUICK_QUESTION_ACTION_ID)!(services, value), /快捷聊天参数/);
		}
	} finally {
		initializeTestLocalization('en');
	}
});
