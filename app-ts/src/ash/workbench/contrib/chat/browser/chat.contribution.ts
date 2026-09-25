import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import "./actions/chatActions.js";
import "./actions/chatLayoutActions.js";
import "../common/widget/chatColors.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { IInstantiationService, ServiceConstructionDescriptor } from "../../../../platform/instantiation/common/instantiation.js";
import { ViewContainerLocation, type WorkbenchViewRegistry, ViewsRegistry } from "../../../common/views.js";
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID } from "../common/chat.js";
import { ChatInputEditor } from "./input/chatInputEditor.js";
import { ChatInputEditors } from "./input/chatInputEditorRegistry.js";
import { ChatViewPane } from "./view/chatViewPane.js";

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
		ctorDescriptor: new ServiceConstructionDescriptor(ChatViewPane),
	}]);
}
