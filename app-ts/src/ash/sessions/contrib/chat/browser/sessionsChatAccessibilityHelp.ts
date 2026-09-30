import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';

/** Gives each composer help and a focus-return target in its own document. */
export class SessionsChatAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly type = AccessibleViewType.Help;
	public readonly priority = 90;
	public readonly name = `sessionsChat-${createUuid()}`;

	constructor(private readonly container: HTMLElement, private readonly focusInput: () => void) {}

	public getProvider(): AccessibleContentProvider | undefined {
		if (!this.container.contains(this.container.ownerDocument.activeElement)) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsChat,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.chat.inputHelp', 'Chat input\nPress Enter to send and Shift+Enter for a new line. Use Tab and Shift+Tab to reach attachments, Agent, model, thinking effort, dictation, Send, and Permissions. Press Enter or Space to open a menu, use arrow keys to select an item, and Escape to return. Use the + button to attach UTF-8 text files or images, or paste and drop images into the input. Attachments can be sent without text. The Permissions menu applies to the next Turn.'),
			this.focusInput,
			AccessibilityVerbositySettingId.Chat,
		);
	}
}
