import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVoiceModeOnboardingService } from '../../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatWidget, type IChatWidgetModel } from '../../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { IChatInputPart } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import './media/nativeChat.css';
import './media/nativeChatList.css';

/** Composes the shared conversation renderer with the native Chat input and layout. */
export class NativeChatWidget<TModel extends IChatWidgetModel = IChatWidgetModel> extends ChatWidget<TModel> {
	constructor(
		container: HTMLElement,
		panelId: string,
		model: TModel,
		createUntitledSession: () => void,
		createInput: (container: HTMLElement, delegate: ChatInputDelegate) => IChatInputPart,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@ICommandService commands: ICommandService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IDialogService dialogs: IDialogService,
		@IQuickInputService quickInput: IQuickInputService,
		@IChatWidgetService widgets: IChatWidgetService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IVoiceModeOnboardingService voiceOnboarding: IVoiceModeOnboardingService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(container, panelId, model, createUntitledSession, contextMenus, contextViews, commands, accessibleViews, notifications,
			undefined, undefined, undefined, createInput, { classPrefix: 'ash-native-chat', showWelcome: false },
			instantiation, dialogs, quickInput, widgets, contextKeys, voiceOnboarding, configuration);
	}
}
