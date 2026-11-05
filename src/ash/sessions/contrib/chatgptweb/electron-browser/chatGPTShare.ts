import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IChatGPTService } from '../browser/chatGPTService.js';

export async function shareChatGPTConversation(chat: IChatGPTService, dialogs: IDialogService, clipboard: IClipboardService, id: string, title: string, messageId?: string): Promise<void> {
	const result = await dialogs.confirm({
		message: messageId ? localize('sessions.chatgpt.shareResponseConfirm', 'Share through this response in “{0}”?', title)
			: localize('sessions.chatgpt.shareConfirm', 'Share “{0}”?', title),
		detail: localize('sessions.chatgpt.shareDetail', 'Anyone with the link may be able to read this chat. A share link will be created and copied.'),
		primaryButton: localize('sessions.chatgpt.share', 'Share'),
	});
	if (!result.confirmed) return;
	const url = await chat.share(id, messageId);
	if (!url) return;
	try {
		await clipboard.writeText(url);
		status(localize('sessions.chatgpt.shareCopied', 'Share link copied.'));
	} catch {
		await dialogs.info(localize('sessions.chatgpt.shareLink', 'Share link'), url);
	}
}
