import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, constObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ILinkPresentationService, type ILinkPresentation } from '../../../../platform/dataChannel/common/dataChannel.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { parseSessionProviderAuthority, sessionIdentity } from '../../../services/sessions/common/sessionIdentity.js';
import { getSessionSummaryHoverData } from '../../sessions/browser/sessionHoverContent.js';
import { sessionManagementLabel } from '../../../browser/sessionManagementLabels.js';

class OpenSessionLinkOpenerContribution extends Disposable {
	constructor(
		@IOpenerService opener: IOpenerService,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@ILinkPresentationService linkPresentation: ILinkPresentationService,
		@ISessionsManagementService sessions: ISessionsManagementService,
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
		this._register(linkPresentation.registerLinkPresentationProvider({
			id: 'sessions.conversationLink',
			kind: 'chat',
			uriPattern: new RegExp(`^${OPEN_SESSION_LINK_SCHEME}://`, 'i'),
		}, {
			createLinkPresentationWatcher: resource => {
				let sessionId: string;
				let threadId: string;
				let providerId: string;
				try {
					const address = parseOpenSessionLinkUri(resource);
					providerId = parseSessionProviderAuthority(address.connectionAuthority, LOCAL_AGENT_HOST_PROVIDER_ID);
					sessionId = sessionIdentity(providerId, address.sessionId, LOCAL_AGENT_HOST_PROVIDER_ID);
					threadId = sessionIdentity(providerId, address.threadId, LOCAL_AGENT_HOST_PROVIDER_ID);
				} catch {
					return Object.assign(toDisposable(() => { }), { presentation: constObservable(undefined) });
				}
				const readPresentation = (): ILinkPresentation | undefined => {
					const session = sessions.sessions.find(session => session.sessionId === sessionId
						&& (session.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID) === providerId);
					const chat = session?.chats.find(chat => chat.threadId === threadId);
					if (!session || !chat) return undefined;
					const title = chat.title || session.title;
					const management = chat.management ?? (chat.origin.type === 'root' ? session.management : undefined);
					const tooltip = [title, sessionManagementLabel(management), management?.activity?.text, management?.summary,
						...getSessionSummaryHoverData(session, chat)].filter(Boolean).join(' · ');
					return { kind: 'chat', title, tooltip };
				};
				const presentation = observableValue('sessionLinkPresentation', readPresentation());
				const listener = sessions.onDidChange(() => {
					const next = readPresentation();
					const previous = presentation.get();
					if (next?.title !== previous?.title || next?.tooltip !== previous?.tooltip) presentation.set(next);
				});
				return Object.assign(listener, { presentation });
			},
		}));
	}
}

registerWorkbenchContribution('sessions.openSessionLinkOpener', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(OpenSessionLinkOpenerContribution));
