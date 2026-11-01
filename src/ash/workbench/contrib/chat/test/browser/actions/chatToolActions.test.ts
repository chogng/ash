import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import { AcceptToolConfirmationActionId, registerChatToolActions, SkipToolConfirmationActionId } from '../../../browser/actions/chatToolActions.js';

suite('Chat tool commands', () => {
	for (const [id, operation] of [[AcceptToolConfirmationActionId, 'accept'], [SkipToolConfirmationActionId, 'skip']]) {
		test(id + ' dispatches through the current input owner', async () => {
			using registration = registerChatToolActions(); using services = new InstantiationService();
			const calls: string[] = [];
			const widget = {
				visible: true, sessionId: 'session', threadId: 'thread', onDidHide: Event.None, onDidChangeViewModel: Event.None,
				input: { acceptActiveToolConfirmation: async () => { calls.push('accept'); }, skipActiveToolConfirmation: async () => { calls.push('skip'); } },
				focusInput: () => calls.push('focus')
			} as unknown as IChatWidget;
			services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget, getAllWidgets: () => [widget] } as unknown as IChatWidgetService);
			await services.invokeFunction(CommandsRegistry.getCommand(id)!);
			assert.deepEqual(calls, [operation, 'focus']);
			Object.assign(widget, { visible: false }); await services.invokeFunction(CommandsRegistry.getCommand(id)!);
			assert.equal(calls.length, 2);
		});
	}

	test('completion never refocuses a composer that changed during confirmation', async () => {
		using resources = new DisposableStore(); resources.add(registerChatToolActions());
		const services = resources.add(new InstantiationService()); const changed = resources.add(new Emitter<void>());
		const pending = new DeferredPromise<void>(); let focused = false;
		const widget = {
			visible: true, sessionId: 'session', threadId: 'thread', onDidHide: Event.None, onDidChangeViewModel: changed.event,
			input: { acceptActiveToolConfirmation: () => pending.p }, focusInput: () => { focused = true; }
		} as unknown as IChatWidget;
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget, getAllWidgets: () => [widget] } as unknown as IChatWidgetService);
		const action = services.invokeFunction(CommandsRegistry.getCommand(AcceptToolConfirmationActionId)!);
		changed.fire(); await pending.complete(); await action;
		assert.equal(focused, false);
	});
});
