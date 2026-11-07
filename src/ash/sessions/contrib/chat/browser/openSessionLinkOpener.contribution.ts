import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { constObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { OPEN_SESSION_LINK_SCHEME, parseOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ILinkPresentationService, type ILinkPresentation } from '../../../../platform/dataChannel/common/dataChannel.js';
import { ISessionSummaryHoverService } from '../../../../workbench/contrib/chat/browser/agentSessions/sessionSummaryHoverService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { agentHostSessionWorkspaceKey } from '../../../common/agentHostSessionWorkspace.js';
import { chatExecutionWorkspace, type IChat, type ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { parseSessionProviderAuthority, sessionIdentity } from '../../../services/sessions/common/sessionIdentity.js';
import { getSessionSummaryHoverData, loadSessionSummaryHoverDetails } from '../../sessions/browser/sessionHoverContent.js';
import { sessionManagementLabel } from '../../../browser/sessionManagementLabels.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { getPullRequestLabel } from '../../github/common/types.js';

export class OpenSessionLinkOpenerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.openSessionLinkOpener';

	constructor(
		@IOpenerService opener: IOpenerService,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@ILinkPresentationService linkPresentation: ILinkPresentationService,
		@ISessionSummaryHoverService summaryHover: ISessionSummaryHoverService,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@ISessionProviderScopeService scopes: ISessionProviderScopeService,
		@IGitHubService github: IGitHubService,
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
		this._register(summaryHover.registerProvider({
			onDidChange: Event.any(sessions.onDidChange, github.onDidChange),
			provideSessionSummaryHoverData: resource => {
				const target = parseSessionLinkTarget(resource);
				const resolved = target && resolveSessionLink(sessions, target);
				if (!resolved) {
					return undefined;
				}
				const { session, chat } = resolved;
				const management = chat.management ?? (chat.origin.type === 'root' ? session.management : undefined);
				const pullRequests = chat.origin.type === 'root' ? github.getSessionPullRequests(session.sessionId).map(getPullRequestLabel) : [];
				const details = [sessionManagementLabel(management), management?.activity?.text, management?.summary,
				...getSessionSummaryHoverData(session, chat), ...pullRequests].filter((value): value is string => !!value);
				return {
					title: chat.title || session.title,
					details,
					detailsSourceKey: agentHostSessionWorkspaceKey(chatExecutionWorkspace(session, chat)),
					loadDetails: token => loadSessionSummaryHoverDetails(sessions, scopes, session.sessionId, chat.threadId, token),
				};
			},
		}));
		this._register(linkPresentation.registerLinkPresentationProvider({
			id: 'sessions.conversationLink',
			kind: 'chat',
			uriPattern: new RegExp(`^${OPEN_SESSION_LINK_SCHEME}://`, 'i'),
		}, {
			createLinkPresentationWatcher: resource => {
				const target = parseSessionLinkTarget(resource);
				if (!target) {
					return Object.assign(toDisposable(() => { }), { presentation: constObservable(undefined) });
				}
				const readPresentation = (): ILinkPresentation | undefined => {
					const resolved = resolveSessionLink(sessions, target);
					return resolved ? { kind: 'chat', title: resolved.chat.title || resolved.session.title } : undefined;
				};
				const presentation = observableValue('sessionLinkPresentation', readPresentation());
				const listener = sessions.onDidChange(() => {
					const next = readPresentation();
					if (next?.title !== presentation.get()?.title) {
						presentation.set(next);
					}
				});
				return Object.assign(listener, { presentation });
			},
		}));
	}
}

interface SessionLinkTarget {
	readonly providerId: string;
	readonly sessionId: string;
	readonly threadId: string;
}

function parseSessionLinkTarget(resource: URI): SessionLinkTarget | undefined {
	try {
		const address = parseOpenSessionLinkUri(resource);
		const providerId = parseSessionProviderAuthority(address.connectionAuthority, LOCAL_AGENT_HOST_PROVIDER_ID);
		return {
			providerId,
			sessionId: sessionIdentity(providerId, address.sessionId, LOCAL_AGENT_HOST_PROVIDER_ID),
			threadId: sessionIdentity(providerId, address.threadId, LOCAL_AGENT_HOST_PROVIDER_ID),
		};
	} catch {
		return undefined;
	}
}

function resolveSessionLink(sessions: ISessionsManagementService, { providerId, sessionId, threadId }: SessionLinkTarget): { session: ISession; chat: IChat; } | undefined {
	const session = sessions.sessions.find(session => session.sessionId === sessionId
		&& (session.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID) === providerId);
	const chat = session?.chats.find(chat => chat.threadId === threadId);
	return session && chat ? { session, chat } : undefined;
}
