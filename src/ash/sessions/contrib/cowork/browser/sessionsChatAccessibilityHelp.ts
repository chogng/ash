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
			() => localize('cowork.inputHelp', 'Cowork input\nPress Enter to send and Shift+Enter for a new line. The + button attaches UTF-8 text files or images; you can also paste or drop images into the input. Attachments can be sent without text. Attachments are on the left of the input card; model, model options, dictation, and Send are on the right. Use Tab and Shift+Tab to reach the toolbar, and arrow keys to move between its actions. Press Enter or Space to open a picker and Escape to return. Use /permission to choose permissions and /guardian setup to prepare review background. Approval requests list the requested actions and exact targets. Use Tab to reach Decline or Approve once, then press Enter or Space.') + '\n' + localize('hooks.feedbackHelp', 'Hook blocks and failures appear in the conversation. Use Tab to reach a Hook summary and Enter or Space to expand its reason. Execution Trace shows status and duration; enable detailed recording to load commands and input/output on demand.') + '\n' + localize('sessions.chat.linkHelp', 'Use Tab to reach links in Chat responses and Enter to open them. Extension providers can show a link title, status, reference and change counts. Link updates keep the opening target and keyboard focus.'),
			this.focusInput,
			AccessibilityVerbositySettingId.Chat,
		);
	}
}
