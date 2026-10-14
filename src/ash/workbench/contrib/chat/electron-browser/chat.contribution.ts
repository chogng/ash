import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { OpenAgentsWindowAction, OpenAgentsWindowTitleBarAction } from './agentSessions/agentSessionsActions.js';
import './actions/voiceChatActions.js';

registerAction2(OpenAgentsWindowAction);
registerAction2(OpenAgentsWindowTitleBarAction);
