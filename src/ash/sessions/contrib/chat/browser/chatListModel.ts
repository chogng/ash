import type { IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, isDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';

import type { SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';
import type { SessionListOrganization } from '../../sessions/browser/views/sessionsList.js';

export interface ChatListEntry extends SessionListOrganization {
	/** Opaque identity, unique across the entire list. */
	readonly id: string;
	readonly title: string;
	/** Session catalog identity, when this row represents an Ash session. */
	readonly sessionId?: string;
	readonly updatedAt?: number;
	readonly projectId?: string;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly defaultIcon: Icon;
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly open: (signal: AbortSignal) => Promise<void>;
	readonly getActions: (signal: AbortSignal, restoreFocus: () => void) => readonly IAction[] | Promise<readonly IAction[]>;
}

type ProjectHistory =
	| { readonly state: 'idle' | 'more' | 'error'; readonly load: () => void; }
	| { readonly state: 'loading' | 'complete' | 'unavailable'; };

export interface ConversationProjectDetails {
	readonly name: string;
	readonly description: string;
}

export interface ConversationProjectEditor {
	readonly details: ConversationProjectDetails;
	save(details: ConversationProjectDetails): Promise<void>;
}

export interface ChatListProject {
	/** Stable identity for membership and persisted expansion. */
	readonly id: string;
	readonly title: string;
	readonly history: ProjectHistory;
	readonly archived?: boolean;
	readonly archive?: () => void;
	readonly restore?: () => void;
	readonly remove?: { readonly removesContents: boolean; run(): Promise<void>; };
	readonly editDetails?: (signal: AbortSignal) => Promise<ConversationProjectEditor>;
}

export interface ChatListSnapshot {
	readonly entries: readonly ChatListEntry[];
	readonly projects?: readonly ChatListProject[];
	readonly groups?: readonly SessionGroup[];
	readonly loading?: boolean;
}

/** Catalog owners supply records and operations. The list owns their placement. */
export interface ChatListSource {
	readonly snapshot: IObservable<ChatListSnapshot>;
	attach?(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable;
	loadMore?(retry: boolean): void;
}

export interface IChatListCatalog {
	readonly sources: readonly ChatListSource[];
}

export const IChatListCatalog = createServiceIdentifier<IChatListCatalog>('chatListCatalog');

export class ChatListCatalog extends Disposable implements IChatListCatalog {
	readonly sources: readonly ChatListSource[];

	constructor(adapters: readonly SyncDescriptor<ChatListSource>[], @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.sources = adapters.map(adapter => {
			const source = instantiation.createInstance(adapter);
			if (isDisposable(source)) this._register(source);
			return source;
		});
	}
}

export interface ChatListGroup {
	readonly key: string;
	readonly title: string;
	readonly rows: ChatListEntry[];
	readonly project?: ChatListProject;
}

export function getProjectSessionRows(entries: readonly ChatListEntry[], sessionIds: readonly string[]): ChatListEntry[] {
	const members = new Set(sessionIds);
	return entries.filter(entry => entry.sessionId !== undefined && members.has(entry.sessionId))
		.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export function groupChatList(snapshots: readonly ChatListSnapshot[], mode: 'chat' | 'projects' | 'archived' = 'chat', hasPinnedProjects = false): readonly ChatListGroup[] {
	const pinned: ChatListGroup = { key: 'pinned', title: localize('sessions.chatList.pinnedGroup', 'Pinned'), rows: [] };
	const other: ChatListGroup = { key: 'other', title: localize('sessions.chatList.otherProjects', 'Other projects'), rows: [] };
	const recent: ChatListGroup = { key: 'recent', title: localize('sessions.chatList.recentGroup', 'Recent'), rows: [] };
	const projects = new Map<string, ChatListGroup>();
	for (const snapshot of snapshots) {
		for (const project of snapshot.projects ?? []) {
			projects.set(project.id, { key: project.id, title: project.title, rows: [], project });
		}
	}
	for (const snapshot of snapshots) {
		for (const entry of snapshot.entries) {
			const project = entry.projectId ? projects.get(entry.projectId) ?? other : undefined;
			const group = mode !== 'chat' ? project : entry.pinned ? pinned : entry.projectId ? undefined : recent;
			group?.rows.push(entry);
		}
	}
	if (mode === 'archived') return [...projects.values()].filter(group => group.project?.archived);
	return (mode === 'projects' ? [...projects.values(), other] : [pinned, recent])
		.filter(group => !group.project?.archived && (group.project || group.rows.length || group === pinned && hasPinnedProjects));
}
