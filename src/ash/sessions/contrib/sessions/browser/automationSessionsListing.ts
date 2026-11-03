import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

/** Connects accepted conversation replies to the existing sidebar visibility policy. */
export class AutomationSessionsListingContribution extends Disposable {
	static readonly ID = 'sessions.automationSessionsListing';

	constructor(
		@IChatService chat: IChatService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@ISessionsListModelService list: ISessionsListModelService,
	) {
		super();
		this._register(chat.onDidSubmitRequest(({ sessionId }) => {
			const session = sessions.sessions.find(candidate => candidate.sessionId === sessionId);
			if (session) list.recordAutomationSessionReply(session);
		}));
	}
}
