import type { Event } from '../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { readStoredOrder, resolveSectionOrder, storeReorderedIds } from './sessionSectionOrderService.js';
import type { ISession } from '../common/session.js';

export type SessionSortMode = 'created' | 'updated';
export type AutomationSessionsListMode = 'always' | 'afterReply' | 'never';
export type SessionsListMode = 'chat' | 'code';
export interface ISessionsListTreeNode {
	readonly id: string;
	readonly label: string;
	readonly kind: 'section' | 'session' | 'chat' | 'draft' | 'project';
	readonly collapsed?: boolean;
	readonly sessionId?: string;
	readonly threadId?: string;
	readonly children?: readonly ISessionsListTreeNode[];
}

export interface ISessionsListModelService {
	readonly onDidChange: Event<void>;
	readonly sortMode: SessionSortMode;
	setSortMode(mode: SessionSortMode): void;
	readonly automationSessionsMode: AutomationSessionsListMode;
	setAutomationSessionsMode(mode: AutomationSessionsListMode): void;
	getAutomationSessionOverride(session: ISession): 'show' | 'hide' | undefined;
	setAutomationSessionOverride(session: ISession, override: 'show' | 'hide' | undefined): void;
	recordAutomationSessionReply(session: ISession): void;
	isSessionListed(session: ISession): boolean;
	getSessionOrder(scope: string, visibleIds: readonly string[]): readonly string[];
	moveSession(scope: string, visibleIds: readonly string[], id: string, targetId: string): void;
	isSessionPinned(session: ISession): boolean;
	pinSession(session: ISession): void;
	unpinSession(session: ISession): void;
	registerTree(mode: SessionsListMode, read: () => readonly ISessionsListTreeNode[]): IDisposable;
	readTree(mode: SessionsListMode): readonly ISessionsListTreeNode[] | undefined;
}

export const ISessionsListModelService = createServiceIdentifier<ISessionsListModelService>('sessionsListModelService');

const automationVisibilityKey = 'sessions.list.showAutomationSessions';
const automationOverridePrefix = 'sessions.list.automationOverride.';
const automationReplyPrefix = 'sessions.list.automationReply.';
const sortModeKey = 'sessions.list.sortMode';
const manualOrderPrefix = 'sessions.list.manualOrder.';
const pinnedSessionPrefix = 'sessions.list.pinned.';

/** Owns profile-local list filters, pins, and manual row order. */
export class SessionsListModelService implements ISessionsListModelService {
	readonly onDidChange: Event<void>;
	private readonly trees = new Map<SessionsListMode, () => readonly ISessionsListTreeNode[]>();

	registerTree(mode: SessionsListMode, read: () => readonly ISessionsListTreeNode[]): IDisposable {
		this.trees.set(mode, read);
		return toDisposable(() => {
			if (this.trees.get(mode) === read) this.trees.delete(mode);
		});
	}

	readTree(mode: SessionsListMode): readonly ISessionsListTreeNode[] | undefined {
		return this.trees.get(mode)?.();
	}

	constructor(@IStorageService private readonly storage: IStorageService) {
		this.onDidChange = (listener, thisArgs, disposables) => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && (event.key === automationVisibilityKey || event.key === sortModeKey
				|| event.key.startsWith(automationOverridePrefix) || event.key.startsWith(automationReplyPrefix)
				|| event.key.startsWith(pinnedSessionPrefix) || event.key.startsWith(manualOrderPrefix))) {
				listener.call(thisArgs);
			}
		}, undefined, disposables);
	}

	get sortMode(): SessionSortMode {
		return this.storage.get(sortModeKey, StorageScope.PROFILE) === 'created' ? 'created' : 'updated';
	}

	setSortMode(mode: SessionSortMode): void {
		this.storage.store(sortModeKey, mode, StorageScope.PROFILE, StorageTarget.USER);
	}

	get automationSessionsMode(): AutomationSessionsListMode {
		const value = this.storage.get(automationVisibilityKey, StorageScope.PROFILE);
		if (value === 'true' || value === 'always') return 'always';
		return value === 'afterReply' ? 'afterReply' : 'never';
	}

	setAutomationSessionsMode(mode: AutomationSessionsListMode): void {
		this.storage.store(automationVisibilityKey, mode, StorageScope.PROFILE, StorageTarget.USER);
	}

	getAutomationSessionOverride(session: ISession): 'show' | 'hide' | undefined {
		const value = this.storage.get(automationOverridePrefix + session.sessionId, StorageScope.PROFILE);
		return value === 'show' || value === 'hide' ? value : undefined;
	}

	setAutomationSessionOverride(session: ISession, override: 'show' | 'hide' | undefined): void {
		if (session.source !== 'automation') return;
		this.storage.store(automationOverridePrefix + session.sessionId, override, StorageScope.PROFILE, StorageTarget.USER);
	}

	recordAutomationSessionReply(session: ISession): void {
		if (session.source !== 'automation') return;
		this.storage.store(automationReplyPrefix + session.sessionId, true, StorageScope.PROFILE, StorageTarget.USER);
	}

	isSessionListed(session: ISession): boolean {
		if (session.source !== 'automation') return true;
		const override = this.getAutomationSessionOverride(session);
		if (override !== undefined) return override === 'show';
		const mode = this.automationSessionsMode;
		return mode === 'always' || mode === 'afterReply'
			&& this.storage.getBoolean(automationReplyPrefix + session.sessionId, StorageScope.PROFILE, false);
	}

	getSessionOrder(scope: string, visibleIds: readonly string[]): readonly string[] {
		return resolveSectionOrder(readStoredOrder(this.storage, this.manualOrderKey(scope)), visibleIds);
	}

	moveSession(scope: string, visibleIds: readonly string[], id: string, targetId: string): void {
		storeReorderedIds(this.storage, this.manualOrderKey(scope), visibleIds, id, targetId);
	}

	private manualOrderKey(scope: string): string {
		// Existing orders were saved while using the catalog's updated-time order.
		return manualOrderPrefix + (this.sortMode === 'created' ? `created:${scope}` : scope);
	}

	isSessionPinned(session: ISession): boolean {
		return this.storage.getBoolean(pinnedSessionPrefix + session.sessionId, StorageScope.PROFILE, false);
	}

	pinSession(session: ISession): void {
		this.storage.store(pinnedSessionPrefix + session.sessionId, true, StorageScope.PROFILE, StorageTarget.USER);
	}

	unpinSession(session: ISession): void {
		this.storage.store(pinnedSessionPrefix + session.sessionId, false, StorageScope.PROFILE, StorageTarget.USER);
	}
}
