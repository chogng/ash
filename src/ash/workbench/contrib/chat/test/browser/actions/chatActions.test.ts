import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatActions } from '../../../browser/actions/chatActions.js';
import { CHAT_VIEW_ID } from '../../../common/chat.js';
import { KeybindingsRegistry, KeybindingRuleKind } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../../base/common/keybindings.js';
import { operatingSystem, isMacintosh } from '../../../../../../base/common/platform.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';

registerChatActions();

suite('Focus Chat Input', () => {
	test('focuses the most recently focused composer without opening another view or changing its draft', async () => {
		const dom = new JSDOM('<!doctype html><body><input id="first"><input id="last"></body>');
		try {
			using services = new InstantiationService();
			const first = dom.window.document.querySelector<HTMLInputElement>('#first')!;
			const last = dom.window.document.querySelector<HTMLInputElement>('#last')!;
			first.value = 'Keep first draft';
			last.value = 'Keep last draft';
			services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
			services.registerInstance(IChatWidgetService, { lastFocusedWidget: { focusInput: () => last.focus() } } as IChatWidgetService);
			first.focus();
			await services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.focusInput')!);
			assert.equal(dom.window.document.activeElement, last);
			assert.deepEqual([first.value, last.value], ['Keep first draft', 'Keep last draft']);
		} finally {
			dom.window.close();
		}
	});

	test('opens the existing Chat view only when no visible composer is available and respects disabled AI', async () => {
		using services = new InstantiationService();
		let disabled = false;
		const calls: string[] = [];
		services.registerInstance(IConfigurationService, { getValue: () => disabled } as unknown as IConfigurationService);
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: undefined } as IChatWidgetService);
		services.registerInstance(IViewsService, {
			openView: async (id: string) => {
				calls.push(id);
				return { focusInput: () => calls.push('focus') };
			}
		} as unknown as IViewsService);
		const command = CommandsRegistry.getCommand('workbench.action.chat.focusInput')!;
		await services.invokeFunction(command);
		disabled = true;
		await services.invokeFunction(command);
		assert.deepEqual(calls, [CHAT_VIEW_ID, 'focus']);
	});

	test('return-to-input shortcuts are scoped to conversations and leave input editing shortcuts available', () => {
		const rules = KeybindingsRegistry.getKeybindings().filter(rule => rule.kind === KeybindingRuleKind.Command && rule.command === 'workbench.action.chat.focusInput');
		assert.equal(rules.length, 2);
		for (const quickChat of [undefined, false, true]) {
			for (const inChat of [false, true]) {
				for (const inInput of [undefined, false, true]) {
					const values = new Map<string, boolean | undefined>([
						[ChatContextKeys.enabled.key, true],
						[ChatContextKeys.inChatSession.key, inChat],
						[ChatContextKeys.inChatInput.key, inInput],
						[ChatContextKeys.inQuickChat.key, quickChat],
					]);
					using context = new ContextKeyService();
					for (const [key, value] of values) { if (value !== undefined) { context.createKey<boolean>(key, false).set(value); } }
					const matching = rules.filter(rule => rule.when?.evaluate(context.getContext()));
					assert.equal(matching.length, inChat && !inInput ? 1 : 0);
					if (matching.length) {
						const expected = KeyMod.CtrlCmd | (quickChat ? KeyCode.UpArrow : KeyCode.DownArrow);
						assert.deepEqual(matching[0]!.keybinding, decodeKeybinding(expected, operatingSystem));
					}
				}
			}
		}
	});
});


suite('Focus Chat List', () => {
	test('the latest and remembered commands dispatch to the registered transcript owner', async () => {
		using services = new InstantiationService();
		const calls: boolean[] = [];
		services.registerInstance(IChatWidgetService, { lastFocusedWidget: { focusResponseItem: (last: boolean) => calls.push(last) } } as unknown as IChatWidgetService);
		for (const id of ['chat.action.focus', 'workbench.chat.action.focusLastFocused']) {
			await services.invokeFunction(CommandsRegistry.getCommand(id)!);
		}
		assert.deepEqual(calls, [false, true]);
	});

	test('list shortcuts stay scoped to the composer and preserve macOS multiline movement', () => {
		const rules = KeybindingsRegistry.getKeybindings().filter(rule => rule.kind === KeybindingRuleKind.Command && rule.command === 'chat.action.focus');
		using context = new ContextKeyService();
		ChatContextKeys.enabled.bindTo(context).set(true);
		ChatContextKeys.inChatSession.bindTo(context).set(true);
		const input = ChatContextKeys.inChatInput.bindTo(context);
		const quick = ChatContextKeys.inQuickChat.bindTo(context);
		const top = ChatContextKeys.inputCursorAtTop.bindTo(context);
		input.set(true); quick.set(false); top.set(false);
		assert.equal(rules.filter(rule => rule.when?.evaluate(context.getContext())).length, isMacintosh ? 0 : 1);
		top.set(true);
		assert.equal(rules.filter(rule => rule.when?.evaluate(context.getContext())).length, 1);
		quick.set(true); top.set(false);
		const matching = rules.filter(rule => rule.when?.evaluate(context.getContext()));
		assert.equal(matching.length, 1);
		assert.deepEqual(matching[0].keybinding, decodeKeybinding(KeyMod.CtrlCmd | KeyCode.DownArrow, operatingSystem));
		input.set(false);
		assert.equal(rules.filter(rule => rule.when?.evaluate(context.getContext())).length, 0);
	});
});
