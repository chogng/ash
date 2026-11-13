import { localize } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { CHANGES_VIEW_ID } from '../common/changes.js';
import { ChangesViewPane } from './changesView.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';

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
					() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('sessions.changes.editorHelp', "Changes editor\nThe file list and comparisons share this editor. Use Changes in the title toolbar to select All Changes, Changes from Turn, Uncommitted Changes, or Compare Against. Toggle Changed Files shows the files in the comparison. In More Actions, use Files View to switch between list and tree. For All Changes and Changes from Turn, use Preview commit to select files and enter a commit message. Use Up and Down to browse files, Left and Right to close and open folders, Space to preview while keeping list focus, or Enter to focus the diff. Select files and use the context menu to mark them reviewed or unreviewed. Changes is a separate tool card with a title toolbar for each editor group. Use Session information under Environment for Git branch actions, pull requests and checks. Alt+F2 reads the file list and before and after contents.") + '\n' + localize('sessions.changes.editorActionsHelp', 'Use the file toolbar to mark a file Viewed, open its workspace file, expand the full file or collapse unchanged regions. Marking Viewed collapses that comparison; marking it unviewed expands it. Read markers belong to the captured revision. Preview commit asks for a message and prepares the exact captured file for review before committing.') + '\n' + localize('sessions.changes.diffViewHelp', 'In the editor title menu, open Diff View to choose Inline, Side by Side, or Automatic for comparisons in the Agents window.'),
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
				const focused = view.element.ownerDocument.activeElement;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChanges,
					{ type },
					() => type === AccessibleViewType.View ? view.getAccessibleContent() : getChangesViewHelp(),
					() => { if (isHTMLElement(focused) && focused.isConnected && view.element.contains(focused)) { focused.focus(); } else { view.focus(); } },
					AccessibilityVerbositySettingId.SessionsChanges,
				);
			},
		});
	}
	return providers;
}

function getChangesViewHelp(): string {
	return localize('sessions.changes.help', 'Changes\nUse the arrow keys to navigate changed files. Hold Shift to select several files, or use Command on macOS and Control on other platforms to add files to the selection. Press Enter to compare a file. Preview selected changes asks for a commit message and opens the final comparison. Commit this preview submits exactly the reviewed contents and message. Committed files remain readable; remaining files can be selected later. Press Alt+F2 to read the files, their Turn and selection state. Changes belong to the selected conversation.') + '\n' + localize('sessions.changes.reviewHelp', 'Choose Conversation Changes to review net changes at the current history checkpoint, or a specific Turn to review its capture. Choose a Turn to preview a commit. Review all changes opens the Changes editor for that selection. Switch between List and Tree; use Left and Right arrows to collapse or expand folders. Select files and choose Mark reviewed or Mark unreviewed. Read markers belong to the exact comparison revision and do not change commit eligibility. Each conversation retains its Turn choice and read markers when this window is restored. Each conversation and view mode retains its selection, focus, expansion and scroll position.') + '\n' + localize('sessions.changes.operationsHelp', 'Use Tab to reach the summary and actions. Retry loading changes reloads a failed list. When checkout needs attention, read the reason in the summary and use Retry checkout after resolving it. Choose Review working tree in the changes selector to open live uncommitted changes in a separate editor. Repository actions and pull request checks are in Session information under Environment.');
}
