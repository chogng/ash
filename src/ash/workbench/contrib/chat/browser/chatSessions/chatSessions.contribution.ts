import { Lxicon } from '../../../../../base/common/lxicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatPartVisibleContext, EditorAreaHiddenByChatContext, IsAuxiliaryWindowContext } from '../../../../common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID, OPEN_CHAT_COMMAND_ID } from '../../common/chat.js';

const ChatContainerVisibleContext = new RawContextKey<boolean>('chatContainerVisible', false);

/** The Code host registers its Chat view command; Sessions retains its own navigation. */
export function registerChatSessionsActions(): void {
	registerWorkbenchContribution('workbench.contrib.chatViewVisibility', WorkbenchPhase.BlockRestore, accessor => {
		const views = accessor.get(IViewsService);
		const visible = ChatContainerVisibleContext.bindTo(accessor.get(IContextKeyService));
		const lifetime = new DisposableStore();
		visible.set(views.isViewContainerVisible(CHAT_VIEW_CONTAINER_ID));
		lifetime.add(views.onDidChangeViewContainerVisibility(event => {
			if (event.id === CHAT_VIEW_CONTAINER_ID) visible.set(event.visible);
		}));
		lifetime.add(toDisposable(() => visible.reset()));
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
				icon: Lxicon.chat,
				toggled: ChatContainerVisibleContext.isEqualTo(true),
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				menu: { id: MenuId.TitleBar, when: IsAuxiliaryWindowContext.isEqualTo(false), group: 'navigation', order: 11 },
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
