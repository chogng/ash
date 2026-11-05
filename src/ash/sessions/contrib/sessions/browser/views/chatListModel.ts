import type { IAction } from '../../../../../base/common/actions.js';
import type { Icon } from '../../../../../base/common/icon.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import type { ISessionStatusIcon } from '../../../../browser/sessionStatusIcon.js';

export interface ChatListEntry {
	/** Opaque identity, unique across the entire list. */
	readonly id: string;
	readonly title: string;
	readonly projectId?: string;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly pinned?: boolean;
	readonly defaultIcon: Icon;
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly open: (signal: AbortSignal) => Promise<void>;
	readonly setPinned?: (pinned: boolean) => void | Promise<void>;
	readonly getActions: (signal: AbortSignal, restoreFocus: () => void) => readonly IAction[] | Promise<readonly IAction[]>;
}

type ProjectHistory =
	| { readonly state: 'idle' | 'more' | 'error'; readonly load: () => void; }
	| { readonly state: 'loading' | 'complete' | 'unavailable'; };

export interface ChatListProject {
	/** Stable identity for membership and persisted expansion. */
	readonly id: string;
	readonly title: string;
	readonly history: ProjectHistory;
}

export interface ChatListSnapshot {
	readonly entries: readonly ChatListEntry[];
	readonly projects?: readonly ChatListProject[];
	readonly loading?: boolean;
}

/** Catalog owners supply records and operations. The list owns their placement. */
export interface ChatListSource {
	readonly snapshot: IObservable<ChatListSnapshot>;
	attach?(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable;
	loadMore?(retry: boolean): void;
}

interface ChatListGroup {
	readonly key: string;
	readonly title: string;
	readonly rows: ChatListEntry[];
	readonly project?: ChatListProject;
}

export function groupChatList(snapshots: readonly ChatListSnapshot[]): readonly ChatListGroup[] {
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
			const group = entry.pinned ? pinned : entry.projectId ? projects.get(entry.projectId) ?? other : recent;
			group.rows.push(entry);
		}
	}
	return [pinned, ...projects.values(), other, recent].filter(group => group.project || group.rows.length);
}
