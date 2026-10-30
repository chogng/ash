import { localize } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { CHANGES_VIEW_ID } from '../common/changes.js';
import { ChangesViewPane } from './changesView.js';
import { SessionChangesEditor } from './sessionChangesEditor.js';
import { CreatePullRequestFocusedContext } from '../common/changes.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';

/** Uses the live view or editor content and restores focus to its owning surface. */
export function getSessionsChangesAccessibilityProviders(): readonly IAccessibleViewImplementation[] {
	const providers: IAccessibleViewImplementation[] = [];
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		providers.push({
			type,
			name: `sessionsCreatePullRequest.${type}`,
			priority: 110,
			when: CreatePullRequestFocusedContext.isEqualTo(true),
			getProvider: accessor => {
				const form = accessor.get(IContextViewService).container.querySelector<HTMLElement>('.ash-sessions-create-pr');
				if (!form) { return undefined; }
				const focused = form.ownerDocument.activeElement;
				return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChanges, { type }, () => {
					if (!form.isConnected) { return localize('sessions.changes.prClosed', 'Pull request form closed.'); }
					if (type === AccessibleViewType.Help) { return localize('sessions.changes.prHelp', 'Create pull request\nUse Tab and Shift+Tab to move between the title, target branch, description, Draft checkbox, merge mode and actions. Choose Create pull request to submit the displayed values. Escape or Cancel closes the form and returns focus. Changes to the session or GitHub account close the form. Creation checks the repository and branch again; a changed context requires reopening the form.') + '\n' + localize('sessions.changes.prAgentHelp', 'The primary button repeats the last pull request action. Use Left and Right to move between it and Pull request action; Down opens the menu. Choose Create directly to use GitHub, or Ask agent to create to submit the displayed title, description, branch and merge choice to this conversation. Choosing a menu action submits immediately. Escape closes the menu and returns focus to its button. An active Turn queues the request. This uses normal agent permissions. Draft and merge choices are remembered for the profile and limited by the current repository. An unconfirmed submission disables retry; inspect the conversation or repository first.'); }
					const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')].filter(field => !field.hidden);
					const values = fields.map(field => {
						let value = field.value;
						if (field instanceof form.ownerDocument.defaultView!.HTMLInputElement && field.type === 'checkbox') {
							value = field.checked ? localize('sessions.changes.prChecked', 'Checked') : localize('sessions.changes.prUnchecked', 'Unchecked');
						}
						return localize('sessions.changes.prField', '{0}: {1}', field.getAttribute('aria-label') ?? '', value);
					});
					return [form.textContent, ...values].join('\n');
				}, () => { if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.SessionsChanges);
			},
		});
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
					() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('sessions.changes.editorHelp', 'Changes card\nThe file list and comparisons share this card. Use the arrow keys to navigate changed files and Enter to compare a file. Use Tab to reach review, commit and comparison controls. Resize the separator to change the list and comparison sizes; narrow cards stack them vertically. Press Alt+F2 to read the file list and before and after contents. The card header can arrange, expand, close or open the retained editor in a separate window. Files and Terminal keep their own cards.') + '\n' + getChangesViewHelp() + '\n' + localize('sessions.changes.editorActionsHelp', 'Use the file toolbar to mark a file Viewed, open its workspace file, expand the full file or collapse unchanged regions. Marking Viewed collapses that comparison; marking it unviewed expands it. Read markers belong to the captured revision. Preview commit asks for a message and prepares the exact captured file for review before committing.'),
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
	return localize('sessions.changes.help', 'Changes\nUse the arrow keys to navigate changed files. Hold Shift to select several files, or use Command on macOS and Control on other platforms to add files to the selection. Press Enter to compare a file. Preview selected changes asks for a commit message and opens the final comparison. Commit this preview submits exactly the reviewed contents and message. Committed files remain readable; remaining files can be selected later. Press Alt+F2 to read the files, their Turn and selection state. Changes belong to the selected conversation.') + '\n' + localize('sessions.changes.reviewHelp', 'Choose All Turns or a specific Turn to filter files. Review all changes opens the Changes editor for that selection. Switch between List and Tree; use Left and Right arrows to collapse or expand folders. Select files and choose Mark reviewed or Mark unreviewed. Read markers belong to the exact Turn revision and do not change commit eligibility. Each conversation retains its Turn choice and read markers when this window is restored. Each conversation and view mode retains its selection, focus, expansion and scroll position.') + '\n' + localize('sessions.changes.ciActionsHelp', 'For a failed check, Read annotations shows plain text output and file locations. GitHub Actions checks also offer Download logs and Re-run job after annotations load. Ask agent to fix CI explicitly sends the displayed check and captured PR head to the initiating conversation, or queues it behind an active Turn, using normal permissions. No request is sent while reading checks. A changed session, account or PR head invalidates old operations; an uncertain submission must be checked before retrying.') + '\n' + localize('sessions.changes.followUpHelp', 'Follow PR checks starts background CI observation for the displayed PR and this conversation. It requests one repair per commit after all checks finish. Stop PR follow-up pauses observation and stops its current repair. Follow-up history opens Automations to inspect runs and their conversations. Follow-up continues after the window closes; account changes require enabling it again.') + '\n' + localize('sessions.changes.operationsHelp', 'Use Tab to reach the summary and actions. Retry loading changes reloads a failed list. Sync changes pulls and pushes the session repository; Publish branch publishes it. Review working tree opens live uncommitted changes. Create pull request opens an editable form; publish the source branch before creating the pull request. Checks shows all check runs and commit statuses for associated open pull requests. Enter or Space on Checks expands or collapses the list. Check links open the full results. Switching sessions or accounts clears old checks; hiding Changes cancels its reads.');
}
