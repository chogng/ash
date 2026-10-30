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
import { IChecksOperationService } from '../common/checksOperationService.js';
import { ChecksOperationService } from './checksOperationService.js';

registerSingleton(IChangesViewService, ChangesViewService, InstantiationType.Delayed);
registerSingleton(ISessionChangesService, SessionChangesService, InstantiationType.Delayed);
registerSingleton(IChecksOperationService, ChecksOperationService, InstantiationType.Delayed);

registerEditorPane({
	id: SessionChangesEditor.ID,
	name: 'Changes',
	canOpen: input => input.resource.scheme === 'ash-session-changes' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(SessionChangesEditor, { ...options, showChangesView: true }),
});

for (const provider of getSessionsChangesAccessibilityProviders()) {
	AccessibleViewRegistry.register(provider);
}
