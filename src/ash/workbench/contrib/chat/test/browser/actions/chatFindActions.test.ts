import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingsRegistry, KeybindingRuleKind } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IChatWidgetService, type IChatWidget, type IChatFindController } from '../../../browser/chat.js';
import { registerChatFindActions, resolveFocusedChatWidget } from '../../../browser/actions/chatFindActions.js';
import { ChatFindCommandId } from '../../../browser/widget/chatFind/chatFindCommandIds.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';

registerChatFindActions();

suite('Chat Find commands', () => {
	test('the focused visible conversation takes precedence over the remembered widget', () => {
		const first = { visible: true, domNode: {} } as IChatWidget;
		const second = { visible: true, domNode: {} } as IChatWidget;
		assert.equal(resolveFocusedChatWidget([first, second], first, root => root === second.domNode), second);
		assert.equal(resolveFocusedChatWidget([first, second], first, () => false), first);
		assert.equal(resolveFocusedChatWidget([{ ...first, visible: false }], undefined, () => true), undefined);
	});

	test('Find seeds only a selection belonging to its conversation and dispatches navigation to the same owner', async () => {
		const dom = new JSDOM('<main><p>selected text</p></main><input>');
		try {
			using services = new InstantiationService();
			const operations: unknown[] = [];
			const controller: IChatFindController = {
				visible: true, show: seed => operations.push(['show', seed]), hide: () => operations.push('hide'),
				next: () => operations.push('next'), previous: () => operations.push('previous'),
				toggleCaseSensitive: () => operations.push('case'), toggleWholeWord: () => operations.push('word'), toggleRegex: () => operations.push('regex'), focus: () => { },
			};
			const root = dom.window.document.querySelector('main')!;
			const widget = { visible: true, domNode: root, getFindController: () => controller } as IChatWidget;
			services.registerInstance(IChatWidgetService, { getAllWidgets: () => [widget], lastFocusedWidget: widget } as unknown as IChatWidgetService);
			services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => null } as unknown as ICodeEditorService);
			const selection = dom.window.getSelection()!;
			const range = dom.window.document.createRange();
			range.selectNodeContents(root.querySelector('p')!); selection.addRange(range);
			for (const id of [ChatFindCommandId.Find, ChatFindCommandId.FindNext, ChatFindCommandId.FindPrevious, ChatFindCommandId.ToggleFindCaseSensitive, ChatFindCommandId.ToggleFindWholeWord, ChatFindCommandId.ToggleFindRegex, ChatFindCommandId.FindHide]) {
				await services.invokeFunction(CommandsRegistry.getCommand(id)!);
			}
			assert.deepEqual(operations, [['show', 'selected text'], 'next', 'previous', 'case', 'word', 'regex', 'hide']);
		} finally { dom.window.close(); }
	});

	test('the Chat shortcut is gated by AI availability and Chat ownership, leaving file-editor Find available', () => {
		const rules = KeybindingsRegistry.getKeybindings().filter(rule => rule.kind === KeybindingRuleKind.Command && rule.command === ChatFindCommandId.Find);
		assert.equal(rules.length, 1);
		using context = new ContextKeyService();
		const enabled = ChatContextKeys.enabled.bindTo(context);
		const supported = ChatContextKeys.findSupported.bindTo(context);
		const inChat = ChatContextKeys.inChatSession.bindTo(context);
		for (const [ai, chat, expected] of [[true, true, true], [true, false, false], [false, true, false]] as const) {
			enabled.set(ai); supported.set(chat); inChat.set(chat);
			assert.equal(rules[0]!.when!.evaluate(context.getContext()), expected);
		}
	});
});
