import { localize } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { CHANGES_VIEW_ID } from '../common/changes.js';
import { ChangesViewPane } from './changesView.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';

/** Uses the live view or editor content and restores focus to its owning surface. */
export function getSessionsChangesAccessibilityProviders(): readonly IAccessibleViewImplementation[] {
	const providers: IAccessibleViewImplementation[] = [];
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		providers.push({
			type,
			name: `sessionsChangesEditor.${type}`,
			priority: 100,
			when: ContextKeyExpr.has('sessionsChangesEditorFocused'),
			getProvider: accessor => {
				const pane = accessor.get(IEditorPart).activePane;
				if (!(pane instanceof SessionChangesEditor)) {
					return undefined;
				}
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChanges,
					{ type },
					() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('sessions.changes.editorHelp', 'Changes editor\nCompare the selected conversation’s file changes. Use Tab to move between comparisons and their controls. Press Alt+F2 to read before and after contents. Toggle details switches the matching file list. Hide editor keeps the shared tabs and Details visible; Show editor restores your open files.'),
					() => pane.focus(),
					AccessibilityVerbositySettingId.SessionsChanges,
				);
			},
		});
		providers.push({
			type,
			name: `sessionsChanges.${type}`,
			priority: 100,
			when: ContextKeyExpr.has('sessionsChangesFocused'),
			getProvider: accessor => {
				const view = accessor.get(IViewsService).getViewWithId(CHANGES_VIEW_ID);
				if (!(view instanceof ChangesViewPane)) { return undefined; }
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChanges,
					{ type },
					() => type === AccessibleViewType.View ? view.getAccessibleContent() : localize('sessions.changes.help', 'Changes\nUse the arrow keys to navigate changed files. Hold Shift to select several files, or use Command on macOS and Control on other platforms to add files to the selection. Press Enter to compare a file. Preview selected changes asks for a commit message and opens the final comparison. Commit this preview submits exactly the reviewed contents and message. Committed files remain readable; remaining files can be selected later. Press Alt+F2 to read the files, their Turn and selection state. Changes belong to the selected conversation.'),
					() => view.focus(),
					AccessibilityVerbositySettingId.SessionsChanges,
				);
			},
		});
	}
	return providers;
}
