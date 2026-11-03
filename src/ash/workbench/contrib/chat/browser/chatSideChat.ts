import type { IChatSideChatSelection } from '../common/chatSideChatService.js';
import type { IChatWidget } from './chat.js';

/** Capture only a selection owned by this transcript, never text selected in another editor. */
export function captureSideChatSelection(widget: IChatWidget | undefined): IChatSideChatSelection | undefined {
	const selection = widget?.domNode.ownerDocument.getSelection();
	const transcript = widget?.domNode.querySelector('.ash-chat-list-widget, .ash-cowork-list-widget');
	if (!selection || !transcript || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !transcript.contains(selection.anchorNode) || !transcript.contains(selection.focusNode)) return undefined;
	const text = selection.toString();
	return text.trim() ? { text } : undefined;
}
