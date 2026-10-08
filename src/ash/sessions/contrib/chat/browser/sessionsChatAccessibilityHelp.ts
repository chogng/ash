import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';

/** Gives each composer help and a focus-return target in its own document. */
export class SessionsChatAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly type = AccessibleViewType.Help;
	public readonly priority = 90;
	public readonly name = `sessionsChat-${createUuid()}`;

	constructor(private readonly container: HTMLElement, private readonly focusInput: () => void) { }

	public getProvider(): AccessibleContentProvider | undefined {
		if (!this.container.contains(this.container.ownerDocument.activeElement)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsChat,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.chat.inputHelp', 'Chat input\nPress Enter to send and Shift+Enter for a new line. Use Tab and Shift+Tab to reach attachments, Agent, model, thinking effort, dictation, Send, and Permissions. Press Enter or Space to open a menu, use arrow keys to select an item, and Escape to return. Use the + button to attach UTF-8 text files or images, or paste and drop images into the input. Attachments can be sent without text. The Permissions menu offers Auto, Manual, and Bypass permissions for the next Turn. While this menu is open, press 1, 2, or 3 to choose a permission mode. Bypass permissions requires confirmation. Review model and Prepare review environment are available below these choices. Environment preparation lets you choose scan scope, review and edit each entry, then save accepted entries. Recent project sessions are optional. Adjust the session limit, commands per session and time range before scanning; the default is 50 sessions, 200 commands per session and all dates. Historical facts show frequency, session counts and source samples. Scan coverage shows how much history and how many facts were included; limits may leave coverage partial. Messages and ordinary arguments are excluded. Use /permission to choose permissions and /guardian setup to prepare review background. /init writes ASH.md, which Guardian reads as untrusted project context. Saved project sources refresh before review; changed target descriptions need confirmation. Escape cancels the scan. Saved target descriptions do not authorize actions. Review settings choose an independent connection, model and thinking effort. Plan and Ask permit investigation only. Leaving Plan or Ask for Agent, Debug or Multitask requires your choice and keeps the permission selection. A different mode selected for the next message is kept. Approval requests list the requested actions and exact targets. Use Tab to reach Decline or Approve once, then press Enter or Space.') + '\n' + localize('sessions.chat.pullRequestHelp', 'Session pull requests appear above the input. Use Tab to reach a pull request and Enter to open it. Its accessible name includes its state, failed checks, merge conflicts and unresolved review comments. The Review button opens the shared Ash PR editor, where you can request Codex review, read discussions and open Codex review settings. Use Tab to reach links in Chat responses and Enter to open them. Extension providers can show a link title, status, reference and change counts. Link updates keep the opening target and keyboard focus.') + '\n' + localize('sessions.management.help', 'The session list shows background activity without opening conversations. Needs input, Working, Ready for review, Failed and Stopped are management states. Session History shows the state of each branch. Opening a branch preserves the other conversations and drafts.') + '\n' + localize('sessions.github.attachHelp', 'Use Attach PR to enter an HTTPS pull request URL. Escape cancels and returns focus. Remove detaches a manually attached pull request; it does not close the pull request on GitHub or remove an automatic branch association.'),
			this.focusInput,
			AccessibilityVerbositySettingId.Chat,
		);
	}
}
