import { localize } from '../../../../nls.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IChatGPTService } from '../browser/chatGPTService.js';
import { shareConversationLink } from '../../chat/browser/conversationShareDialog.js';

export async function shareChatGPTConversation(chat: IChatGPTService, dialogs: IDialogService, clipboard: IClipboardService, id: string, title: string, messageId?: string): Promise<void> {
	const scope = chat.state.get().catalogScope;
	await shareConversationLink(dialogs, clipboard, {
		message: messageId ? localize('sessions.chatgpt.shareResponseConfirm', 'Share through this response in “{0}”?', title)
			: localize('sessions.chatgpt.shareConfirm', 'Share “{0}”?', title),
		detail: localize('sessions.chatgpt.shareDetail', 'A ChatGPT share link will be created and copied. Anyone with the link may be able to read this chat.'),
	}, async () => {
		if (scope !== chat.state.get().catalogScope) return undefined;
		const url = await chat.share(id, messageId);
		const state = chat.state.get();
		if (scope !== state.catalogScope) return undefined;
		if (!url) {
			throw new Error(state.error || localize('sessions.chatgpt.shareFailed', 'Could not create a ChatGPT share link. Try again.'));
		}
		return url;
	});
}
