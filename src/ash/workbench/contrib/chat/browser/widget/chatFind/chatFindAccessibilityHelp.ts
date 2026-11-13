import { localize } from '../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { getFocusedFindController } from '../../actions/chatFindActions.js';

export class ChatFindAccessibilityHelp implements IAccessibleViewImplementation {
	public readonly name = 'chatFind';
	public readonly type = AccessibleViewType.Help;
	public readonly priority = 130;
	public readonly when = ChatContextKeys.findWidgetFocused.isEqualTo(true);

	public getProvider(accessor: ServicesAccessor): AccessibleContentProvider | undefined {
		const controller = getFocusedFindController(accessor);
		if (!controller?.visible) { return undefined; }
		return new AccessibleContentProvider(AccessibleViewProviderId.ChatFindHelp, { type: AccessibleViewType.Help },
			() => localize('chat.find.help', 'Find in Chat\nSearch user messages, assistant replies and voice transcripts. Markdown links match their visible labels; code blocks match their complete source even outside the viewport. Reasoning, tool evidence and unsent drafts are excluded. Selected message text seeds the query. Enter and Shift+Enter move to the next and previous match. While the conversation has focus, {0} and {1} navigate and reopen a closed Find without moving focus. Input method composition is searched after it is committed. Results wrap around and the current match is announced. Tab reaches Match case, Whole word, Regular expression, navigation and Close Find. Invalid expressions are reported without changing the conversation. Earlier messages are searched through the existing history loader. A progress label reports pending history; Search earlier messages continues large searches or retries a failed page. Escape closes Find and returns focus to the invoking control. Hiding the conversation stops further search work. Streaming updates preserve the current match when it still exists. Closing this help returns focus to Find.', '<keybinding:workbench.action.chat.findNext>', '<keybinding:workbench.action.chat.findPrevious>'),
			() => controller.focus(), AccessibilityVerbositySettingId.Find);
	}
}
