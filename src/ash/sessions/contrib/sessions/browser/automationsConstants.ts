import type { AutomationTarget } from '../../../../workbench/contrib/chat/common/automations/automation.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';

export const AUTOMATIONS_CUSTOM_VIEW_ID = 'sessions.customView.automations';
export const SCHEDULED_CUSTOM_VIEW_ID = 'sessions.customView.scheduled';

export function belongsToAutomationView(target: AutomationTarget, kind: 'chat' | 'code'): boolean {
	return kind === 'chat'
		? target.session.type === 'newChat' && target.providerId === LOCAL_AGENT_HOST_PROVIDER_ID
		: target.session.type !== 'newChat';
}
