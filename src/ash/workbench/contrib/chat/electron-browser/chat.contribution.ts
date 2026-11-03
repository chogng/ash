import { toDisposable } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { OpenChatInWorkspaceAction, restoreTransferredChatConversation } from '../browser/actions/chatTransfer.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { OpenAgentsWindowAction, OpenAgentsWindowTitleBarAction } from './agentSessions/agentSessionsActions.js';
import './actions/voiceChatActions.js';
import { AgentsWindowInvitationContribution } from './agentSessions/agentsWindowInvitation.js';
import { ChatScreenshotContribution } from './chatScreenshot.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

registerAction2(OpenAgentsWindowAction);
registerAction2(OpenAgentsWindowTitleBarAction);
registerWorkbenchContribution(AgentsWindowInvitationContribution.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(AgentsWindowInvitationContribution));
registerWorkbenchContribution('workbench.contrib.chatScreenshot', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(ChatScreenshotContribution));

registerAction2(OpenChatInWorkspaceAction);
registerWorkbenchContribution('workbench.contrib.chatTransfer', WorkbenchPhase.AfterRestored, accessor => {
	const notifications = accessor.get(INotificationService);
	const lifetime = new AbortController();
	void restoreTransferredChatConversation(accessor, lifetime.signal).catch(error => {
		if (!lifetime.signal.aborted) { notifications.error(error instanceof Error ? error : String(error)); }
	});
	return toDisposable(() => lifetime.abort());
});
