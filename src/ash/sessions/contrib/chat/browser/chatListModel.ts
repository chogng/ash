import { Lxicon } from '../../../../base/common/lxicons.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { createSessionWorkspaceActions } from '../../../browser/agentSessionsModel.js';
import { ISessionGroupsService, type SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { canOpenThreadInCode, type IChat, type ISession } from '../../../../workbench/services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND } from '../../../common/chatWorkspace.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';
import type { Event } from '../../../../base/common/event.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { extname } from '../../../../base/common/path.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { getChatSessionArchiveActionPresentation, getChatSessionArchiveActionWording } from '../../../../platform/chat/common/sessionArchiveActions.js';
import { IProjectService, type Project, type ProjectMaterial, type ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';
import type { CatalogProjectCreator, CatalogProjectMemoryMode, ConversationProjectEditor, SessionGroupingContext, SessionsCatalogProject, SessionsCatalogProjectFile, SessionsCatalogRow, SessionsCatalogSnapshot } from '../../sessions/browser/views/sessionsCatalogList.js';
import type { SessionsCatalogListModel } from '../../sessions/browser/views/sessionsView.js';
import { Separator, SubmenuAction, type IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable, DisposableMap, DisposableStore, isDisposable, type IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableFromEvent, observableSignalFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';

import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';

import { sessionProjectOrganization, type SessionListOrganization, type SessionListProjectOrganization } from '../../sessions/browser/views/sessionsListActions.js';
import { NativeConversationShare } from './nativeConversationShare.js';
import { ChatListForks } from './chatListForks.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { isWeb } from '../../../../base/common/platform.js';
import { openProjectFile, projectMaterialFile, projectMaterialId, resolveProjectFileReference } from '../../projects/browser/projectMaterialFiles.js';
import { IProjectMaterialFileService } from '../../projects/browser/projectMaterialFileService.js';

export interface ChatListForkReference {
	readonly id: string;
	readonly title?: string;
	readonly preferenceKey?: string;
}

export interface ChatListForkEvidence {
	readonly source?: ChatListForkReference;
	readonly hasMarker: boolean;
	readonly createdAt?: number;
	readonly messages: ReadonlyMap<string, number>;
}

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
	readonly forkSource?: { readonly id: string; readonly title: string; readonly open?: (signal: AbortSignal) => Promise<void>; };
	readonly loadForkEvidence?: (signal: AbortSignal) => Promise<ChatListForkEvidence>;
	readonly openForkSource?: (source: ChatListForkReference, signal: AbortSignal) => Promise<void>;
	/** Opaque profile identity for catalog conversation preferences. */
	readonly preferenceKey?: string;
	readonly open: (signal: AbortSignal, threadId?: string) => Promise<void>;
	readonly rename?: (title: string) => Promise<void>;
	readonly validateRename?: (title: string) => string | undefined;
	readonly share?: () => Promise<void>;
	readonly archive?: () => Promise<boolean>;
	/** Deletes this conversation after the host confirms the action. */
	readonly remove?: () => Promise<void>;
	readonly getActions?: (signal: AbortSignal) => readonly IAction[] | Promise<readonly IAction[]>;
}

export function getChatListEntryProject(
	entry: ChatListEntry, destinations: readonly { readonly id: string; readonly name: string; }[],
	projects: IProjectService, localProjectId?: string,
): SessionListProjectOrganization | undefined {
	if (entry.sessionId) return sessionProjectOrganization(projects, entry.sessionId, localProjectId, destinations);
	const externalId = entry.externalConversationId;
	if (!externalId) return entry.project;
	const ashDestinations = destinations.map(({ id, name }) => ({ id, title: name }));
	if (localProjectId) {
		return {
			current: localProjectId,
			destinations: ashDestinations,
			move: destination => projects.moveExternalConversation(externalId, localProjectId, destination),
		};
	}
	const remote = entry.project;
	if (remote?.current || !ashDestinations.length) return remote;
	return {
		...remote,
		destinations: [...ashDestinations, ...(remote?.destinations ?? [])],
		move: destination => ashDestinations.some(item => item.id === destination)
			? projects.moveExternalConversation(externalId, undefined, destination)
			: remote?.move(destination) ?? Promise.resolve(),
	};
}

export async function getChatListEntryActions(
	entry: ChatListEntry, signal: AbortSignal, commands: ICommandService, configuration: IConfigurationService,
): Promise<IAction[]> {
	const contributed = await entry.getActions?.(signal);
	const actions = [...contributed ?? []];
	if (signal.aborted || !(entry.archive || entry.remove)) return actions;
	if (actions.length) actions.push(new Separator());
	if (entry.archive) {
		const presentation = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archive;
		actions.push({
			id: 'agentSession.archive',
			label: presentation.title.value, tooltip: presentation.title.value, icon: presentation.icon, enabled: true,
			run: () => commands.executeCommand('agentSession.archive', { catalogId: entry.id }),
		});
	}
	if (entry.remove) actions.push({
		id: 'agentSession.delete', label: localize('sessions.list.delete', 'Delete'),
		icon: Lxicon.trash, enabled: true, tooltip: '',
		run: () => commands.executeCommand('agentSession.delete', { catalogId: entry.id, preferenceKey: entry.preferenceKey }),
	});
	return actions;
}

type ProjectHistory =
	| { readonly state: 'idle'; readonly load: () => void; }
	| { readonly state: 'more'; readonly load: () => void; readonly manual?: boolean; }
	| { readonly state: 'loading' | 'refreshing' | 'complete' | 'unavailable' | 'error'; };

export interface ProjectMaterialRow {
	readonly id: string;
	readonly name: string;
	readonly kind: 'file' | 'folder';
	readonly tooltip?: string;
	readonly sizeBytes?: number;
	/** Reads the provider's source bytes. Ash owns the lifecycle of any local copy. */
	readonly read?: (signal: AbortSignal) => Promise<Blob>;
	readonly open?: () => Promise<void>;
	readonly remove?: () => Promise<void>;
}

export interface CatalogProjectMemoryEditor {
	/** Saved versions, with the current version first. */
	readonly versions: readonly string[];
	readonly storageDescription: string;
	/** On conflict, returns the latest editor so the caller can review its versions and retry. */
	readonly save?: (body: string) => Promise<CatalogProjectMemoryEditor | undefined>;
}

export interface CatalogProjectDetails {
	readonly key: string;
	readonly data: IObservable<{
		readonly description: string;
		readonly materials: readonly ProjectMaterialRow[] | undefined;
		readonly canEdit: boolean;
		readonly memoryMode?: CatalogProjectMemoryMode;
	} | undefined>;
	readonly load?: (signal: AbortSignal) => Promise<void>;
	readonly editMemory?: (signal: AbortSignal) => Promise<CatalogProjectMemoryEditor>;
	readonly upload?: {
		readonly limits: { readonly count: number; readonly fileBytes: number; readonly totalBytes: number; };
		readonly limitMessage: string;
		/** Calls onFileAdded once the provider confirms the file, before publishing the updated catalog. */
		readonly addFiles: (files: readonly File[], onFileAdded: (file: Pick<ProjectMaterialRow, 'id' | 'name'>) => void | Promise<void>) => Promise<void>;
	};
}

export interface ChatListProject {
	/** Stable identity for membership and persisted expansion. */
	readonly id: string;
	readonly title: string;
	/** Milliseconds since the Unix epoch, when supplied by the project owner. */
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly history: ProjectHistory;
	/** Revalidates the project's first page if its cached result is stale. */
	readonly refreshHistory?: () => void;
	readonly details?: CatalogProjectDetails;
	readonly composer?: {
		/** Opaque draft scope. The catalog owner includes the account and project identity. */
		readonly key: string;
		create(isVisible: () => boolean): IChatWidgetModel & { readonly submitted: boolean; };
	};
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
	readonly projectCreator?: CatalogProjectCreator;
	/** Threads within an existing session appear as shortcuts in its fork tree. */
	readonly forkEntries?: readonly ChatListEntry[];
	readonly projects?: readonly ChatListProject[];
	readonly groups?: readonly SessionGroup[];
	readonly loading?: boolean;
}

/** Catalog owners supply records and operations. The list owns their placement. */
export interface ChatListSource {
	readonly snapshot: IObservable<ChatListSnapshot>;
	readonly onDidCreateFork?: Event<{ readonly key: string; readonly parent: ChatListForkReference; }>;
	readonly onDidRetirePreferenceIdentity?: Event<{ readonly key: string; readonly replacementKey?: string; }>;
	/** Returns the project member references this source confirmed archived. */
	archiveProjectMembers?(references: ReadonlySet<string>): Promise<ReadonlySet<string>>;
	attach?(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable;
	loadMore?(): void;
}

export interface IChatListCatalog {
	readonly sources: readonly ChatListSource[];
	readonly forks?: Pick<ChatListForks, 'project'>;
	attach(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable;
}

export const IChatListCatalog = createServiceIdentifier<IChatListCatalog>('chatListCatalog');

export class ChatListCatalog extends Disposable implements IChatListCatalog {
	readonly sources: readonly ChatListSource[];
	readonly forks: ChatListForks;
	private readonly windows = this._register(new DisposableMap<Window, IDisposable & { readonly views: Set<() => boolean>; }>());

	constructor(adapters: readonly SyncDescriptor<ChatListSource>[],
		@IInstantiationService instantiation: IInstantiationService,
		@ISessionsListModelService list: ISessionsListModelService,
		@IStorageService storage: IStorageService,
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
		this.forks = this._register(new ChatListForks(this.sources, storage));
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): IDisposable {
		const view = () => isVisible();
		const existing = this.windows.get(window);
		const views = existing?.views ?? new Set<() => boolean>();
		views.add(view);
		if (!existing) {
			const sources = new DisposableStore();
			this.windows.set(window, Object.assign(sources, { views }));
			// Projects and Chat can keep their views alive in the same window. The provider
			// only needs one set of window listeners and refreshes while either surface is visible.
			try {
				for (const source of this.sources) {
					if (source.attach) sources.add(source.attach(window, () => [...views].some(check => check())));
				}
			} catch (error) {
				this.windows.deleteAndDispose(window);
				throw error;
			}
		}
		return toDisposable(() => {
			views.delete(view);
			if (!views.size && this.windows.get(window)?.views === views) this.windows.deleteAndDispose(window);
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
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const sharing = instantiation.createInstance(NativeConversationShare);
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
			const selectedThread = selectedId && active?.kind === 'thread' ? active.threadId : undefined;
			const sessions = catalog.read(reader).filter(session => session.kind === 'chat' && session.backendSessionId === undefined && session.status === 'active');
			const roots = new Map<string, IChat>();
			const threads = new Map<string, { readonly session: ISession; readonly thread: IChat; readonly id: string; }>();
			for (const session of sessions) {
				const chats = session.chats.filter(chat => chat.status === 'active');
				const root = chats.find(chat => chat.threadId === session.sessionId) ?? chats.find(chat => chat.origin.type === 'root') ?? chats[0];
				if (!root) continue;
				roots.set(session.sessionId, root);
				for (const thread of chats) {
					const id = thread === root ? `ash:${session.sessionId}` : `ash:thread:${JSON.stringify([session.sessionId, thread.threadId])}`;
					threads.set(thread.threadId, { session, thread, id });
				}
			}
			const openThread = async (signal: AbortSignal, sessionId: string, threadId: string) => {
				await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
				if (!signal.aborted) view.selectChatThread(sessionId, threadId);
			};
			const forkSource = (thread: IChat): ChatListEntry['forkSource'] => {
				if (thread.origin.type !== 'fork') return undefined;
				const parent = threads.get(thread.origin.parentThreadId);
				if (!parent) return {
					id: `ash:unlisted-thread:${thread.origin.parentThreadId}`,
					title: localize('sessions.list.forkSourceUnavailable', 'Source conversation unavailable'),
				};
				return {
					id: parent.id, title: parent.thread.title || parent.session.title,
					open: signal => openThread(signal, parent.session.sessionId, parent.thread.threadId),
				};
			};
			const rows: ChatListEntry[] = [];
			const forkEntries: ChatListEntry[] = [];
			const pendingArchives = management.pendingArchives.read(reader);
			for (const session of sessions) {
				if (pendingArchives.has(session.sessionId) || session.sessionId !== selectedId && !list.isSessionListed(session)) continue;
				const thread = roots.get(session.sessionId);
				if (!thread) continue;
				const id = session.sessionId;
				const title = session.title || localize('sessions.list.untitled', 'Untitled Session');
				const selectedThreadId = selectedId === id ? selectedThread : undefined;
				const isPinned = list.isSessionPinned(session);
				const open = (signal: AbortSignal, threadId = thread.threadId) => openThread(signal, id, threadId);
				for (const child of session.chats) {
					if (child === thread || child.status !== 'active' || child.origin.type !== 'fork') continue;
					forkEntries.push({
						id: threads.get(child.threadId)!.id,
						title: child.title || localize('sessions.list.untitledChat', 'Untitled Chat'),
						createdAt: child.createdAt?.getTime(),
						updatedAt: (child.updatedAt ?? child.createdAt)?.getTime(),
						selected: selectedThreadId === child.threadId,
						defaultIcon: Lxicon.chatSession,
						forkSource: forkSource(child),
						open: signal => openThread(signal, id, child.threadId),
					});
				}
				rows.push({
					id: `ash:${id}`,
					title,
					sessionId: id,
					groupingContext: { sessionId: id, workspace: session.workspace ?? undefined, management: session.management },
					createdAt: thread.createdAt?.getTime(),
					updatedAt: (thread.updatedAt ?? thread.createdAt)?.getTime(),
					selected: selectedId === id,
					selectedThreadId,
					status: session.management?.status === 'working' ? working : undefined,
					defaultIcon: Lxicon.chatSession,
					forkSource: forkSource(thread),
					pinned: isPinned,
					setPinned: pinned => pinned ? list.pinSession(session) : list.unpinSession(session),
					moveToGroup: group => groups.move(id, group),
					open,
					rename: title => management.renameSession(id, title),
					share: () => sharing.share(id, selectedThreadId ?? thread.threadId, title),
					getActions: signal => {
						const saved = management.sessions.find(session => session.sessionId === id);
						const codeThreadId = selectedThreadId ?? thread.threadId;
						const codeThread = saved?.chats.find(chat => chat.threadId === codeThreadId);
						const workspaceActions = createSessionWorkspaceActions(id, thread.threadId, management, commands);
						// The catalog projects both forks and rewrites as branches.
						const branches = saved?.chats.filter(chat => chat.status === 'active' && (chat.origin.type === 'fork' || chat.origin.type === 'rewind')) ?? [];
						if (thread.origin.type === 'root' && branches.length) {
							workspaceActions.push(new SubmenuAction('sessions.chat.versions', localize('sessions.chat.versions', 'Conversation versions'),
								[thread, ...branches].map((version, index) => ({
									id: `sessions.chat.version.${version.threadId}`,
									label: index ? localize('sessions.chat.versionNumber', 'Version {0}', index) : localize('sessions.chat.originalVersion', 'Original conversation'),
									tooltip: '', enabled: true, checked: version.threadId === selectedThreadId,
									run: () => open(signal, version.threadId),
								}))));
						}
						if (saved?.status === 'active' && codeThread && canOpenThreadInCode(saved, codeThread)) {
							workspaceActions.push({
								id: 'sessions.workspace.continueInCode',
								label: localize({ bundle: 'ash.sessions', key: 'sessions.workspace.continueInCode' }, 'Continue in Code'),
								tooltip: '', enabled: true,
								run: () => view.openSession(id, codeThreadId, { reveal: 'code' }),
							});
						}
						return workspaceActions;
					},
				});
			}
			return { entries: rows, forkEntries, groups: groups.groups.filter(group => group.kind !== 'comparison') };
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

type ChatProjectPreview = NonNullable<SessionsCatalogProject['preview']>;

export function getLocalProjectPreview(project: ProjectSummary, readDescription: () => Promise<string>, description?: string): ChatProjectPreview {
	return {
		conversationCount: project.sessionCount,
		updatedAt: project.updatedAtMs,
		createdAt: project.createdAtMs,
		description,
		descriptionSource: description === undefined ? {
			key: JSON.stringify([project.id, project.revision]),
			load: token => raceCancellationError(readDescription(), token),
		} : undefined,
	};
}

export function getCatalogProjectPreview(group: ChatListGroup, reader?: IReader): ChatProjectPreview {
	const details = group.project?.details;
	const description = reader && details?.data.read(reader)?.description;
	return {
		conversationCount: new Set(group.rows.map(row => row.id)).size,
		updatedAt: group.project?.updatedAt,
		createdAt: group.project?.createdAt,
		description,
		descriptionSource: description === undefined && details ? {
			key: details.key,
			load: async token => {
				// Read outside the Projects page's render so resolving hover content does not replace its anchor.
				const cached = details.data.get()?.description;
				if (cached !== undefined || !details.load || token.isCancellationRequested) return cached;
				const controller = new AbortController();
				using cancellation = token.onCancellationRequested(() => controller.abort());
				await details.load(controller.signal);
				return details.data.get()?.description;
			},
		} : undefined,
	};
}

export function getCatalogProjectRename(editDetails: ChatListProject['editDetails']): ((name: string, signal: AbortSignal) => Promise<void>) | undefined {
	if (!editDetails) return undefined;
	return async (name, signal) => {
		const editor = await editDetails(signal);
		signal.throwIfAborted();
		await editor.save({ ...editor.details, name });
	};
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
	project: Project | undefined;
	readonly read: Promise<Project>;
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
		@IFileService private readonly files: IFileService,
		@IEditorService private readonly editors: IEditorService,
		@IProjectMaterialFileService private readonly projectMaterialFiles: IProjectMaterialFileService,
		@ISessionsEntryService private readonly entries: ISessionsEntryService,
	) {
		super();
		this.migrateCollapseState(storage);
		const listChanged = observableSignalFromEvent(this, list.onDidChange);
		this.snapshot = derived(reader => {
			listChanged.read(reader);
			const projects = this.projects.state.read(reader).projects.filter(project => !project.archived);
			this.membershipVersion.read(reader);
			const snapshots = this.catalog.sources.map(source => {
				const snapshot = source.snapshot.read(reader);
				return this.catalog.forks ? { ...snapshot, entries: this.catalog.forks.project(snapshot.entries, reader) } : snapshot;
			});
			const localProjects = new Map(projects.map(project => [project.id, project]));
			for (const id of this.membership.keys()) {
				if (!localProjects.has(id)) this.membership.delete(id);
			}
			const projectGroups = new Map(groupChatList(snapshots, 'projects').filter(group => group.project).map(group => [group.key, group]));
			const entries = snapshots.flatMap(snapshot => snapshot.entries);
			const projectEntryIds = new Set<string>();
			for (const project of projects) {
				const saved = project.sessionCount ? this.readProject(project).project : undefined;
				const existing = projectGroups.get(project.id);
				const rows = getProjectSessionRows(entries, saved?.sessionIds ?? [], saved?.externalConversationIds);
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
				forkEntries: snapshots.flatMap(snapshot => (snapshot.forkEntries ?? []).map(entry => this.toRow(entry, projects))),
				sections: groups.map(group => {
					const { key } = group;
					const rows = group.rows.filter(entry => key !== 'recent' || !projectEntryIds.has(entry.id) && !grouped.has(entry.id))
						.map(entry => this.toRow(entry, projects));
					const projectGroups = key === 'pinned' ? pinnedProjects : key === 'projects' ? otherProjects : [];
					return { key, rows, projects: projectGroups.map(project => this.toProject(project, projects, localProjects.get(project.key), reader)) };
				}),
			} satisfies SessionsCatalogSnapshot;
		});
	}

	attach(window: Window & typeof globalThis, isVisible: () => boolean): void {
		void this.projects.reload();
		this._register(this.catalog.attach(window, isVisible));
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

	private readProject({ id, revision }: ProjectSummary): ProjectMembership {
		const current = this.membership.get(id);
		if (current?.revision === revision) return current;

		// Keep the last known membership until the new project revision is read.
		const request: ProjectMembership = { revision, project: current?.project, read: this.projectService.read(id, 'chat') };
		this.membership.set(id, request);
		const finish = (project?: Project): void => {
			if (this.isDisposed || this.membership.get(id) !== request) return;
			request.failed = project === undefined;
			if (project) request.project = project;
			this.membershipVersion.set(this.membershipVersion.get() + 1);
		};
		void request.read.then(finish, () => finish());
		return request;
	}

	private toProject(project: ChatListGroup, destinations: readonly ProjectSummary[], localProject: ProjectSummary | undefined, reader: IReader): SessionsCatalogProject {
		const rows = project.rows.map(entry => this.toRow(entry, destinations, project.key));
		const current = this.membership.get(project.key);
		const history = project.project?.history;
		const preview = localProject ? getLocalProjectPreview(localProject,
			async () => (await this.readProject(localProject).read).description,
			current?.revision === localProject.revision && !current.failed ? current.project?.description : undefined,
		) : getCatalogProjectPreview(project, reader);
		const loading = history?.state === 'loading' || (!!localProject?.sessionCount && current !== undefined && current.failed === undefined);
		const retry = localProject?.sessionCount && current?.failed ? () => {
			this.membership.delete(project.key);
			this.membershipVersion.set(this.membershipVersion.get() + 1);
		} : undefined;
		return {
			key: project.key,
			title: project.title,
			rows,
			loading,
			preview,
			localProject,
			appearance: project.project?.preferenceKey ? this.projects.getCatalogProjectAppearance(project.project.preferenceKey) : undefined,
			operations: {
				editDetails: project.project?.editDetails,
				archive: project.project?.archive,
				remove: project.project?.remove,
			},
			history: retry ? { label: localize('sessions.chatList.retryProjectChats', 'Could not load project chats. Retry'), action: retry }
				: history?.state === 'more' && history.manual
					? { label: localize({ bundle: 'ash.sessions', key: 'sessions.list.moreProjectConversations' }, 'Load more conversations'), action: history.load }
					: undefined,
			onExpand: history?.state === 'idle' ? history.load : undefined,
			loadMore: history?.state === 'more' && !history.manual ? history.load : undefined,
			files: this.projectFiles(localProject, project.project, destinations, reader),
		};
	}

	private projectFiles(local: ProjectSummary | undefined, catalog: ChatListProject | undefined, destinations: readonly ProjectSummary[], reader: IReader): SessionsCatalogProject['files'] {
		if (local) {
			const current = this.membership.get(local.id);
			return {
				key: JSON.stringify(['local', local.id, local.revision]),
				rows: current?.project?.materials.flatMap(material => material.kind === 'file' ? [this.localProjectFile(local.id, material, destinations)] : []),
				load: current?.revision === local.revision && current.failed === false ? undefined : async signal => {
					if (this.membership.get(local.id)?.failed) this.membership.delete(local.id);
					await this.readProject(local).read;
					signal.throwIfAborted();
				},
			};
		}
		const details = catalog?.details;
		if (!catalog || !details) return undefined;
		const source = this.catalog.sources.find(source => source.snapshot.read(reader).projects?.some(project => project.details?.key === details.key));
		const targets = source?.snapshot.read(reader).projects?.filter(project => !project.archived && project.details?.key !== details.key && project.details?.upload && project.details.data.read(reader)?.canEdit !== false) ?? [];
		return {
			key: details.key,
			rows: details.data.read(reader)?.materials?.filter(material => material.kind === 'file').map(material => this.catalogProjectFile(catalog, details, material, targets)),
			load: details.load,
		};
	}

	private localProjectFile(projectId: string, material: Extract<ProjectMaterial, { kind: 'file'; }>, destinations: readonly ProjectSummary[]): SessionsCatalogProjectFile {
		const id = projectMaterialId(material);
		const key = `local:${projectId}`;
		const read = async () => {
			const project = await this.projectService.read(projectId, 'chat');
			const file = project.materials.find(item => item.kind === 'file' && projectMaterialId(item) === id);
			if (project.archived || file?.kind !== 'file') throw new CancellationError();
			return { project, file };
		};
		return {
			id, name: material.name,
			open: async (signal, restoreFocus) => {
				using copies = this.projectMaterialFiles.copies(key);
				const resource = await resolveProjectFileReference(this.files, copies, material, () => !signal.aborted);
				signal.throwIfAborted();
				await this.openSidebarFile(resource, resource.scheme === projectMaterialFilesScheme, signal, restoreFocus);
			},
			rename: async name => {
				const { project, file } = await read();
				await this.projectService.update(project, project.name, project.description, project.materials.map(item => item === file ? { ...file, name } : item));
			},
			remove: async () => {
				const { project, file } = await read();
				await this.projectService.update(project, project.name, project.description, project.materials.filter(item => item !== file));
				using copies = this.projectMaterialFiles.copies(key);
				if (copies) await this.projectMaterialFiles.removeCopy(copies, projectMaterialFile(file));
			},
			reveal: !isWeb && material.resource.scheme === 'file' && !material.resource.authority ? async () => {
				const { file } = await read();
				using copies = this.projectMaterialFiles.copies(key);
				const managed = await copies?.existing(projectMaterialFile(file));
				return managed && copies ? copies.localResource(managed) : file.resource;
			} : undefined,
			destinations: destinations.filter(target => target.id !== projectId).map(target => ({
				id: target.id, title: target.name,
				move: async () => {
					const { project, file } = await read();
					const destination = await this.projectService.read(target.id, 'chat');
					if (destination.archived) throw new CancellationError();
					const existing = destination.materials.find(item => item.kind !== 'text' && item.resource.toString() === file.resource.toString());
					if (existing && projectMaterialId(existing) !== id) {
						throw new Error(localize('projects.fileAlreadyInProject', 'This file is already in the destination project.'));
					}
					using copies = this.projectMaterialFiles.copies(key);
					using targetCopies = this.projectMaterialFiles.copies(`local:${destination.id}`);
					const material = projectMaterialFile(file);
					const sourceCopy = await copies?.existing(material);
					let replacement: URI | undefined;
					if (sourceCopy && targetCopies) {
						await this.projectMaterialFiles.prepareTransfer(sourceCopy);
						const { bytes } = await this.files.readFileBytes(sourceCopy);
						replacement = await targetCopies.ensure(material, async () => new Blob([new Uint8Array(bytes).buffer]));
						const targetBytes = (await this.files.readFileBytes(replacement)).bytes;
						if (targetBytes.length !== bytes.length || !targetBytes.every((byte, index) => byte === bytes[index])) {
							throw new Error(localize('projects.fileCopyConflict', 'The destination already has a local copy with different contents.'));
						}
					}
					if (!existing) await this.projectService.update(destination, destination.name, destination.description, [...destination.materials, file]);
					try {
						await this.projectService.update(project, project.name, project.description, project.materials.filter(item => item !== file));
						if (copies) await this.projectMaterialFiles.removeCopy(copies, material, replacement);
					} catch (error) { throw incompleteFileTransfer(error); }
				},
			})),
		};
	}

	private catalogProjectFile(catalog: ChatListProject, details: CatalogProjectDetails, file: ProjectMaterialRow, targets: readonly ChatListProject[]): SessionsCatalogProjectFile {
		const remove = file.remove && (async (replacement?: URI) => {
			await file.remove!();
			this.projects.forgetCatalogMaterialName(catalog.preferenceKey ?? details.key, file.id);
			using copies = this.projectMaterialFiles.copies(details.key);
			if (copies) await this.projectMaterialFiles.removeCopy(copies, file, replacement);
		});
		const transfer = async (target: CatalogProjectDetails, name: string) => {
			const source = details.data.get();
			if (!remove || !target.upload || !source?.canEdit || !source.materials?.some(item => item.id === file.id)) throw new CancellationError();
			const controller = new AbortController();
			await target.load?.(controller.signal);
			const destination = target.data.get();
			if (!destination?.canEdit) throw new Error(localize('projects.fileDestinationReadOnly', 'The destination project only allows viewing files.'));
			if (destination.materials?.some(item => item.name === name)) {
				throw new Error(localize('projects.fileNameInUse', 'A file with that name already exists in the destination project.'));
			}
			using copies = this.projectMaterialFiles.copies(details.key);
			const resource = await copies?.existing(file);
			if (resource) await this.projectMaterialFiles.prepareTransfer(resource);
			const remote = await file.read?.(controller.signal);
			if (!remote) throw new Error(localize('projects.localFileOffline', 'This project file is unavailable offline.'));
			// PDF edits in the managed copy stay local when the provider file is replaced.
			const local = resource ? await this.readProjectCopy(resource, file.name) : remote;
			using targetCopies = this.projectMaterialFiles.copies(target.key);
			let replacement: URI | undefined;
			await target.upload.addFiles([new File([remote], name, { type: remote.type || getMediaOrTextMime(name) })], async added => {
				replacement = await targetCopies?.ensure(added, async () => local);
			});
			try { await remove(replacement); }
			catch (error) { throw incompleteFileTransfer(error); }
		};
		return {
			id: file.id, name: file.name, remove,
			open: file.open ?? ((signal, restoreFocus) => this.openCatalogFile(details.key, file, signal, restoreFocus)),
			rename: remove && details.upload ? name => transfer(details, name) : undefined,
			reveal: !isWeb && (file.read || this.files.hasProvider(URI.from({ scheme: projectMaterialFilesScheme }))) ? async () => {
				using copies = this.projectMaterialFiles.copies(details.key);
				if (!copies) throw new Error(localize('projects.localFileOffline', 'This project file is unavailable offline.'));
				return copies.localResource(await copies.ensure(file, file.read));
			} : undefined,
			destinations: remove ? targets.flatMap(project => project.details ? [{
				id: project.id, title: project.title, move: () => transfer(project.details!, file.name),
			}] : []) : undefined,
		};
	}

	private async readProjectCopy(resource: URI, name: string): Promise<Blob> {
		const { bytes } = await this.files.readFileBytes(resource);
		return new Blob([new Uint8Array(bytes).buffer], { type: getMediaOrTextMime(name) });
	}

	private async openCatalogFile(key: string, file: ProjectMaterialRow, signal: AbortSignal, restoreFocus: () => void): Promise<void> {
		using copies = this.projectMaterialFiles.copies(key);
		if (!copies) throw new Error(localize('projects.localFileOffline', 'This project file is unavailable offline.'));
		const download = file.read;
		const resource = await copies.ensure(file, download && (request => download(AbortSignal.any([signal, request]))));
		signal.throwIfAborted();
		if (!this.catalog.sources.some(source => source.snapshot.get().projects?.some(project => project.details?.key === key))) throw new CancellationError();
		await this.openSidebarFile(resource, true, signal, restoreFocus);
	}

	private openSidebarFile(resource: URI, readOnly: boolean, signal: AbortSignal, restoreFocus: () => void): Promise<void> {
		if (extname(resource.path).toLowerCase() === '.pdf') {
			return this.entries.openConversationFile({ resource, showBreadcrumbs: false }, restoreFocus, signal);
		}
		return openProjectFile(this.editors, resource, readOnly);
	}

	private openConversation(open: (signal: AbortSignal) => Promise<void>): void {
		const controller = new AbortController();
		this.opening.value = toDisposable(() => controller.abort());
		void open(controller.signal).catch(error => {
			if (!controller.signal.aborted) this.notifications.error(toErrorMessage(error));
		});
	}

	private toRow(entry: ChatListEntry, destinations: readonly ProjectSummary[], parentProject?: string): SessionsCatalogRow {
		const sessionId = entry.sessionId;
		const forkSource = entry.forkSource;
		const openSource = forkSource?.open;
		const iconKey = sessionId ? `session:${sessionId}` : entry.preferenceKey;
		const iconScope = sessionId ? undefined : 'catalog';
		const project = () => {
			const memberships = destinations.filter(({ id, sessionCount }) => {
				if (!sessionCount) return false;
				const project = this.membership.get(id)?.project;
				return sessionId ? project?.sessionIds.includes(sessionId)
					: entry.externalConversationId && project?.externalConversationIds?.includes(entry.externalConversationId);
			});
			const current = (sessionId ? parentProject : memberships.find(item => item.id === parentProject)?.id)
				?? (memberships.length === 1 && (!parentProject || parentProject !== entry.projectId) ? memberships[0]!.id : undefined);
			return getChatListEntryProject(entry, destinations, this.projectService, current);
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
			forkSource: forkSource && {
				id: forkSource.id,
				title: forkSource.title,
				open: openSource && (() => this.openConversation(openSource)),
			},
			iconId: iconKey ? this.list.getRowIcon(iconKey, iconScope) : undefined,
			setIcon: iconKey ? icon => this.list.setRowIcon(iconKey, icon?.id, iconScope) : undefined,
			pinned: entry.pinned,
			setPinned: entry.setPinned,
			rename: entry.rename,
			validateRename: entry.validateRename,
			organization: () => entry.disabled || entry.actionsDisabled ? undefined : {
				pinned: entry.pinned, setPinned: entry.setPinned, moveToGroup: entry.moveToGroup, project: project(),
			},
			open: threadId => this.openConversation(signal => entry.open(signal, threadId)),
			getActions: signal => getChatListEntryActions(entry, signal, this.commands, this.configuration),
		};
	}
}

function incompleteFileTransfer(error: unknown): Error {
	return new Error(localize('projects.fileTransferIncomplete', 'The file was added to the destination. The source could not be fully removed: {0}', toErrorMessage(error)), { cause: error });
}
