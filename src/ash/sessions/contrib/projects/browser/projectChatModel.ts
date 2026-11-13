import { RunOnceScheduler } from '../../../../base/common/async.js';
import { canceled } from '../../../../base/common/errors.js';
import { buildOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IGeneratedFilesService } from '../../../services/generatedFiles/common/generatedFilesService.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';
import { AshChatModel } from '../../chat/browser/ashChatModel.js';

/** Keeps the project composer on its own draft until the first submission is accepted. */
export class ProjectChatModel extends AshChatModel {
	public submitted = false;
	private readonly reveal: RunOnceScheduler;

	constructor(
		draft: IUntitledChatSession,
		@ISessionsManagementService management: ISessionsManagementService,
		@ISessionPrimaryProviderServices primary: SessionProviderServices,
		@IConfigurationService configuration: IConfigurationService,
		@IStorageService storage: IStorageService,
		@IGeneratedFilesService generatedFiles: IGeneratedFilesService,
		@IContextKeyService contexts: IContextKeyService,
		@ISessionsService view: ISessionsService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IOpenerService opener: IOpenerService,
	) {
		super({ kind: 'untitled', session: draft }, 'compact', management, primary.chat, primary.prompts, primary.models, primary.execution, configuration, storage, generatedFiles, contexts, undefined);
		// Let the shared input clear the accepted draft before navigation hides it.
		this.reveal = this._register(new RunOnceScheduler(() => {
			const open = draft.kind === 'chat'
				? opener.open(buildOpenSessionLinkUri(this.sessionId!, this.threadId!, 'local'))
				: view.openSession(this.sessionId!, this.threadId!).then(() => commands.executeCommand('sessions.open.chat'));
			void open.catch(error => notifications.error(error));
		}, 0));
	}

	override async send(...args: Parameters<AshChatModel['send']>): Promise<void> {
		if (!args[0].trim() && !args[3]?.length) return;
		await super.send(...args);
		if (this.isDisposed || args[4]?.signal?.aborted) throw canceled();
		this.submitted = true;
		this.reveal.schedule();
	}
}
