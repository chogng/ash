import type { ChatContextAttachment } from '../../services/chat/common/chatContextService.js';
import type { ITerminalOutputSnapshot } from '../../../platform/terminal/common/terminal.js';

/** Stable command identity shared by terminal menus and Chat integration. */
export const enum TerminalChatCommandId {
	AttachToChat = 'workbench.action.terminal.attachToChat',
}

/** Only accepted display snapshots offer a passive terminal preview. */
export function isTerminalChatAttachment(attachment: ChatContextAttachment): attachment is ChatContextAttachment & { readonly terminalSnapshot: ITerminalOutputSnapshot } {
	return attachment.kind === 'terminal' && attachment.terminalSnapshot !== undefined;
}
