import './createSessionFromPullRequestAction.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IChecksOperationService } from '../common/checksOperationService.js';
import { CreatePullRequestFocusedContext } from '../common/pullRequestCreation.js';
import { ChecksOperationService } from './checksOperationService.js';

registerSingleton(IChecksOperationService, ChecksOperationService, InstantiationType.Delayed);

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
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
}
