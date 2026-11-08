import { h } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { NewCoworkInputWidget } from '../../cowork/browser/newCoworkInput.js';
import { CoworkWidget } from '../../cowork/browser/widget/coworkWidget.js';
import { CoworkModelPreferences } from '../../cowork/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../cowork/common/languageModelsConfiguration.js';
import { LanguageModelsConfigurationService } from '../../cowork/browser/languageModelsConfigurationService.js';
import { ProjectChatModel } from './projectChatModel.js';

/** Retained independently of project metadata refreshes; Chat owns editor, draft and command behavior. */
export class ProjectChatInput extends Disposable {
	public readonly element: HTMLElement;
	private readonly widget: CoworkWidget<ProjectChatModel>;

	constructor(
		ownerDocument: Document,
		projectId: string,
		@ISessionProviderScopeService scopes: ISessionProviderScopeService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@ICommandService commands: ICommandService,
	) {
		super();
		// Projects belong to this host, independently of the foreground conversation's host.
		const draft = sessions.createUntitledSession(
			undefined,
			undefined,
			LOCAL_AGENT_HOST_PROVIDER_ID,
			false,
			undefined,
			isWeb ? undefined : { kind: 'chat' },
		);
		const scope = this._register(scopes.createScope(undefined, draft.providerId));
		scope.registerSingleton(ILanguageModelsConfigurationService, () =>
			scope.createInstance(LanguageModelsConfigurationService, CoworkModelPreferences),
		);
		const model = scope.createInstance(ProjectChatModel, projectId, draft);
		this.element = h(ownerDocument, 'section', {
			className: 'ash-projects-composer',
			attributes: {
				'aria-label': localize('projects.newChat', 'New chat in project'),
			},
		});
		this.widget = this._register(
			scope.createInstance<CoworkWidget<ProjectChatModel>>(
				CoworkWidget,
				this.element,
				`ash-project-chat-${draft.untitledSessionId}`,
				model,
				() => sessions.createUntitledSession(),
				commands,
				undefined,
				undefined,
				undefined,
				(container: HTMLElement, delegate: ChatInputDelegate) =>
					scope.createInstance(NewCoworkInputWidget, container, delegate, model, 'embedded'),
			),
		);
	}

	get submitted(): boolean {
		return this.widget.model.submitted;
	}
	setVisible(visible: boolean): void {
		this.widget.setVisible(visible);
	}
	focus(): void {
		this.widget.focusInput();
	}
}
