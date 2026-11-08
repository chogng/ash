import { RunOnceScheduler } from '../../../../base/common/async.js';
import { canceled } from '../../../../base/common/errors.js';
import { IAgentExecutionSettingsService } from '../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { buildOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProjectService } from '../../../../platform/projects/common/projectService.js';
import { ILanguageModelsService } from '../../cowork/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../cowork/common/languageModelsConfiguration.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { CoworkWidgetModel } from '../../cowork/browser/coworkWidgetModel.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';

/** Adds project membership before any first Turn, including voice tasks. */
export class ProjectChatModel extends CoworkWidgetModel {
	public submitted = false;
	private associatedSessionId: string | undefined;
	private readonly reveal: RunOnceScheduler;

	constructor(
		private readonly projectId: string,
		draft: IUntitledChatSession,
		@IChatService chat: IChatService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IPromptsService prompts: IPromptsService,
		@ILanguageModelsService models: ILanguageModelsService,
		@ILanguageModelsConfigurationService
		preferences: ILanguageModelsConfigurationService,
		@IAgentExecutionSettingsService execution: IAgentExecutionSettingsService,
		@IConfigurationService configuration: IConfigurationService,
		@IProjectService private readonly projects: IProjectService,
		@ISessionsService view: ISessionsService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
	) {
		super(chat, { kind: 'untitled', session: draft }, sessions, prompts, models, preferences, execution, configuration);
		// Finish the input's successful-send bookkeeping before navigation hides its host.
		this.reveal = this._register(
			new RunOnceScheduler(() => {
				const open = draft.kind === 'chat'
					? opener.open(buildOpenSessionLinkUri(this.sessionId!, this.threadId!, 'local'))
					: view.openSession(this.sessionId!, this.threadId!).then(() => commands.executeCommand('sessions.open.chat'));
				void open.catch(error => notifications.error(error));
			}, 0),
		);
	}

	override async prepareConversation(signal?: AbortSignal): ReturnType<CoworkWidgetModel['prepareConversation']> {
		const active = await super.prepareConversation(signal);
		if (this.associatedSessionId !== active.sessionId) {
			// Read the current revision so changing materials while composing is safe.
			const project = await this.projects.read(this.projectId, 'chat');
			if (this.isDisposed || signal?.aborted) throw canceled();
			if (!project.sessionIds.includes(active.sessionId)) await this.projects.addSession(project, active.sessionId);
			this.associatedSessionId = active.sessionId;
		}
		if (this.isDisposed || signal?.aborted) throw canceled();
		return active;
	}

	override async send(...args: Parameters<CoworkWidgetModel['send']>): Promise<void> {
		if (!args[0].trim() && !args[3]?.length) return;
		await this.prepareConversation(args[4]?.signal);
		await super.send(...args);
		if (this.isDisposed || args[4]?.signal?.aborted) throw canceled();
		this.submitted = true;
		this.reveal.schedule();
	}

}
