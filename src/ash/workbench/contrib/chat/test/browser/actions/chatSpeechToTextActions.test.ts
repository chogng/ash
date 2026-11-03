import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatSpeechToTextActions, ToggleChatSpeechToTextAction } from '../../../browser/actions/chatSpeechToTextActions.js';

const commands = [
	'workbench.action.chat.showSpeechToTextIntroduction',
	'workbench.action.chat.resetSpeechToTextIntroduction',
	'workbench.action.chat.cancelSpeechToText',
	'workbench.action.chat.toggleSpeechToText',
	'workbench.action.chat.holdToSpeechToText',
	'workbench.action.chat.selectSpeechToTextMicrophone',
];

suite('Chat speech action registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('imports are inert; explicit registration exposes commands and releases them together', async () => {
		for (const id of commands) assert.equal(CommandsRegistry.getCommand(id), undefined);
		using services = new InstantiationService();
		services.registerInstance(IChatWidgetService, {
			lastFocusedWidget: undefined, getAllWidgets: () => [],
		} as unknown as IChatWidgetService);
		const registration = registerChatSpeechToTextActions();
		try {
			for (const id of commands) assert.ok(CommandsRegistry.getCommand(id), id);
			await services.invokeFunction(CommandsRegistry.getCommand(ToggleChatSpeechToTextAction.ID)!);
		} finally {
			registration.dispose();
		}
		for (const id of commands) assert.equal(CommandsRegistry.getCommand(id), undefined);
		using restored = registerChatSpeechToTextActions();
		await services.invokeFunction(CommandsRegistry.getCommand(ToggleChatSpeechToTextAction.ID)!);
	});

	test('a conflicting command rolls back only this registration attempt', () => {
		const held = 'workbench.action.chat.holdToSpeechToText';
		using existing = CommandsRegistry.register(held, () => undefined);
		const handler = CommandsRegistry.getCommand(held);
		assert.throws(() => registerChatSpeechToTextActions(), /already registered/);
		assert.equal(CommandsRegistry.getCommand(held), handler);
		for (const id of commands.filter(id => id !== held)) assert.equal(CommandsRegistry.getCommand(id), undefined);
	});
});
