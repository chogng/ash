import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import type { Event } from '../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { readStoredOrder, resolveSectionOrder, storeReorderedIds } from './sessionSectionOrderService.js';
import type { ISession } from '../common/session.js';

type SessionListIdentity = Pick<ISession, 'sessionId' | 'source'>;

export type SessionSortMode = 'name' | 'created' | 'updated';
export type SessionSortDirection = 'ascending' | 'descending';
export type SessionGrouping = 'none' | 'projects' | 'repository' | 'status' | 'environment';
export type AutomationSessionsListMode = 'always' | 'afterReply' | 'never';
const listModes = ['chat', 'code'] as const;
export type SessionsListMode = typeof listModes[number];
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
	getSort(mode: SessionsListMode): { readonly field: SessionSortMode; readonly direction: SessionSortDirection; };
	setSortMode(mode: SessionsListMode, field: SessionSortMode): void;
	setSortDirection(mode: SessionsListMode, direction: SessionSortDirection): void;
	readonly grouping: SessionGrouping;
	setGrouping(grouping: SessionGrouping): void;
	readonly showAttentionGroup: boolean;
	setShowAttentionGroup(show: boolean): void;
	readonly showComparisonGroups: boolean;
	setShowComparisonGroups(show: boolean): void;
	readonly automationSessionsMode: AutomationSessionsListMode;
	setAutomationSessionsMode(mode: AutomationSessionsListMode): void;
	getAutomationSessionOverride(session: SessionListIdentity): 'show' | 'hide' | undefined;
	setAutomationSessionOverride(session: ISession, override: 'show' | 'hide' | undefined): void;
	recordAutomationSessionReply(session: ISession): void;
	isSessionListed(session: SessionListIdentity): boolean;
	getSessionOrder(mode: SessionsListMode, section: string, visibleIds: readonly string[]): readonly string[];
	moveSession(mode: SessionsListMode, section: string, visibleIds: readonly string[], id: string, targetId: string): void;
	isSessionPinned(session: SessionListIdentity): boolean;
	pinSession(session: SessionListIdentity): void;
	unpinSession(session: SessionListIdentity): void;
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
const attentionGroupKey = 'sessions.list.showAttentionGroup';
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
		this.migrateSortPreferences();
		this.onDidChange = (listener, thisArgs, disposables) => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && (event.key === automationVisibilityKey || event.key.startsWith(`${sortModeKey}.`)
				|| event.key.startsWith(`${sortDirectionKey}.`) || event.key === groupingKey || event.key === comparisonGroupsKey
				|| event.key === attentionGroupKey
				|| event.key.startsWith(automationOverridePrefix) || event.key.startsWith(automationReplyPrefix)
				|| event.key.startsWith(pinnedSessionPrefix) || event.key.startsWith(manualOrderPrefix) || event.key.startsWith(rowIconPrefix))) {
				listener.call(thisArgs);
			}
		}, undefined, disposables);
	}

	getSort(mode: SessionsListMode): { readonly field: SessionSortMode; readonly direction: SessionSortDirection; } {
		const value = this.storage.get(`${sortModeKey}.${mode}`, StorageScope.PROFILE);
		const field = value === 'created' || value === 'name' ? value : 'updated';
		const direction = this.storage.get(`${sortDirectionKey}.${mode}`, StorageScope.PROFILE);
		return {
			field,
			direction: direction === 'ascending' || direction === 'descending' ? direction : field === 'name' ? 'ascending' : 'descending',
		};
	}

	setSortMode(mode: SessionsListMode, field: SessionSortMode): void {
		this.storage.store(`${sortModeKey}.${mode}`, field, StorageScope.PROFILE, StorageTarget.USER);
	}

	setSortDirection(mode: SessionsListMode, direction: SessionSortDirection): void {
		this.storage.store(`${sortDirectionKey}.${mode}`, direction, StorageScope.PROFILE, StorageTarget.USER);
	}

	private migrateSortPreferences(): void {
		const preferences = [
			[sortModeKey, ['name', 'created', 'updated']],
			[sortDirectionKey, ['ascending', 'descending']],
		] as const;
		const migrated = new Map<string, string>();
		for (const [key, valid] of preferences) {
			const legacy = this.storage.get(key, StorageScope.PROFILE);
			if (legacy === undefined || !valid.some(value => value === legacy)) continue;
			const targets = listModes.map(mode => {
				const keyForMode = `${key}.${mode}`;
				return { key: keyForMode, value: this.storage.get(keyForMode, StorageScope.PROFILE) };
			});
			if (targets.some(target => target.value !== undefined && target.value !== legacy)) {
				console.warn(`Cannot migrate ${key}: a mode already has a different preference.`);
				continue;
			}
			for (const target of targets) {
				if (target.value === undefined) this.storage.store(target.key, legacy, StorageScope.PROFILE, StorageTarget.USER);
			}
			migrated.set(key, legacy);
		}
		if (!migrated.size) return;
		// Keep the legacy values until both copies have reached durable storage.
		void this.storage.flush().then(() => {
			for (const [key, value] of migrated) {
				if (this.storage.get(key, StorageScope.PROFILE) === value) this.storage.remove(key, StorageScope.PROFILE);
			}
		}).catch(onUnexpectedError);
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

	get showAttentionGroup(): boolean {
		return this.storage.getBoolean(attentionGroupKey, StorageScope.PROFILE, false);
	}

	setShowAttentionGroup(show: boolean): void {
		this.storage.store(attentionGroupKey, show, StorageScope.PROFILE, StorageTarget.USER);
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

	getAutomationSessionOverride(session: SessionListIdentity): 'show' | 'hide' | undefined {
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

	isSessionListed(session: SessionListIdentity): boolean {
		if (session.source !== 'automation') return true;
		const override = this.getAutomationSessionOverride(session);
		if (override !== undefined) return override === 'show';
		const mode = this.automationSessionsMode;
		return mode === 'always' || mode === 'afterReply'
			&& this.storage.getBoolean(automationReplyPrefix + session.sessionId, StorageScope.PROFILE, false);
	}

	getSessionOrder(mode: SessionsListMode, section: string, visibleIds: readonly string[]): readonly string[] {
		return resolveSectionOrder(readStoredOrder(this.storage, this.manualOrderKey(mode, section)), visibleIds);
	}

	moveSession(mode: SessionsListMode, section: string, visibleIds: readonly string[], id: string, targetId: string): void {
		storeReorderedIds(this.storage, this.manualOrderKey(mode, section), visibleIds, id, targetId);
	}

	private manualOrderKey(mode: SessionsListMode, section: string): string {
		// Existing orders were saved while using the catalog's updated-time order.
		const { field, direction } = this.getSort(mode);
		const scope = `${mode}:${section}`;
		if (field === 'updated' && direction === 'descending') {
			return manualOrderPrefix + scope;
		}
		if (field === 'created' && direction === 'descending') {
			return manualOrderPrefix + `created:${scope}`;
		}
		return manualOrderPrefix + `${field}:${direction}:${scope}`;
	}

	isSessionPinned(session: SessionListIdentity): boolean {
		return this.storage.getBoolean(pinnedSessionPrefix + session.sessionId, StorageScope.PROFILE, false);
	}

	pinSession(session: SessionListIdentity): void {
		this.storage.store(pinnedSessionPrefix + session.sessionId, true, StorageScope.PROFILE, StorageTarget.USER);
	}

	getRowIcon(rowId: string): string | undefined {
		return this.storage.get(rowIconPrefix + rowId, StorageScope.PROFILE);
	}

	setRowIcon(rowId: string, iconId: string | undefined): void {
		if (iconId !== undefined && !getLxiconDefinition(iconId)) { return; }
		this.storage.store(rowIconPrefix + rowId, iconId, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	unpinSession(session: SessionListIdentity): void {
		this.storage.store(pinnedSessionPrefix + session.sessionId, false, StorageScope.PROFILE, StorageTarget.USER);
	}
}
