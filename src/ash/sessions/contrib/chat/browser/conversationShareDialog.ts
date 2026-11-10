import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

export async function shareConversationLink(
	dialogs: IDialogService,
	clipboard: IClipboardService,
	prompt: { readonly message: string; readonly detail: string; },
	publish: () => Promise<string | undefined>,
): Promise<void> {
	const confirmation = await dialogs.confirm({
		...prompt,
		title: localize('sessions.chat.shareTitle', 'Share conversation'),
		primaryButton: localize('sessions.titlebar.share', 'Share'),
		layout: 'form',
	});
	if (!confirmation.confirmed) return;
	const url = await publish();
	if (!url) return;
	try {
		await clipboard.writeText(url);
		status(localize('sessions.chatgpt.shareCopied', 'Share link copied.'));
	} catch {
		await dialogs.info(localize('sessions.chatgpt.shareLink', 'Share link'), url);
	}
}
