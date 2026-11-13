import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { conversationShareId, conversationShareMaxBytes, conversationShareMaxMessages, conversationShareRetentionDays, type ConversationShare, type ConversationShareMessage } from '../../../../platform/chat/common/conversationShare.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ChatResponseActionContext } from '../../../../workbench/contrib/chat/browser/chat.js';
import { toPortableMarkdown } from '../../../../workbench/contrib/chat/browser/widget/chatClipboard.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import type { ChatResponseFeedbackTarget } from '../../../../workbench/contrib/chat/common/chatResponseFeedback.js';
import { getCompletedChatResponseSource } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { shareConversationLink } from './conversationShareDialog.js';

const shareServiceSetting = 'sessions.chat.shareServiceUrl';
const defaultShareService = 'https://ash-chat-share.lanxiang0901.workers.dev';

function shareServiceOrigin(value: unknown): string {
	if (typeof value === 'string') {
		let url: URL | undefined;
		try { url = new URL(value); } catch { /* Report invalid configuration below. */ }
		if (url && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
			if (url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') return url.origin;
		}
	}
	throw new TypeError(localize('sessions.chat.shareServiceInvalid', 'Enter an HTTPS service origin or an HTTP loopback origin for local testing.'));
}

export function registerNativeConversationSharing(): void {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key: shareServiceSetting,
		defaultValue: defaultShareService,
		scope: ConfigurationScope.APPLICATION_MACHINE,
		parse: shareServiceOrigin,
		setting: {
			valueType: 'text',
			title: localize('sessions.chat.shareServiceTitle', 'Ash conversation share service'),
			description: localize('sessions.chat.shareServiceDescription', 'The service that stores public links for native Ash conversations.'),
			placeholder: defaultShareService,
		},
	});
	registerAction2(class ShareAshResponseAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.chat.response.share',
				title: localize2('sessions.chat.shareResponse', 'Share Ash response'),
				icon: Lxicon.share,
				menu: {
					id: MenuId.ChatMessageFooter, group: 'navigation', order: 11,
					when: ContextKeyExpr.and(ChatContextKeys.messageActionSurface.isEqualTo('chat'), ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.responseHasConversationLink.isEqualTo(true)),
				},
			});
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			const source = context instanceof ChatResponseActionContext && context.visible && context.surface === 'chat' && getCompletedChatResponseSource(context.item);
			if (!source) return;
			const sharing = accessor.get(IInstantiationService).createInstance(NativeConversationShare);
			await sharing.share(source.sessionId, source.threadId, source);
		}
	});
}

/** Publishes the branch's message history from its owning Ash connection. */
export class NativeConversationShare {
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IChatService private readonly chat: IChatService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IClipboardService private readonly clipboard: IClipboardService,
	) { }

	async share(sessionId: string, threadId: string, target: string | Pick<ChatResponseFeedbackTarget, 'turnId' | 'itemId'>): Promise<void> {
		const origin = shareServiceOrigin(this.configuration.getValue(shareServiceSetting));
		using connection = this.navigation.captureConnection?.(sessionId);
		if (!connection) throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
		await shareConversationLink(this.dialogs, this.clipboard, {
			message: typeof target === 'string' ? localize('sessions.chat.shareConfirm', 'Share “{0}”?', target)
				: localize('sessions.chat.shareResponseConfirm', 'Share through this response?'),
			detail: localize('sessions.chat.shareDetail', 'Share a copy of the conversation text with anyone who has the link. The copy is stored at {0} for {1} days.', origin, conversationShareRetentionDays),
		}, async () => {
			await connection.assertCurrent();
			const conversation = await this.chat.readThread(sessionId, threadId);
			await connection.assertCurrent();
			if (conversation.thread.sessionId !== sessionId || conversation.thread.threadId !== threadId) {
				throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
			}
			const entries = conversation.transcript.entries;
			let sharedEntries = entries;
			if (typeof target !== 'string') {
				const reply = entries.findIndex(entry => entry.type === 'item' && !entry.transient && entry.turnId === target.turnId
					&& entry.item.type === 'agentMessage' && entry.item.itemId === target.itemId);
				if (reply < 0) throw new Error(localize('sessions.chat.shareResponseMissing', 'This response is no longer available to share.'));
				sharedEntries = entries.slice(0, reply + 1);
			}
			const messages: ConversationShareMessage[] = [];
			for (const entry of sharedEntries) {
				if (entry.type === 'item' && !entry.transient && (entry.item.type === 'userMessage' || entry.item.type === 'agentMessage')) {
					messages.push({
						role: entry.item.type === 'userMessage' ? 'user' : 'assistant',
						text: toPortableMarkdown(entry.item.text),
						timestamp: entry.timestamp,
					});
				} else if (entry.type === 'voiceTranscript') {
					messages.push({ role: entry.transcript.speaker === 'user' ? 'user' : 'assistant', text: entry.transcript.text });
				}
			}
			if (!messages.length) throw new Error(localize('sessions.chat.shareEmpty', 'This conversation has no messages to share yet.'));
			const snapshot: ConversationShare = { version: 1, title: typeof target === 'string' ? target : conversation.thread.title, messages };
			const body = new TextEncoder().encode(JSON.stringify(snapshot));
			if (messages.length > conversationShareMaxMessages || body.byteLength > conversationShareMaxBytes) {
				throw new Error(localize('sessions.chat.shareTooLarge', 'This conversation is too large to share. The limit is 10 MB and 10,000 messages.'));
			}
			const failed = localize('sessions.chat.shareFailed', 'Could not create a share link. Check the share service and try again.');
			let response: Response;
			try {
				response = await fetch(new URL('/v1/shares', origin), {
					method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
					credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000),
				});
			} catch { throw new Error(failed); }
			if (response.status !== 201) throw new Error(failed);
			const location = response.headers.get('Location');
			if (!location?.startsWith('/s/') || !conversationShareId.test(location.slice(3))) throw new Error(failed);
			return new URL(location, origin).href;
		});
	}
}
