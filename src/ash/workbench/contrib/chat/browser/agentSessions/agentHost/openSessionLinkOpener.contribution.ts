import { canceled } from '../../../../../../base/common/errors.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../../../platform/agentHost/common/openSessionLink.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IChatService } from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../../services/chat/common/chatSessionNavigationService.js';

/** Opens conversation links on the current window’s ambient host. */
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
		if (resource.scheme !== OPEN_SESSION_LINK_SCHEME || resource.authority !== 'local') {
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
		await withChatConversation(this.chat, this.appServer, link.sessionId, link.threadId, async () => {
			if (this.isDisposed) {
				throw canceled();
			}
			await this.navigation.openConversation(link.sessionId, link.threadId);
		});
		return true;
	}
}
