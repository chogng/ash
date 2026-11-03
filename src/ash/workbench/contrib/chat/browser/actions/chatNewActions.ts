import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { NEW_CHAT_COMMAND_ID } from '../../common/chat.js';
import { clearChatEditor } from './chatClear.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { ChatEditorInput } from '../widgetHosts/editor/chatEditorInput.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { resolveCommandsContext } from '../../../../browser/parts/editor/editorCommandsContext.js';

export class NewChatAction extends Action2 {
	constructor() {
		super({
			id: NEW_CHAT_COMMAND_ID,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
			icon: Lxicon.add,
			f1: true,
			menu: {
				id: MenuId.ChatNewMenu,
				group: '1_open',
				order: 1,
				when: ChatContextKeys.enabled.isEqualTo(true),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<boolean> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return false;
		await accessor.get(IChatSessionNavigationService).createNewConversation();
		return true;
	}
}

export function registerNewChatActions(): void {
	registerAction2(NewChatAction);
	registerAction2(class NewChatEditorAction extends Action2 {
		constructor() {
			const when = ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ActiveEditorContext.isEqualTo(ChatEditorInput.EditorID));
			super({
				id: 'workbench.action.chatEditor.newChat',
				title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
				icon: Lxicon.add, precondition: when,
				menu: { id: MenuId.EditorTitle, group: 'navigation', order: 0, when },
			});
		}
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
			const group = context === undefined ? undefined : resolveCommandsContext([context], accessor.get(IEditorGroupsService)).groupedEditors[0]?.group;
			const target = group?.activeInput;
			if (context !== undefined && !(target instanceof ChatEditorInput)) return;
			await clearChatEditor(accessor, target as ChatEditorInput | undefined);
		}
	});
	MenusRegistry.appendMenuItem(MenuId.ChatTitle, {
		submenu: MenuId.ChatNewMenu,
		title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
		isSplitButton: true,
		when: ChatContextKeys.enabled.isEqualTo(true),
		group: 'navigation',
		order: 1,
	});
}
