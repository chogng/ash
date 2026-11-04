import { localize } from '../../../../../nls.js';
import type { AutomationCatalogueState } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';

/** Both catalogue presentations report the status of the same provider-owned snapshot. */
export function getAutomationCatalogueMessage(state: AutomationCatalogueState): string {
	switch (state) {
		case 'loading': return localize('automations.loading', 'Loading automations…');
		case 'error': return localize('automations.loadFailed', 'Could not load automations.');
		case 'unavailable': return localize('automations.unavailable', 'The owning automation host is unavailable. Saved results may be out of date.');
		case 'ready': return '';
	}
}
