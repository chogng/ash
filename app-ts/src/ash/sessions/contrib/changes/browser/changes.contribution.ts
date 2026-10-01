import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ServiceConstructionDescriptor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../../workbench/services/views/browser/viewsService.js';
import { ChangesViewPane } from './changesView.js';

export const CHANGES_VIEW_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.changesContainer';
const CHANGES_VIEW_ID = 'sessions.changes';

SessionsViewRegistry.registerStaticViewContainer({
	id: CHANGES_VIEW_CONTAINER_ID,
	title: 'Changes',
	localizationKey: { bundle: 'ash', key: 'sessions.changes.title' },
	location: ViewContainerLocation.AuxiliaryBar,
	icon: Lxicon.diff,
	order: 1,
});
SessionsViewRegistry.registerStaticViews(CHANGES_VIEW_CONTAINER_ID, [{
	id: CHANGES_VIEW_ID,
	title: 'Changes',
	localizationKey: { bundle: 'ash', key: 'sessions.changes.title' },
	ctorDescriptor: new ServiceConstructionDescriptor(ChangesViewPane),
	canToggleVisibility: false,
}]);

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		name: `sessionsChanges.${type}`,
		priority: 100,
		when: ContextKeyExpr.has('sessionsChangesFocused'),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).openView(CHANGES_VIEW_ID);
			if (!(view instanceof ChangesViewPane)) { return undefined; }
			return new AccessibleContentProvider(
				AccessibleViewProviderId.SessionsChanges,
				{ type },
				() => type === AccessibleViewType.View ? view.getAccessibleContent() : localize('sessions.changes.help', 'Changes\nUse the arrow keys to select a changed file. Press Enter to compare its before and after contents. Review all changes opens a combined comparison. Press Alt+F2 to read the changed files. Changes belong to the selected conversation.'),
				() => view.focus(),
				AccessibilityVerbositySettingId.SessionsChanges,
			);
		},
	});
}
