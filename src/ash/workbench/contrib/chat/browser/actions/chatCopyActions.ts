import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatService, type ThreadRead } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';
import { toPortableMarkdown } from '../widget/chatClipboard.js';

// Single-host owners retain the established local address namespace.
const connectionAuthority = 'local';

export class CopyChatSessionLinkAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.copySessionLink',
			title: localize2('chat.copySessionLink', 'Chat: Copy Conversation Link'),
			shortTitle: localize2('chat.copySessionLink.label', 'Copy Conversation Link'),
			f1: true,
			menu: { id: MenuId.ChatTitle, group: '1_cutcopypaste', order: 10 },
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const navigation = accessor.get(IChatSessionNavigationService);
		const selected = context === undefined ? navigation.getActiveConversation() : context;
		if (!selected || typeof selected !== 'object' || !('sessionId' in selected) || !('threadId' in selected)
			|| typeof selected.sessionId !== 'string' || !selected.sessionId || typeof selected.threadId !== 'string' || !selected.threadId) {
			throw new Error(localize('chat.sessionLink.draft', 'Send a message in this conversation before copying its link.'));
		}
		// Capture the command target before asynchronous reads; later selection changes cannot redirect it.
		const { sessionId, threadId } = selected;
		const clipboard = accessor.get(IClipboardService);
		const accessibility = accessor.get(IAccessibilityService);
		if (navigation.prepareConversationLink) {
			const address = await navigation.prepareConversationLink(sessionId, threadId);
			await clipboard.writeText(buildOpenSessionLinkUri(address.sessionId, address.threadId, address.connectionAuthority).toString());
		} else {
			await withChatConversation(accessor.get(IChatService), accessor.get(IAppServerApi), sessionId, threadId,
				() => clipboard.writeText(buildOpenSessionLinkUri(sessionId, threadId, connectionAuthority).toString()));
		}
		accessibility.status(localize('chat.sessionLink.copied', 'Conversation link copied to clipboard'));
	}
}

export function registerChatCopyActions(): void {
	for (const finalResponse of [false, true]) {
		registerAction2(class CopyAllAction extends Action2 {
			constructor() {
				super({
					id: finalResponse ? 'workbench.action.chat.copyFinalResponse' : 'workbench.action.chat.copyAll',
					title: finalResponse ? localize2('chat.copyFinalResponse', 'Chat: Copy Final Response') : localize2('chat.copyAll', 'Chat: Copy Conversation'),
					precondition: ChatContextKeys.enabled.isEqualTo(true),
					f1: true,
				});
			}

			public override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
				const navigation = accessor.get(IChatSessionNavigationService);
				const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
				const selected = context === undefined ? widget ?? navigation.getActiveConversation() : context;
				if (!selected || typeof selected !== 'object' || !('sessionId' in selected) || !('threadId' in selected)
					|| typeof selected.sessionId !== 'string' || !selected.sessionId || typeof selected.threadId !== 'string' || !selected.threadId) {
					return;
				}
				const { sessionId, threadId } = selected;
				const chat = accessor.get(IChatService);
				const clipboard = accessor.get(IClipboardService);
				const accessibility = accessor.get(IAccessibilityService);
				const copy = async (conversation: ThreadRead): Promise<void> => {
					// Read the owning transcript, including history outside the mounted list.
					const messages: string[] = [];
					for (const entry of conversation.transcript.entries) {
						if (finalResponse && !(entry.type === 'item' && entry.item.type === 'agentMessage' && !entry.transient && (entry.item.phase == null || entry.item.phase === 'final_answer')
							|| entry.type === 'voiceTranscript' && entry.transcript.speaker !== 'user')) { continue; }
						let speaker: string;
						let text: string;
						if (entry.type === 'item' && (entry.item.type === 'userMessage' || entry.item.type === 'agentMessage')) {
							speaker = entry.item.type === 'userMessage' ? localize('chat.copyAll.user', 'User') : localize('chat.copyAll.assistant', 'Assistant');
							text = entry.item.text;
						} else if (entry.type === 'voiceTranscript') {
							speaker = entry.transcript.speaker === 'user' ? localize('chat.copyAll.user', 'User') : localize('chat.copyAll.assistant', 'Assistant');
							text = entry.transcript.text;
						} else {
							continue;
						}
						if (text) {
							if (finalResponse) { messages.splice(0, messages.length, text); }
							else { messages.push(`${speaker}: ${text}`); }
						}
					}
					if (messages.length) {
						await clipboard.writeText(toPortableMarkdown(messages.join('\n\n')));
						accessibility.status(finalResponse ? localize('chat.copyFinalResponse.copied', 'Final response copied to clipboard') : localize('chat.copyAll.copied', 'Conversation copied to clipboard'));
					}
				};
				const connection = navigation.captureConnection?.(sessionId);
				try {
					if (connection) {
						await connection.assertCurrent();
						const conversation = await chat.readThread(sessionId, threadId);
						await connection.assertCurrent();
						await copy(conversation);
					} else {
						const appServer = accessor.get(IAppServerApi);
						await withChatConversation(chat, appServer, sessionId, threadId, copy);
					}
				} finally {
					connection?.dispose();
				}
			}
		});

	}

	registerAction2(class CopyItemAction extends Action2 {
		constructor() { super({ id: 'workbench.action.chat.copyItem', title: localize2('chat.message.copy', 'Copy message') }); }
		public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (!context || typeof context !== 'object' || !('text' in context) || typeof context.text !== 'string' || !('type' in context) || context.type !== 'agentMessage' && context.type !== 'userMessage') return;
			await accessor.get(IClipboardService).writeText(toPortableMarkdown(context.text));
		}
	});
	registerAction2(CopyChatSessionLinkAction);
}
