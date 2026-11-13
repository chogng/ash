import { registerEditorToolAction } from '../../../../browser/actions/editorToolActions.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { WorkbenchEditorToolsAvailable } from '../../../../common/contextkeys.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IView } from '../../../../common/views.js';
import type { IChatContextTarget } from '../../../../services/chat/common/chatContextService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../../chat/common/chat.js';
import { captureTerminalAttachment } from '../../../terminal/browser/chatTerminalCommandMirror.js';
import { ITerminalService, type ITerminalView } from '../../../terminal/browser/terminal.js';
import { TERMINAL_VIEW_ID } from '../../../terminal/common/terminal.js';
import { TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';
import { TerminalChatCommandId } from '../../../terminal/terminalContribChatExports.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { isObject } from '../../../../../base/common/types.js';

CommandsRegistry.register(TerminalChatCommandId.RevealAgentCommand, (accessor, target, takeInput) => {
	if (!isObject(target) || !('sessionId' in target) || typeof target.sessionId !== 'string'
		|| !('threadId' in target) || typeof target.threadId !== 'string'
		|| !('toolCallId' in target) || typeof target.toolCallId !== 'string'
		|| !('commandSessionId' in target) || typeof target.commandSessionId !== 'string'
		|| typeof takeInput !== 'boolean') throw new TypeError('Invalid Agent command terminal target');
	const terminals = accessor.get(ITerminalService);
	if (!terminals.revealAgentCommand) throw new Error('Agent command terminals are unavailable');
	return terminals.revealAgentCommand({ sessionId: target.sessionId, threadId: target.threadId, toolCallId: target.toolCallId, commandSessionId: target.commandSessionId }, takeInput);
});

/** The session's existing composer owns the draft, attachments and later submission. */
registerEditorToolAction(class TerminalChatStartAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.terminal.chat.start', title: localize2('terminal.chat.start', 'Terminal: Ask Chat'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const contextKeys = accessor.get(IContextKeyService);
		const terminals = accessor.get(ITerminalService);
		const views = accessor.get(IViewsService);
		const navigation = accessor.get(IChatSessionNavigationService);
		const input = accessor.get(IQuickInputService);
		const instance = terminals.activeInstance;
		if (!instance || !terminals.instances.includes(instance)) return;
		using lifetime = new DisposableStore();
		const token = lifetime.add(new CancellationTokenSource());
		const controller = new AbortController();
		const retire = (): void => { token.cancel(); controller.abort(); };
		lifetime.add(terminals.onDidChangeActiveInstance(retire));
		lifetime.add(terminals.onDidDisposeInstance(closed => { if (closed === instance) retire(); }));
		lifetime.add(instance.onDidChangeState(retire));
		const current = (): boolean => contextKeys.contextMatchesRules(WorkbenchEditorToolsAvailable) && !controller.signal.aborted && terminals.activeInstance === instance && terminals.instances.includes(instance);
		try {
			// Freeze context before awaiting either user input or opening the Chat view.
			const attachment = await captureTerminalAttachment(instance, views.getViewWithId<ITerminalView>(TERMINAL_VIEW_ID), controller.signal);
			if (!attachment || !current()) return;
			// Opening Chat may create its first untitled conversation. Capture the
			// visible draft's revision only after the original owner has initialized it.
			const chat = await views.openView<IView & IChatContextTarget>(CHAT_VIEW_ID, true);
			if (!chat || !current()) return;
			const revision = navigation.revision;
			const question = await input.input({ title: localize('terminal.chat.question', 'Ask about this terminal'), placeHolder: localize('terminal.chat.placeholder', 'Describe the command or output you want help with') }, token.token);
			if (!question?.trim() || !current() || navigation.revision !== revision) return;
			chat.addContext(attachment);
			chat.appendToDraft(question.trim());
		} finally {
			retire();
		}
	}
});
