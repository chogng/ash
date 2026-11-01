import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IsNativeContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID } from '../../common/chat.js';
import type { IChatViewPane } from '../chat.js';

export function registerMoveActions(): void {
	registerAction2(class MoveChatToEditorAction extends Action2 {
		constructor() {
			super({
				id: MOVE_CHAT_TO_EDITOR_COMMAND_ID,
				title: localize2({ bundle: 'ash.sessions', key: 'command.MoveChatToEditorAction' }, 'Move Chat to Editor Area'),
				icon: Lxicon.layoutPanel1,
				precondition: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ContextKeyExpr.not('chatInEditor')),
				f1: true,
				menu: {
					id: MenuId.ChatTitle,
					group: 'chatActions',
					order: 2,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID);
			if (view) await view.moveToEditor();
		}
	});

	registerAction2(class MoveChatToSidebarAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.moveToSideBar',
				title: localize2('chat.moveToSidebar', 'Move Chat to Side Bar'),
				precondition: ContextKeyExpr.equals('chatInEditor', true),
				f1: true,
				menu: { id: MenuId.ChatTitle, group: 'chatActions', order: 2, when: ContextKeyExpr.equals('chatInEditor', true) },
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const navigation = accessor.get(IChatSessionNavigationService);
			const editorGroups = accessor.get(IEditorGroupsService);
			const views = accessor.get(IViewsService);
			const revision = navigation.revision;
			await navigation.captureActiveDraft();
			if (revision !== navigation.revision) return;
			for (const group of editorGroups.groups) {
				for (const input of [...group.inputs]) {
					if (input.resource.scheme === Schemas.vscodeChatEditor) await group.closeEditor(input);
				}
			}
			await views.focusView(CHAT_VIEW_ID);
		}
	});

	registerAction2(class MoveChatToNewWindowAction extends Action2 {
		constructor() {
			super({
				id: MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID,
				title: localize2({ bundle: 'ash.sessions', key: 'command.MoveChatToNewWindowAction' }, 'Move Chat to New Window'),
				icon: Lxicon.linkExternal,
				precondition: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), IsNativeContext.isEqualTo(true)),
				menu: {
					id: MenuId.ChatTitle,
					group: 'chatActions',
					order: 3,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID);
			if (view) await view.openInNewWindow();
		}
	});
}
