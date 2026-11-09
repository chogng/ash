import { ChatTimelineStorage, type ChatTimeline, type ChatTimelineTask } from '../../../browser/chatTimelineStorage.js';
import { ChatCoworkTasks } from '../../cowork/browser/chatCoworkTasks.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { Thread } from '../../../../workbench/services/chat/common/chatService.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ChatReplyError } from '../../../common/chatReplyBackend.js';
import { ChatGPTReplyBackend } from './chatGPTReplyBackend.js';
import { ChatGPTOutbox, type PendingChatGPTCreation } from './chatGPTOutbox.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { isRecord } from '../../../../base/common/types.js';
import { isUuid } from '../../../../base/common/uuid.js';
import type { URI } from '../../../../base/common/uri.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity, type INotificationActions, type INotificationHandle } from '../../../../platform/notification/common/notification.js';
import { IProjectService } from '../../../../platform/projects/common/projectService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChatGPTAuthenticationError, IChatGPTNativeTransport, IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ChatGPTClient, ChatGPTRequestError, isChatGPTRateLimit, type ChatGPTConversation, type ChatGPTMessage, type ChatGPTModel, type ChatGPTProject, type ChatGPTProjectCursor, type ChatGPTHistory } from './chatGPTClient.js';
import { ChatGPTDraftAttachmentStorage, type ChatGPTAttachment } from './chatGPTDraftAttachmentStorage.js';
import { createChatGPTFetch } from './chatGPTFetch.js';
import { getChatGPTRichContentText } from './chatGPTRichContent.js';
import type { ChatGPTVoiceSession } from './chatGPTVoiceSession.js';

const catalogKey = 'sessions.chatgpt.catalog.v1';
const historyFreshnessMs = 60_000;
const recentFreshnessMs = 5 * 60_000;
const sidebarFreshnessMs = 15 * 60_000;

function isCachedTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(new Date(value).getTime());
}

type HistoryValidation = Pick<ChatGPTHistory, 'parentId' | 'model' | 'thinkingEffort'> & { readonly validatedAt: number; };
interface ProjectHistory {
	readonly status: 'loading' | 'ready' | 'error';
	readonly cursor?: ChatGPTProjectCursor;
	readonly interrupted?: boolean;
}

type HistoryRead = 'catalog' | 'recentPage' | 'conversation' | `project:${string}`;
type HistoryFailure = { readonly error: unknown; readonly retry: () => Promise<void>; };
type HistoryNotice = 'offline' | 'limited' | 'failed';

interface ChatGPTProjectDetails {
	readonly name: string;
	readonly description: string;
}

interface ChatGPTProjectEdit {
	readonly details: ChatGPTProjectDetails;
	save(details: ChatGPTProjectDetails): Promise<void>;
}

function isMissingConversation(error: unknown): boolean {
	return error instanceof ChatGPTRequestError && (error.status === 404 || error.status === 410);
}

interface ChatGPTDraft {
	readonly text: string;
	readonly attachments: readonly ChatGPTAttachment[];
	readonly selection?: Pick<ChatGPTState, 'model' | 'modelPreset'>;
	readonly target?: ChatGPTDraftTarget;
}

interface ChatGPTDraftTarget {
	readonly projectId?: string;
	readonly ashProjectId?: string;
	readonly folder?: URI;
}

export function chatGPTProjectPreferenceKey(scope: string | undefined, id: string): string | undefined {
	return scope && `${scope}:${id}`;
}

/** The account scope keeps external conversation IDs distinct in the shared Ash catalog. */
export function chatGPTProjectConversationId(scope: string | undefined, id: string): string | undefined {
	if (!scope) return undefined;
	const hash = new StringSHA1();
	hash.update(JSON.stringify(['chatgpt', scope, id]));
	return hash.digest();
}

export const chatGPTAttachmentLimits = { count: 10, fileBytes: 20 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 };

export function chatGPTAttachmentLimitMessage(): string {
	return localize('sessions.chatgpt.attachmentLimit', 'Attach up to 10 files, with at most 20 MB per file and 50 MB in total.');
}

export interface ChatCoworkTaskView extends ChatTimelineTask {
	readonly thread?: Thread;
	readonly readError?: string;
}

export function coworkTaskStatus(task: ChatCoworkTaskView): string {
	switch (task.thread?.turns.at(-1)?.status) {
		case 'created':
		case 'running':
		case 'cancelling': return localize('sessions.chat.coworkRunning', 'Cowork is working…');
		case 'waitingForApproval':
		case 'waitingForUserInput':
		case 'waitingForCapability': return localize('sessions.chat.coworkWaiting', 'Cowork is waiting for input');
		case 'completed': return localize('sessions.chat.coworkComplete', 'Cowork completed the task');
		case 'failed': return localize('sessions.chat.coworkFailed', 'Cowork task failed');
		case 'interrupted': return localize('sessions.chat.coworkInterrupted', 'Cowork task interrupted');
		default: return task.error ? localize('sessions.chat.coworkFailed', 'Cowork task failed')
			: task.readError ? localize('sessions.chat.coworkUnavailable', 'This Cowork task could not be opened.')
				: localize('sessions.chat.coworkPreparing', 'Preparing Cowork task…');
	}
}

export interface ChatGPTState {
	readonly catalogScope?: string;
	readonly coworkTasks: readonly ChatCoworkTaskView[];
	readonly localConversationId: string;
	readonly draft: string;
	readonly draftTarget?: ChatGPTDraftTarget;
	readonly attachments: readonly ChatGPTAttachment[];
	readonly voice: 'idle' | 'connecting' | 'connected' | 'stopping';
	readonly voiceTranscript: readonly { readonly id: string; readonly text: string; readonly role: 'user' | 'assistant'; }[];
	readonly connected: boolean;
	readonly networkAvailable: boolean;
	readonly canQueue: boolean;
	readonly pendingSync: boolean;
	readonly pendingCreation?: 'queued' | 'submitted';
	readonly busy: boolean;
	/** Distinguishes content reads from sending, uploads and voice operations. */
	readonly loading?: { readonly kind: 'history'; } | { readonly kind: 'conversation'; readonly id: string; };
	readonly sending: boolean;
	readonly conversations: readonly ChatGPTConversation[];
	readonly projects: readonly ChatGPTProject[];
	readonly projectHistory: ReadonlyMap<string, ProjectHistory>;
	readonly hasMore: boolean;
	readonly historyListFailed?: boolean;
	readonly models: readonly ChatGPTModel[];
	readonly model: string;
	readonly modelPreset?: string;
	/** An explicit draft choice must still resolve before a new message can be queued. */
	readonly explicitDraftModel?: boolean;
	readonly conversationId?: string;
	readonly title: string;
	readonly parentId: string;
	readonly olderCursor?: string;
	readonly readingOlderHistory?: boolean;
	readonly messages: readonly ChatGPTMessage[];
	readonly error: string;
	readonly uncertain: boolean;
	readonly stopped: boolean;
	readonly managing: boolean;
}

/** One window-local model shared by the sidebar View and the chat EditorPane. */
export function selectedChatConversationId(state: ChatGPTState): string | undefined {
	const localId = `local:${state.localConversationId}`;
	return state.conversationId ?? state.conversations.find(item => item.local && (item.id === localId || item.id === `pending:${state.localConversationId}`))?.id;
}

export function canQueueChatGPTCreation(state: ChatGPTState): boolean {
	return state.canQueue && !selectedChatConversationId(state) && !state.uncertain && !!state.draft.trim() && !state.attachments.length
		&& (!state.explicitDraftModel || state.models.some(model => model.id === state.model));
}

export function isChatGPTNewDraft(state: ChatGPTState): boolean {
	return !selectedChatConversationId(state) && !state.pendingCreation && !state.messages.length
		&& !state.coworkTasks.length && state.loading?.kind !== 'conversation';
}

export function pendingCreationStatus(state: ChatGPTState): string {
	if (state.pendingCreation === 'queued') {
		return localize('sessions.chatgpt.creationQueued', 'Saved on this device. Ash will send it when the connection is available.');
	}
	if (state.pendingCreation === 'submitted') {
		return localize('sessions.chatgpt.creationChecking', 'Waiting for ChatGPT to confirm this conversation.');
	}
	return '';
}

export interface IChatGPTService {
	readonly native?: true;
	readonly state: IObservable<ChatGPTState>;
	readonly newDraftRevision: number;
	/** Reports permanent removal or replacement of an identity within the current catalog. */
	readonly onDidRetireConversationIdentity: Event<{ readonly id: string; readonly replacementId?: string; }>;
	initialize(): void;
	refresh(): Promise<void>;
	setNetworkAvailable(available: boolean): void;
	setHistoryNotificationsVisible?(visible: boolean): void;
	reload(): Promise<void>;
	newChat(options?: { readonly clearDraft: boolean; }): void;
	select(id: string): Promise<void>;
	loadOlderHistory?(): Promise<void>;
	loadMore(): Promise<void>;
	loadProjectConversations(projectId: string, nextPage?: boolean): Promise<void>;
	rename(id: string, title: string): Promise<void>;
	setPinned(id: string, pinned: boolean): Promise<void>;
	archive(id: string): Promise<boolean>;
	deleteConversation(id: string): Promise<void>;
	moveToProject(id: string, projectId: string | null): Promise<void>;
	createProjectAndMove(id: string, name: string): Promise<void>;
	share(id: string, messageId?: string): Promise<string | undefined>;
	readResponseAudio(id: string, messageId: string, signal: AbortSignal): Promise<Blob>;
	editProjectDetails(id: string, signal: AbortSignal): Promise<ChatGPTProjectEdit>;
	archiveProjectConversations(id: string): Promise<boolean>;
	deleteProject(id: string): Promise<void>;
	setDraft(value: string): void;
	setDraftTarget(change: Partial<ChatGPTDraftTarget>): void;
	setModel(value: string, preset?: string): void;
	attachFiles(files: readonly File[]): Promise<void>;
	removeAttachment(id: string): void;
	retryAttachment(id: string): Promise<void>;
	startVoice(window: Window & typeof globalThis): Promise<void>;
	stopVoice(): Promise<void>;
	send(): Promise<void>;
	stop(): Promise<void>;
	readResource(resource: string, conversationId: string | undefined, messageId: string, signal: AbortSignal): Promise<Blob>;
	getAccessibleContent(): string;
}
export const IChatGPTService = createServiceIdentifier<IChatGPTService>('chatGPTService');
export const IChatGPTNativeService = createServiceIdentifier<IChatGPTService>('chatGPTNativeService');

export class ChatGPTService extends Disposable implements IChatGPTService {
	private readonly storagePrefix: string;
	private readonly selectedConversationKey: string;
	private readonly newDraftIdKey: string;
	public get native(): true | undefined { return this.transport.native; }
	private newConversationId: string = crypto.randomUUID();
	private readonly localIdsByRemoteId = new Map<string, string>();
	private readonly model = observableValue<ChatGPTState>('chatgpt', {
		coworkTasks: [], localConversationId: this.newConversationId, draft: '', attachments: [], voice: 'idle', voiceTranscript: [], connected: false, busy: false, loading: undefined, sending: false, conversations: [], projects: [], hasMore: false,
		projectHistory: new Map(), models: [], model: '', title: 'ChatGPT', parentId: crypto.randomUUID(), messages: [], error: '', uncertain: false, stopped: false, managing: false,
		networkAvailable: true, canQueue: false, pendingSync: false,
	});
	private readonly timeline: ChatTimelineStorage;
	private remoteTimeline: ChatTimelineStorage | undefined;
	private cacheScope: string | undefined;
	private readonly taskWatchers = this._register(new DisposableStore());
	private readonly drafts = new Map<string, ChatGPTDraft>();
	private readonly draftAttachments: ChatGPTDraftAttachmentStorage;
	private readonly pendingAttachmentWrites = new Set<Promise<void>>();
	private readonly savingAttachments = new Set<string>();
	private readonly attachmentFiles = new Map<string, File>();
	private readonly uploads = new Map<string, AbortController>();
	private voiceController: AbortController | undefined;
	private voiceMedia: ChatGPTVoiceSession | undefined;
	private voiceMessageId: string | undefined;
	private voiceCreatedConversation = false;
	private voiceStopping: Promise<void> | undefined;
	private operation: AbortController | undefined;
	private olderRead: AbortController | undefined;
	private conversationRead: { readonly id: string; readonly generation: number; readonly promise: Promise<void>; } | undefined;
	// Disk snapshots can paint on startup. Only this window's successful reads
	// establish which continuation nodes are still fresh enough to reuse.
	private readonly historyValidations = new Map<string, HistoryValidation>();
	private historyConnection = new AbortController();
	private readonly historyFailures = new Map<HistoryRead, HistoryFailure>();
	private readonly historyNoticeClose = this._register(new MutableDisposable());
	private historyNotification: INotificationHandle | undefined;
	private historyNotice: HistoryNotice | undefined;
	private historyNotificationsVisible = true;
	private retryingHistory = false;
	private refreshOperation: AbortController | undefined;
	private outbox: ChatGPTOutbox | undefined;
	private syncingOutbox: Promise<void> | undefined;
	private activeOutboxCreation: { readonly outbox: ChatGPTOutbox; readonly localId: string; readonly controller: AbortController; } | undefined;
	private stream: AbortController | undefined;
	private stopping: Promise<void> | undefined;
	private generation = 0;
	private management = new AbortController();
	// Auxiliary pin results do not advance the recent-history pagination offset.
	private recentOffset = 0;
	private recentFetchedAt: number | undefined;
	private projectsFetchedAt: number | undefined;
	private pinsFetchedAt: number | undefined;
	private readonly recentIds = new Set<string>();

	public readonly state: IObservable<ChatGPTState> = this.model;
	private readonly retiredConversationIdentity = this._register(new Emitter<{ readonly id: string; readonly replacementId?: string; }>());
	public readonly onDidRetireConversationIdentity = this.retiredConversationIdentity.event;
	private draftRevision = 0;
	public get newDraftRevision(): number { return this.draftRevision; }
	private readonly client: ChatGPTClient;
	private readonly replyBackend: ChatGPTReplyBackend;
	constructor(
		@IChatGPTTransport private readonly transport: IChatGPTTransport,
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly instantiation?: IInstantiationService,
	) {
		super();
		this.storagePrefix = transport.native ? 'sessions.chatgptExperimental' : 'sessions.chatgpt';
		this.selectedConversationKey = this.storagePrefix + '.conversation';
		this.newDraftIdKey = this.storagePrefix + '.newDraftId';
		this.timeline = new ChatTimelineStorage(storage, transport.native ? 'chatgpt-native' : 'chatgpt-web');
		this.draftAttachments = this._register(new ChatGPTDraftAttachmentStorage(storage, this.storagePrefix));
		this._register(lifecycle.onWillShutdown(event => {
			if (this.pendingAttachmentWrites.size) {
				event.join(async () => {
					while (this.pendingAttachmentWrites.size) { await Promise.allSettled(this.pendingAttachmentWrites); }
					// Saving the bytes may have published new manifest entries after the window's first flush.
					await this.storage.flush();
				}, 'ChatGPT draft attachments');
			}
		}));
		const newDraftId = storage.get(this.newDraftIdKey, StorageScope.WORKSPACE);
		if (isUuid(newDraftId)) { this.newConversationId = newDraftId; }
		this.update({ conversations: this.localConversations(), localConversationId: this.newConversationId, draft: this.readDraft(this.newConversationId)?.text ?? '' });
		this.client = new ChatGPTClient(createChatGPTFetch(transport), transport.native);
		this.replyBackend = new ChatGPTReplyBackend(this.client);
		this._register(toDisposable(() => {
			this.management.abort();
			this.olderRead?.abort();
			this.historyConnection.abort();
			this.closeHistoryNotice();
			void this.endVoice(false);
			this.generation++; this.operation?.abort(); this.refreshOperation?.abort(); this.stream?.abort(); this.drafts.clear();
			for (const upload of this.uploads.values()) { upload.abort(); }
			this.uploads.clear(); this.attachmentFiles.clear();
		}));
		if (transport.onDidChangeAuthentication) { this._register(transport.onDidChangeAuthentication(() => this.authenticationChanged())); }
	}

	private authenticationChanged(): void {
		if (this.isDisposed) { return; }
		const draft = this.model.get().draft;
		this.generation++;
		this.operation?.abort(); this.stream?.abort(); this.stream = undefined;
		this.refreshOperation?.abort();
		this.management.abort();
		this.olderRead?.abort();
		this.management = new AbortController();
		void this.endVoice(false);
		for (const upload of this.uploads.values()) { upload.abort(); }
		this.uploads.clear(); this.attachmentFiles.clear(); this.drafts.clear();
		this.localIdsByRemoteId.clear();
		this.historyValidations.clear();
		this.client.clearHistoryLimits();
		this.historyFailures.clear();
		if (this.historyNotice !== 'offline') { this.closeHistoryNotice(); }
		this.taskWatchers.clear();
		this.forgetDraft(this.newConversationId);
		this.rotateNewDraft();
		this.drafts.set(this.newConversationId, { text: draft, attachments: [] });
		this.persistDraftText(this.newConversationId, draft);
		this.recentIds.clear(); this.recentOffset = 0; this.recentFetchedAt = undefined;
		this.projectsFetchedAt = this.pinsFetchedAt = undefined;
		this.cacheScope = undefined;
		this.remoteTimeline = undefined;
		this.outbox = undefined;
		this.syncingOutbox = undefined;
		this.storage.remove(this.selectedConversationKey, StorageScope.PROFILE);
		// User-authored draft text stays local. Conversation IDs, files and history
		// belong to the retired account and cannot be reused with its successor.
		this.update({
			coworkTasks: [], localConversationId: this.newConversationId, draft, attachments: [], connected: false, busy: false, sending: false, managing: false,
			loading: undefined, conversations: this.localConversations(), projects: [], projectHistory: new Map(), models: [], model: '', modelPreset: undefined,
			historyListFailed: false,
			conversationId: undefined, messages: [], parentId: crypto.randomUUID(), title: 'ChatGPT',
			voice: 'idle', voiceTranscript: [], uncertain: false, stopped: false, hasMore: false, error: '',
		});
		this.initialize();
	}
	public initialize(): void {
		const state = this.model.get();
		if (this.isDisposed || state.connected || state.busy) { return; }
		// A rejected login must not latch initialization: re-entry reads the current
		// credentials again while pending and successful loads remain shared.
		void this.loadCatalog().then(() => this.syncOutbox());
	}

	public setNetworkAvailable(available: boolean): void {
		const state = this.model.get();
		if (state.networkAvailable === available) { return; }
		if (!available) {
			this.historyConnection.abort();
			this.refreshOperation?.abort();
			if (this.outbox && state.loading) {
				this.operation?.abort();
				this.generation++;
			}
		} else {
			if (!this.native) { this.recentFetchedAt = undefined; }
			this.historyConnection = new AbortController();
			this.closeHistoryNotice();
		}
		this.update({
			networkAvailable: available,
			...(!available && this.outbox && state.loading ? { busy: false, loading: undefined } : {}),
		});
		if (!available) { this.updateHistoryNotice(); }
	}

	public async refresh(): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.networkAvailable || this.refreshOperation || this.syncingOutbox || state.busy || state.sending || state.managing || state.voice !== 'idle') { return; }
		if (!state.connected) {
			if (this.cacheScope) { await this.loadCatalog(); await this.syncOutbox(); }
			return;
		}
		const controller = this.refreshOperation = new AbortController();
		try {
			await this.loadCatalog(controller);
			if (!controller.signal.aborted) {
				for (const [projectId, page] of this.model.get().projectHistory) {
					if (page.interrupted) { await this.loadProjectConversations(projectId, true); }
				}
			}
		}
		finally { this.refreshOperation = undefined; }
		await this.syncOutbox();
	}
	public async editProjectDetails(id: string, signal: AbortSignal): Promise<ChatGPTProjectEdit> {
		const account = this.management.signal;
		const details = await this.client.projectDetails(id, AbortSignal.any([account, signal, AbortSignal.timeout(30_000)]));
		return {
			details: { name: details.name, description: details.description },
			save: async edited => {
				if (edited.name === details.name && edited.description === details.description) return;
				const request = AbortSignal.any([account, AbortSignal.timeout(30_000)]);
				const latest = await this.client.projectDetails(id, request);
				const updated = {
					...latest,
					name: edited.name === details.name ? latest.name : edited.name,
					description: edited.description === details.description ? latest.description : edited.description,
				};
				await this.client.updateProjectDetails(id, updated, request);
				request.throwIfAborted();
				this.refreshOperation?.abort();
				this.updateCatalog({
					projects: this.model.get().projects.map(project =>
						project.id === id ? { ...project, title: updated.name } : project)
				});
			},
		};
	}

	public async archiveProjectConversations(id: string): Promise<boolean> {
		const state = this.model.get();
		if (this.isDisposed || state.busy || state.sending || state.managing || state.voice !== 'idle'
			|| !state.connected || !state.networkAvailable || !state.projects.some(project => project.id === id)) return false;
		const account = this.management.signal;
		const projectHistory = new Map(state.projectHistory);
		// Retire in-flight pages so an old response cannot repopulate archived rows.
		projectHistory.delete(id);
		this.refreshOperation?.abort();
		this.update({ managing: true, projectHistory });
		const archived = new Set<string>();
		try {
			const ids = await this.client.listProjectConversationIds(id, AbortSignal.any([account, AbortSignal.timeout(30_000)]));
			for (const conversationId of ids) {
				account.throwIfAborted();
				await this.removeRemoteConversation(conversationId, false, AbortSignal.any([account, AbortSignal.timeout(30_000)]));
				archived.add(conversationId);
			}
			account.throwIfAborted();
			return true;
		} finally {
			if (!account.aborted) {
				this.update({ managing: false });
				const selected = this.model.get().conversationId;
				if (selected && archived.has(selected)) this.newChat();
			}
		}
	}

	public async deleteProject(id: string): Promise<void> {
		const state = this.model.get();
		if (state.managing || !state.connected || !state.networkAvailable || !state.projects.some(project => project.id === id)) return;
		const account = this.management.signal;
		const signal = AbortSignal.any([account, AbortSignal.timeout(30_000)]);
		this.update({ managing: true });
		try {
			await this.client.deleteProject(id, signal);
			signal.throwIfAborted();
			this.refreshOperation?.abort();
			const current = this.model.get();
			const removed = current.conversations.filter(item => item.projectId === id && !item.local);
			const removedIds = new Set(removed.map(item => item.id));
			for (const item of removed) {
				if (this.recentIds.delete(item.id)) this.recentOffset = Math.max(0, this.recentOffset - 1);
				this.forgetRemoteConversation(item.id);
			}
			this.updateCatalog({
				projects: current.projects.filter(project => project.id !== id),
				conversations: current.conversations.filter(item => !removedIds.has(item.id)),
			});
			if (current.conversationId && removedIds.has(current.conversationId)) this.newChat();
		} finally {
			if (!account.aborted) this.update({ managing: false });
		}
	}

	public async loadProjectConversations(projectId: string, nextPage = false): Promise<void> {
		const state = this.model.get();
		const previous = state.projectHistory.get(projectId);
		if (this.isDisposed || state.managing || !state.connected || !state.networkAvailable || !state.projects.some(project => project.id === projectId)
			|| previous?.status === 'loading' || (previous && (!nextPage || previous.status === 'ready' && !previous.cursor))) { return; }

		const management = this.management;
		const connection = this.historyConnection;
		const signal = AbortSignal.any([management.signal, connection.signal, AbortSignal.timeout(30_000)]);
		const updatePage = (page: ProjectHistory, conversations?: readonly ChatGPTConversation[]): void => {
			const projectHistory = new Map(this.model.get().projectHistory);
			projectHistory.set(projectId, page);
			if (conversations) this.updateCatalog({ projectHistory, conversations });
			else this.update({ projectHistory });
		};
		const loading: ProjectHistory = { status: 'loading', cursor: previous?.cursor };
		updatePage(loading);
		const isCurrent = () => !management.signal.aborted && this.model.get().projectHistory.get(projectId) === loading;
		try {
			const page = await this.client.projectConversations(projectId, previous?.cursor, signal);
			signal.throwIfAborted();
			if (!isCurrent()) return;
			const items = new Map(this.model.get().conversations.map(item => [item.id, item]));
			const previousItems = new Map(state.conversations.map(item => [item.id, item]));
			for (const item of page.items) {
				const existing = items.get(item.id);
				if (existing) {
					if (existing === previousItems.get(item.id)) {
						items.set(item.id, {
							...existing, projectId,
							createdAt: existing.createdAt ?? item.createdAt,
							updatedAt: existing.updatedAt ?? item.updatedAt,
						});
					}
				} else if (!previousItems.has(item.id) && !this.outbox?.isDeleted(item.id)) {
					// A project page augments the catalog without advancing recent history.
					items.set(item.id, { ...item, projectOnly: true });
				}
			}
			updatePage({ status: 'ready', cursor: page.cursor }, [...items.values()]);
			this.setHistoryFailure(`project:${projectId}`, undefined);
		} catch (error) {
			if (!isCurrent()) { return; }
			updatePage({ status: 'error', cursor: previous?.cursor, interrupted: connection.signal.aborted });
			if (!connection.signal.aborted) {
				this.setHistoryFailure(`project:${projectId}`, { error, retry: () => this.loadProjectConversations(projectId, true) });
			}
		}
	}

	public async rename(id: string, title: string): Promise<void> {
		const normalized = title.trim();
		if (!normalized || normalized.length > 256) { return; }
		if (id.startsWith('local:')) { this.updateLocalConversation(id, { title: normalized }); return; }
		await this.manage(id, async signal => {
			await this.client.rename(id, normalized, signal);
			signal.throwIfAborted();
			this.updateCatalog({
				conversations: this.model.get().conversations.map(item => item.id === id ? { ...item, title: normalized } : item),
				...(this.model.get().conversationId === id ? { title: normalized } : {})
			});
		});
	}

	public async setPinned(id: string, pinned: boolean): Promise<void> {
		if (id.startsWith('local:')) { this.updateLocalConversation(id, { pinned }); return; }
		await this.manage(id, async signal => {
			await this.client.updateConversation(id, { is_starred: pinned }, signal);
			signal.throwIfAborted();
			this.updateCatalog({ conversations: this.model.get().conversations.map(item => item.id === id ? { ...item, pinned } : item) });
		});
	}

	public archive(id: string): Promise<boolean> { return this.removeConversation(id, false); }
	public async deleteConversation(id: string): Promise<void> {
		const outbox = this.outbox;
		const state = this.model.get();
		if (!outbox || id.startsWith('local:')) { await this.removeConversation(id, true); return; }
		if (this.isDisposed || state.busy || state.sending || state.managing || state.voice !== 'idle' || !state.conversations.some(item => item.id === id)) { return; }
		this.refreshOperation?.abort();
		if (id.startsWith('pending:')) {
			const creation = outbox.creation(id.slice('pending:'.length));
			if (!creation) { return; }
			if (creation.remoteId) {
				outbox.deleteConversation(creation.remoteId, creation.localId);
				this.forgetRemoteConversation(creation.remoteId);
			} else if (creation.submittedAgainst) {
				outbox.saveCreation({ ...creation, cancelled: true });
			} else { outbox.removeCreation(creation.localId); }
			const active = this.activeOutboxCreation;
			if (active?.outbox === outbox && active.localId === creation.localId) {
				active.controller.abort();
			}
		} else {
			outbox.deleteConversation(id);
			if (this.recentIds.delete(id)) { this.recentOffset = Math.max(0, this.recentOffset - 1); }
			this.forgetRemoteConversation(id);
		}
		this.updateCatalog({ conversations: state.conversations });
		if (selectedChatConversationId(state) === id) { this.newChat(); }
		try {
			await this.storage.flush();
			await this.syncOutbox();
		} catch (error) {
			if (this.outbox === outbox) { this.update({ error: this.errorText(error) }); }
		}
	}

	private async removeConversation(id: string, deleted: boolean): Promise<boolean> {
		if (id.startsWith('local:')) {
			const state = this.model.get();
			if (state.sending || state.managing || !deleted && !state.conversations.some(item => item.id === id)) return false;
			const wasSelected = selectedChatConversationId(state) === id;
			if (deleted) {
				const localId = this.timeline.read(id)?.localId;
				if (localId) { this.forgetDraft(localId); }
				this.timeline.remove(id);
				this.retiredConversationIdentity.fire({ id });
			} else this.updateLocalConversation(id, { archived: true });
			this.update({ conversations: this.model.get().conversations.filter(item => item.id !== id) });
			if (wasSelected) this.newChat();
			return true;
		}
		const completed = await this.manage(id, async signal => {
			await this.removeRemoteConversation(id, deleted, signal);
			return true;
		});
		if (completed && this.model.get().conversationId === id) { this.newChat(); }
		return completed === true;
	}

	private async removeRemoteConversation(id: string, deleted: boolean, signal: AbortSignal): Promise<void> {
		try {
			if (deleted) await this.client.deleteConversation(id, signal);
			else await this.client.updateConversation(id, { is_archived: true }, signal);
		} catch (error) {
			if (!deleted || !isMissingConversation(error)) throw error;
		}
		signal.throwIfAborted();
		if (this.recentIds.delete(id)) this.recentOffset = Math.max(0, this.recentOffset - 1);
		this.updateCatalog({ conversations: this.model.get().conversations.filter(item => item.id !== id) });
		if (deleted) this.forgetRemoteConversation(id);
	}

	private forgetRemoteConversation(id: string): void {
		const localId = this.localIdsByRemoteId.get(id) ?? this.timelineFor(id).read(id)?.localId;
		if (localId) { this.forgetDraft(localId); }
		this.localIdsByRemoteId.delete(id);
		this.historyValidations.delete(id);
		this.retiredConversationIdentity.fire({ id });
		this.remoteTimeline?.remove(id);
		this.timeline.remove(id);
	}

	public async moveToProject(id: string, projectId: string | null): Promise<void> {
		const moved = await this.manage(id, async signal => {
			await this.assignConversationToProject(id, projectId, signal);
			return true;
		});
		if (!moved) throw new Error(this.model.get().error || localize('sessions.chatgpt.projectMoveFailed', 'Could not move this conversation. Try again.'));
	}

	public async createProjectAndMove(id: string, name: string): Promise<void> {
		const moved = await this.manage(id, async signal => {
			const project = await this.client.createProject(name, signal);
			signal.throwIfAborted();
			this.updateCatalog({
				projects: [project, ...this.model.get().projects.filter(item => item.id !== project.id)],
			});
			try {
				await this.assignConversationToProject(id, project.id, signal);
			} catch {
				throw new Error(localize('sessions.chatgpt.projectCreatedMoveFailed', 'Created {0}. Choose it from Move to project to try the move again.', project.title));
			}
			return true;
		});
		if (!moved) throw new Error(this.model.get().error || localize('sessions.chatgpt.projectCreateMoveFailed', 'Could not create a project and move this conversation. Try again.'));
	}

	private async assignConversationToProject(id: string, projectId: string | null, signal: AbortSignal): Promise<void> {
		await this.client.updateConversation(id, { gizmo_id: projectId }, signal);
		signal.throwIfAborted();
		const state = this.model.get();
		const projectHistory = new Map(state.projectHistory);
		const previous = state.conversations.find(item => item.id === id)?.projectId;
		if (previous) projectHistory.delete(previous);
		if (projectId) projectHistory.delete(projectId);
		this.updateCatalog({
			projectHistory,
			conversations: state.conversations.map(item => item.id !== id ? item : {
				...item,
				projectId: projectId ?? undefined,
				projectOnly: projectId ? item.projectOnly : undefined,
			}),
		});
	}

	public share(id: string, messageId?: string): Promise<string | undefined> { return this.manage(id, signal => this.client.share(id, signal, messageId)); }

	public readResponseAudio(id: string, messageId: string, signal: AbortSignal): Promise<Blob> {
		return this.client.readResponseAudio(id, messageId, AbortSignal.any([signal, this.management.signal, AbortSignal.timeout(30_000)]));
	}

	/** Serialize writes independently of history reads; navigation must not abort a possibly accepted mutation. */
	private async manage<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.managing || state.voice !== 'idle' || !state.conversations.some(item => item.id === id)) { return undefined; }
		this.refreshOperation?.abort();
		this.update({ managing: true, error: '' });
		const management = this.management;
		try { return await operation(AbortSignal.any([management.signal, AbortSignal.timeout(30_000)])); }
		catch (error) { if (management === this.management) { this.update({ error: this.errorText(error) }); } return undefined; }
		finally { if (management === this.management) { this.update({ managing: false }); } }
	}

	public async reload(): Promise<void> {
		if (this.model.get().busy || this.model.get().sending || this.model.get().managing) { return; }
		if (this.voiceController) { await this.endVoice(true); return; }
		const id = selectedChatConversationId(this.model.get());
		if (id?.startsWith('local:')) { this.watchCoworkTasks(); }
		await this.loadCatalog(undefined, true);
		await this.syncOutbox();
	}
	public setDraft(draft: string): void {
		const key = this.draftKey();
		const stored = this.drafts.get(key);
		if (stored) { this.drafts.set(key, { ...stored, text: draft }); }
		this.persistDraftText(key, draft);
		this.update({ draft });
	}
	public setDraftTarget(change: Partial<ChatGPTDraftTarget>): void {
		const state = this.model.get();
		if (!isChatGPTNewDraft(state) || state.busy || state.sending || state.managing || state.uncertain || state.voice !== 'idle') return;
		if (change.projectId && !state.projects.some(project => project.id === change.projectId)) return;
		if (change.folder && (change.folder.scheme !== 'file' || change.folder.authority)) return;
		const key = this.draftKey();
		this.drafts.set(key, {
			...this.drafts.get(key), text: state.draft, attachments: state.attachments,
			target: {
				...state.draftTarget, ...change,
				...(change.projectId && { ashProjectId: undefined }),
				...(change.ashProjectId && { projectId: undefined }),
			},
		});
		this.update({});
	}
	public setModel(model: string, preset?: string): void {
		const state = this.model.get();
		const selected = state.models.find(entry => entry.id === model);
		if (!selected || state.busy || state.sending || state.voice !== 'idle') { return; }
		if (preset !== undefined && !selected.presets.some(option => option.id === preset)) { return; }
		this.selectModel({ model, modelPreset: this.resolveModelPreset(selected, preset ?? state.modelPreset) }, state);
	}

	private selectModel(selection: NonNullable<ChatGPTDraft['selection']>, state: ChatGPTState): void {
		if (state.localConversationId === this.newConversationId) {
			this.drafts.set(this.newConversationId, { ...this.drafts.get(this.newConversationId), text: state.draft, attachments: state.attachments, selection });
		}
		this.update(selection);
	}

	private resolveModelPreset(model: ChatGPTModel | undefined, preferred: string | undefined): string | undefined {
		return model?.presets.find(preset => preset.id === preferred)?.id ?? model?.defaultPreset;
	}

	public async startVoice(window: Window & typeof globalThis): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || !state.networkAvailable || state.pendingCreation || state.busy || state.sending || state.uncertain || state.voice !== 'idle' || state.draft.trim() || state.attachments.length) { return; }
		if (!window.navigator.userActivation?.isActive) { return; }
		this.refreshOperation?.abort();
		if (state.conversationId) this.historyValidations.delete(state.conversationId);
		const controller = new AbortController();
		this.voiceController = controller;
		this.voiceMessageId = undefined;
		this.voiceCreatedConversation = !state.conversationId;
		this.update({ voice: 'connecting', voiceTranscript: [], error: '' });
		try {
			const { ChatGPTVoiceSession } = await import('./chatGPTVoiceSession.js');
			if (controller.signal.aborted || this.voiceController !== controller) { return; }
			const media = this.voiceMedia = new ChatGPTVoiceSession(window, update => {
				if (this.voiceController !== controller || controller.signal.aborted) { return; }
				if (update.conversationId && update.conversationId !== this.model.get().conversationId) {
					this.update({ conversationId: update.conversationId }); this.rememberConversation(update.conversationId);
				}
				if (update.parentId) { this.voiceMessageId = update.parentId; }
				const message = update.message;
				if (message?.text.trim() && !message.activity) {
					this.voiceMessageId = message.id;
					const transcript = this.model.get().voiceTranscript;
					const item = { id: message.id, text: message.text.slice(0, 65536), role: message.role };
					this.update({ voiceTranscript: (transcript.some(previous => previous.id === item.id) ? transcript.map(previous => previous.id === item.id ? item : previous) : [...transcript, item]).slice(-64) });
				}
			}, error => {
				if (this.voiceController !== controller) { return; }
				// Even a failed room may have committed turns; reload its continuation node.
				void this.endVoice(true);
				if (error !== undefined) { this.update({ error: this.errorText(error) }); }
			});
			media.unlockAudio();
			await media.connect((sdp, signal) => this.client.voice({ sdp, conversationId: state.conversationId, parentId: state.parentId, language: getNLSLanguage() }, signal), controller.signal);
			if (this.voiceController === controller && !controller.signal.aborted) { this.update({ voice: 'connected' }); }
		} catch (error) {
			if (this.voiceController === controller && !controller.signal.aborted) {
				await this.endVoice(!!this.voiceMessageId);
				this.update({ error: this.errorText(error) });
			}
		}
	}

	public stopVoice(): Promise<void> { return this.endVoice(true); }

	private async endVoice(refresh: boolean): Promise<void> {
		if (this.voiceStopping) { return this.voiceStopping; }
		const controller = this.voiceController;
		if (!controller) { return; }
		this.voiceController = undefined;
		controller.abort();
		this.voiceMedia?.dispose(); this.voiceMedia = undefined;
		const id = this.model.get().conversationId;
		const messageId = this.voiceMessageId;
		if (!refresh || this.isDisposed) { this.update({ voice: 'idle', voiceTranscript: [] }); return; }
		if (!messageId && this.voiceCreatedConversation) {
			this.update({ voice: 'idle', voiceTranscript: [], conversationId: undefined }); this.rememberConversation(undefined); return;
		}
		const { signal, generation } = this.beginOperation();
		this.update({ voice: 'stopping', busy: true });
		this.voiceStopping = (async () => {
			try {
				if (id) {
					const history = await this.client.voiceHistory(id, messageId, signal);
					const target = this.voiceCreatedConversation ? this.drafts.get(this.draftKey())?.target : undefined;
					const move = await this.assignNewConversationToProject(id, target, signal);
					if (generation === this.generation) {
						if (this.voiceCreatedConversation) this.forgetDraft(this.draftKey());
						this.bindConversation(history.id, this.draftKey());
						this.bindLocalTimeline(this.draftKey(), history.id);
						this.restoreHistory(history);
						this.rememberHistory(history, { projectId: move?.projectId });
						if (move?.error) this.update({ error: move.error });
					}
				}
			} catch (error) {
				if (generation === this.generation) { this.update({ error: this.errorText(error), uncertain: !!messageId }); }
			} finally {
				if (generation === this.generation) { this.update({ voice: 'idle', busy: false, loading: undefined, voiceTranscript: [] }); }
			}
		})();
		try { await this.voiceStopping; } finally { this.voiceStopping = undefined; }
	}

	public async attachFiles(files: readonly File[]): Promise<void> {
		const state = this.model.get();
		if (!files.length || this.isDisposed || this.lifecycle.willShutdown || !state.connected || state.busy || state.sending || state.managing || state.voice !== 'idle') { return; }
		if (state.attachments.length + files.length > chatGPTAttachmentLimits.count
			|| files.some(file => !file.name.trim() || file.name.length > 1024 || file.size > chatGPTAttachmentLimits.fileBytes)
			|| [...state.attachments, ...files].reduce((size, file) => size + file.size, 0) > chatGPTAttachmentLimits.totalBytes) {
			this.update({ error: chatGPTAttachmentLimitMessage() });
			return;
		}
		const key = this.draftKey();
		const sources = files.map(file => ({ id: crypto.randomUUID(), file }));
		const attachments = sources.map(({ id, file }) => ({ id, name: file.name, size: file.size, status: 'uploading' as const }));
		const scope = this.cacheScope;
		for (const { id, file } of sources) {
			this.attachmentFiles.set(id, file);
			if (scope) { this.savingAttachments.add(id); }
		}
		this.drafts.set(key, { ...this.drafts.get(key), text: state.draft, attachments: [...state.attachments, ...attachments] });
		this.update({ attachments: this.drafts.get(key)!.attachments, error: '' });
		if (scope) { await this.trackAttachmentWrite(this.saveAttachmentFiles(key, scope, sources)); }
		if (this.isDisposed || this.lifecycle.willShutdown) { return; }
		await Promise.all(attachments.map(attachment => this.uploadAttachment(key, attachment.id)));
	}

	private async saveAttachmentFiles(key: string, scope: string, sources: readonly { id: string; file: File; }[]): Promise<void> {
		const account = this.management.signal;
		try {
			await this.draftAttachments.saveFiles(scope, sources);
		} catch (error) {
			if (!account.aborted && !this.isDisposed) {
				const ids = new Set(sources.map(source => source.id));
				for (const id of ids) { this.attachmentFiles.delete(id); }
				const draft = this.drafts.get(key);
				if (draft) {
					const attachments = draft.attachments.filter(attachment => !ids.has(attachment.id));
					this.drafts.set(key, { ...draft, attachments });
					if (key === this.draftKey()) {
						this.update({ attachments, error: localize('sessions.chatgpt.saveDraftAttachmentsFailed', 'Could not save draft attachments: {0}', this.errorText(error)) });
					}
				}
			}
			return;
		} finally {
			for (const { id } of sources) { this.savingAttachments.delete(id); }
		}
		if (this.isDisposed) { return; }
		const draft = !account.aborted ? this.drafts.get(key) : undefined;
		if (draft) { this.persistDraftAttachments(key, draft); }
		await this.deleteAttachmentFiles(scope, sources.filter(source => !draft?.attachments.some(attachment => attachment.id === source.id)).map(source => source.id));
	}

	public removeAttachment(id: string): void {
		const state = this.model.get();
		if (state.sending || !state.attachments.some(attachment => attachment.id === id)) { return; }
		this.releaseAttachment(id);
		const attachments = state.attachments.filter(attachment => attachment.id !== id);
		const draft = { ...this.drafts.get(state.localConversationId), text: state.draft, attachments };
		this.drafts.set(state.localConversationId, draft);
		this.persistDraftAttachments(state.localConversationId, draft);
		if (this.cacheScope && !this.savingAttachments.has(id)) { this.trackAttachmentWrite(this.deleteAttachmentFiles(this.cacheScope, [id])); }
		this.update({ attachments });
	}

	public async retryAttachment(id: string): Promise<void> {
		if (this.model.get().sending || !this.model.get().attachments.some(attachment => attachment.id === id && attachment.status === 'failed')) { return; }
		await this.uploadAttachment(this.draftKey(), id);
	}

	private async uploadAttachment(key: string, id: string): Promise<void> {
		const draft = this.readDraft(key);
		const attachment = draft?.attachments.find(item => item.id === id);
		const scope = this.cacheScope;
		if (!draft || !attachment || attachment.status === 'ready' || this.uploads.has(id) || this.lifecycle.willShutdown) { return; }
		this.drafts.set(key, draft);
		const controller = new AbortController();
		this.uploads.set(id, controller);
		const update = (value: Partial<ChatGPTAttachment>): void => {
			const draft = this.drafts.get(key);
			if (this.isDisposed || this.lifecycle.willShutdown || controller.signal.aborted || !draft || !draft.attachments.some(attachment => attachment.id === id)) { return; }
			const attachments = draft.attachments.map(attachment => attachment.id === id ? { ...attachment, ...value } : attachment);
			const updated = { ...draft, attachments };
			this.drafts.set(key, updated);
			this.persistDraftAttachments(key, updated);
			if (key === this.draftKey()) { this.update({ attachments }); }
		};
		update({ status: 'uploading', error: undefined });
		try {
			const source = this.attachmentFiles.get(id) ?? (scope ? await this.draftAttachments.readFile(scope, attachment) : undefined);
			controller.signal.throwIfAborted();
			if (!source) { throw new Error(localize('sessions.chatgpt.draftAttachmentUnavailable', 'The original file is unavailable. Remove the attachment and add the file again.')); }
			const file = await this.client.upload(source, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
			update({ status: 'ready', file });
			this.attachmentFiles.delete(id);
		} catch (error) { update({ status: 'failed', error: this.errorText(error) }); }
		finally { if (this.uploads.get(id) === controller) { this.uploads.delete(id); } }
	}
	public readResource(resource: string, conversationId: string | undefined, messageId: string, signal: AbortSignal): Promise<Blob> {
		return this.client.readResource(resource, conversationId, messageId, signal);
	}
	public getAccessibleContent(): string {
		const state = this.model.get();
		const messages = state.messages.filter(message => !message.activity).map(message => {
			return `${message.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'}\n${message.role === 'assistant' ? getChatGPTRichContentText(message.text, message.references) : message.text}\n${message.resources?.map(resource => resource.name).join('\n') ?? ''}`;
		});
		const cowork = state.coworkTasks.map(task => [task.prompt, coworkTaskStatus(task), task.error ?? task.readError,
		...task.thread?.turns.flatMap(turn => turn.items.flatMap(item => item.type === 'agentMessage' || item.type === 'plan' ? [item.text]
			: item.type === 'toolResult' ? item.content?.flatMap(part => part.type === 'artifact' && 'uri' in part.artifact.source ? [part.artifact.source.uri] : []) ?? [] : [])) ?? [],
		].filter(Boolean).join('\n'));
		return [state.title, pendingCreationStatus(state), ...messages, ...cowork, ...state.voiceTranscript.map(item => `${item.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'}: ${item.text}`), state.error].filter(Boolean).join('\n\n');
	}
	private restoreCachedTimeline(remoteId: string, saved: ChatTimeline | undefined, validation?: HistoryValidation): void {
		if (!saved?.history) return;
		const { title, parentId, messages, olderCursor } = saved.history;
		this.bindConversation(remoteId, saved.localId);
		const draft = this.readDraft(saved.localId);
		this.update({
			conversationId: remoteId, localConversationId: saved.localId,
			title: this.model.get().conversations.find(item => item.id === remoteId)?.title ?? title,
			parentId, messages, olderCursor, coworkTasks: saved.tasks,
			draft: draft?.text ?? '', attachments: draft?.attachments ?? [], uncertain: !validation, stopped: false,
			...(validation ? this.historyModel(validation) : {}),
		});
		this.rememberConversation(remoteId);
		this.watchCoworkTasks();
	}

	private persistHistory(history: ChatGPTHistory, tasks?: readonly ChatTimelineTask[]): void {
		const localId = this.localIdsByRemoteId.get(history.id);
		if (!localId) return;
		const { title, parentId, messages, olderCursor } = history;
		const timeline = this.timelineFor(history.id);
		timeline.write(history.id, { localId, tasks: tasks ?? timeline.read(history.id)?.tasks ?? [], history: { title, parentId, messages, olderCursor } });
	}

	private markHistoryValidated({ id, parentId, model, thinkingEffort }: ChatGPTHistory): void {
		this.historyValidations.set(id, { parentId, model, thinkingEffort, validatedAt: Date.now() });
	}

	private freshHistory(id: string, parentId: string): HistoryValidation | undefined {
		const validation = this.historyValidations.get(id);
		if (!validation || validation.parentId !== parentId) return undefined;
		const age = Date.now() - validation.validatedAt;
		return age >= 0 && age < historyFreshnessMs ? validation : undefined;
	}

	private watchCoworkTasks(): void {
		this.taskWatchers.clear();
		const state = this.model.get();
		for (const task of state.coworkTasks) this.watchCoworkTask(state.localConversationId, task);
	}

	private watchCoworkTask(localId: string, task: ChatTimelineTask): void {
		if (!this.instantiation) return;
		const controller = new AbortController();
		const owner = this.taskWatchers.add(new DisposableStore());
		owner.add(toDisposable(() => controller.abort()));
		const tasks = this.instantiation.createInstance(ChatCoworkTasks);
		void tasks.resolve(task, controller.signal).then(active => {
			if (controller.signal.aborted) return;
			const model = tasks.createModel(active, owner);
			const update = () => this.updateCoworkTask(localId, task, { thread: model.thread, readError: model.error });
			owner.add(model.onDidChange(update));
			update();
		}).catch(error => {
			if (!controller.signal.aborted) this.updateCoworkTask(localId, task, { readError: this.errorText(error) });
		});
	}

	private updateCoworkTask(localId: string, task: ChatTimelineTask, change: Partial<ChatCoworkTaskView>): void {
		const state = this.model.get();
		if (state.localConversationId !== localId) return;
		this.update({ coworkTasks: state.coworkTasks.map(entry => entry.threadId === task.threadId && entry.sessionId === task.sessionId ? { ...entry, ...change } : entry) });
	}

	private localConversations(): ChatGPTConversation[] {
		const pending = this.outbox?.creations().filter(entry => !entry.cancelled).map(entry => ({
			id: `pending:${entry.localId}`, title: entry.text.slice(0, 80), projectId: entry.projectId, local: true,
		})) ?? [];
		return [...pending, ...this.timeline.listLocal().map(({ id, timeline }) => ({
			id, title: timeline.title ?? timeline.tasks[0]?.prompt ?? 'ChatGPT', local: true, pinned: timeline.pinned,
		})).reverse()];
	}

	private withLocalConversations(conversations: readonly ChatGPTConversation[]): ChatGPTConversation[] {
		const pendingIds = new Set(this.outbox?.creations().map(entry => entry.remoteId));
		return [...this.localConversations(), ...conversations.filter(item => !item.local && !pendingIds.has(item.id) && !this.outbox?.isDeleted(item.id))];
	}

	private updateLocalConversation(id: string, change: { title?: string; pinned?: boolean; archived?: boolean; }): void {
		const timeline = this.timeline.read(id);
		if (!timeline) return;
		this.timeline.write(id, { ...timeline, ...change });
		const state = this.model.get();
		this.update({
			conversations: this.withLocalConversations(state.conversations),
			...(selectedChatConversationId(state) === id && change.title ? { title: change.title } : {}),
		});
	}

	private restoreLocalConversation(id: string): void {
		const timeline = this.timeline.read(id);
		if (!timeline || timeline.archived) return;
		const draft = this.readDraft(timeline.localId);
		this.update({
			conversationId: undefined, localConversationId: timeline.localId, title: timeline.title ?? timeline.tasks[0]?.prompt ?? 'ChatGPT',
			parentId: crypto.randomUUID(), messages: [], coworkTasks: timeline.tasks, draft: draft?.text ?? '', attachments: draft?.attachments ?? [],
			busy: false, loading: undefined, error: '', uncertain: false, stopped: false,
		});
		this.rememberConversation(id);
		this.watchCoworkTasks();
	}

	private timelineFor(id: string): ChatTimelineStorage {
		return id.startsWith('local:') ? this.timeline : this.remoteTimeline ?? this.timeline;
	}

	private retainedConversation(): string | undefined {
		const legacy = this.storage.get(this.selectedConversationKey, StorageScope.PROFILE);
		// A fresh New entry can be opened before the account's cache scope is known.
		if (legacy === '') { return undefined; }
		if (legacy?.startsWith('local:') || !this.cacheScope) { return legacy; }
		return (this.storage.get(`${this.selectedConversationKey}:${this.cacheScope}`, StorageScope.PROFILE) ?? legacy) || undefined;
	}

	private rememberConversation(id: string | undefined): void {
		if (this.cacheScope && !id?.startsWith('local:')) {
			this.storage.store(`${this.selectedConversationKey}:${this.cacheScope}`, id ?? '', StorageScope.PROFILE, StorageTarget.MACHINE);
			this.storage.remove(this.selectedConversationKey, StorageScope.PROFILE);
		} else {
			this.storage.store(this.selectedConversationKey, id ?? '', StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	private restorePendingCreation(entry: PendingChatGPTCreation): void {
		this.taskWatchers.clear();
		this.update({
			conversationId: undefined, localConversationId: entry.localId, title: entry.text.slice(0, 80),
			parentId: entry.parentId, messages: [{ id: entry.messageId, role: 'user', text: entry.text }],
			draft: '', attachments: [], coworkTasks: [], error: '', uncertain: false, stopped: false,
		});
		this.rememberConversation(`pending:${entry.localId}`);
	}

	private async queueCreation(entry: PendingChatGPTCreation): Promise<void> {
		const outbox = this.outbox;
		if (!outbox) { return; }
		outbox.saveCreation(entry);
		this.forgetDraft(entry.localId);
		if (entry.localId === this.newConversationId) { this.rotateNewDraft(); }
		this.updateCatalog({ conversations: this.model.get().conversations });
		this.restorePendingCreation(entry);
		try { await this.storage.flush(); }
		catch (error) { if (this.outbox === outbox) { this.update({ error: this.errorText(error) }); } }
	}

	private async syncOutbox(): Promise<void> {
		const outbox = this.outbox;
		const state = this.model.get();
		if (!outbox || this.isDisposed || !state.connected || !state.networkAvailable || state.sending || state.managing || state.voice !== 'idle') { return; }
		if (this.syncingOutbox) { await this.syncingOutbox; return; }
		if (!outbox.pendingDeletes().length && !outbox.creations().some(entry => !entry.submittedAgainst && !entry.cancelled)) { return; }
		const signal = this.management.signal;
		const sync = this.drainOutbox(outbox, signal).catch(error => {
			if (!signal.aborted) { this.update({ error: this.errorText(error) }); }
		});
		this.syncingOutbox = sync;
		try { await sync; }
		finally { if (this.syncingOutbox === sync) { this.syncingOutbox = undefined; } }
	}

	private async drainOutbox(outbox: ChatGPTOutbox, account: AbortSignal): Promise<void> {
		await this.storage.flush();
		for (const id of outbox.pendingDeletes()) {
			if (account.aborted || !this.model.get().networkAvailable) { return; }
			const signal = AbortSignal.any([account, AbortSignal.timeout(15_000)]);
			try { await this.client.deleteConversation(id, signal); }
			catch (error) {
				if (!isMissingConversation(error)) { break; }
			}
			if (account.aborted) { return; }
			outbox.confirmDeletion(id);
			this.update({});
			await this.storage.flush();
		}
		for (const entry of outbox.creations()) {
			if (account.aborted || this.outbox !== outbox || !this.model.get().networkAvailable) { return; }
			// An earlier send can yield to deletion. Preparation already carries the prompt.
			if (entry.submittedAgainst || entry.cancelled || outbox.creation(entry.localId) !== entry) { continue; }
			const state = this.model.get();
			const model = state.models.find(model => model.modelIds.includes(entry.model ?? ''));
			const preset = model?.presets.find(preset => preset.model === entry.model && preset.thinkingEffort === entry.thinkingEffort)
				?? state.models.find(model => model.id === state.model)?.presets.find(preset => preset.id === state.modelPreset);
			if (!preset) { return; }
			const controller = new AbortController();
			const active = this.activeOutboxCreation = { outbox, localId: entry.localId, controller };
			const signal = AbortSignal.any([account, controller.signal, AbortSignal.timeout(120_000)]);
			let submitted = false;
			try {
				for await (const event of this.client.send({ ...entry, model: preset.model, thinkingEffort: preset.thinkingEffort }, signal, async () => {
					signal.throwIfAborted();
					if (this.outbox !== outbox || outbox.creation(entry.localId) !== entry || !this.model.get().networkAvailable) { throw new DOMException('Cancelled', 'AbortError'); }
					outbox.saveCreation({ ...entry, submittedAgainst: state.conversations.filter(item => !item.local).map(item => item.id) });
					submitted = true;
					this.update({});
					await this.storage.flush();
					if (outbox.creation(entry.localId)?.cancelled) {
						outbox.removeCreation(entry.localId);
						await this.storage.flush();
						throw new DOMException('Cancelled', 'AbortError');
					}
				})) {
					if (account.aborted) { return; }
					const current = outbox.creation(entry.localId);
					if (!current || !event.conversationId || current.remoteId) { continue; }
					if (current.cancelled) {
						outbox.deleteConversation(event.conversationId, entry.localId);
					} else { outbox.saveCreation({ ...current, remoteId: event.conversationId }); }
					await this.storage.flush();
				}
				const current = outbox.creation(entry.localId);
				if (current?.remoteId) {
					const history = await this.client.history(current.remoteId, signal);
					if (!account.aborted && outbox.creation(entry.localId) === current) { await this.completePendingCreation(current, history, signal); }
				}
			} catch (error) {
				if (account.aborted) { return; }
				// A definite rate limit rejected the POST. A timeout or broken
				// stream after dispatch must be reconciled by message ID instead.
				const current = outbox.creation(entry.localId);
				if (submitted && current && !current.remoteId && error instanceof ChatGPTRequestError && [401, 403, 429].includes(error.status)) {
					if (current.cancelled) { outbox.removeCreation(entry.localId); }
					else { outbox.saveCreation(entry); }
					this.update({});
					await this.storage.flush();
				}
				if (!controller.signal.aborted) { break; }
			} finally {
				if (this.activeOutboxCreation === active) { this.activeOutboxCreation = undefined; }
			}
		}
	}

	private async completePendingCreation(entry: PendingChatGPTCreation, history: ChatGPTHistory, signal: AbortSignal): Promise<void> {
		const outbox = this.outbox!;
		if (entry.cancelled) {
			outbox.deleteConversation(history.id, entry.localId);
			this.forgetRemoteConversation(history.id);
			return;
		}
		const projectMove = await this.assignNewConversationToProject(history.id, entry, signal);
		if (signal.aborted || this.outbox !== outbox || outbox.creation(entry.localId) !== entry) return;
		const selected = this.model.get().localConversationId === entry.localId;
		this.bindConversation(history.id, entry.localId);
		outbox.removeCreation(entry.localId);
		if (selected) {
			this.restoreHistory(history, true, this.model.get().busy);
			this.rememberConversation(history.id);
		} else {
			this.persistHistory(history);
			this.markHistoryValidated(history);
		}
		this.rememberHistory(history, { projectId: projectMove ? projectMove.projectId : undefined });
		if (selected && projectMove && projectMove.error) this.update({ error: projectMove.error });
	}

	private async reconcilePendingCreations(items: Map<string, ChatGPTConversation>, signal: AbortSignal): Promise<ReadonlySet<string>> {
		const outbox = this.outbox;
		const hidden = new Set<string>();
		if (!outbox) { return hidden; }
		const reads = new Map<string, Promise<ChatGPTHistory>>();
		for (const entry of outbox.creations()) {
			if (!entry.submittedAgainst) { continue; }
			const known = new Set(entry.submittedAgainst);
			const candidates = entry.remoteId ? [entry.remoteId] : [...items.keys()].filter(id => !known.has(id));
			const unverified = entry.cancelled ? new Set(candidates) : undefined;
			for (let offset = 0; offset < candidates.length && !signal.aborted; offset += 4) {
				const batch = candidates.slice(offset, offset + 4);
				const results = await Promise.allSettled(batch.map(id => {
					const read = reads.get(id) ?? this.client.history(id, signal);
					reads.set(id, read);
					return read;
				}));
				if (signal.aborted || this.outbox !== outbox || outbox.creation(entry.localId) !== entry) { break; }
				let matched = false;
				for (const [index, id] of batch.entries()) {
					const result = results[index]!;
					if (result.status === 'fulfilled' && (entry.remoteId === id || result.value.messages.some(message => message.role === 'user' && message.id === entry.messageId))) {
						await this.completePendingCreation(entry, result.value, signal);
						const conversation = this.model.get().conversations.find(item => item.id === id);
						if (conversation?.projectId) items.set(id, { ...items.get(id) ?? conversation, projectId: conversation.projectId });
						if (entry.cancelled) { hidden.add(id); }
						unverified?.clear();
						matched = true;
						break;
					}
					if (result.status === 'fulfilled') { unverified?.delete(id); }
				}
				if (matched || results.some(result => result.status === 'rejected' && isChatGPTRateLimit(result.reason))) { break; }
			}
			for (const id of unverified ?? []) { hidden.add(id); }
		}
		return hidden;
	}

	private restoreCatalog(scope: string): void {
		this.historyValidations.clear();
		this.cacheScope = scope;
		this.recentFetchedAt = undefined;
		this.projectsFetchedAt = this.pinsFetchedAt = undefined;
		this.recentOffset = 0;
		this.recentIds.clear();
		this.remoteTimeline = new ChatTimelineStorage(this.storage, `chatgpt-web:${scope}`);
		this.outbox = new ChatGPTOutbox(this.storage, scope);
		this.update({ conversations: this.withLocalConversations([]), historyListFailed: false, attachments: this.readDraft(this.draftKey())?.attachments ?? [] });
		const raw = this.storage.get(`${catalogKey}:${scope}`, StorageScope.PROFILE);
		if (!raw) { return; }
		let value: unknown;
		try { value = JSON.parse(raw); }
		catch { return; }
		if (!isRecord(value)) { return; }
		const conversations = Array.isArray(value.conversations) ? value.conversations.flatMap(item => {
			if (!isRecord(item) || typeof item.id !== 'string' || item.id.startsWith('local:') || typeof item.title !== 'string') { return []; }
			return [{
				id: item.id, title: item.title, pinned: item.pinned === true, projectId: typeof item.projectId === 'string' ? item.projectId : undefined,
				...(item.projectOnly === true ? { projectOnly: true } : {}),
			}];
		}) : [];
		const projects = Array.isArray(value.projects) ? value.projects.flatMap(item => {
			if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string') { return []; }
			return [{
				id: item.id, title: item.title,
				...(isCachedTimestamp(item.createdAt) ? { createdAt: item.createdAt } : {}),
				...(isCachedTimestamp(item.updatedAt) ? { updatedAt: item.updatedAt } : {}),
			}];
		}) : [];
		const recent = value.recent;
		const now = Date.now();
		const restoredRecent = isRecord(recent)
			&& typeof recent.fetchedAt === 'number' && Number.isSafeInteger(recent.fetchedAt)
			&& recent.fetchedAt > 0 && recent.fetchedAt <= now
			&& typeof recent.offset === 'number' && Number.isSafeInteger(recent.offset) && recent.offset >= 0
			&& typeof recent.hasMore === 'boolean'
			? { fetchedAt: recent.fetchedAt, offset: recent.offset, hasMore: recent.hasMore } : undefined;
		if (restoredRecent) {
			this.recentFetchedAt = restoredRecent.fetchedAt;
			this.recentOffset = restoredRecent.offset;
			if (this.native) {
				for (const item of conversations) {
					if (!item.pinned && !item.projectOnly) this.recentIds.add(item.id);
				}
			} else if (isRecord(recent) && Array.isArray(recent.ids)) {
				for (const id of recent.ids) {
					if (typeof id === 'string') { this.recentIds.add(id); }
				}
			}
		}
		const freshAt = (timestamp: unknown) =>
			typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : undefined;
		// Older catalogs recorded projectsFetchedAt before project timestamps were decoded.
		this.projectsFetchedAt = freshAt(value.projectMetadataFetchedAt);
		this.pinsFetchedAt = freshAt(value.pinsFetchedAt);
		this.update({ conversations: this.withLocalConversations(conversations), projects, ...(restoredRecent ? { hasMore: restoredRecent.hasMore } : {}) });
	}

	private updateCatalog(change: Partial<ChatGPTState>): void {
		const projectHistory = change.projectHistory ?? this.model.get().projectHistory;
		const projectIds = change.projects && new Set(change.projects.map(project => project.id));
		this.update({
			...change,
			...(change.conversations ? { conversations: this.withLocalConversations(change.conversations) } : {}),
			...(projectIds ? { projectHistory: new Map([...projectHistory].filter(([id]) => projectIds.has(id))) } : {}),
		});
		if (this.cacheScope) {
			const { conversations, projects, hasMore } = this.model.get();
			this.storage.store(`${catalogKey}:${this.cacheScope}`, JSON.stringify({
				conversations: conversations.filter(item => !item.local),
				projects,
				...(this.recentFetchedAt !== undefined ? {
					recent: { fetchedAt: this.recentFetchedAt, offset: this.recentOffset, hasMore, ids: this.native ? undefined : [...this.recentIds] },
				} : {}),
				projectMetadataFetchedAt: this.projectsFetchedAt,
				pinsFetchedAt: this.pinsFetchedAt,
			}), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}
	private update(change: Partial<ChatGPTState>): void {
		if (this.isDisposed) { return; }
		const previous = this.model.get();
		const next = { ...previous, ...change };
		if (next.conversationId !== previous.conversationId) {
			this.olderRead?.abort();
			next.olderCursor = change.olderCursor;
			next.readingOlderHistory = false;
		}
		const creation = !next.conversationId ? this.outbox?.creation(next.localConversationId) : undefined;
		const draft = this.drafts.get(next.localConversationId);
		this.model.set({
			...next, catalogScope: this.cacheScope, canQueue: !!this.outbox, pendingSync: this.outbox?.hasPending() === true,
			pendingCreation: creation && !creation.cancelled ? creation.submittedAgainst ? 'submitted' : 'queued' : undefined,
			explicitDraftModel: !next.conversationId && !!draft?.selection,
			draftTarget: !next.conversationId && !creation ? draft?.target : undefined,
		});
	}
	private draftKey(): string { return this.model.get().localConversationId; }

	private readDraft(localId: string): ChatGPTDraft | undefined {
		const draft = this.drafts.get(localId);
		if (draft) { return draft; }
		const text = this.storage.get(`${this.storagePrefix}.draft:${localId}`, StorageScope.WORKSPACE);
		const saved = this.cacheScope ? this.draftAttachments.read(localId) : undefined;
		const attachments = saved?.scope === this.cacheScope ? saved?.attachments : undefined;
		return text === undefined && !attachments?.length ? undefined : { text: text ?? '', attachments: attachments ?? [] };
	}

	private persistDraftText(localId: string, text: string): void {
		this.storage.store(`${this.storagePrefix}.draft:${localId}`, text || undefined, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.rememberNewDraft(localId, text);
	}

	private rememberNewDraft(localId: string, text: string): void {
		if (localId !== this.newConversationId) { return; }
		this.storage.store(this.newDraftIdKey, text || this.draftAttachments.has(localId) ? localId : undefined, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private persistDraftAttachments(localId: string, draft: ChatGPTDraft): void {
		const scope = this.cacheScope;
		if (!scope) { return; }
		const previous = this.draftAttachments.read(localId);
		if (previous && previous.scope !== scope) {
			this.trackAttachmentWrite(this.deleteAttachmentFiles(previous.scope, previous.attachments.map(attachment => attachment.id)));
		}
		// An upload is only restorable once its original bytes have committed.
		this.draftAttachments.write(localId, scope, draft.attachments.filter(attachment => !this.savingAttachments.has(attachment.id)));
		this.rememberNewDraft(localId, draft.text);
	}

	private trackAttachmentWrite(operation: Promise<void>): Promise<void> {
		const tracked = operation.finally(() => this.pendingAttachmentWrites.delete(tracked));
		this.pendingAttachmentWrites.add(tracked);
		return tracked;
	}

	private async deleteAttachmentFiles(scope: string, ids: readonly string[]): Promise<void> {
		try { await this.draftAttachments.deleteFiles(scope, ids); }
		catch (error) { this.update({ error: localize('sessions.chatgpt.removeDraftAttachmentsFailed', 'Could not remove draft attachment files: {0}', this.errorText(error)) }); }
	}

	private releaseAttachment(id: string): void {
		this.uploads.get(id)?.abort();
		this.uploads.delete(id);
		this.attachmentFiles.delete(id);
	}

	private forgetDraft(localId: string): void {
		const saved = this.draftAttachments.read(localId);
		for (const attachment of this.drafts.get(localId)?.attachments ?? []) { this.releaseAttachment(attachment.id); }
		this.draftAttachments.remove(localId);
		if (saved) {
			this.trackAttachmentWrite(this.deleteAttachmentFiles(saved.scope, saved.attachments.map(attachment => attachment.id)));
		}
		this.drafts.delete(localId);
		this.persistDraftText(localId, '');
	}

	private rotateNewDraft(): void {
		this.newConversationId = crypto.randomUUID();
		this.storage.remove(this.newDraftIdKey, StorageScope.WORKSPACE);
	}

	/** The first accepted reply binds a remote conversation to the existing local draft. */
	private bindConversation(remoteId: string, localId: string): void {
		this.localIdsByRemoteId.set(remoteId, localId);
		if (localId === this.newConversationId) { this.rotateNewDraft(); }
	}
	private bindLocalTimeline(localId: string, remoteId: string): void {
		const localKey = `local:${localId}`;
		const local = this.timeline.read(localKey);
		if (!local) return;
		const timeline = this.timelineFor(remoteId);
		const remote = timeline.read(remoteId);
		const tasks = [...local.tasks, ...(remote?.tasks ?? []).filter(task => !local.tasks.some(other => other.sessionId === task.sessionId && other.threadId === task.threadId))];
		const { title, parentId, messages } = this.model.get();
		timeline.write(remoteId, { ...remote, localId, tasks, history: remote?.history ?? { title, parentId, messages } });
		this.retiredConversationIdentity.fire({ id: localKey, replacementId: remoteId });
		this.timeline.remove(localKey);
		this.update({ conversations: this.model.get().conversations.filter(item => item.id !== localKey) });
		this.rememberHistory({ id: remoteId, title: local.title ?? this.model.get().title });
	}

	private cancelReads(): void {
		this.olderRead?.abort();
		this.refreshOperation?.abort();
		this.operation?.abort();
		this.generation++;
	}

	private beginOperation(): { signal: AbortSignal; generation: number; } {
		this.cancelReads();
		this.operation = new AbortController();
		return { signal: AbortSignal.any([this.operation.signal, AbortSignal.timeout(30_000)]), generation: this.generation };
	}

	private async loadCatalog(background?: AbortController, forceReload = false): Promise<void> {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing) { return; }
		const retainedLocal = this.retainedConversation();
		if (!background && retainedLocal?.startsWith('local:') && selectedChatConversationId(this.model.get()) !== retainedLocal) this.restoreLocalConversation(retainedLocal);
		const { signal, generation } = background
			? { signal: AbortSignal.any([background.signal, AbortSignal.timeout(30_000)]), generation: this.generation }
			: this.beginOperation();
		if (!background) { this.update({ busy: true, loading: { kind: 'history' }, error: '' }); }
		try {
			const scope = await this.transport.getCacheScope().catch(() => undefined);
			if (generation !== this.generation || background?.signal.aborted) { return; }
			if (scope && this.cacheScope !== scope) {
				this.restoreCatalog(scope);
				const retained = this.retainedConversation();
				if (retained?.startsWith('pending:')) {
					const entry = this.outbox?.creation(retained.slice('pending:'.length));
					if (entry && !entry.cancelled) { this.restorePendingCreation(entry); }
				} else if (retained && !retained.startsWith('local:') && this.model.get().conversations.some(item => item.id === retained)) {
					this.restoreCachedTimeline(retained, this.remoteTimeline?.read(retained));
				}
			}
			if (!this.model.get().networkAvailable || this.native && !scope) {
				if (!background) { this.update({ busy: false, loading: undefined }); }
				return;
			}
			const now = Date.now();
			const isFresh = (fetchedAt: number | undefined, maxAge: number) =>
				!forceReload && fetchedAt !== undefined && now >= fetchedAt && now - fetchedAt < maxAge;
			const recoveringSend = !this.native && this.outbox?.creations().some(entry => entry.submittedAgainst);
			const readRecent = !isFresh(this.recentFetchedAt, recoveringSend ? 60_000 : recentFreshnessMs);
			const readProjects = !isFresh(this.projectsFetchedAt, sidebarFreshnessMs);
			const readPins = !isFresh(this.pinsFetchedAt, sidebarFreshnessMs);
			const stateBeforeReads = this.model.get();
			const refreshRetainedHistory = this.native && !!(this.retainedConversation() ?? stateBeforeReads.conversationId);
			if (background && !readRecent && !readProjects && !readPins && !refreshRetainedHistory) { return; }
			const fullRecent = this.native || forceReload;
			const [catalog, [projects, pins, conversations]] = await Promise.all([
				!background && (!stateBeforeReads.connected || !stateBeforeReads.conversationId) ? this.client.models(signal) : undefined,
				Promise.allSettled([
					readProjects ? this.client.projects(signal) : undefined,
					readPins ? this.client.pinnedConversations(signal) : undefined,
					readRecent ? this.readRecentPages(signal, fullRecent) : undefined,
				]),
			]);
			if (generation !== this.generation || background?.signal.aborted) { return; }
			const recent = conversations.status === 'fulfilled' ? conversations.value : undefined;
			const recentFailed = conversations.status === 'rejected' || recent?.rateLimit !== undefined;
			// Recent history is auxiliary to restoring a known conversation and its
			// continuation. Its rate limit must not disable an otherwise usable chat.
			const items = new Map((recent?.items ?? this.model.get().conversations.filter(item => !item.local)).map(item => [item.id, item]));
			const pinned = pins.status === 'fulfilled' ? pins.value : undefined;
			if (pinned) {
				if (!recent) {
					for (const item of items.values()) {
						if (!item.local && item.pinned) { items.set(item.id, { ...item, pinned: false }); }
					}
				}
				for (const item of pinned) {
					const listed = items.get(item.id);
					const previous = listed ?? this.model.get().conversations.find(candidate => candidate.id === item.id);
					items.set(item.id, {
						...item, projectId: item.projectId ?? previous?.projectId,
						createdAt: item.createdAt ?? previous?.createdAt,
						updatedAt: listed?.updatedAt ?? item.updatedAt ?? previous?.updatedAt,
						...(previous?.projectOnly ? { projectOnly: true } : {}),
					});
				}
			} else if (recent && !this.native) {
				for (const previous of this.model.get().conversations) {
					const item = items.get(previous.id);
					if (item && previous.pinned && !item.pinned) { items.set(item.id, { ...item, pinned: true }); }
				}
			}
			const hidden = await this.reconcilePendingCreations(items, signal);
			if (generation !== this.generation || background?.signal.aborted) { return; }
			for (const id of items.keys()) {
				if (hidden.has(id) || this.outbox?.isDeleted(id)) { items.delete(id); }
			}
			const before = this.model.get();
			const missing = recent ? before.conversations.filter(item => !item.local && !item.projectOnly && !items.has(item.id) && !hidden.has(item.id)) : [];
			const retained = this.retainedConversation() ?? before.conversationId;
			const histories = new Map<string, PromiseSettledResult<ChatGPTHistory>>();
			const ids = fullRecent && !recentFailed ? missing.filter(item => item.id !== retained && (pinned || !item.pinned)).map(item => item.id) : [];
			if (retained && !retained.startsWith('local:') && !retained.startsWith('pending:') && !this.outbox?.isDeleted(retained) && retained.length < 1024) {
				const needsHistory = before.uncertain || !this.freshHistory(retained, before.parentId);
				if (!background || this.native || readRecent && needsHistory) { ids.unshift(retained); }
			}
			// Offset pagination can shift as other devices write. Verify omitted
			// rows directly, in bounded batches, before treating them as deleted.
			for (let offset = 0; offset < ids.length && !signal.aborted; offset += 4) {
				const batch = ids.slice(offset, offset + 4);
				const results = await Promise.allSettled(batch.map(id => this.client.history(id, signal)));
				for (const [index, id] of batch.entries()) { histories.set(id, results[index]!); }
				if (results.some(result => result.status === 'rejected' && isChatGPTRateLimit(result.reason))) { break; }
			}
			if (generation !== this.generation || background?.signal.aborted) { return; }
			const deleted = new Set<string>();
			for (const item of missing) {
				const history = histories.get(item.id);
				if (history?.status === 'rejected' && isMissingConversation(history.reason)) {
					this.forgetRemoteConversation(item.id);
					deleted.add(item.id);
				} else if (history?.status !== 'fulfilled' || !history.value.archived) {
					const title = history?.status === 'fulfilled' ? history.value.title : item.title;
					items.set(item.id, { ...item, title, pinned: !pinned && item.pinned === true });
				}
			}
			const history = retained ? histories.get(retained) : undefined;
			if (retained && !deleted.has(retained) && !items.has(retained) && recent && (!this.native || pinned)
				&& history?.status === 'rejected' && isMissingConversation(history.reason)) {
				this.forgetRemoteConversation(retained);
				deleted.add(retained);
			}
			// Changes beyond the refreshed pages can shift the old offset even
			// when the head is unchanged. Keep cached rows visible while the
			// next scroll continues from the last page actually read.
			if (recent) { this.resetRecentPage(recent); }
			const fetchedAt = Date.now();
			if (readRecent) { this.recentFetchedAt = recent && !recentFailed ? fetchedAt : undefined; }
			if (readProjects) { this.projectsFetchedAt = projects.status === 'fulfilled' ? fetchedAt : undefined; }
			if (readPins) { this.pinsFetchedAt = pins.status === 'fulfilled' ? fetchedAt : undefined; }
			const state = this.model.get();
			const currentProjects = (projects.status === 'fulfilled' ? projects.value : undefined) ?? state.projects;
			if (recent) {
				const projectIds = new Set(currentProjects.map(project => project.id));
				for (const item of state.conversations) {
					if (item.projectOnly && item.projectId && projectIds.has(item.projectId) && !items.has(item.id) && !hidden.has(item.id) && !this.outbox?.isDeleted(item.id)) {
						items.set(item.id, { ...item, pinned: !pinned && item.pinned === true });
					}
				}
			}
			const explicitDraft = state.explicitDraftModel;
			const selected = catalog?.models.find(model => model.id === state.model)
				?? (explicitDraft ? undefined : catalog?.models.find(model => model.id === catalog.defaultModel));
			const modelError = catalog && explicitDraft && !selected ? localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.') : '';
			this.updateCatalog({
				connected: true, busy: false, loading: undefined,
				...(catalog ? { models: catalog.models } : {}),
				...(selected ? { model: selected.id, modelPreset: this.resolveModelPreset(selected, state.modelPreset) } : {}),
				conversations: this.withLocalConversations([...items.values()]), hasMore: recent?.hasMore ?? state.hasMore,
				historyListFailed: readRecent ? recentFailed : state.historyListFailed,
				projects: currentProjects,
				...(!background ? { error: modelError } : {}),
			});
			const failures = [conversations, projects, pins].filter(result => result.status === 'rejected');
			const failure = recent?.rateLimit ?? (failures.find(result => isChatGPTRateLimit(result.reason)) ?? failures[0])?.reason;
			this.setHistoryFailure('catalog', failure && { error: failure, retry: this.reloadHistory });
			const requested = this.retainedConversation();
			if (!background && requested && requested !== retained && !requested.startsWith('local:')) {
				await this.select(requested);
				return;
			}
			if (retained && deleted.has(retained)) {
				this.setHistoryFailure('conversation', undefined);
				if (state.conversationId === retained) {
					this.newChat();
					if (state.draft && !this.model.get().draft) { this.setDraft(state.draft); }
				} else { this.rememberConversation(undefined); }
				return;
			}
			if (history?.status === 'fulfilled') {
				this.setHistoryFailure('conversation', undefined);
				const value = history.value;
				if (!background || state.uncertain || state.parentId !== value.parentId || state.title !== value.title || !equals(state.messages, value.messages)) {
					this.restoreHistory(value, !!background);
					this.rememberConversation(value.id);
				} else {
					this.markHistoryValidated(value);
				}
				if (conversations.status === 'rejected' && !items.has(value.id) && !value.archived) { this.rememberHistory(value); }
			} else if (history?.status === 'rejected') {
				this.setHistoryFailure('conversation', { error: history.reason, retry: this.reloadHistory });
			}
		} catch (error) {
			if (generation === this.generation && !background) {
				const authenticationFailed = error instanceof ChatGPTAuthenticationError || (error instanceof ChatGPTRequestError && error.status === 401);
				this.update({ busy: false, loading: undefined, ...(authenticationFailed ? { error: this.errorText(error), connected: false } : {}) });
				if (!authenticationFailed) { this.setHistoryFailure('catalog', { error, retry: this.reloadHistory }); }
			}
		}
	}

	private async readRecentPages(signal: AbortSignal, includeOlder: boolean): Promise<Awaited<ReturnType<ChatGPTClient['conversations']>> & { rateLimit?: ChatGPTRequestError; }> {
		if (!includeOlder) { return this.client.conversations(0, signal); }
		const depth = Math.max(this.recentOffset, this.model.get().conversations.filter(item => !item.local && !item.pinned && !item.projectOnly).length);
		let page = await this.client.conversations(0, signal);
		const items = [...page.items];
		while (page.hasMore && page.nextOffset < depth) {
			try { page = await this.client.conversations(page.nextOffset, signal); }
			catch (error) {
				// Publish the pages already read while the unread tail is cooling down.
				if (isChatGPTRateLimit(error)) { return { ...page, items, rateLimit: error }; }
				break;
			}
			items.push(...page.items);
		}
		return { ...page, items };
	}

	private resetRecentPage(page: { items: readonly ChatGPTConversation[]; nextOffset: number; }): void {
		this.recentOffset = page.nextOffset;
		this.recentIds.clear();
		for (const item of page.items) { this.recentIds.add(item.id); }
	}

	public newChat(options?: { readonly clearDraft: boolean; }): void {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing || this.voiceStopping) { return; }
		if (this.voiceController) { void this.endVoice(true).then(() => this.newChat(options)); return; }
		if (options?.clearDraft) { this.forgetDraft(this.newConversationId); }
		this.openNewChat();
	}

	private openNewChat(): void {
		const models = this.model.get().models;
		this.operation?.abort();
		this.refreshOperation?.abort();
		this.generation++;
		this.draftRevision++;
		this.taskWatchers.clear();
		const draft = this.readDraft(this.newConversationId);
		const selected = models.find(model => model.id === draft?.selection?.model);
		const selection = selected ? { model: selected.id, modelPreset: this.resolveModelPreset(selected, draft?.selection?.modelPreset) } : draft?.selection;
		this.update({ coworkTasks: [], localConversationId: this.newConversationId, draft: draft?.text ?? '', attachments: draft?.attachments ?? [], conversationId: undefined, title: 'ChatGPT', messages: [], parentId: crypto.randomUUID(), error: '', busy: false, loading: undefined, uncertain: false, stopped: false, models, ...selection });
		this.setHistoryFailure('conversation', undefined);
		this.rememberConversation(undefined);
		// New may interrupt the first catalog while its native auth owner is still
		// becoming ready. The new entry must retain a live initialization attempt.
		this.initialize();
	}

	public async select(id: string): Promise<void> {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing || this.outbox?.isDeleted(id)) { return; }
		const account = this.management;
		await this.endVoice(true);
		const current = this.model.get();
		if (this.isDisposed || account !== this.management || current.sending || current.managing || this.outbox?.isDeleted(id)) { return; }
		if (id.startsWith('pending:')) {
			const entry = this.outbox?.creation(id.slice('pending:'.length));
			if (entry && !entry.cancelled) {
				if (current.connected || current.loading?.kind !== 'history') {
					this.cancelReads();
					this.update({ busy: false, loading: undefined });
				}
				this.restorePendingCreation(entry);
			}
			return;
		}
		if (id.startsWith('local:')) {
			this.cancelReads();
			this.restoreLocalConversation(id);
			return;
		}
		const pending = this.conversationRead;
		if (pending?.id === id && pending.generation === this.generation) { return pending.promise; }

		const listed = current.conversations.some(item => item.id === id);
		const alreadySelected = current.conversationId === id;
		if (alreadySelected && current.connected && !current.uncertain && current.loading?.kind !== 'conversation' && this.freshHistory(id, current.parentId)) return;

		const timeline = this.remoteTimeline ?? (current.connected ? this.timeline : undefined);
		const saved = listed || alreadySelected ? timeline?.read(id) : undefined;
		if (!current.connected && current.loading?.kind === 'history' && listed) {
			// Keep the initial refresh running when opening an already listed chat.
			if (!alreadySelected) this.restoreCachedTimeline(id, saved);
			this.rememberConversation(id);
			return;
		}

		const validation = saved?.history && current.connected && (!alreadySelected || !current.uncertain)
			? this.freshHistory(id, saved.history.parentId) : undefined;
		if (saved?.history && (validation || !current.networkAvailable)) {
			this.cancelReads();
			if (!alreadySelected) this.restoreCachedTimeline(id, saved, validation);
			this.update({ busy: false, loading: undefined, error: '', uncertain: !validation });
			return;
		}
		if (!current.networkAvailable) { return; }

		if (!alreadySelected) this.restoreCachedTimeline(id, saved);
		const { signal, generation } = this.beginOperation();
		const promise = this.validateConversation(id, signal, generation);
		const read = this.conversationRead = { id, generation, promise };
		try { await promise; }
		finally { if (this.conversationRead === read) this.conversationRead = undefined; }
	}

	private async validateConversation(id: string, signal: AbortSignal, generation: number): Promise<void> {
		const state = this.model.get();
		this.update({
			busy: true, loading: { kind: 'conversation', id }, error: '',
			uncertain: state.conversationId === id || state.uncertain,
		});
		try {
			const history = await this.client.history(id, signal);
			if (generation !== this.generation) { return; }
			this.restoreHistory(history);
			this.rememberConversation(id);
			this.setHistoryFailure('conversation', undefined);
		} catch (error) {
			if (generation === this.generation) {
				this.update({
					busy: false,
					loading: undefined,
				});
				this.setHistoryFailure('conversation', { error, retry: () => this.select(id) });
			}
		}
	}

	public async loadOlderHistory(): Promise<void> {
		const state = this.model.get();
		const { conversationId, olderCursor } = state;
		if (!this.native || !conversationId || !olderCursor || state.busy || state.sending || !state.networkAvailable
			|| this.olderRead && !this.olderRead.signal.aborted) return;
		const read = this.olderRead = new AbortController();
		this.update({ readingOlderHistory: true });
		const connection = this.historyConnection.signal;
		const signal = AbortSignal.any([read.signal, connection, AbortSignal.timeout(30_000)]);
		try {
			const page = await this.client.olderHistory(conversationId, olderCursor, signal);
			signal.throwIfAborted();
			const current = this.model.get();
			if (current.conversationId !== conversationId || current.olderCursor !== olderCursor) return;
			const ids = new Set(current.messages.map(message => message.id));
			const messages = [...page.messages.filter(message => !ids.has(message.id)), ...current.messages];
			this.persistHistory({ id: conversationId, title: current.title, parentId: current.parentId, messages, olderCursor: page.olderCursor });
			this.update({ messages, olderCursor: page.olderCursor });
			this.setHistoryFailure('conversation', undefined);
		} catch (error) {
			if (!read.signal.aborted && !connection.aborted) {
				this.setHistoryFailure('conversation', { error, retry: () => this.loadOlderHistory() });
			}
		} finally {
			if (this.olderRead === read) {
				this.olderRead = undefined;
				this.update({ readingOlderHistory: false });
			}
		}
	}

	/** Retain the loaded prefix only when the new tail belongs to the same branch. */
	private retainNativeHistory(history: ChatGPTHistory, saved: ChatTimeline['history']): ChatGPTHistory {
		if (!this.native || !history.olderCursor || !saved) return history;
		const prefixLength = saved.messages.findIndex(message => message.id === history.messages[0]?.id);
		if (prefixLength <= 0) return history;
		return { ...history, messages: [...saved.messages.slice(0, prefixLength), ...history.messages], olderCursor: saved.olderCursor };
	}

	private restoreHistory(history: ChatGPTHistory, preserveModel = false, preserveLoading = false): void {
		const state = this.model.get();
		const timeline = this.timelineFor(history.id);
		const scoped = timeline.read(history.id);
		// The successful history read authorizes migration of legacy task references.
		const legacy = !scoped && timeline !== this.timeline ? this.timeline.read(history.id) : undefined;
		const saved = scoped ?? legacy;
		history = this.retainNativeHistory(history, saved?.history);
		const localId = this.localIdsByRemoteId.get(history.id) ?? saved?.localId ?? crypto.randomUUID();
		const sameConversation = state.localConversationId === localId && (state.conversationId === history.id || !state.conversationId);
		this.bindConversation(history.id, localId);
		this.persistHistory(history, saved?.tasks);
		this.markHistoryValidated(history);
		if (legacy) { this.timeline.remove(history.id); }
		const draft = this.readDraft(localId);
		this.update({
			coworkTasks: sameConversation ? state.coworkTasks : saved?.tasks ?? [], localConversationId: localId, draft: draft?.text ?? '', attachments: draft?.attachments ?? [], conversationId: history.id, title: history.title, messages: history.messages, parentId: history.parentId, olderCursor: history.olderCursor,
			...(!preserveModel ? this.historyModel(history) : {}),
			...(!preserveLoading ? { busy: false, loading: undefined } : {}),
			uncertain: false, stopped: false,
		});
		if (!sameConversation) { this.watchCoworkTasks(); }
	}

	private historyModel(history: Pick<ChatGPTHistory, 'model' | 'thinkingEffort'>): Pick<ChatGPTState, 'model' | 'modelPreset'> {
		const state = this.model.get();
		const selected = state.models.find(model => history.model !== undefined && model.modelIds.includes(history.model)) ?? state.models.find(model => model.id === state.model);
		const preset = selected?.presets.find(preset => preset.model === history.model && preset.thinkingEffort === history.thinkingEffort)
			?? selected?.presets.find(preset => preset.model === history.model && preset.thinkingEffort === undefined)
			?? selected?.presets.find(preset => preset.model === history.model);
		return { model: selected?.id ?? state.model, modelPreset: preset?.id ?? this.resolveModelPreset(selected, state.modelPreset) };
	}

	/** An accepted turn already supplies its canonical title and ID; do not refetch every recent chat. */
	private rememberHistory(history: Pick<ChatGPTHistory, 'id' | 'title'>, { acceptedAt, projectId }: { acceptedAt?: number; projectId?: string; } = {}): void {
		if (this.outbox?.isDeleted(history.id)) { return; }
		const state = this.model.get();
		const previous = state.conversations.find(item => item.id === history.id);
		if (!previous?.projectOnly && !this.recentIds.has(history.id)) { this.recentIds.add(history.id); this.recentOffset++; }
		const entry = {
			...previous, id: history.id, title: history.title,
			createdAt: previous ? previous.createdAt : acceptedAt,
			updatedAt: acceptedAt ?? previous?.updatedAt,
			projectId: projectId ?? previous?.projectId,
		};
		const projectHistory = projectId ? new Map(state.projectHistory) : undefined;
		if (projectId) projectHistory?.delete(projectId);
		this.updateCatalog({
			...(projectHistory ? { projectHistory } : {}),
			conversations: [entry, ...state.conversations.filter(item => item.id !== history.id)],
		});
	}

	private async assignNewConversationToProject(id: string, target: Pick<ChatGPTDraftTarget, 'projectId' | 'ashProjectId'> | undefined, signal: AbortSignal): Promise<{ projectId?: string; error?: string; } | undefined> {
		try {
			if (target?.ashProjectId) {
				const reference = chatGPTProjectConversationId(this.cacheScope, id);
				const projects = this.instantiation?.getOptional(IProjectService);
				if (!reference || !projects) throw new Error(localize({ bundle: 'ash', key: 'projects.requestFailed' }, 'Could not access projects. Check the connection and try again.'));
				signal.throwIfAborted();
				await projects.moveExternalConversation(reference, undefined, target.ashProjectId);
			} else if (target?.projectId) {
				await this.client.updateConversation(id, { gizmo_id: target.projectId }, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
				return { projectId: target.projectId };
			}
			return undefined;
		} catch (error) {
			return { error: localize('sessions.chatgpt.newProjectMoveFailed', 'The message was sent, but the conversation could not be added to the project: {0}', this.errorText(error)) };
		}
	}

	public async loadMore(): Promise<void> {
		const state = this.model.get();
		if (!state.connected || !state.networkAvailable || state.busy || state.sending || state.managing || !state.hasMore) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, loading: { kind: 'history' } });
		try {
			const result = await this.client.conversations(this.recentOffset, signal);
			if (generation !== this.generation) { return; }
			const items = new Map(this.model.get().conversations.filter(item => !item.local).map(item => [item.id, item]));
			for (const item of result.items) {
				const previous = items.get(item.id);
				items.set(item.id, {
					...item, pinned: item.pinned || previous?.pinned === true,
					createdAt: item.createdAt ?? previous?.createdAt,
					updatedAt: item.updatedAt ?? previous?.updatedAt,
				});
			}
			const hidden = await this.reconcilePendingCreations(items, signal);
			if (generation !== this.generation) { return; }
			for (const item of this.model.get().conversations) {
				if (item.projectOnly && !items.has(item.id) && !this.outbox?.isDeleted(item.id)) items.set(item.id, item);
			}
			for (const id of hidden) { items.delete(id); }
			this.recentOffset = result.nextOffset;
			for (const item of result.items) { this.recentIds.add(item.id); }
			const ordered = [...this.recentIds].flatMap(id => {
				const item = items.get(id);
				items.delete(id);
				return item ? [item] : [];
			});
			this.updateCatalog({
				conversations: this.withLocalConversations([...ordered, ...items.values()]),
				hasMore: result.hasMore, busy: false, loading: undefined, historyListFailed: false,
			});
			this.setHistoryFailure('recentPage', undefined);
		} catch (error) {
			if (generation === this.generation) {
				this.update({
					busy: false,
					loading: undefined,
					historyListFailed: true,
				});
				this.setHistoryFailure('recentPage', { error, retry: () => this.loadMore() });
			}
		}
	}

	public async send(): Promise<void> {
		const state = this.model.get();
		const text = state.draft.trim();
		if (this.isDisposed || state.pendingCreation || state.busy || state.sending || state.managing || state.voice !== 'idle') return;
		this.refreshOperation?.abort();
		const preset = state.models.find(model => model.id === state.model)?.presets.find(preset => preset.id === state.modelPreset);
		const target = isChatGPTNewDraft(state) ? state.draftTarget : undefined;
		const creation = canQueueChatGPTCreation(state) ? {
			localId: state.localConversationId, text, messageId: crypto.randomUUID(), parentId: state.parentId,
			model: preset?.model, thinkingEffort: preset?.thinkingEffort, projectId: target?.projectId, ashProjectId: target?.ashProjectId,
		} : undefined;
		if (creation && (!state.connected || !state.networkAvailable)) { await this.queueCreation(creation); return; }
		if (!preset || !state.connected || !state.networkAvailable || state.uncertain || (!text && !state.attachments.length) || state.attachments.some(attachment => attachment.status !== 'ready') || !state.model) { return; }
		if (state.conversationId) this.historyValidations.delete(state.conversationId);
		const controller = this.stream = new AbortController();
		const messageId = creation?.messageId ?? crypto.randomUUID();
		const draftKey = this.draftKey();
		const files = state.attachments.flatMap(attachment => attachment.file ? [attachment.file] : []);
		let acknowledged = false;
		let submitted = false;
		let projectMove: { readonly id: string; readonly result: ReturnType<ChatGPTService['assignNewConversationToProject']>; } | undefined;
		this.update({ sending: true, stopped: false, error: '', messages: [...state.messages, { id: messageId, role: 'user', text, resources: files.map(file => ({ uri: `file-service://${file.id}`, name: file.name, kind: file.mimeType.startsWith('image/') ? 'image' : 'document', mimeType: file.mimeType })) }] });
		try {
			for await (const event of this.replyBackend.streamReply({ text, model: preset.model, thinkingEffort: preset.thinkingEffort, parentId: state.parentId, conversationId: state.conversationId, messageId, files }, controller.signal, async () => { submitted = true; })) {
				if (this.isDisposed || this.stream !== controller) { return; }
				if (!acknowledged) {
					acknowledged = true;
					this.forgetDraft(draftKey);
					this.update({ draft: '', attachments: [] });
				}
				if (event.conversationId) {
					this.bindConversation(event.conversationId, draftKey);
					if (!state.conversationId) this.bindLocalTimeline(draftKey, event.conversationId);
				}
				const current = this.model.get();
				let messages = current.messages;
				if (event.message) {
					const message = event.message;
					const index = messages.findIndex(item => item.id === message.id);
					messages = index < 0 ? [...messages, message] : messages.map((item, i) => i === index ? message : item);
				}
				this.update({ messages, conversationId: event.conversationId ?? current.conversationId, parentId: event.message?.id ?? current.parentId });
				if (event.conversationId) { this.rememberConversation(event.conversationId); }
				if (event.conversationId && (target?.projectId || target?.ashProjectId) && !projectMove) {
					// The conversation can be organized as soon as the server assigns its ID.
					// Keep consuming reply frames while the independent catalog write runs.
					projectMove = {
						id: event.conversationId,
						result: this.assignNewConversationToProject(event.conversationId, target, this.management.signal),
					};
				}
			}
			this.forgetDraft(draftKey);
			this.update({ draft: '', attachments: [] });
			const current = this.model.get();
			const currentId = current.conversationId;
			if (currentId && !controller.signal.aborted && this.stream === controller) {
				this.persistHistory({ id: currentId, title: current.title, parentId: current.parentId, messages: current.messages, olderCursor: current.olderCursor });
				this.rememberHistory({ id: currentId, title: current.title }, { acceptedAt: Date.now() });
				try {
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
					const history = this.retainNativeHistory(await this.client.history(currentId, signal), this.timelineFor(currentId).read(currentId)?.history);
					if (this.stream !== controller || controller.signal.aborted) { return; }
					this.persistHistory(history);
					this.markHistoryValidated(history);
					this.update({ title: history.title, parentId: history.parentId, messages: history.messages, olderCursor: history.olderCursor });
					this.rememberHistory(history);
					this.setHistoryFailure('conversation', undefined);
				} catch (error) {
					// The reply is already accepted and saved. Retry validation on the next explicit read.
					if (!controller.signal.aborted && !isChatGPTRateLimit(error)) {
						this.setHistoryFailure('conversation', { error, retry: this.reloadHistory });
					}
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				if (creation && !submitted && error instanceof ChatReplyError && error.outcome === 'uncertain') {
					await this.queueCreation(creation);
					return;
				}
				const rejected = error instanceof ChatReplyError && error.outcome === 'rejected';
				this.update({
					error: this.errorText(error), uncertain: !rejected,
					...(rejected ? { messages: state.messages, parentId: state.parentId } : {}),
					...(error instanceof ChatReplyError && error.disconnected ? { connected: false } : {}),
				});
			}
		} finally {
			// Keep this turn's controls locked until its remote stop settles; a delayed stop
			// must not overlap a new send in the same conversation.
			await this.stopping;
			const move = await projectMove?.result;
			if (this.stream === controller) {
				const current = this.model.get();
				if (projectMove && move?.projectId) this.rememberHistory({ id: projectMove.id, title: current.title }, { projectId: move.projectId });
				this.stream = undefined;
				this.update({ sending: false, ...(move?.error && !current.error ? { error: move.error } : {}) });
			}
		}
	}

	public async stop(): Promise<void> {
		const controller = this.stream;
		if (!controller || this.stopping) { return; }
		const state = this.model.get();
		const message = state.messages.at(-1);
		this.stopping = Promise.resolve().then(async () => {
			try {
				if (state.conversationId && message?.role === 'assistant') {
					await this.replyBackend.stopReply(state.conversationId, message.id, AbortSignal.timeout(10_000));
					this.update({ stopped: true });
				} else { this.update({ uncertain: true, error: localize('sessions.chatgpt.stopUnconfirmed', 'The request was interrupted before ChatGPT confirmed this reply. Reload the conversation or check recent conversations before sending it again.') }); }
			} catch (error) { this.update({ uncertain: true, error: this.errorText(error) }); }
		});
		// Cancellation must reach preparation and verification before any remote stop I/O.
		// Otherwise finishing verification while stop is pending could still send the draft.
		controller.abort();
		try { await this.stopping; }
		finally { this.stopping = undefined; }
	}

	private readonly reloadHistory = () => this.reload();

	private setHistoryFailure(read: HistoryRead, failure: HistoryFailure | undefined): void {
		if (failure) {
			if (!this.model.get().networkAvailable) { return; }
			this.historyFailures.set(read, failure);
		} else {
			this.historyFailures.delete(read);
		}
		this.updateHistoryNotice();
	}

	public setHistoryNotificationsVisible(visible: boolean): void {
		if (this.historyNotificationsVisible === visible) return;
		this.historyNotificationsVisible = visible;
		this.updateHistoryNotice();
	}

	private updateHistoryNotice(): void {
		if (!this.historyNotificationsVisible) { this.closeHistoryNotice(); return; }
		const failures = [...this.historyFailures.values()];
		const notice = !this.model.get().networkAvailable ? 'offline'
			: failures.some(({ error }) => isChatGPTRateLimit(error)) ? 'limited'
				: failures.length ? 'failed' : undefined;
		if (this.historyNotice === notice) { return; }
		if (!notice) { this.closeHistoryNotice(); return; }
		this.historyNotice = notice;
		const message = notice === 'offline'
			? localize('sessions.chatgpt.historyOffline', 'ChatGPT is offline. Previously loaded chats are still available.')
			: notice === 'limited'
				? localize('sessions.chatgpt.historyRateLimited', 'ChatGPT is temporarily limiting history requests. Try again later.')
				: localize('sessions.chatgpt.historySyncFailed', 'Could not sync ChatGPT history. Previously loaded chats are still available.');
		const severity = notice === 'offline' ? Severity.Info : Severity.Warning;
		const actions: INotificationActions | undefined = notice === 'offline' ? undefined : {
			primary: [{
				id: 'sessions.chatgpt.retryHistory', label: localize('sessions.chatgpt.retryHistory', 'Retry'), tooltip: '', enabled: true, keepOpen: true,
				run: () => this.retryHistory(),
			}],
		};
		if (this.historyNotification) {
			this.historyNotification.updateMessage(message);
			this.historyNotification.updateSeverity(severity);
			this.historyNotification.updateActions(actions);
			return;
		}
		const handle = this.historyNotification = this.notifications.notify({ message, severity, actions });
		this.historyNoticeClose.value = handle.onDidClose(() => { this.historyNotification = undefined; });
	}

	private closeHistoryNotice(): void {
		this.historyNotice = undefined;
		this.historyNoticeClose.clear();
		this.historyNotification?.close();
		this.historyNotification = undefined;
	}

	private async retryHistory(): Promise<void> {
		if (this.isDisposed || this.retryingHistory || !this.model.get().networkAvailable) { return; }
		const account = this.management.signal;
		this.retryingHistory = true;
		try {
			for (const retry of new Set([...this.historyFailures.values()].map(failure => failure.retry))) {
				if (account.aborted || !this.model.get().networkAvailable) { break; }
				await retry();
			}
		} finally { this.retryingHistory = false; }
	}

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : localize('sessions.chatgpt.connectionFailed', 'Could not connect to ChatGPT.');
	}

}

export class ChatGPTNativeService extends ChatGPTService {
	constructor(
		@IChatGPTNativeTransport transport: IChatGPTTransport,
		@IStorageService storage: IStorageService,
		@ILifecycleService lifecycle: ILifecycleService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(transport, storage, lifecycle, notifications, instantiation);
	}
}
