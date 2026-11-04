import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import type { Event } from '../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { readStoredOrder, resolveSectionOrder, storeReorderedIds } from './sessionSectionOrderService.js';
import type { ISession } from '../common/session.js';

export type SessionSortMode = 'name' | 'created' | 'updated';
export type SessionSortDirection = 'ascending' | 'descending';
export type SessionGrouping = 'none' | 'projects' | 'repository' | 'status' | 'environment';
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
	readonly sortDirection: SessionSortDirection;
	setSortDirection(direction: SessionSortDirection): void;
	readonly grouping: SessionGrouping;
	setGrouping(grouping: SessionGrouping): void;
	readonly showComparisonGroups: boolean;
	setShowComparisonGroups(show: boolean): void;
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
	getRowIcon(rowId: string): string | undefined;
	setRowIcon(rowId: string, iconId: string | undefined): void;
	registerTree(mode: SessionsListMode, read: () => readonly ISessionsListTreeNode[]): IDisposable;
	readTree(mode: SessionsListMode): readonly ISessionsListTreeNode[] | undefined;
}

export const ISessionsListModelService = createServiceIdentifier<ISessionsListModelService>('sessionsListModelService');

const automationVisibilityKey = 'sessions.list.showAutomationSessions';
const automationOverridePrefix = 'sessions.list.automationOverride.';
const automationReplyPrefix = 'sessions.list.automationReply.';
const sortModeKey = 'sessions.list.sortMode';
const sortDirectionKey = 'sessions.list.sortDirection';
const groupingKey = 'sessions.list.grouping';
const comparisonGroupsKey = 'sessions.list.showComparisonGroups';
const manualOrderPrefix = 'sessions.list.manualOrder.';
const pinnedSessionPrefix = 'sessions.list.pinned.';
const rowIconPrefix = 'sessions.list.rowIcon.';

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
				|| event.key === sortDirectionKey || event.key === groupingKey || event.key === comparisonGroupsKey
				|| event.key.startsWith(automationOverridePrefix) || event.key.startsWith(automationReplyPrefix)
				|| event.key.startsWith(pinnedSessionPrefix) || event.key.startsWith(manualOrderPrefix) || event.key.startsWith(rowIconPrefix))) {
				listener.call(thisArgs);
			}
		}, undefined, disposables);
	}

	get sortMode(): SessionSortMode {
		const value = this.storage.get(sortModeKey, StorageScope.PROFILE);
		return value === 'created' || value === 'name' ? value : 'updated';
	}

	setSortMode(mode: SessionSortMode): void {
		this.storage.store(sortModeKey, mode, StorageScope.PROFILE, StorageTarget.USER);
	}

	get sortDirection(): SessionSortDirection {
		const value = this.storage.get(sortDirectionKey, StorageScope.PROFILE);
		if (value === 'ascending' || value === 'descending') {
			return value;
		}
		return this.sortMode === 'name' ? 'ascending' : 'descending';
	}

	setSortDirection(direction: SessionSortDirection): void {
		this.storage.store(sortDirectionKey, direction, StorageScope.PROFILE, StorageTarget.USER);
	}

	get grouping(): SessionGrouping {
		const value = this.storage.get(groupingKey, StorageScope.PROFILE);
		switch (value) {
			case 'projects': case 'repository': case 'status': case 'environment': return value;
			default: return 'none';
		}
	}

	setGrouping(grouping: SessionGrouping): void {
		this.storage.store(groupingKey, grouping, StorageScope.PROFILE, StorageTarget.USER);
	}

	get showComparisonGroups(): boolean {
		return this.storage.getBoolean(comparisonGroupsKey, StorageScope.PROFILE, true);
	}

	setShowComparisonGroups(show: boolean): void {
		this.storage.store(comparisonGroupsKey, show, StorageScope.PROFILE, StorageTarget.USER);
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
		const mode = this.sortMode;
		if (mode === 'updated' && this.sortDirection === 'descending') {
			return manualOrderPrefix + scope;
		}
		if (mode === 'created' && this.sortDirection === 'descending') {
			return manualOrderPrefix + `created:${scope}`;
		}
		return manualOrderPrefix + `${mode}:${this.sortDirection}:${scope}`;
	}

	isSessionPinned(session: ISession): boolean {
		return this.storage.getBoolean(pinnedSessionPrefix + session.sessionId, StorageScope.PROFILE, false);
	}

	pinSession(session: ISession): void {
		this.storage.store(pinnedSessionPrefix + session.sessionId, true, StorageScope.PROFILE, StorageTarget.USER);
	}

	getRowIcon(rowId: string): string | undefined {
		return this.storage.get(rowIconPrefix + rowId, StorageScope.PROFILE);
	}

	setRowIcon(rowId: string, iconId: string | undefined): void {
		if (iconId !== undefined && !getLxiconDefinition(iconId)) { return; }
		this.storage.store(rowIconPrefix + rowId, iconId, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	unpinSession(session: ISession): void {
		this.storage.store(pinnedSessionPrefix + session.sessionId, false, StorageScope.PROFILE, StorageTarget.USER);
	}
}
