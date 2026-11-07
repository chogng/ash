import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getChatSessionArchiveActionPresentation, getChatSessionArchiveActionWording } from '../../../../platform/chat/common/sessionArchiveActions.js';
import { IProjectService, type ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';
import type { SessionGroupingContext, SessionsCatalogProject, SessionsCatalogProjectAppearance, SessionsCatalogRow, SessionsCatalogSnapshot } from '../../sessions/browser/views/sessionsCatalogList.js';
import type { SessionsCatalogListModel } from '../../sessions/browser/views/sessionsView.js';
import { CHAT_WORKSPACE_NAVIGATION_ID } from '../common/constants.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, isDisposable, type IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';

import type { SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';
import { sessionProjectOrganization, type SessionListOrganization } from '../../sessions/browser/views/sessionsListActions.js';

export interface ChatListEntry extends SessionListOrganization {
	/** Opaque identity, unique across the entire list. */
	readonly id: string;
	readonly title: string;
	/** Session catalog identity, when this row represents an Ash session. */
	readonly sessionId?: string;
	readonly groupingContext?: SessionGroupingContext;
	/** Milliseconds since the Unix epoch, when supplied by the catalog. */
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly projectId?: string;
	readonly selected: boolean;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly defaultIcon: Icon;
	readonly iconId?: string;
	readonly setIcon?: (icon: Icon | undefined) => void;
	readonly open: (signal: AbortSignal, threadId?: string) => Promise<void>;
	readonly archive?: () => Promise<boolean>;
	readonly getActions?: (signal: AbortSignal, restoreFocus: () => void) => readonly IAction[] | Promise<readonly IAction[]>;
}

type ProjectHistory =
	| { readonly state: 'idle' | 'more'; readonly load: () => void; }
	| { readonly state: 'loading' | 'complete' | 'unavailable' | 'error'; };

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
	readonly archive?: () => Promise<boolean>;
	readonly restore?: () => void;
	readonly remove?: { readonly removesContents: boolean; run(): Promise<void>; };
	readonly editDetails?: (signal: AbortSignal) => Promise<ConversationProjectEditor>;
	readonly appearance?: SessionsCatalogProjectAppearance;
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
	loadMore?(): void;
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

interface ProjectMembership {
	readonly revision: number;
	sessionIds?: readonly string[];
	failed?: boolean;
}

/** Combines the desktop conversation sources into the sidebar's ordered tree. */
export class ChatWorkspaceListModel extends Disposable implements SessionsCatalogListModel {
	private readonly membership = new Map<string, ProjectMembership>();
	private readonly membershipVersion = observableValue(this, 0);
	private readonly opening = this._register(new MutableDisposable());
	readonly snapshot;

	constructor(
		@IChatListCatalog private readonly catalog: IChatListCatalog,
		@IProjectsService private readonly projects: IProjectsService,
		@IProjectService private readonly projectService: IProjectService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService storage: IStorageService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.migrateCollapseState(storage);
		this.snapshot = derived(reader => {
			const projects = this.projects.state.read(reader).projects.filter(project => !project.archived);
			this.membershipVersion.read(reader);
			const snapshots = this.catalog.sources.map(source => source.snapshot.read(reader));
			const localProjects = new Map(projects.map(project => [project.id, project]));
			for (const id of this.membership.keys()) {
				if (!localProjects.has(id)) this.membership.delete(id);
			}
			const projectGroups = new Map(groupChatList(snapshots, 'projects').filter(group => group.project).map(group => [group.key, group]));
			const entries = snapshots.flatMap(snapshot => snapshot.entries);
			const projectEntryIds = new Set<string>();
			for (const project of projects) {
				const membership = this.readMembership(project.id, project.revision, project.sessionCount);
				const existing = projectGroups.get(project.id);
				const rows = getProjectSessionRows(entries, membership?.sessionIds ?? []);
				for (const row of rows) projectEntryIds.add(row.id);
				projectGroups.set(project.id, { key: project.id, title: project.name, rows: [...rows, ...(existing?.rows ?? [])], project: existing?.project });
			}

			const pinnedProjects = [...projectGroups.values()].filter(project => this.projects.isPinned(project.key));
			const otherProjects = [...projectGroups.values()].filter(project => !this.projects.isPinned(project.key));
			const groups = [...groupChatList(snapshots, 'chat', pinnedProjects.length > 0)];
			if (!groups.some(group => group.key === 'recent') && entries.some(entry => entry.pinned || entry.projectId || projectEntryIds.has(entry.id))) {
				groups.push({ key: 'recent', title: localize('sessions.chatList.recentGroup', 'Recent'), rows: [] });
			}
			const recent = groups.find(group => group.key === 'recent');
			const grouped = new Set<string>();
			const sessionIds = new Set(entries.map(entry => entry.sessionId));
			for (const group of snapshots.flatMap(snapshot => snapshot.groups ?? [])) {
				if (group.sessionIds.length && !group.sessionIds.some(id => sessionIds.has(id))) continue;
				const members = new Set(group.sessionIds);
				const rows = (recent?.rows ?? []).filter(entry => entry.sessionId && members.has(entry.sessionId)
					&& !projectEntryIds.has(entry.id) && !grouped.has(entry.id));
				for (const row of rows) grouped.add(row.id);
				groups.splice(recent ? groups.indexOf(recent) : groups.length, 0, { key: `group:${group.sectionId}`, title: group.name, rows });
			}
			groups.splice(groups[0]?.key === 'pinned' ? 1 : 0, 0,
				{ key: 'projects', title: localize('projects.title', 'Projects'), rows: [] });

			return {
				loading: snapshots.some(snapshot => snapshot.loading),
				sections: groups.map(group => {
					const { key } = group;
					const rows = group.rows.filter(entry => key !== 'recent' || !projectEntryIds.has(entry.id) && !grouped.has(entry.id))
						.map(entry => this.toRow(entry, projects));
					const projectGroups = key === 'pinned' ? pinnedProjects : key === 'projects' ? otherProjects : [];
					return { key, rows, projects: projectGroups.map(project => this.toProject(project, projects, localProjects.get(project.key))) };
				}),
			} satisfies SessionsCatalogSnapshot;
		});
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): void {
		void this.projects.reload();
		for (const source of this.catalog.sources) {
			if (source.attach) this._register(source.attach(window, isVisible));
		}
	}

	loadMore(): void {
		for (const source of this.catalog.sources) source.loadMore?.();
	}

	private migrateCollapseState(storage: IStorageService): void {
		const prefix = 'sessions.list.chat.collapsed.';
		const previousListPrefix = 'sessions.list.code.collapsed.';
		const previousPrefixes = [
			`workbench.viewContainer.${CHAT_WORKSPACE_NAVIGATION_ID}.${CHAT_WORKSPACE_NAVIGATION_ID}.`,
			'sessions.chatgpt.navigation.collapsed.',
		];
		for (const key of storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE)) {
			const previousProject = key.startsWith(`${previousListPrefix}catalog-project:`);
			const previousPrefix = previousPrefixes.find(prefix => key.startsWith(prefix));
			if (!previousProject && !previousPrefix) continue;
			const section = previousProject ? key.slice(previousListPrefix.length) : key.slice(previousPrefix!.length).replace(/\.collapsed$/, '');
			const group = previousProject || section === 'pinned' || section === 'recent' || section.startsWith('group:');
			const next = prefix + (group ? section : `catalog-project:${section.replace(/^project:/, '')}`);
			const previous = storage.getBoolean(key, StorageScope.PROFILE);
			if (section && section !== 'projects' && previous !== undefined && storage.getBoolean(next, StorageScope.PROFILE) === undefined) {
				storage.store(next, previous, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			storage.remove(key, StorageScope.PROFILE);
		}
	}

	private readMembership(id: string, revision: number, sessionCount: number): ProjectMembership | undefined {
		if (!sessionCount) {
			this.membership.delete(id);
			return undefined;
		}
		const current = this.membership.get(id);
		if (current?.revision === revision) return current;

		// Keep the last known membership until the new project revision is read.
		const request: ProjectMembership = { revision, sessionIds: current?.sessionIds };
		this.membership.set(id, request);
		const finish = (sessionIds?: readonly string[]): void => {
			if (this.isDisposed || this.membership.get(id) !== request) return;
			request.failed = sessionIds === undefined;
			request.sessionIds = sessionIds ?? request.sessionIds;
			this.membershipVersion.set(this.membershipVersion.get() + 1);
		};
		void this.projectService.read(id, 'chat').then(value => finish(value.sessionIds), () => finish());
		return request;
	}

	private toProject(project: ChatListGroup, destinations: readonly ProjectSummary[], localProject: ProjectSummary | undefined): SessionsCatalogProject {
		const rows = project.rows.map(entry => this.toRow(entry, destinations, project.key));
		const current = this.membership.get(project.key);
		const history = project.project?.history;
		const editDetails = project.project?.editDetails;
		const loading = history?.state === 'loading' || (current !== undefined && current.failed === undefined);
		const retry = current?.failed ? () => {
			this.membership.delete(project.key);
			this.membershipVersion.set(this.membershipVersion.get() + 1);
		} : undefined;
		return {
			key: project.key,
			title: project.title,
			rows,
			loading,
			localProject,
			appearance: project.project?.appearance,
			operations: {
				rename: editDetails && (async (name, signal) => {
					const editor = await editDetails(signal);
					signal.throwIfAborted();
					await editor.save({ ...editor.details, name });
				}),
				archive: project.project?.archive,
				remove: project.project?.remove,
			},
			history: retry ? { label: localize('sessions.chatList.retryProjectChats', 'Could not load project chats. Retry'), action: retry } : undefined,
			onExpand: history?.state === 'idle' ? history.load : undefined,
			loadMore: history?.state === 'more' ? history.load : undefined,
		};
	}

	private toRow(entry: ChatListEntry, destinations: readonly { readonly id: string; readonly name: string; }[], parentProject?: string): SessionsCatalogRow {
		const sessionId = entry.sessionId;
		const project = sessionId ? () => {
			const memberships = destinations.filter(project => this.membership.get(project.id)?.sessionIds?.includes(sessionId));
			const current = parentProject ?? (memberships.length === 1 ? memberships[0]!.id : undefined);
			return sessionProjectOrganization(this.projectService, sessionId, current, destinations);
		} : () => entry.project;
		return {
			id: entry.id,
			sessionId,
			title: entry.title,
			groupingContext: entry.groupingContext,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			selected: entry.selected,
			status: entry.status,
			disabled: entry.disabled,
			actionsDisabled: entry.actionsDisabled,
			defaultIcon: entry.defaultIcon,
			iconId: entry.iconId,
			setIcon: entry.setIcon,
			pinned: entry.pinned,
			setPinned: entry.setPinned,
			organization: () => entry.disabled || entry.actionsDisabled ? undefined : {
				pinned: entry.pinned, setPinned: entry.setPinned, moveToGroup: entry.moveToGroup, project: project(),
			},
			open: threadId => {
				const controller = new AbortController();
				this.opening.value = toDisposable(() => controller.abort());
				void entry.open(controller.signal, threadId).catch(error => {
					if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
				});
			},
			getActions: async (signal, restoreFocus) => {
				const contributed = await entry.getActions?.(signal, restoreFocus);
				const actions = [...contributed ?? []];
				if (entry.archive && !signal.aborted) {
					const presentation = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(this.configuration)).archive;
					const separator = actions.map(action => action instanceof Separator).lastIndexOf(true);
					actions.splice(separator < 0 ? actions.length : separator + 1, 0, {
						id: 'agentSession.archive',
						label: presentation.title.value, tooltip: presentation.title.value, icon: presentation.icon, enabled: true,
						run: () => this.commands.executeCommand('agentSession.archive', { catalogId: entry.id }),
					});
				}
				return actions;
			},
		};
	}
}
