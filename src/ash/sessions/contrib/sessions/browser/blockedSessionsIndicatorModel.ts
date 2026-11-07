import { derived, observableSignalFromEvent, type IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { createUuid } from '../../../../base/common/uuid.js';
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

export interface IBlockedSessionsIndicatorService {
	readonly blockedSessions: IObservable<readonly IBlockedSession[]>;
	ignore(items: readonly IBlockedSession[]): (() => void) | undefined;
}

export const IBlockedSessionsIndicatorService = createServiceIdentifier<IBlockedSessionsIndicatorService>('blockedSessionsIndicatorService');

type IgnoredOccurrence = readonly [sessionId: string, reason: IBlockedSession['reason'], occurrence: string, operationId?: string];

function ignoreKey(sessionId: string, reason: IBlockedSession['reason']): string {
	return JSON.stringify([sessionId, reason]);
}

/** Projects one actionable destination per background Session from the owning services. */
export class BlockedSessionsIndicatorModel implements IBlockedSessionsIndicatorService {
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
				if (item && ignored.get(ignoreKey(session.sessionId, item.reason))?.[2] !== item.occurrence) blocked.push(item);
			}
			return blocked;
		});
	}

	ignore(items: readonly IBlockedSession[]): (() => void) | undefined {
		const ignored = this.readIgnored();
		const previous = new Map<string, IgnoredOccurrence | undefined>();
		const operationId = createUuid();
		for (const item of items) {
			const { session: { sessionId }, reason, occurrence } = item;
			const key = ignoreKey(sessionId, reason);
			const existing = ignored.get(key);
			if (existing?.[2] === occurrence || previous.has(key)) continue;
			previous.set(key, existing);
			ignored.delete(key);
			ignored.set(key, [sessionId, reason, occurrence, operationId]);
		}
		if (!previous.size) return undefined;
		this.writeIgnored(ignored);

		return () => {
			const current = this.readIgnored();
			let changed = false;
			for (const [key, entry] of previous) {
				// A later ignore may have replaced this reason's record in another list or window.
				if (current.get(key)?.[3] !== operationId) continue;
				if (entry) current.set(key, entry);
				else current.delete(key);
				changed = true;
			}
			if (changed) this.writeIgnored(current);
		};
	}

	private writeIgnored(ignored: ReadonlyMap<string, IgnoredOccurrence>): void {
		this.storage.store(ignoredKey, JSON.stringify([...ignored.values()].slice(-1000)), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private readIgnored(): Map<string, IgnoredOccurrence> {
		const ignored = new Map<string, IgnoredOccurrence>();
		try {
			const value: unknown = JSON.parse(this.storage.get(ignoredKey, StorageScope.PROFILE, '[]'));
			if (!Array.isArray(value)) return ignored;
			for (const entry of value) {
				if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
				const [sessionId, reason, occurrence, operationId] = entry;
				if (entry.length === 2 && typeof reason === 'string') {
					// Earlier profiles stored one occurrence per session, with the reason inside it.
					if (reason.startsWith('["input",')) ignored.set(ignoreKey(sessionId, 'input'), [sessionId, 'input', reason]);
					else if (reason.startsWith('["ci",')) ignored.set(ignoreKey(sessionId, 'ci'), [sessionId, 'ci', reason]);
				} else if ((reason === 'input' || reason === 'ci') && typeof occurrence === 'string'
					&& (operationId === undefined || typeof operationId === 'string')) {
					const record: IgnoredOccurrence = operationId === undefined
						? [sessionId, reason, occurrence]
						: [sessionId, reason, occurrence, operationId];
					ignored.set(ignoreKey(sessionId, reason), record);
				}
			}
		} catch {
			// A malformed profile entry must not suppress any alerts.
		}
		return ignored;
	}
}
