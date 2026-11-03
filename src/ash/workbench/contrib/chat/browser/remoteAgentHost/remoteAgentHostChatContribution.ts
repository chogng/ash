import { canceled } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

/** Opens remote conversations through the window's registered session providers. */
export class RemoteAgentHostContribution extends Disposable {
	static readonly ID = 'workbench.contrib.remoteAgentHostContribution';

	constructor(
		@IOpenerService opener: IOpenerService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
	) {
		super();
		this._register(opener.registerOpener({ open: target => this.open(target) }));
	}

	private async open(target: URI | string): Promise<boolean> {
		const resource = typeof target === 'string' ? URI.parse(target) : target;
		if (resource.scheme !== OPEN_SESSION_LINK_SCHEME || resource.authority === 'local') {
			return false;
		}
		let link;
		try {
			link = parseOpenSessionLinkUri(resource);
		} catch {
			throw new Error(localize('chat.sessionLink.invalid', 'This conversation link is invalid.'));
		}
		if (!this.navigation.openConversationLink) {
			throw new Error(localize('chat.sessionLink.connection', 'The connection for this conversation link is unavailable.'));
		}
		await this.navigation.openConversationLink(link);
		if (this.isDisposed) {
			throw canceled();
		}
		return true;
	}
}
