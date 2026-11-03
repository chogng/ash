import { KeybindingResolver } from '../../../../../../platform/keybinding/common/keybindingResolver.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, suiteTeardown, test } from 'mocha';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingsRegistry, KeybindingRuleKind } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IChatWidgetService, type IChatWidget } from '../../../browser/chat.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { ChatRequestQueueKind } from '../../../../../services/chat/common/chatService.js';
import { ChatSubmitAction, CancelAction, OpenModelPickerAction, OpenModePickerAction, OpenPermissionPickerAction, OpenWorkspacePickerAction, registerChatExecuteActions } from '../../../browser/actions/chatExecuteActions.js';

const registration = registerChatExecuteActions();
suiteTeardown(() => registration.dispose());

suite('Chat execution commands', () => {
	test('submit and cancel use one registered visible owner, including an explicit widget context', async () => {
		using services = new InstantiationService();
		const calls: unknown[] = [];
		const first = { visible: true, acceptInput: async (...args: unknown[]) => { calls.push(['first', ...args]); }, cancelTranscriptProgress: () => { calls.push('stop-first'); return true; } } as IChatWidget;
		const second = { visible: true, acceptInput: async (...args: unknown[]) => { calls.push(['second', ...args]); }, cancelTranscriptProgress: () => { calls.push('stop-second'); return true; } } as IChatWidget;
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: second, getAllWidgets: () => [first, second] } as unknown as IChatWidgetService);
		await services.invokeFunction(CommandsRegistry.getCommand(ChatSubmitAction.ID)!);
		await services.invokeFunction(CommandsRegistry.getCommand(ChatSubmitAction.ID)!, { widget: first, inputValue: 'Explicit message', acceptInputOptions: { queue: ChatRequestQueueKind.Queued } });
		await services.invokeFunction(CommandsRegistry.getCommand(ChatSubmitAction.ID)!, { widget: first, acceptInputOptions: { cancelCurrentRequest: true } });
		await services.invokeFunction(CommandsRegistry.getCommand(CancelAction.ID)!, { widget: first });
		assert.deepEqual(calls, [['second', undefined, undefined], ['first', 'Explicit message', { queue: 'queued' }], ['first', undefined, { cancelCurrentRequest: true }], 'stop-first']);
		Object.assign(first, { visible: false });
		await services.invokeFunction(CommandsRegistry.getCommand(ChatSubmitAction.ID)!, { widget: first });
		assert.equal(calls.length, 4);
	});

	test('command input validates external options and cannot dispatch to a fabricated widget', async () => {
		using services = new InstantiationService();
		const widget = { visible: true, acceptInput: async () => { throw new Error('Unexpected send'); } } as unknown as IChatWidget;
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: undefined, getAllWidgets: () => [] } as unknown as IChatWidgetService);
		const submit = CommandsRegistry.getCommand(ChatSubmitAction.ID)!;
		for (const value of [null, 'text', { inputValue: 12 }, { acceptInputOptions: { queue: 'unknown' } }, { acceptInputOptions: { preserveInput: true } }, { acceptInputOptions: { cancelCurrentRequest: 'true' } }, { acceptInputOptions: { cancelCurrentRequest: true, queue: ChatRequestQueueKind.Queued } }, { widget }]) {
			await assert.rejects(async () => { await services.invokeFunction(submit, value); }, /execution context is invalid/);
		}
		await services.invokeFunction(submit);
		await services.invokeFunction(CommandsRegistry.getCommand(CancelAction.ID)!);
	});

	test('the stop shortcut remains available for active work after disabling AI and never fires outside Chat', () => {
		const rule = KeybindingsRegistry.getKeybindings().find(rule => rule.kind === KeybindingRuleKind.Command && rule.command === CancelAction.ID)!;
		using context = new ContextKeyService();
		ChatContextKeys.enabled.bindTo(context).set(false);
		const active = ChatContextKeys.hasActiveRequest.bindTo(context);
		const inChat = ChatContextKeys.inChatSession.bindTo(context);
		active.set(true); inChat.set(true);
		assert.equal(rule.when!.evaluate(context.getContext()), true);
		active.set(false);
		assert.equal(rule.when!.evaluate(context.getContext()), false);
		active.set(true); inChat.set(false);
		assert.equal(rule.when!.evaluate(context.getContext()), false);
	});
	test('picker commands use the focused input owner and leave hidden composers alone', async () => {
		using services = new InstantiationService();
		const calls: string[] = [];
		const widget = {
			visible: true, input: {
				openModelPicker: () => calls.push('model'), openModePicker: () => calls.push('mode'), openPermissionPicker: () => calls.push('permission'),
				openWorkspacePicker: () => calls.push('workspace'),
			}
		} as unknown as IChatWidget;
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as unknown as IChatWidgetService);
		const ids = [OpenModelPickerAction.ID, OpenModePickerAction.ID, OpenPermissionPickerAction.ID, OpenWorkspacePickerAction.ID];
		for (const id of ids) await services.invokeFunction(CommandsRegistry.getCommand(id)!);
		assert.deepEqual(calls, ['model', 'mode', 'permission', 'workspace']);
		Object.assign(widget, { visible: false });
		for (const id of ids) await services.invokeFunction(CommandsRegistry.getCommand(id)!);
		assert.equal(calls.length, 4);
	});

	test('picker shortcuts apply only inside the Chat input', () => {
		using context = new ContextKeyService();
		ChatContextKeys.enabled.bindTo(context).set(true);
		const inInput = ChatContextKeys.inChatInput.bindTo(context);
		for (const id of [OpenModelPickerAction.ID, OpenModePickerAction.ID]) {
			const rule = KeybindingsRegistry.getKeybindings().find(rule => rule.kind === KeybindingRuleKind.Command && rule.command === id)!;
			inInput.set(true); assert.equal(rule.when!.evaluate(context.getContext()), true);
			const result = new KeybindingResolver().resolve(context.getContext(), [{ key: '.', code: 'Period', ctrlKey: !isMacintosh, metaKey: isMacintosh, altKey: id === OpenModelPickerAction.ID, shiftKey: false }]);
			assert.equal('command' in result ? result.command : undefined, id);
			if (id === OpenModelPickerAction.ID) {
				const optionPeriod = new KeybindingResolver().resolve(context.getContext(), [{ key: '≥', code: 'Period', ctrlKey: !isMacintosh, metaKey: isMacintosh, altKey: true, shiftKey: false }]);
				assert.equal('command' in optionPeriod ? optionPeriod.command : undefined, id);
			}
			inInput.set(false); assert.equal(rule.when!.evaluate(context.getContext()), false);
		}
	});

});
