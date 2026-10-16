import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize } from '../../../../../nls.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { createImageAttachment } from '../chatImageUtils.js';

/** Reuses the image pipeline so screenshot previews, hashes and draft persistence agree. */
export function convertBufferToScreenshotVariable(buffer: VSBuffer): Promise<ChatContextAttachment> {
	return createImageAttachment(localize('chat.context.screenshotName', 'Screenshot'), buffer.buffer, 'image/png');
}
