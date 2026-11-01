import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatTitleActions } from '../../../browser/actions/chatTitleActions.js';

suite('Chat title commands', () => {
	test('retry uses the focused visible model and propagates a failed retry', async () => {
		using registration = registerChatTitleActions(); using services = new InstantiationService();
		let calls = 0;
		const widget = { visible: true, retryFailedTurn: async () => { calls++; throw new Error('Retry failed'); } };
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as unknown as IChatWidgetService);
		const run = async (): Promise<void> => { await services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.retry')!); };
		await assert.rejects(run(), /Retry failed/); assert.equal(calls, 1);
		widget.visible = false; await run(); assert.equal(calls, 1);
	});
});
