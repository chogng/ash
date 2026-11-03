import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { MarkHelpfulActionId, registerChatTitleActions } from '../../../browser/actions/chatTitleActions.js';

suite('Chat title commands', () => {
	test('the public helpful command records the captured response once and rejects invalid targets', () => {
		using registration = registerChatTitleActions();
		using services = new InstantiationService();
		const values = new Map<string, boolean>();
		let writes = 0;
		services.registerInstance(IStorageService, {
			getBoolean: (key: string, _scope: unknown, fallback: boolean) => values.get(key) ?? fallback,
			store: (key: string, value: boolean) => { values.set(key, value); writes++; },
		} as unknown as IStorageService);
		const target = { sessionId: 'session', threadId: 'thread', turnId: 'turn', itemId: 'item' };
		const command = CommandsRegistry.getCommand(MarkHelpfulActionId)!;
		assert.equal(services.invokeFunction(command, target), true);
		assert.equal(services.invokeFunction(command, { ...target }), false);
		assert.throws(() => services.invokeFunction(command, { ...target, turnId: '' }), /completed Chat response/);
		assert.equal(writes, 1);
	});

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
