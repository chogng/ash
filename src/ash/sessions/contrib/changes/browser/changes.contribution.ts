import './changesMultiDiffSourceResolver.js';
import './changesActions.js';
import './changesetReviewActions.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import './changesViewActions.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';

import { getSessionsChangesAccessibilityProviders } from './sessionsChangesAccessibilityHelp.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChangesViewService } from '../common/changesViewService.js';
import { ChangesViewService } from './changesViewService.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';
import { SessionChangesService } from './sessionChangesService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { CHANGES_VIEW_CONTAINER_ID, CHANGES_VIEW_ID } from '../common/changes.js';
import { ChangesViewPane } from './changesView.js';

registerSingleton(IChangesViewService, ChangesViewService, InstantiationType.Delayed);
registerSingleton(ISessionChangesService, SessionChangesService, InstantiationType.Delayed);

const localizationKey = { bundle: 'ash', key: 'sessions.changes.title' };
SessionsViewRegistry.registerStaticViewContainer({
	id: CHANGES_VIEW_CONTAINER_ID, title: 'Changes', localizationKey, icon: Lxicon.diff,
	location: ViewContainerLocation.AuxiliaryBar, hideIfEmpty: true,
});
SessionsViewRegistry.registerStaticViews(CHANGES_VIEW_CONTAINER_ID, [{
	id: CHANGES_VIEW_ID, title: 'Changes', localizationKey,
	ctorDescriptor: new SyncDescriptor(ChangesViewPane), when: ContextKeyExpr.has('sessions.desktopCode'), canToggleVisibility: false,
}]);

registerEditorPane({
	id: SessionChangesEditor.ID,
	name: 'Changes',
	canOpen: input => input.resource.scheme === 'ash-session-changes' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(SessionChangesEditor, { showFileList: true }),
});

for (const provider of getSessionsChangesAccessibilityProviders()) {
	AccessibleViewRegistry.register(provider);
}
