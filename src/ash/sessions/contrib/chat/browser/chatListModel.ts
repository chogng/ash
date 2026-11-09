import { Lxicon } from '../../../../base/common/lxicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { createSessionWorkspaceActions } from '../../../browser/agentSessionsModel.js';
import { ISessionGroupsService, type SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { canOpenThreadInCode } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ASH_CHAT_SELECTED_CONTEXT, SHOW_ASH_CHAT_COMMAND } from '../common/constants.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';
import type { Event } from '../../../../base/common/event.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getChatSessionArchiveActionPresentation, getChatSessionArchiveActionWording } from '../../../../platform/chat/common/sessionArchiveActions.js';
import { IProjectService, type ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';
import type { ConversationProjectEditor, SessionGroupingContext, SessionsCatalogProject, SessionsCatalogRow, SessionsCatalogSnapshot } from '../../sessions/browser/views/sessionsCatalogList.js';
import type { SessionsCatalogListModel } from '../../sessions/browser/views/sessionsView.js';
import { CHAT_WORKSPACE_NAVIGATION_ID } from '../common/constants.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, isDisposable, type IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableFromEvent, observableSignalFromEvent, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';

import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';

import { sessionProjectOrganization, type SessionListOrganization } from '../../sessions/browser/views/sessionsListActions.js';

export interface ChatListEntry extends SessionListOrganization {
	/** Opaque identity, unique across the entire list. */
	readonly id: string;
	readonly title: string;
	/** Session catalog identity, when this row represents an Ash session. */
	readonly sessionId?: string;
	readonly externalConversationId?: string;
	readonly groupingContext?: SessionGroupingContext;
	/** Milliseconds since the Unix epoch, when supplied by the catalog. */
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly projectId?: string;
	readonly selected: boolean;
	readonly selectedThreadId?: string;
	readonly status?: ISessionStatusIcon;
	readonly disabled?: boolean;
	readonly actionsDisabled?: boolean;
	readonly defaultIcon: Icon;
	/** Opaque profile identity for catalog conversation preferences. */
	readonly preferenceKey?: string;
	readonly open: (signal: AbortSignal, threadId?: string) => Promise<void>;
	readonly archive?: () => Promise<boolean>;
	readonly getActions?: (signal: AbortSignal, restoreFocus: () => void) => readonly IAction[] | Promise<readonly IAction[]>;
}

type ProjectHistory =
	| { readonly state: 'idle' | 'more'; readonly load: () => void; }
	| { readonly state: 'loading' | 'complete' | 'unavailable' | 'error'; };

export interface ChatListProject {
	/** Stable identity for membership and persisted expansion. */
	readonly id: string;
	readonly title: string;
	/** Milliseconds since the Unix epoch, when supplied by the project owner. */
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly history: ProjectHistory;
	readonly archived?: boolean;
	readonly archive?: () => Promise<boolean>;
	readonly restore?: () => void;
	readonly remove?: { readonly removesContents: boolean; run(): Promise<void>; };
	readonly editDetails?: (signal: AbortSignal) => Promise<ConversationProjectEditor>;
	/** Profile preference identity, scoped to the owning account and project. */
	readonly preferenceKey?: string;
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
	readonly onDidRetirePreferenceIdentity?: Event<{ readonly key: string; readonly replacementKey?: string; }>;
	attach?(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable;
	loadMore?(): void;
}

export interface IChatListCatalog {
	readonly sources: readonly ChatListSource[];
}

export const IChatListCatalog = createServiceIdentifier<IChatListCatalog>('chatListCatalog');

export class ChatListCatalog extends Disposable implements IChatListCatalog {
	readonly sources: readonly ChatListSource[];

	constructor(adapters: readonly SyncDescriptor<ChatListSource>[],
		@IInstantiationService instantiation: IInstantiationService,
		@ISessionsListModelService list: ISessionsListModelService,
	) {
		super();
		this.sources = adapters.map(adapter => {
			const source = instantiation.createInstance(adapter);
			if (isDisposable(source)) this._register(source);
			if (source.onDidRetirePreferenceIdentity) {
				this._register(source.onDidRetirePreferenceIdentity(({ key, replacementKey }) => {
					const icon = list.getRowIcon(key, 'catalog');
					if (replacementKey === key || icon === undefined) return;
					if (replacementKey && list.getRowIcon(replacementKey, 'catalog') === undefined) {
						list.setRowIcon(replacementKey, icon, 'catalog');
					}
					list.setRowIcon(key, undefined, 'catalog');
				}));
			}
			return source;
		});
	}
}

/** Projects native Sessions through the same list contract as contributed sources. */
export class NativeChatCatalogSource extends Disposable implements ChatListSource {
	readonly snapshot;

	constructor(
		@ISessionsListModelService list: ISessionsListModelService,
		@ISessionGroupsService groups: ISessionGroupsService,
		@ICommandService commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ISessionsSearchService search: ISessionsSearchService,
		@ISessionsManagementService management: ISessionsManagementService,
		@ISessionsService view: ISessionsService,
	) {
		super();
		const context = new Set([ASH_CHAT_SELECTED_CONTEXT]);
		const visible = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(context)) listener(event);
		}), () => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) === true);
		const catalog = observableFromEvent(this, management.onDidChange, () => management.sessions);
		void management.initialize().catch(onUnexpectedError);
		const listChanged = observableSignalFromEvent(this, list.onDidChange);
		const groupsChanged = observableSignalFromEvent(this, groups.onDidChange);
		const working: ISessionStatusIcon = {
			label: localize('sessions.management.working', 'Working'), kind: 'inProgress', icon: Lxicon.sync,
		};
		this.snapshot = derived<ChatListSnapshot>(reader => {
			listChanged.read(reader);
			groupsChanged.read(reader);
			const active = view.chatSelection.read(reader);
			const selectedId = visible.read(reader) && active?.kind === 'thread' ? active.sessionId : undefined;
			const rows: ChatListEntry[] = [];
			for (const session of catalog.read(reader)) {
				if (session.kind !== 'chat' || session.backendSessionId !== undefined || session.status !== 'active'
					|| session.sessionId !== selectedId && !list.isSessionListed(session)) continue;
				const chats = session.chats.filter(chat => chat.status === 'active');
				const thread = chats.find(chat => chat.threadId === session.sessionId)
					?? chats.find(chat => chat.origin.type === 'root') ?? chats[0];
				if (!thread) continue;
				const id = session.sessionId;
				const isPinned = list.isSessionPinned(session);
				rows.push({
					id: `ash:${id}`,
					title: session.title || localize('sessions.list.untitled', 'Untitled Session'),
					sessionId: id,
					groupingContext: { sessionId: id, workspace: session.workspace ?? undefined, management: session.management },
					createdAt: thread.createdAt?.getTime(),
					updatedAt: (thread.updatedAt ?? thread.createdAt)?.getTime(),
					selected: selectedId === id,
					selectedThreadId: selectedId === id && active?.kind === 'thread' ? active.threadId : undefined,
					status: session.management?.status === 'working' ? working : undefined,
					defaultIcon: Lxicon.chatSession,
					pinned: isPinned,
					setPinned: pinned => pinned ? list.pinSession(session) : list.unpinSession(session),
					moveToGroup: group => groups.move(id, group),
					open: async (signal, threadId = thread.threadId) => {
						await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
						if (signal.aborted) return;
						view.selectChatThread(id, threadId);
					},
					getActions: () => {
						const saved = management.sessions.find(session => session.sessionId === id);
						const savedThread = saved?.chats.find(chat => chat.threadId === thread.threadId);
						const workspaceActions = createSessionWorkspaceActions(id, thread.threadId, management, commands);
						if (saved?.status === 'active' && savedThread && canOpenThreadInCode(saved, savedThread)) {
							workspaceActions.push({
								id: 'sessions.workspace.continueInCode',
								label: localize({ bundle: 'ash.sessions', key: 'sessions.workspace.continueInCode' }, 'Continue in Code'),
								tooltip: '', enabled: true,
								run: () => view.openSession(id, thread.threadId, { reveal: 'code' }),
							});
						}
						return workspaceActions;
					},
				});
			}
			return { entries: rows, groups: groups.groups.filter(group => group.kind !== 'comparison') };
		});
		this._register(search.registerSource(this.snapshot.map(snapshot => snapshot.entries.map(entry => ({
			id: entry.id, category: 'sessions', title: entry.title, icon: entry.defaultIcon,
			target: { kind: 'contributed', open: () => entry.open(new AbortController().signal) },
		} satisfies SearchResult)))));
	}
}

export interface ChatListGroup {
	readonly key: string;
	readonly title: string;
	readonly rows: ChatListEntry[];
	readonly project?: ChatListProject;
}

export function getProjectSessionRows(entries: readonly ChatListEntry[], sessionIds: readonly string[], externalConversationIds?: readonly string[]): ChatListEntry[] {
	const members = new Set(sessionIds);
	const external = new Set(externalConversationIds);
	return entries.filter(entry => (entry.sessionId !== undefined && members.has(entry.sessionId))
		|| (entry.externalConversationId !== undefined && external.has(entry.externalConversationId)))
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
	externalConversationIds?: readonly string[];
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
		@ISessionsListModelService private readonly list: ISessionsListModelService,
	) {
		super();
		this.migrateCollapseState(storage);
		const listChanged = observableSignalFromEvent(this, list.onDidChange);
		this.snapshot = derived(reader => {
			listChanged.read(reader);
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
				const rows = getProjectSessionRows(entries, membership?.sessionIds ?? [], membership?.externalConversationIds);
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
		const request: ProjectMembership = { revision, sessionIds: current?.sessionIds, externalConversationIds: current?.externalConversationIds };
		this.membership.set(id, request);
		const finish = (project?: { readonly sessionIds: readonly string[]; readonly externalConversationIds?: readonly string[]; }): void => {
			if (this.isDisposed || this.membership.get(id) !== request) return;
			request.failed = project === undefined;
			if (project) {
				request.sessionIds = project.sessionIds;
				request.externalConversationIds = project.externalConversationIds;
			}
			this.membershipVersion.set(this.membershipVersion.get() + 1);
		};
		void this.projectService.read(id, 'chat').then(finish, () => finish());
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
			appearance: project.project?.preferenceKey ? this.projects.getCatalogProjectAppearance(project.project.preferenceKey) : undefined,
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
		const iconKey = sessionId ? `session:${sessionId}` : entry.preferenceKey;
		const iconScope = sessionId ? undefined : 'catalog';
		const project = sessionId ? () => {
			const memberships = destinations.filter(project => this.membership.get(project.id)?.sessionIds?.includes(sessionId));
			const current = parentProject ?? (memberships.length === 1 ? memberships[0]!.id : undefined);
			return sessionProjectOrganization(this.projectService, sessionId, current, destinations);
		} : () => {
			const externalId = entry.externalConversationId;
			if (!externalId) return entry.project;
			const memberships = destinations.filter(item => this.membership.get(item.id)?.externalConversationIds?.includes(externalId));
			const current = memberships.find(item => item.id === parentProject) ?? (memberships.length === 1 ? memberships[0] : undefined);
			const ashDestinations = destinations.map(({ id, name }) => ({ id, title: name }));
			if (!current) {
				const remote = entry.project;
				if (remote?.current || !ashDestinations.length) return remote;
				return {
					...remote,
					destinations: [...ashDestinations, ...(remote?.destinations ?? [])],
					move: (destination: string | undefined) => ashDestinations.some(item => item.id === destination)
						? this.projectService.moveExternalConversation(externalId, undefined, destination)
						: remote?.move(destination) ?? Promise.resolve(),
				};
			}
			return {
				current: current.id,
				destinations: ashDestinations,
				move: (destination: string | undefined) => this.projectService.moveExternalConversation(externalId, current.id, destination),
			};
		};
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
			iconId: iconKey ? this.list.getRowIcon(iconKey, iconScope) : undefined,
			setIcon: iconKey ? icon => this.list.setRowIcon(iconKey, icon?.id, iconScope) : undefined,
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
