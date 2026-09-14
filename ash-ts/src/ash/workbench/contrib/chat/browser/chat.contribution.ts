import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import "./actions/chatActions.js";
import "./actions/chatLayoutActions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { IMenuService } from "../../../../platform/actions/common/menuService.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IContextViewService } from "../../../../platform/contextview/browser/contextView.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IInstantiationService, ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, ViewsRegistry } from "../../../common/views.js";
import { IChatService } from "../../../services/chat/common/chatService.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";
import { ISessionsManagementService } from "../../../../sessions/services/sessions/common/sessionsManagementService.js";
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID } from "../common/chat.js";
import { ChatInputEditor } from "./input/stanzaChatInputEditor.js";
import { ChatInputEditors } from "./input/chatInputEditor.js";
import { ChatViewPane } from "./view/chatViewPane.js";
import { IChatContextPickService } from "../../../services/chat/common/chatContextService.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { IContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { ChatFileContextContribution } from "./chatFileContext.js";
import { ChatInstructionContextContribution } from './promptSyntax/attachInstructionsAction.js';
import { IInstructionApi } from '../../../../platform/instructions/common/instructionApi.js';

registerWorkbenchContribution('workbench.contrib.chatInputEditor', WorkbenchPhase.BlockStartup, accessor => {
	const instantiationService = accessor.get(IInstantiationService);
	return ChatInputEditors.register({ id: 'stanza', create: options => new ChatInputEditor({ ...options, instantiationService }) });
});

registerWorkbenchContribution('workbench.contrib.chatFileContext', WorkbenchPhase.BlockRestore, accessor => new ChatFileContextContribution(
	accessor.get(IChatContextPickService),
	accessor.get(IEditorService),
	accessor.get(IFileService),
));

registerWorkbenchContribution('workbench.contrib.chatInstructionContext', WorkbenchPhase.BlockRestore, accessor => new ChatInstructionContextContribution(
	accessor.get(IChatContextPickService),
	accessor.get(IInstructionApi),
	accessor.get(ISessionsManagementService),
));

/** Registers the fixed Chat view. */
export function registerChatViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: CHAT_VIEW_CONTAINER_ID,
		title: "Chat",
		localizationKey: { bundle: "ash.views", key: "chat" },
		location: ViewContainerLocation.AuxiliaryBar,
		icon: lxiconsLibrary.chat,
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
				IContextKeyService,
			],
		}),
	}]);
}
