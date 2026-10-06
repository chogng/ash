import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import type { ISessionsConversationPane } from '../../../browser/parts/sessions/sessionsChatView.js';
import { CoworkWidget } from './widget/coworkWidget.js';
import { CoworkWidgetModel } from './coworkWidgetModel.js';
import { NewCoworkInputWidget } from './newCoworkInput.js';
import type { ChatInputDelegate } from './widget/input/chatInput.js';
import { ChatTipService, IChatTipService } from './chatTipService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from './speechToText/chatSpeechToTextService.js';
import { DictationOnboardingService, IDictationOnboardingService } from './speechToText/dictationOnboarding.js';
import './actions/coworkSpeechToTextActions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { CoworkModelPreferences } from '../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../common/languageModelsConfiguration.js';
import { LanguageModelsConfigurationService } from './languageModelsConfigurationService.js';

/** Cowork owns its conversation implementation; the Sessions Part only hosts and selects panes. */
export class CoworkPaneFactory extends Disposable {
	private readonly services: InstantiationService;
	constructor(
		@IInstantiationService services: IInstantiationService,
		@IChatService private readonly chat: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.services = this._register(services.createChild());
		// Cowork owns its defaults and remembered choice while sharing the catalog and provider connections.
		this.services.registerInstance(ILanguageModelsConfigurationService, this._register(services.createInstance(LanguageModelsConfigurationService, CoworkModelPreferences)));
	}

	public createPane(container: HTMLElement, panelId: string, selection: SessionsViewSelection, createNewSession: () => void): ISessionsConversationPane {
		const model = this.services.createInstance(CoworkWidgetModel, this.chat, selection.kind === 'session' ? { kind: 'session', active: selection.active } : { kind: 'untitled', session: selection.session }, this.sessions);
		return this.services.createInstance<CoworkWidget<CoworkWidgetModel>>(CoworkWidget, container, panelId, model, createNewSession, this.commands, undefined, undefined, undefined,
			(inputContainer: HTMLElement, delegate: ChatInputDelegate) => this.services.createInstance(NewCoworkInputWidget, inputContainer, delegate, model));
	}
}

registerSingleton(IChatTipService, ChatTipService, InstantiationType.Delayed);
registerSingleton(IChatSpeechToTextService, ChatSpeechToTextService, InstantiationType.Delayed);
registerSingleton(IDictationOnboardingService, DictationOnboardingService, InstantiationType.Delayed);
