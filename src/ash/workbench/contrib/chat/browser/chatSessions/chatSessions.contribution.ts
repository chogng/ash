import { Lxicon } from '../../../../../base/common/lxicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { AuxiliaryBarHasActiveViewsContext, AuxiliaryBarVisibleContext, ChatPartVisibleContext, EditorAreaHiddenByChatContext, IsAuxiliaryWindowContext, TitleBarRightSideBarShowsChatContext } from '../../../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID, OPEN_CHAT_COMMAND_ID } from '../../common/chat.js';

/** The Code host registers its Chat view command; Sessions retains its own navigation. */
export function registerChatSessionsActions(): void {
	registerWorkbenchContribution('workbench.contrib.chatTitleBar', WorkbenchPhase.BlockRestore, accessor => {
		const context = accessor.get(IContextKeyService);
		const target = TitleBarRightSideBarShowsChatContext.bindTo(context);
		// The existing right side bar control can open Chat when the secondary side bar has no view to show.
		const showChat = ContextKeyExpr.and(
			ChatContextKeys.enabled.isEqualTo(true),
			AuxiliaryBarHasActiveViewsContext.isEqualTo(false),
			AuxiliaryBarVisibleContext.isEqualTo(false),
		);
		const keys = new Set(showChat?.keys());
		const lifetime = new DisposableStore();
		const update = (): void => target.set(context.contextMatchesRules(showChat));
		update();
		lifetime.add(context.onDidChangeContext(event => {
			if (event.affectsSome(keys)) update();
		}));
		lifetime.add(toDisposable(() => target.reset()));
		return lifetime;
	});
	registerAction2(class OpenChatAction extends Action2 {
		constructor() {
			super({
				id: OPEN_CHAT_COMMAND_ID,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				title: localize2({ bundle: 'ash.sessions', key: 'command.OpenChatAction' }, 'Open Chat'),
				icon: Lxicon.chat,
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): Promise<boolean> {
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return Promise.resolve(false);
			return accessor.get(IViewsService).focusView(CHAT_VIEW_ID);
		}
	});
	registerAction2(class ToggleChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.toggleChat',
				title: localize2({ bundle: 'ash.actions', key: 'toggleChat' }, 'Toggle Chat'),
				icon: Lxicon.layoutSidebarRightOff,
				toggled: { condition: ChatPartVisibleContext.isEqualTo(true), icon: Lxicon.layoutSidebarRight },
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				menu: {
					id: MenuId.TitleBar,
					when: ContextKeyExpr.and(IsAuxiliaryWindowContext.isEqualTo(false), TitleBarRightSideBarShowsChatContext.isEqualTo(true)),
					group: 'navigation',
					order: 10,
				},
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
			const views = accessor.get(IViewsService);
			if (views.isViewContainerVisible(CHAT_VIEW_CONTAINER_ID)) {
				views.closeViewContainer(CHAT_VIEW_CONTAINER_ID);
			} else {
				await views.focusView(CHAT_VIEW_ID);
			}
		}
	});
	registerAction2(class CloseChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.closeChat',
				title: localize2({ bundle: 'ash.actions', key: 'hideChat' }, 'Hide Chat'),
				icon: Lxicon.close,
				precondition: ChatPartVisibleContext.isEqualTo(true),
				menu: { id: MenuId.ChatHostTitle, group: 'navigation', order: 50 },
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): void {
			accessor.get(IViewsService).closeViewContainer(CHAT_VIEW_CONTAINER_ID);
		}
	});
	registerAction2(class ToggleExpandedChatAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.toggleExpandedChat',
				title: localize2({ bundle: 'ash.actions', key: 'expandChat' }, 'Expand Chat'),
				icon: Lxicon.screenFull,
				toggled: {
					condition: EditorAreaHiddenByChatContext.isEqualTo(true),
					title: localize2({ bundle: 'ash.actions', key: 'restoreChatWidth' }, 'Restore Chat Width'),
					icon: Lxicon.screenNormal,
				},
				precondition: ChatPartVisibleContext.isEqualTo(true),
				menu: { id: MenuId.ChatHostTitle, group: 'navigation', order: 40 },
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): void {
			const layout = accessor.get(IWorkbenchLayoutService);
			layout.setEditorHiddenByChat(!layout.isEditorHiddenByChat());
		}
	});
}
