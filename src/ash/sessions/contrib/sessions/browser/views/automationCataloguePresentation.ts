import { localize } from '../../../../../nls.js';
import type { AutomationCatalogueState } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';

/** Both catalogue presentations report the status of the same provider-owned snapshot. */
export function getAutomationCatalogueMessage(state: AutomationCatalogueState, kind: 'chat' | 'code'): string {
	switch (state) {
		case 'loading': return kind === 'chat'
			? localize('scheduled.loading', 'Loading scheduled tasks…')
			: localize('automations.loading', 'Loading routines…');
		case 'error': return kind === 'chat'
			? localize('scheduled.loadFailed', 'Could not load scheduled tasks.')
			: localize('automations.loadFailed', 'Could not load routines.');
		case 'unavailable': return localize('automations.unavailable', 'The execution host is unavailable. Saved results may be out of date.');
		case 'ready': return '';
	}
}
