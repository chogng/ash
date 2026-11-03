import { derived, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { ISession, ThreadId } from '../../../services/sessions/common/session.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IResolvedSessionPullRequest } from '../../github/common/types.js';

const ignoredKey = 'sessions.blockedIndicator.ignoredOccurrences';

export interface IBlockedSession {
	readonly session: ISession;
	readonly threadId: ThreadId;
	readonly reason: 'input' | 'ci';
	readonly occurrence: string;
	readonly checks?: readonly IResolvedSessionPullRequest[];
}

/** Projects one actionable destination per background Session from the owning services. */
export class BlockedSessionsIndicatorModel {
	readonly blockedSessions;

	constructor(
		@ISessionsManagementService catalog: ISessionsManagementService,
		@ISessionsService sessions: ISessionsService,
		@IGitHubService github: IGitHubService,
		@IStorageService private readonly storage: IStorageService,
	) {
		const catalogChanged = observableSignalFromEvent(this, catalog.onDidChange);
		const checksChanged = observableSignalFromEvent(this, github.onDidChange);
		const ignoredChanged = observableSignalFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === ignoredKey) listener(event);
		}));
		this.blockedSessions = derived(reader => {
			catalogChanged.read(reader);
			checksChanged.read(reader);
			ignoredChanged.read(reader);
			const ignored = this.readIgnored();
			const { activeSelection, visibleSelections } = sessions.getSelection(reader);
			const provider = activeSelection?.kind === 'session'
				? activeSelection.active.session.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID
				: undefined;
			const visible = new Set(visibleSelections.flatMap(selection => selection.kind === 'session' ? [selection.active.session.sessionId] : []));
			const blocked: IBlockedSession[] = [];
			for (const session of catalog.sessions) {
				if (session.status !== 'active' || visible.has(session.sessionId)
					|| provider !== undefined && (session.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID) !== provider) {
					continue;
				}
				const chats = session.chats.filter(chat => chat.status === 'active' && chat.origin.type !== 'agentSpawn');
				const main = chats.find(chat => chat.origin.type === 'root') ?? chats[0];
				if (!main) continue;
				const waiting = chats.find(chat => chat.management?.status === 'needsInput');
				let item: IBlockedSession | undefined;
				if (waiting || session.management?.status === 'needsInput') {
					const threadId = (waiting ?? main).threadId;
					const status = waiting?.management ?? session.management;
					item = { session, threadId, reason: 'input', occurrence: JSON.stringify(['input', threadId, status?.statusChangedAtUnixMs]) };
				} else {
					const checks = github.getSessionPullRequests(session.sessionId).filter(request => request.state === 'open' && request.status.hasFailingChecks);
					if (checks.length) {
						const targets = checks.map(request => JSON.stringify([request.uri.toString(), request.headCommit])).sort();
						item = { session, threadId: main.threadId, reason: 'ci', checks, occurrence: JSON.stringify(['ci', targets]) };
					}
				}
				if (item && ignored.get(session.sessionId) !== item.occurrence) blocked.push(item);
			}
			return blocked;
		});
	}

	ignore(items: readonly IBlockedSession[]): void {
		const ignored = this.readIgnored();
		for (const item of items) {
			ignored.delete(item.session.sessionId);
			ignored.set(item.session.sessionId, item.occurrence);
		}
		this.storage.store(ignoredKey, JSON.stringify([...ignored].slice(-1000)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private readIgnored(): Map<string, string> {
		try {
			const value: unknown = JSON.parse(this.storage.get(ignoredKey, StorageScope.PROFILE, '[]'));
			if (Array.isArray(value)) return new Map(value.filter((entry): entry is [string, string] =>
				Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'));
		} catch {
			// A malformed profile entry must not suppress any alerts.
		}
		return new Map();
	}
}
