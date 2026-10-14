import { canceled } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { buildOpenSessionLinkUri, OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

// Desktop and Web currently each expose one profile-owned App Server. SSH execution
// targets belong to that server's Sessions; they are not separate chat connections.
const connectionAuthority = 'local';

async function withConversation(chat: IChatService, appServer: IAppServerApi, sessionId: string, threadId: string, operation: () => Promise<void>): Promise<void> {
	const generation = appServer.connectionGeneration;
	let retired = false;
	// Close can retire a resolved response before its consumer runs without changing generation.
	const listener = appServer.onConnectionState(state => { if (state !== 'ready') retired = true; });
	try {
		const result = await chat.readThread(sessionId, threadId);
		const state = await appServer.getConnectionState();
		if (retired || generation !== appServer.connectionGeneration || state !== 'ready') throw canceled();
		if (result.thread.sessionId !== sessionId || result.thread.threadId !== threadId) {
			throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
		}
		await operation();
	} finally {
		listener.dispose();
	}
}

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
		await withConversation(accessor.get(IChatService), accessor.get(IAppServerApi), sessionId, threadId,
			() => clipboard.writeText(buildOpenSessionLinkUri(sessionId, threadId, connectionAuthority).toString()));
		accessibility.status(localize('chat.sessionLink.copied', 'Conversation link copied to clipboard'));
	}
}

/** Opens conversation links inside the current owner instead of sending them to the OS. */
export class ChatSessionLinkOpener extends Disposable {
	constructor(
		@IOpenerService opener: IOpenerService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IChatService private readonly chat: IChatService,
		@IAppServerApi private readonly appServer: IAppServerApi,
	) {
		super();
		this._register(opener.registerOpener({ open: target => this.open(target) }));
	}

	private async open(target: URI | string): Promise<boolean> {
		const resource = typeof target === 'string' ? URI.parse(target) : target;
		if (resource.scheme !== OPEN_SESSION_LINK_SCHEME) return false;
		let link;
		try { link = parseOpenSessionLinkUri(resource); }
		catch { throw new Error(localize('chat.sessionLink.invalid', 'This conversation link is invalid.')); }
		if (link.connectionAuthority !== connectionAuthority) {
			throw new Error(localize('chat.sessionLink.connection', 'The connection for this conversation link is unavailable.'));
		}
		await withConversation(this.chat, this.appServer, link.sessionId, link.threadId, async () => {
			if (this.isDisposed) throw canceled();
			await this.navigation.openConversation(link.sessionId, link.threadId);
		});
		return true;
	}
}

export function registerChatCopyActions(): void {
	registerAction2(CopyChatSessionLinkAction);
}
