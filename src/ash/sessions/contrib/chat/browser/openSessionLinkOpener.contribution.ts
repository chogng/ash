import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';

class OpenSessionLinkOpenerContribution extends Disposable {
	constructor(
		@IOpenerService opener: IOpenerService,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
	) {
		super();
		this._register(opener.registerOpener({
			open: async (target, options) => {
				const resource = typeof target === 'string' ? URI.parse(target) : target;
				if (resource.scheme !== OPEN_SESSION_LINK_SCHEME) { return false; }
				let address;
				try {
					address = parseOpenSessionLinkUri(resource);
				} catch {
					throw new Error(localize({ bundle: 'ash', key: 'chat.sessionLink.invalid' }, 'This conversation link is invalid.'));
				}
				if (!navigation.openConversationLink) {
					throw new Error(localize({ bundle: 'ash', key: 'chat.sessionLink.connection' }, 'The connection for this conversation link is unavailable.'));
				}
				await navigation.openConversationLink(address, { sideBySide: options?.openToSide === true });
				return true;
			},
		}));
	}
}

registerWorkbenchContribution('sessions.openSessionLinkOpener', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(OpenSessionLinkOpenerContribution));
