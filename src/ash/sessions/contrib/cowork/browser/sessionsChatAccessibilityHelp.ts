import { localize } from '../../../../nls.js';

/** Product-specific help appended by the shared input's accessibility provider. */
export function getCoworkChatAccessibilityHelp(): string {
	return [
		localize({ bundle: 'ash', key: 'sessions.closeSplitHelp' }, 'When conversations are side by side, use Tab to reach Close Session in the pane you want to close. Press Enter or Space to close it and move focus to the remaining conversation.'),
		localize('cowork.inputHelp', 'Cowork input\nPress Enter to send and Shift+Enter for a new line. The + button attaches UTF-8 text files or images; you can also paste or drop images into the input. Attachments can be sent without text. Attachments are on the left of the input card; model, model options, dictation, and Send are on the right. Use Tab and Shift+Tab to reach the toolbar, and arrow keys to move between its actions. Press Enter or Space to open a picker and Escape to return. Slash-prefixed text is sent as a normal message. Use $ to choose Skills and @ or # to attach context. Approval requests list the requested actions and exact targets. Use Tab to reach Decline or Approve once, then press Enter or Space.'),
		localize('sessions.chat.linkHelp', 'Use Tab to reach links in Chat responses and Enter to open them. Extension providers can show a link title, status, reference and change counts. Link updates keep the opening target and keyboard focus.'),
	].join('\n');
}
