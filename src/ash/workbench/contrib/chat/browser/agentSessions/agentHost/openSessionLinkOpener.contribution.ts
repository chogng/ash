import { canceled } from '../../../../../../base/common/errors.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../../../platform/agentHost/common/openSessionLink.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IChatService } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../../services/chat/common/chatSessionNavigationService.js';

const connectionAuthority = 'local';

/** Opens conversation links inside the current owner instead of sending them to the OS. */
export class AgentHostOpenSessionLinkOpenerContribution extends Disposable {
	public static readonly ID = 'workbench.chat.agentHostOpenSessionLinkOpener';

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
		if (resource.scheme !== OPEN_SESSION_LINK_SCHEME) {
			return false;
		}
		let link;
		try {
			link = parseOpenSessionLinkUri(resource);
		} catch {
			throw new Error(localize('chat.sessionLink.invalid', 'This conversation link is invalid.'));
		}
		if (this.navigation.openConversationLink) {
			await this.navigation.openConversationLink(link);
			if (this.isDisposed) {
				throw canceled();
			}
			return true;
		}
		if (link.connectionAuthority !== connectionAuthority) {
			throw new Error(localize('chat.sessionLink.connection', 'The connection for this conversation link is unavailable.'));
		}
		await withChatConversation(this.chat, this.appServer, link.sessionId, link.threadId, async () => {
			if (this.isDisposed) {
				throw canceled();
			}
			await this.navigation.openConversation(link.sessionId, link.threadId);
		});
		return true;
	}
}
