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
