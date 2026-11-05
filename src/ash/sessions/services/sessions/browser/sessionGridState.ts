import type { SerializedGridDescriptor } from '../../../../base/browser/ui/grid/grid.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { isRecord } from '../../../../base/common/types.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import { isModelReasoningEffort } from '../../../../platform/models/common/agentModels.js';
import type { IUntitledChatSession, SessionEnvironmentSelection, SessionWorkspaceSelection } from '../common/session.js';
import { visibilityKey, type SessionsViewReference } from './visibleSessions.js';

const storageKey = 'sessions.viewState';

export function loadSessionGridState(storage: IStorageService): ISessionGridState | undefined {
	const raw = storage.get(storageKey, StorageScope.WORKSPACE);
	if (raw === undefined) {
		return undefined;
	}
	const preferCode = storage.get('sessions.activityBar.activePage', StorageScope.WORKSPACE) === 'code';
	return parseStoredSessionsViewState(JSON.parse(raw), preferCode);
}

export function saveSessionGridState(storage: IStorageService, snapshot: { readonly references: readonly SessionsViewReference[]; readonly active: number; }, drafts: readonly IUntitledChatSession[]): void {
	const visible = snapshot.references.map(reference => reference.kind === 'session' ? reference : {
		kind: 'untitled' as const,
		session: drafts.find(draft => draft.untitledSessionId === reference.untitledSessionId)!,
	});
	const state: ISessionGridState = { version: 2, drafts, visible, active: snapshot.active };
	storage.store(storageKey, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

type StoredSessionsViewReference = Extract<SessionsViewReference, { kind: 'session'; }> | { readonly kind: 'untitled'; readonly session: IUntitledChatSession; };

interface StoredSessionsSelection {
	readonly visible: readonly StoredSessionsViewReference[];
	readonly active: number;
}

export interface ISessionGridState extends StoredSessionsSelection {
	readonly version: 2;
	readonly drafts: readonly IUntitledChatSession[];
}

export function storedReference(reference: StoredSessionsViewReference): SessionsViewReference {
	return reference.kind === 'session' ? reference : { kind: 'untitled', untitledSessionId: reference.session.untitledSessionId };
}

function parseStoredSessionsViewState(value: unknown, preferCode: boolean): ISessionGridState {
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) { throw new TypeError('Invalid stored Sessions view state'); }
	let states: unknown[];
	if (value.version === 1) {
		if (!isRecord(value.pages)) { throw new TypeError('Invalid stored Sessions view state'); }
		states = preferCode ? [value.pages.code, value.pages.chat] : [value.pages.chat, value.pages.code];
	} else {
		states = [value];
	}
	for (const state of states) {
		if (!isRecord(state) || !Array.isArray(state.visible) || !Number.isInteger(state.active)
			|| (state.visible.length === 0 ? state.active !== -1 : (state.active as number) < 0 || (state.active as number) >= state.visible.length)) {
			throw new TypeError('Invalid stored Sessions selection');
		}
		const keys = new Set<string>();
		for (const reference of state.visible) {
			if (!isRecord(reference)) {
				throw new TypeError('Invalid stored Sessions reference');
			}
			if (reference.kind === 'session') {
				if (!nonEmptyString(reference.sessionId) || !nonEmptyString(reference.threadId) || reference.sideThread !== undefined && reference.sideThread !== true) {
					throw new TypeError('Invalid stored Session identity');
				}
			} else if (reference.kind === 'untitled') {
				if (!isUntitledSession(reference.session)) {
					throw new TypeError('Invalid stored untitled Session');
				}
			} else {
				throw new TypeError('Invalid stored Sessions reference kind');
			}
			const key = visibilityKey(storedReference(reference as unknown as StoredSessionsViewReference))!;
			if (keys.has(key)) {
				throw new TypeError('Duplicate stored Sessions slot');
			}
			keys.add(key);
		}
	}
	const selections = states as StoredSessionsSelection[];
	const drafts = [...new Map(selections.flatMap(state => state.visible.flatMap(reference => reference.kind === 'untitled' ? [[reference.session.untitledSessionId, reference.session] as const] : []))).values()];
	if (value.version === 2) {
		if (!Array.isArray(value.drafts) || !value.drafts.every(isUntitledSession) || new Set(value.drafts.map(draft => draft.untitledSessionId)).size !== value.drafts.length) {
			throw new TypeError('Invalid stored Sessions drafts');
		}
		for (const reference of selections[0]!.visible) {
			if (reference.kind === 'untitled' && !value.drafts.some(draft => draft.untitledSessionId === reference.session.untitledSessionId)) {
				throw new TypeError('Stored visible draft is missing from the draft catalog');
			}
		}
		drafts.splice(0, drafts.length, ...value.drafts);
	}
	const visible: StoredSessionsViewReference[] = [];
	const keys = new Set<string>();
	for (const state of selections) {
		for (const reference of state.visible) {
			const key = visibilityKey(storedReference(reference))!;
			if (!keys.has(key)) { visible.push(reference); keys.add(key); }
		}
	}
	const preferred = selections.find(state => state.active >= 0);
	const activeKey = preferred && visibilityKey(storedReference(preferred.visible[preferred.active]!));
	return { version: 2, drafts, visible, active: activeKey ? visible.findIndex(reference => visibilityKey(storedReference(reference)) === activeKey) : -1 };
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function isUntitledSession(value: unknown): value is IUntitledChatSession {
	return isRecord(value) && nonEmptyString(value.untitledSessionId) && typeof value.title === 'string'
		&& (value.model === undefined || isRecord(value.model) && nonEmptyString(value.model.provider) && nonEmptyString(value.model.model))
		&& (value.forkSource === undefined || isRecord(value.forkSource) && nonEmptyString(value.forkSource.sessionId) && nonEmptyString(value.forkSource.threadId))
		&& (value.providerId === undefined || nonEmptyString(value.providerId))
		&& (value.projectId === undefined || nonEmptyString(value.projectId))
		&& (value.modelSelectionKind === undefined || value.modelSelectionKind === 'manual')
		&& (value.reasoningEffortSelection === undefined || value.reasoningEffortSelection === null || isModelReasoningEffort(value.reasoningEffortSelection))
		&& (value.automaticTitle === undefined || value.automaticTitle === true)
		&& (value.modelDefaults === undefined || isRecord(value.modelDefaults)
			&& (value.modelDefaults.workspace === null || nonEmptyString(value.modelDefaults.workspace))
			&& (value.modelDefaults.effort === undefined || isModelReasoningEffort(value.modelDefaults.effort)))
		&& (value.devContainer === undefined || typeof value.devContainer === 'boolean')
		&& (value.branchName === undefined || typeof value.branchName === 'string' && value.branchName.trim().length > 0 && value.branchName.length <= 1024)
		&& (value.agent === undefined || isRecord(value.agent) && nonEmptyString(value.agent.name) && typeof value.agent.description === 'string' && nonEmptyString(value.agent.sourceId))
		&& (value.environment === undefined || isSessionEnvironmentSelection(value.environment))
		&& isWorkspaceSelection(value.workspace);
}

export function isSessionEnvironmentSelection(value: unknown): value is SessionEnvironmentSelection {
	return isRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.name) && typeof value.hasVariables === 'boolean'
		&& Array.isArray(value.folders) && value.folders.every(folder => isRecord(folder) && folder.type !== 'current' && folder.type !== 'multiple' && isWorkspaceSelection(folder));
}

function isWorkspaceSelection(value: unknown): value is SessionWorkspaceSelection {
	if (!isRecord(value)) {
		return false;
	}
	if (value.type === 'current') {
		return true;
	}
	if (value.type === 'local') {
		return nonEmptyString(value.root);
	}
	if (value.type === 'ssh') {
		return nonEmptyString(value.host) && nonEmptyString(value.root);
	}
	if (value.type === 'remote') {
		return nonEmptyString(value.authority) && /^(wsl|tunnel)\+(?:[0-9a-f]{2})+$/.test(value.authority) && nonEmptyString(value.root);
	}
	if (value.type === 'provider') {
		return nonEmptyString(value.providerId) && nonEmptyString(value.workspace) && nonEmptyString(value.root)
			&& (value.hostAuthority === undefined || nonEmptyString(value.hostAuthority));
	}
	return value.type === 'multiple' && Array.isArray(value.folders) && value.folders.length > 0
		&& value.folders.every(folder => isRecord(folder) && typeof folder.label === 'string' && isRecord(folder.target)
			&& (folder.target.type === 'local' || folder.target.type === 'ssh' || folder.target.type === 'provider') && isWorkspaceSelection(folder.target));
}

const layoutStorageKey = 'sessions.gridState';
const legacyLayoutStorageKeys = ['sessions.gridState.code', 'sessions.gridState.chat'] as const;

export type SessionGridNode =
	| Omit<Extract<SerializedGridDescriptor, { type: 'leaf'; }>, 'data'> & { readonly data: { readonly id: string; }; }
	| Omit<Extract<SerializedGridDescriptor, { type: 'branch'; }>, 'children'> & { readonly children: readonly SessionGridNode[]; };

export function loadSessionGridLayout(storage: IStorageService): { readonly layout?: SessionGridNode; readonly widths?: ReadonlyMap<string, number>; } {
	const raw = storage.get(layoutStorageKey, StorageScope.WORKSPACE);
	if (raw !== undefined) {
		const value: unknown = JSON.parse(raw);
		return isRecord(value) && value.version === 1
			? { widths: parseStoredWidths(value) }
			: { layout: parseStoredLayout(value) };
	}

	const widths = new Map<string, number>();
	for (const key of legacyLayoutStorageKeys) {
		const legacy = storage.get(key, StorageScope.WORKSPACE);
		if (legacy !== undefined) {
			for (const [id, width] of parseStoredWidths(JSON.parse(legacy))) {
				widths.set(id, width);
			}
		}
	}
	return widths.size ? { widths } : {};
}

export function saveSessionGridLayout(storage: IStorageService, layout: SessionGridNode): void {
	storage.store(layoutStorageKey, JSON.stringify({ version: 3, layout }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	for (const key of legacyLayoutStorageKeys) {
		storage.remove(key, StorageScope.WORKSPACE);
	}
}

function parseStoredWidths(value: unknown): ReadonlyMap<string, number> {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.widths) || !value.widths.length) throw new TypeError('Invalid stored Sessions grid state');
	const widths = new Map<string, number>();
	for (const entry of value.widths) {
		if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.length || widths.has(entry.id)
			|| typeof entry.width !== 'number' || !Number.isFinite(entry.width) || entry.width <= 0) throw new TypeError('Invalid stored Sessions pane width');
		widths.set(entry.id, entry.width);
	}
	return widths;
}

/** Version 2 encoded editor groups. Migration resolves them once into Session identities. */
function parseStoredLayout(value: unknown): SessionGridNode {
	if (!isRecord(value) || (value.version !== 2 && value.version !== 3)) throw new TypeError('Invalid stored Sessions grid state');
	const groups = new Map<string, string>();
	if (value.version === 2) {
		if (!Array.isArray(value.groups) || !value.groups.length) throw new TypeError('Invalid stored Sessions grid bindings');
		const ids = new Set<string>();
		for (const binding of value.groups) {
			if (!isRecord(binding) || typeof binding.groupId !== 'string' || !binding.groupId.length || binding.groupId.length > 128 || groups.has(binding.groupId)
				|| typeof binding.id !== 'string' || !binding.id.length || ids.has(binding.id)) throw new TypeError('Invalid stored Sessions grid binding');
			groups.set(binding.groupId, binding.id);
			ids.add(binding.id);
		}
	}
	const seen = new Set<string>();
	const visit = (node: unknown, parentOrientation?: Orientation, depth = 0): SessionGridNode => {
		if (!isRecord(node)) throw new TypeError('Invalid stored Sessions grid node');
		const priority = node.priority === 'normal' ? LayoutPriority.Normal : node.priority === 'low' ? LayoutPriority.Low : node.priority === 'high' ? LayoutPriority.High : node.priority;
		const orientation = node.orientation === 'vertical' ? Orientation.VERTICAL : node.orientation === 'horizontal' ? Orientation.HORIZONTAL : node.orientation;
		if (depth > 64 || typeof node.size !== 'number' || !Number.isFinite(node.size) || node.size < 0
			|| (priority !== LayoutPriority.Low && priority !== LayoutPriority.Normal && priority !== LayoutPriority.High)) throw new TypeError('Invalid stored Sessions grid geometry');
		if (node.type === 'leaf') {
			const reference = isRecord(node.data) ? value.version === 2 ? node.data.groupId : node.data.id : undefined;
			const id = typeof reference === 'string' && value.version === 2 ? groups.get(reference) : reference;
			if (typeof id !== 'string' || !id.length || seen.has(id) || typeof node.visible !== 'boolean') throw new TypeError('Invalid stored Sessions grid reference');
			seen.add(id);
			return { type: 'leaf', data: { id }, size: node.size, priority, visible: node.visible };
		}
		if (node.type !== 'branch' || (orientation !== Orientation.HORIZONTAL && orientation !== Orientation.VERTICAL) || orientation === parentOrientation
			|| !Array.isArray(node.children) || !node.children.length) throw new TypeError('Invalid stored Sessions grid branch');
		return { type: 'branch', orientation, size: node.size, priority, children: node.children.map(child => visit(child, orientation, depth + 1)) };
	};
	const layout = visit(value.layout);
	if (value.version === 2 && seen.size !== groups.size) throw new TypeError('Incomplete stored Sessions grid bindings');
	return layout;
}
