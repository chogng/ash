import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import "./actions/chatActions.js";
import "./actions/chatLayoutActions.js";
import "../common/widget/chatColors.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { IMenuService } from "../../../../platform/actions/common/actions.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IInstantiationService, ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, ViewsRegistry } from "../../../common/views.js";
import { IChatService } from "../../../services/chat/common/chatService.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import { ISessionsManagementService } from "../../../../sessions/services/sessions/common/sessionsManagementService.js";
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID } from "../common/chat.js";
import { ChatInputEditor } from "./input/chatInputEditor.js";
import { ChatInputEditors } from "./input/chatInputEditorRegistry.js";
import { ChatViewPane } from "./view/chatViewPane.js";
import { IChatContextPickService } from "../../../services/chat/common/chatContextService.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { IOpenerService } from "../../../../platform/opener/common/openerService.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IFileService } from '../../../../platform/files/common/files.js';

registerWorkbenchContribution('workbench.contrib.chatInputEditor', WorkbenchPhase.BlockStartup, accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	return ChatInputEditors.register({ id: 'stanza', create: options => instantiationService.createInstance(ChatInputEditor, options) });
});

/** Registers the fixed Chat view. */
export function registerChatViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: CHAT_VIEW_CONTAINER_ID,
		title: "Chat",
		localizationKey: { bundle: "ash.views", key: "chat" },
		location: ViewContainerLocation.AuxiliaryBar,
		icon: Lxicon.chat,
		order: 1,
		isDefault: true,
	});
	registry.registerStaticViews(CHAT_VIEW_CONTAINER_ID, [{
		id: CHAT_VIEW_ID,
		title: "Chat",
		localizationKey: { bundle: "ash.views", key: "chat" },
		order: 1,
		canToggleVisibility: false,
		ctorDescriptor: new ServiceConstructionDescriptor(ChatViewPane, {
			serviceDependencies: [
				IChatService,
				ISessionsManagementService,
				IMenuService,
				IContextMenuService,
				IContextViewService,
				ICommandService,
				IWorkbenchLayoutService,
				IChatContextPickService,
				IQuickInputService,
				IFileService,
				IContextKeyService,
				IOpenerService,
				IEditorService,
			],
		}),
	}]);
}
