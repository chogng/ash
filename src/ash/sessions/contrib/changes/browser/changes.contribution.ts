import './changesMultiDiffSourceResolver.js';
import './changesActions.js';
import './changesetReviewActions.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import './changesViewActions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ChangesViewPane } from './changesView.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';

import { CHANGES_VIEW_CONTAINER_ID, CHANGES_VIEW_ID } from '../common/changes.js';
import { getSessionsChangesAccessibilityProviders } from './sessionsChangesAccessibilityHelp.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { ChangesViewService } from './changesViewService.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesService } from './sessionChangesService.js';
import { IChecksOperationService } from '../common/checksOperationService.js';
import { ChecksOperationService } from './checksOperationService.js';

registerSingleton(IChangesViewService, ChangesViewService, InstantiationType.Delayed);
registerSingleton(ISessionChangesService, SessionChangesService, InstantiationType.Delayed);
registerSingleton(IChecksOperationService, ChecksOperationService, InstantiationType.Delayed);

registerEditorPane({
	id: SessionChangesEditor.ID,
	name: 'Changes',
	canOpen: input => input.resource.scheme === 'ash-session-changes' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(SessionChangesEditor, options),
});

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
	ctorDescriptor: new SyncDescriptor(ChangesViewPane),
	canToggleVisibility: false,
}]);

for (const provider of getSessionsChangesAccessibilityProviders()) {
	AccessibleViewRegistry.register(provider);
}
