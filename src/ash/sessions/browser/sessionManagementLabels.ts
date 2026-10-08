import { localize } from '../../nls.js';
import type { SessionManagementInfo } from '../services/sessions/common/session.js';

export function sessionManagementLabel(management: SessionManagementInfo | undefined): string | undefined {
	switch (management?.status) {
		case 'idle': return localize('sessions.management.idle', 'Idle');
		case 'needsInput': return localize('sessions.management.needsInput', 'Needs input');
		case 'working': return localize('sessions.management.working', 'Working');
		case 'readyForReview': return localize('sessions.management.readyForReview', 'Ready for review');
		case 'completed': return localize('sessions.management.completed', 'Completed');
		case 'failed': return localize('sessions.management.failed', 'Failed');
		case 'stopped': return localize('sessions.management.stopped', 'Stopped');
		case undefined: return undefined;
	}
}
