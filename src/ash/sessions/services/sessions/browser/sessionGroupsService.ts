import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { ISessionsManagementService } from '../common/sessionsManagement.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isRecord } from '../../../../base/common/types.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface SessionGroup {
	readonly sectionId: string;
	readonly name: string;
	readonly sessionIds: readonly string[];
}

/** Profile presentation state; session lifecycle and history remain in the product backend. */
export interface ISessionGroupsService {
	readonly groups: readonly SessionGroup[];
	readonly onDidChange: import('../../../../base/common/event.js').Event<void>;
	create(name: string, signal?: AbortSignal): Promise<SessionGroup>;
	rename(sectionId: string, name: string, signal?: AbortSignal): Promise<void>;
	delete(sectionId: string, signal?: AbortSignal): Promise<void>;
	move(sessionId: string, sectionId: string | null, signal?: AbortSignal): Promise<void>;
	reorder(sectionId: string, sessionIds: readonly string[], signal?: AbortSignal): Promise<void>;
}
export const ISessionGroupsService = createServiceIdentifier<ISessionGroupsService>('sessionGroupsService');
const STORAGE_KEY = 'sessions.groups';

export class SessionGroupsService extends Disposable implements ISessionGroupsService {
	private readonly state = observableValue<readonly SessionGroup[]>(this, []);
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private stored: string | undefined;
	private pending: Promise<void> = Promise.resolve();

	constructor(@IStorageService private readonly storage: IStorageService, @ISessionsManagementService private readonly sessions: ISessionsManagementService) {
		super();
		this.reload();
		this._register(sessions.onDidChange(() => {
			const archived = new Set(sessions.sessions.filter(session => session.status === 'archived').map(session => session.sessionId));
			if (this.groups.some(group => group.sessionIds.some(id => archived.has(id)))) {
				void this.change(groups => groups.map(group => ({ ...group, sessionIds: group.sessionIds.filter(id => !archived.has(id)) }))).catch(onUnexpectedError);
			}
		}));
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === STORAGE_KEY) this.reload();
		}));
	}
	get groups(): readonly SessionGroup[] { return this.state.get(); }
	private reload(): void {
		const raw = this.storage.get(STORAGE_KEY, StorageScope.PROFILE);
		if (raw === this.stored) return;
		const groups: unknown = raw === undefined ? [] : JSON.parse(raw);
		if (!Array.isArray(groups) || groups.length > 100) throw new Error('Invalid saved session groups');
		const sections = new Set<string>();
		const sessions = new Set<string>();
		for (const group of groups) {
			if (!isRecord(group) || typeof group.sectionId !== 'string' || !group.sectionId || sections.has(group.sectionId) || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 128 || !Array.isArray(group.sessionIds) || group.sessionIds.length > 1000) throw new Error('Invalid saved session group');
			sections.add(group.sectionId);
			for (const id of group.sessionIds) {
				if (typeof id !== 'string' || !id || sessions.has(id)) throw new Error('Invalid saved session group membership');
				sessions.add(id);
			}
		}
		this.stored = raw;
		this.state.set(groups as SessionGroup[]);
		this.changed.fire();
	}
	private async change(update: (groups: readonly SessionGroup[]) => readonly SessionGroup[], signal?: AbortSignal): Promise<void> {
		// Serialize writes within the window and read storage anew to incorporate other windows.
		const next = this.pending.then(async () => {
			this.assertNotDisposed();
			if (signal) throwIfCancelled(signal);
			this.reload();
			const groups = update(this.groups);
			this.storage.store(STORAGE_KEY, JSON.stringify(groups), StorageScope.PROFILE, StorageTarget.USER);
			this.reload();
			await this.storage.flush();
		});
		this.pending = next.catch(() => { });
		await next;
	}
	async create(name: string, signal?: AbortSignal): Promise<SessionGroup> {
		const group: SessionGroup = { sectionId: generateUuid(), name: validName(name), sessionIds: [] };
		await this.change(groups => {
			if (groups.length >= 100) throw new Error('Maximum session groups reached');
			return [...groups, group];
		}, signal);
		return group;
	}
	async rename(sectionId: string, name: string, signal?: AbortSignal): Promise<void> {
		await this.change(groups => { findGroup(groups, sectionId); return groups.map(group => group.sectionId === sectionId ? { ...group, name: validName(name) } : group); }, signal);
	}
	async delete(sectionId: string, signal?: AbortSignal): Promise<void> {
		await this.change(groups => { findGroup(groups, sectionId); return groups.filter(group => group.sectionId !== sectionId); }, signal);
	}
	async move(sessionId: string, sectionId: string | null, signal?: AbortSignal): Promise<void> {
		if (!sessionId) throw new Error('Session ID is required');
		await this.change(groups => {
			if (sectionId !== null && this.sessions.sessions.some(session => session.sessionId === sessionId && session.status === 'archived')) throw new Error('Restore the archived task before assigning a group');
			if (sectionId !== null && findGroup(groups, sectionId).sessionIds.length >= 1000) throw new Error('Maximum group membership reached');
			return groups.map(group => ({ ...group, sessionIds: [...group.sessionIds.filter(id => id !== sessionId), ...(group.sectionId === sectionId ? [sessionId] : [])] }));
		}, signal);
	}
	async reorder(sectionId: string, sessionIds: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.change(groups => {
			const group = findGroup(groups, sectionId);
			if (sessionIds.length !== group.sessionIds.length || new Set(sessionIds).size !== sessionIds.length || sessionIds.some(id => !group.sessionIds.includes(id))) throw new Error('Include each assigned session exactly once');
			return groups.map(group => group.sectionId === sectionId ? { ...group, sessionIds: [...sessionIds] } : group);
		}, signal);
	}
}
function validName(name: string): string {
	if (!name.trim() || name.length > 128) throw new Error('Section name must contain 1–128 characters');
	return name.trim();
}
function findGroup(groups: readonly SessionGroup[], sectionId: string): SessionGroup {
	const group = groups.find(group => group.sectionId === sectionId);
	if (!group) throw new Error('Session group does not exist');
	return group;
}
