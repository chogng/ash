import { getWindowId } from '../../../../base/browser/window.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ContextKeyExpr, type ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getWindowCommandTarget } from '../../../browser/actions/windowActions.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { isWindowCommandContext } from '../../../common/windowCommandContext.js';
import { ITerminalEditorService, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../terminal/browser/terminalEditorInput.js';
import { chatWindowEdges, ChatWindowLayoutMode, ChatWindowTerminalPosition, type ChatWindowEdge } from '../common/chatWindowLayout.js';
import { IChatWindowService, type IChatWindow } from './chatWindow.js';
import { CanToggleChatWindowConversationContext, InChatWindowContext } from './chatWindowContextKeys.js';

export const terminalPositions = [ChatWindowTerminalPosition.FullWidth, ChatWindowTerminalPosition.UnderChat, ChatWindowTerminalPosition.UnderEditor];

export function getTerminalPositionAction(position: ChatWindowTerminalPosition) {
	const id = `workbench.action.chatWindow.terminalPosition.${position}`;
	switch (position) {
		case ChatWindowTerminalPosition.FullWidth:
			return { id, title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.terminalFullWidth' }, 'Terminal Across Window') };
		case ChatWindowTerminalPosition.UnderChat:
			return { id, title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.terminalUnderChat' }, 'Terminal Under Chat') };
		case ChatWindowTerminalPosition.UnderEditor:
			return { id, title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.terminalUnderEditor' }, 'Terminal Under Editor') };
	}
}

const edgeCommands: Record<ChatWindowEdge, () => ReturnType<typeof localize2>> = {
	left: () => localize2({ bundle: 'ash.workbench', key: 'chatWindow.moveLeft' }, 'Move Editor to Left Window Edge'),
	right: () => localize2({ bundle: 'ash.workbench', key: 'chatWindow.moveRight' }, 'Move Editor to Right Window Edge'),
	top: () => localize2({ bundle: 'ash.workbench', key: 'chatWindow.moveTop' }, 'Move Editor to Top Window Edge'),
	bottom: () => localize2({ bundle: 'ash.workbench', key: 'chatWindow.moveBottom' }, 'Move Editor to Bottom Window Edge'),
};

export function getChatWindowActions() {
	return {
		newChat: { id: 'workbench.action.chatWindow.newChat', title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.newChat' }, 'New Chat Tab'), icon: Lxicon.add },
		pickChat: { id: 'workbench.action.chatWindow.pickChat', title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.pickChat' }, 'Open Chat in This Window'), icon: Lxicon.search },
		openFile: { id: 'workbench.action.chatWindow.openFile', title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.openFile' }, 'Open File Beside Chat'), icon: Lxicon.file },
		toggleLayout: { id: 'workbench.action.chatWindow.toggleLayout', title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.toggleLayout' }, 'Toggle Chat Window Split Layout'), icon: Lxicon.splitHorizontal },
		newTerminal: { id: 'workbench.action.chatWindow.newTerminal', title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.newTerminal' }, 'New Terminal in Chat Window'), icon: Lxicon.terminal },
		moveTerminal: { id: 'workbench.action.chatWindow.moveTerminal', title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.moveTerminal' }, 'Move Active Terminal into Chat Window'), icon: Lxicon.terminal },
	};
}

export function registerChatWindowLayoutActions(): void {
	const actions = getChatWindowActions();
	const register = (
		action: { id: string; title: ReturnType<typeof localize2>; icon?: typeof Lxicon.add; },
		run: (accessor: ServicesAccessor, window: IChatWindow) => void | Promise<void>,
		when?: ContextKeyExpression,
	): void => {
		registerAction2(class extends Action2 {
			constructor() { super({ ...action, f1: true, precondition: ContextKeyExpr.and(InChatWindowContext.isEqualTo(true), when) }); }
			override run(accessor: ServicesAccessor, ...args: unknown[]): void | Promise<void> {
				const windows = accessor.get(IChatWindowService);
				const explicit = args.find(isWindowCommandContext);
				const id = explicit?.windowId ?? getWindowId(getWindowCommandTarget(accessor));
				const window = id === undefined ? windows.activeWindow : windows.getWindow(id);
				if (window) return run(accessor, window);
			}
		});
	};
	register(actions.newChat,
		(accessor, window) => accessor.get(IChatWindowService).openNewChat(window));
	register(actions.pickChat, (accessor, window) => accessor.get(IChatWindowService).pickChat(window));
	register(actions.openFile, async (accessor, window) => {
		const dialog = accessor.get(IFileDialogService);
		const windows = accessor.get(IChatWindowService);
		const files = await dialog.showOpenDialog({ canSelectFiles: true, canSelectMany: true });
		if (windows.getWindow(window.windowId) !== window) return;
		for (const resource of files ?? []) await window.mainPart.openEditor({ resource }, { pinned: true });
	});
	register(actions.toggleLayout, (_accessor, window) => {
		window.setLayoutMode(window.layoutMode === ChatWindowLayoutMode.SideBySide ? ChatWindowLayoutMode.Stacked : ChatWindowLayoutMode.SideBySide);
		window.showEditor();
	});
	register({
		id: 'workbench.action.chatWindow.toggleConversation',
		title: localize2({ bundle: 'ash.workbench', key: 'chatWindow.toggleConversation' }, 'Toggle Chat Conversation'),
	}, (_accessor, window) => window.toggleConversation(), CanToggleChatWindowConversationContext.isEqualTo(true));
	for (const edge of chatWindowEdges) {
		register({ id: `workbench.action.chatWindow.moveEditor.${edge}`, title: edgeCommands[edge]() },
			(_accessor, window) => window.moveEditorToEdge(edge));
	}
	for (const position of terminalPositions) {
		register(getTerminalPositionAction(position), (_accessor, window) => window.setTerminalPosition(position));
	}
	register(actions.newTerminal, async (accessor, window) => {
		await accessor.get(ITerminalService).createTerminal({ location: { viewColumn: window.terminalsPart.activeGroup.id } });
	});
	register(actions.moveTerminal, async (accessor, window) => {
		const instance = accessor.get(ITerminalService).activeInstance;
		if (!instance?.resource) return;
		const resource = instance.resource;
		const target = window.terminalsPart.activeGroup;
		const group = accessor.get(IEditorPartsService).groups.find(group =>
			group.inputs.some(input => input instanceof TerminalEditorInput && input.contains(resource)));
		const input = group?.inputs.find(input => input instanceof TerminalEditorInput && input.contains(resource));
		if (group && input) await group.moveEditorTo(input, target, target.inputs.length);
		else await accessor.get(ITerminalEditorService).openEditor(instance, { viewColumn: target.id });
		target.focus();
	});
}
