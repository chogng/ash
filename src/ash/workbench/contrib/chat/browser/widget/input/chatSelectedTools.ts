import { localize } from '../../../../../../nls.js';
import { parseChatToolSelection, type ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';

/** Reads the selection from the originating composer's draft attachments. */
export async function readChatSelectedTools(attachments: readonly ChatContextAttachment[]): Promise<readonly string[]> {
	const selection = attachments.find(attachment => attachment.kind === 'toolSelection');
	return selection ? parseChatToolSelection((await selection.resolve()).content) : [];
}

export function createToolSelectionAttachment(disabled: readonly string[]): ChatContextAttachment {
	const content = JSON.stringify([...disabled].sort());
	const name = localize('chat.tools.selection', 'Tool selection: {0} disabled', disabled.length);
	return {
		id: 'tool-selection', kind: 'toolSelection', name,
		resolve: async () => ({ name, content, kind: 'toolSelection' }),
	};
}
