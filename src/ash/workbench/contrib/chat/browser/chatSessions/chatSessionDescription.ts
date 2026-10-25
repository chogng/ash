import type { AgentSessionActivity } from '../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../nls.js';

/** Reads the backend's activity projection; completed work never retains a running label. */
export function getInProgressSessionDescription(activity: AgentSessionActivity | undefined): string | undefined {
	if (activity?.status !== 'working' && activity?.status !== 'needsInput') return undefined;
	const description = activity.activity?.text.replace(/\s+/gu, ' ').trim();
	if (description) return description;
	return activity.status === 'needsInput'
		? localize('chat.sessions.description.needsInput', 'Waiting for input…')
		: localize('chat.sessions.description.working', 'Working…');
}
