import { shouldRunCowork } from '../../../browser/chatTaskRouting.js';
import { ChatTimelineStorage, type ChatTimeline, type ChatTimelineTask } from '../../../browser/chatTimelineStorage.js';
import { ChatCoworkTasks } from '../../cowork/browser/chatCoworkTasks.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { Thread } from '../../../../workbench/services/chat/common/chatService.js';
import { ChatReplyError } from '../../../common/chatReplyBackend.js';
import { ChatGPTReplyBackend } from './chatGPTReplyBackend.js';
import { ChatGPTOutbox, type PendingChatGPTCreation } from './chatGPTOutbox.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { getLxiconDefinition } from '../../../../base/common/lxiconsUtil.js';
import { observableFromEvent, observableValue, type IObservable } from '../../../../base/common/observable.js';
import { equals } from '../../../../base/common/objects.js';
import { isRecord } from '../../../../base/common/types.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChatGPTAuthenticationError, IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ChatGPTClient, ChatGPTRequestError, type ChatGPTConversation, type ChatGPTMessage, type ChatGPTModel, type ChatGPTFile, type ChatGPTProject, type ChatGPTHistory } from './chatGPTClient.js';
import { createChatGPTFetch } from './chatGPTFetch.js';
import { getChatGPTRichContentText } from '../../chat/browser/chatGPTRichContent.js';
import type { ChatGPTVoiceSession } from './chatGPTVoiceSession.js';

export const chatGPTNavigationContainerId = 'sessions.chatgpt.navigation';
const selectedConversationKey = 'sessions.chatgpt.conversation';
const catalogKey = 'sessions.chatgpt.catalog.v1';
const historyFreshnessMs = 60_000;
type HistoryValidation = Pick<ChatGPTHistory, 'parentId' | 'model' | 'thinkingEffort'> & { readonly validatedAt: number; };

function isMissingConversation(error: unknown): boolean {
	return error instanceof ChatGPTRequestError && (error.status === 404 || error.status === 410);
}

export interface ChatGPTAttachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly status: 'uploading' | 'ready' | 'failed';
	readonly file?: ChatGPTFile;
	readonly error?: string;
}
interface ChatGPTDraft {
	readonly text: string;
	readonly attachments: readonly ChatGPTAttachment[];
	readonly selection?: Pick<ChatGPTState, 'model' | 'modelPreset'>;
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
	readonly coworkTasks: readonly ChatCoworkTaskView[];
	readonly coworkStarting: boolean;
	readonly localConversationId: string;
	readonly draft: string;
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
	readonly hasMore: boolean;
	readonly models: readonly ChatGPTModel[];
	readonly model: string;
	readonly modelPreset?: string;
	/** Explicit model routing suppresses automatic Cowork for this unbound draft. */
	readonly explicitDraftModel?: boolean;
	readonly conversationId?: string;
	readonly title: string;
	readonly parentId: string;
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

export function pendingCreationStatus(state: ChatGPTState): string {
	if (state.pendingCreation === 'queued') {
		return localize('sessions.chatgpt.creationQueued', 'Saved on this device. Ash will send it when the connection is available.');
	}
	if (state.pendingCreation === 'submitted') {
		return localize('sessions.chatgpt.creationChecking', 'Waiting for ChatGPT to confirm this conversation.');
	}
	return '';
}

export function isCoworkSubmission(state: ChatGPTState): boolean {
	return !state.conversationId && !state.pendingCreation && !state.explicitDraftModel
		&& state.attachments.length === 0 && shouldRunCowork(state.draft);
}

export interface IChatGPTService {
	readonly state: IObservable<ChatGPTState>;
	readonly newDraftRevision: number;
	initialize(): void;
	refresh(): Promise<void>;
	setNetworkAvailable(available: boolean): void;
	reload(): Promise<void>;
	newChat(): void;
	listNewChatModels(signal: AbortSignal): Promise<readonly ChatGPTModel[]>;
	newChatWithModel(modelId: string, draftText?: string): Promise<void>;
	select(id: string): Promise<void>;
	loadMore(): Promise<void>;
	rename(id: string, title: string): Promise<void>;
	setPinned(id: string, pinned: boolean): Promise<void>;
	observeConversationIcon(id: string): IObservable<string | undefined> | undefined;
	setConversationIcon(id: string, iconId: string | undefined): void;
	archive(id: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	moveToProject(id: string, projectId: string): Promise<void>;
	share(id: string): Promise<string | undefined>;
	listProjects(signal: AbortSignal): Promise<readonly ChatGPTProject[]>;
	setDraft(value: string): void;
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

export class ChatGPTService extends Disposable implements IChatGPTService {
	private newConversationId = crypto.randomUUID();
	private readonly localIdsByRemoteId = new Map<string, string>();
	private readonly model = observableValue<ChatGPTState>('chatgpt', {
		coworkTasks: [], coworkStarting: false, localConversationId: this.newConversationId, draft: '', attachments: [], voice: 'idle', voiceTranscript: [], connected: false, busy: false, loading: undefined, sending: false, conversations: [], projects: [], hasMore: false,
		models: [], model: '', title: 'ChatGPT', parentId: crypto.randomUUID(), messages: [], error: '', uncertain: false, stopped: false, managing: false,
		networkAvailable: true, canQueue: false, pendingSync: false,
	});
	private readonly timeline: ChatTimelineStorage;
	private remoteTimeline: ChatTimelineStorage | undefined;
	private cacheScope: string | undefined;
	private readonly taskWatchers = this._register(new DisposableStore());
	private readonly taskLaunch = this._register(new DisposableStore());
	private readonly drafts = new Map<string, ChatGPTDraft>();
	private readonly attachmentFiles = new Map<string, File>();
	private readonly uploads = new Map<string, AbortController>();
	private voiceController: AbortController | undefined;
	private voiceMedia: ChatGPTVoiceSession | undefined;
	private voiceMessageId: string | undefined;
	private voiceCreatedConversation = false;
	private voiceStopping: Promise<void> | undefined;
	private operation: AbortController | undefined;
	private conversationRead: { readonly id: string; readonly generation: number; readonly promise: Promise<void>; } | undefined;
	// Disk snapshots can paint on startup. Only this window's successful reads
	// establish which continuation nodes are still fresh enough to reuse.
	private readonly historyValidations = new Map<string, HistoryValidation>();
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
	private readonly recentIds = new Set<string>();

	public readonly state: IObservable<ChatGPTState> = this.model;
	private draftRevision = 0;
	public get newDraftRevision(): number { return this.draftRevision; }
	private readonly client: ChatGPTClient;
	private readonly replyBackend: ChatGPTReplyBackend;
	constructor(@IChatGPTTransport private readonly transport: IChatGPTTransport, @IStorageService private readonly storage: IStorageService, @IInstantiationService private readonly instantiation?: IInstantiationService) {
		super();
		this.timeline = new ChatTimelineStorage(storage, 'chatgpt-web');
		this.update({ conversations: this.localConversations() });
		this.client = new ChatGPTClient(createChatGPTFetch(transport));
		this.replyBackend = new ChatGPTReplyBackend(this.client);
		this._register(toDisposable(() => {
			this.management.abort();
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
		this.management.abort(); this.management = new AbortController();
		void this.endVoice(false);
		for (const upload of this.uploads.values()) { upload.abort(); }
		this.uploads.clear(); this.attachmentFiles.clear(); this.drafts.clear();
		this.localIdsByRemoteId.clear();
		this.historyValidations.clear();
		this.taskLaunch.clear();
		this.taskWatchers.clear();
		this.newConversationId = crypto.randomUUID();
		this.drafts.set(this.newConversationId, { text: draft, attachments: [] });
		this.recentIds.clear(); this.recentOffset = 0;
		this.cacheScope = undefined;
		this.remoteTimeline = undefined;
		this.outbox = undefined;
		this.syncingOutbox = undefined;
		this.storage.remove(selectedConversationKey, StorageScope.PROFILE);
		// User-authored draft text stays local. Conversation IDs, files and history
		// belong to the retired account and cannot be reused with its successor.
		this.update({
			coworkTasks: [], coworkStarting: false, localConversationId: this.newConversationId, draft, attachments: [], connected: false, busy: false, sending: false, managing: false,
			loading: undefined, conversations: this.localConversations(), projects: [], models: [], model: '', modelPreset: undefined,
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
			this.refreshOperation?.abort();
			if (this.outbox && state.loading) {
				this.operation?.abort();
				this.generation++;
				this.update({ networkAvailable: false, busy: false, loading: undefined });
				return;
			}
		}
		this.update({ networkAvailable: available });
	}

	public async refresh(): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.networkAvailable || this.refreshOperation || this.syncingOutbox || state.busy || state.sending || state.managing || state.coworkStarting || state.voice !== 'idle') { return; }
		if (!state.connected) {
			if (this.cacheScope) { await this.loadCatalog(); await this.syncOutbox(); }
			return;
		}
		const controller = this.refreshOperation = new AbortController();
		try { await this.loadCatalog(controller); }
		finally { this.refreshOperation = undefined; }
		await this.syncOutbox();
	}
	public async listProjects(signal: AbortSignal): Promise<readonly ChatGPTProject[]> {
		this.refreshOperation?.abort();
		const request = AbortSignal.any([signal, this.management.signal, AbortSignal.timeout(30_000)]);
		const projects = await this.client.projects(request);
		request.throwIfAborted();
		const previous = this.model.get().projects;
		if (projects.length !== previous.length || projects.some((project, index) => project.id !== previous[index]?.id || project.title !== previous[index]?.title)) {
			this.updateCatalog({ projects });
		}
		return projects;
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

	public observeConversationIcon(id: string): IObservable<string | undefined> | undefined {
		const key = this.conversationIconKey(id);
		if (!key) { return undefined; }
		return observableFromEvent(this, listener => this.storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === key) { listener(event); }
		}),
			() => this.storage.get(key, StorageScope.PROFILE));
	}

	public setConversationIcon(id: string, iconId: string | undefined): void {
		const key = this.conversationIconKey(id);
		if (!key || !this.model.get().conversations.some(item => item.id === id) || (iconId !== undefined && !getLxiconDefinition(iconId))) { return; }
		this.storage.store(key, iconId, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private conversationIconKey(id: string): string | undefined {
		if (id.startsWith('local:')) { return `sessions.chatgpt.icon:${id}`; }
		if (!this.cacheScope || id.startsWith('pending:')) { return undefined; }
		return `sessions.chatgpt.icon:${this.cacheScope}:${id}`;
	}

	private forgetConversationIcon(id: string): void {
		const key = this.conversationIconKey(id);
		if (key) { this.storage.remove(key, StorageScope.PROFILE); }
	}

	public archive(id: string): Promise<void> { return this.removeConversation(id, false); }
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

	private async removeConversation(id: string, deleted: boolean): Promise<void> {
		if (id.startsWith('local:')) {
			const state = this.model.get();
			if (state.coworkStarting || state.sending || state.managing) return;
			const wasSelected = selectedChatConversationId(state) === id;
			if (deleted) {
				this.timeline.remove(id);
				this.forgetConversationIcon(id);
			} else this.updateLocalConversation(id, { archived: true });
			this.update({ conversations: this.model.get().conversations.filter(item => item.id !== id) });
			if (wasSelected) this.newChat();
			return;
		}
		const completed = await this.manage(id, async signal => {
			if (deleted) {
				try { await this.client.deleteConversation(id, signal); }
				catch (error) { if (!isMissingConversation(error)) { throw error; } }
			}
			else { await this.client.updateConversation(id, { is_archived: true }, signal); }
			signal.throwIfAborted();
			if (this.recentIds.delete(id)) { this.recentOffset = Math.max(0, this.recentOffset - 1); }
			this.updateCatalog({ conversations: this.model.get().conversations.filter(item => item.id !== id) });
			if (deleted) { this.forgetRemoteConversation(id); }
			return true;
		});
		if (completed && this.model.get().conversationId === id) { this.newChat(); }
	}

	private forgetRemoteConversation(id: string): void {
		const localId = this.localIdsByRemoteId.get(id);
		if (localId) {
			for (const attachment of this.drafts.get(localId)?.attachments ?? []) {
				this.uploads.get(attachment.id)?.abort();
				this.uploads.delete(attachment.id);
				this.attachmentFiles.delete(attachment.id);
			}
			this.drafts.delete(localId);
		}
		this.localIdsByRemoteId.delete(id);
		this.historyValidations.delete(id);
		this.forgetConversationIcon(id);
		this.remoteTimeline?.remove(id);
		this.timeline.remove(id);
	}

	public async moveToProject(id: string, projectId: string): Promise<void> {
		await this.manage(id, async signal => {
			await this.client.updateConversation(id, { gizmo_id: projectId }, signal);
			signal.throwIfAborted();
			this.updateCatalog({ conversations: this.model.get().conversations.map(item => item.id === id ? { ...item, projectId } : item) });
		});
	}

	public share(id: string): Promise<string | undefined> { return this.manage(id, signal => this.client.share(id, signal)); }

	/** Serialize writes independently of history reads; navigation must not abort a possibly accepted mutation. */
	private async manage<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.coworkStarting || state.managing || state.voice !== 'idle' || !state.conversations.some(item => item.id === id)) { return undefined; }
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
		await this.loadCatalog();
		await this.syncOutbox();
	}
	public setDraft(draft: string): void {
		const key = this.draftKey();
		this.drafts.set(key, { ...this.drafts.get(key), text: draft, attachments: this.model.get().attachments });
		this.update({ draft });
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
			this.drafts.set(this.newConversationId, { text: state.draft, attachments: state.attachments, selection });
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
					if (generation === this.generation) {
						this.bindConversation(history.id, this.draftKey());
						this.bindLocalTimeline(this.draftKey(), history.id);
						this.restoreHistory(history);
						this.rememberHistory(history);
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
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.managing || state.voice !== 'idle') { return; }
		if (state.attachments.length + files.length > 10 || files.some(file => !file.name.trim() || file.name.length > 1024 || file.size > 20 * 1024 * 1024)
			|| [...state.attachments, ...files].reduce((size, file) => size + file.size, 0) > 50 * 1024 * 1024) {
			this.update({ error: localize('sessions.chatgpt.attachmentLimit', 'Attach up to 10 files, with at most 20 MB per file and 50 MB in total.') });
			return;
		}
		const key = this.draftKey();
		const attachments = files.map(file => {
			const id = crypto.randomUUID();
			this.attachmentFiles.set(id, file);
			return { id, name: file.name, size: file.size, status: 'uploading' as const };
		});
		this.drafts.set(key, { ...this.drafts.get(key), text: state.draft, attachments: [...state.attachments, ...attachments] });
		this.update({ attachments: this.drafts.get(key)!.attachments, error: '' });
		await Promise.all(attachments.map(attachment => this.uploadAttachment(key, attachment.id)));
	}

	public removeAttachment(id: string): void {
		if (this.model.get().sending) { return; }
		this.uploads.get(id)?.abort(); this.uploads.delete(id); this.attachmentFiles.delete(id);
		const state = this.model.get();
		const attachments = state.attachments.filter(attachment => attachment.id !== id);
		this.drafts.set(state.localConversationId, { ...this.drafts.get(state.localConversationId), text: state.draft, attachments });
		this.update({ attachments });
	}

	public async retryAttachment(id: string): Promise<void> {
		if (this.model.get().sending || !this.model.get().attachments.some(attachment => attachment.id === id && attachment.status === 'failed')) { return; }
		await this.uploadAttachment(this.draftKey(), id);
	}

	private async uploadAttachment(key: string, id: string): Promise<void> {
		const source = this.attachmentFiles.get(id);
		if (!source || this.uploads.has(id)) { return; }
		const controller = new AbortController();
		this.uploads.set(id, controller);
		const update = (value: Partial<ChatGPTAttachment>): void => {
			const draft = this.drafts.get(key);
			if (this.isDisposed || controller.signal.aborted || !draft || !draft.attachments.some(attachment => attachment.id === id)) { return; }
			const attachments = draft.attachments.map(attachment => attachment.id === id ? { ...attachment, ...value } : attachment);
			this.drafts.set(key, { ...draft, attachments });
			if (key === this.draftKey()) { this.update({ attachments }); }
		};
		update({ status: 'uploading', error: undefined });
		try {
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
		const messages = state.messages.map(message => {
			if (message.activity) {
				const step = localize('sessions.chatgpt.activityAccessible', 'Execution step: {0}', message.activity.tool ?? localize('sessions.chatgpt.activityProgress', 'Progress'));
				return `${message.activity.failed ? localize('sessions.chatgpt.activityStepFailed', '{0} · Failed', step) : step}\n${message.text}`;
			}
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
		const { title, parentId, messages } = saved.history;
		this.bindConversation(remoteId, saved.localId);
		const draft = this.drafts.get(saved.localId);
		this.update({
			conversationId: remoteId, localConversationId: saved.localId,
			title: this.model.get().conversations.find(item => item.id === remoteId)?.title ?? title,
			parentId, messages, coworkTasks: saved.tasks,
			draft: draft?.text ?? '', attachments: draft?.attachments ?? [], uncertain: !validation, stopped: false,
			...(validation ? this.historyModel(validation) : {}),
		});
		this.rememberConversation(remoteId);
		this.watchCoworkTasks();
	}

	private persistHistory(history: ChatGPTHistory, tasks?: readonly ChatTimelineTask[]): void {
		const localId = this.localIdsByRemoteId.get(history.id);
		if (!localId) return;
		const { title, parentId, messages } = history;
		const timeline = this.timelineFor(history.id);
		timeline.write(history.id, { localId, tasks: tasks ?? timeline.read(history.id)?.tasks ?? [], history: { title, parentId, messages } });
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

	private async runCoworkTask(state: ChatGPTState): Promise<void> {
		const id = state.conversationId ?? `local:${state.localConversationId}`;
		const prompt = state.draft.trim();
		if (!this.instantiation) return;
		if (!state.conversationId && this.newConversationId === state.localConversationId) this.newConversationId = crypto.randomUUID();
		this.update({ coworkStarting: true, error: '' });
		const controller = new AbortController();
		const lifetime = this.taskLaunch.add(new DisposableStore());
		lifetime.add(toDisposable(() => controller.abort()));
		const storage = this.timelineFor(id);
		let task: ChatTimelineTask | undefined;
		try {
			const tasks = this.instantiation.createInstance(ChatCoworkTasks);
			const { sessionId, threadId, model } = await tasks.prepare(prompt, controller.signal, lifetime);
			if (controller.signal.aborted) return;
			task = { prompt, sessionId, threadId, afterMessageId: state.messages.at(-1)?.id };
			const timeline = storage.read(id) ?? { localId: state.localConversationId, tasks: [], title: prompt.slice(0, 80) };
			storage.write(id, { ...timeline, tasks: [...timeline.tasks, task] });
			if (!state.conversationId) {
				this.update({ conversations: this.withLocalConversations(this.model.get().conversations) });
				if (this.draftKey() === state.localConversationId) {
					this.rememberConversation(id);
					this.update({ title: timeline.title ?? state.title });
				}
			}
			await this.storage.flush();
			if (controller.signal.aborted) return;
			if (this.model.get().localConversationId === state.localConversationId) {
				const visible = this.model.get().coworkTasks;
				if (!visible.some(entry => entry.sessionId === sessionId && entry.threadId === threadId)) {
					this.update({ coworkTasks: [...visible, task] });
					this.watchCoworkTask(state.localConversationId, task);
				}
			}
			const recent = state.messages.filter(message => !message.activity).slice(-12)
				.map(message => `${message.role}: ${message.text.slice(0, 2000)}`).join('\n');
			await model.send(prompt, 'agent', undefined, recent ? [{ name: localize('sessions.chat.coworkContext', 'Conversation context'), content: recent }] : undefined, { signal: controller.signal });
			if (controller.signal.aborted) return;
			const retainedDraft = this.drafts.get(state.localConversationId);
			if (retainedDraft?.text === state.draft && !retainedDraft.attachments.length) {
				this.drafts.delete(state.localConversationId);
				if (this.draftKey() === state.localConversationId) this.update({ draft: '' });
			}
		} catch (error) {
			if (controller.signal.aborted) return;
			const message = this.errorText(error);
			const timeline = task && storage.read(id);
			if (task && timeline) {
				const failed = task;
				storage.write(id, { ...timeline, tasks: timeline.tasks.map(entry => entry.threadId === failed.threadId && entry.sessionId === failed.sessionId ? { ...entry, error: message } : entry) });
				this.updateCoworkTask(state.localConversationId, task, { error: message });
			} else if (this.draftKey() === state.localConversationId) {
				this.update({ error: message });
			}
		} finally {
			if (!controller.signal.aborted) this.update({ coworkStarting: false });
			this.taskLaunch.delete(lifetime);
			lifetime.dispose();
		}
	}

	private localConversations(): ChatGPTConversation[] {
		const pending = this.outbox?.creations().filter(entry => !entry.cancelled).map(entry => ({
			id: `pending:${entry.localId}`, title: entry.text.slice(0, 80), local: true,
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
		const draft = this.drafts.get(timeline.localId);
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
		const legacy = this.storage.get(selectedConversationKey, StorageScope.PROFILE);
		if (legacy?.startsWith('local:') || !this.cacheScope) { return legacy; }
		return this.storage.get(`${selectedConversationKey}:${this.cacheScope}`, StorageScope.PROFILE) ?? legacy;
	}

	private rememberConversation(id: string | undefined): void {
		if (this.cacheScope && !id?.startsWith('local:')) {
			this.storage.store(`${selectedConversationKey}:${this.cacheScope}`, id, StorageScope.PROFILE, StorageTarget.MACHINE);
			this.storage.remove(selectedConversationKey, StorageScope.PROFILE);
		} else {
			this.storage.store(selectedConversationKey, id, StorageScope.PROFILE, StorageTarget.MACHINE);
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
		if (entry.localId === this.newConversationId) { this.newConversationId = crypto.randomUUID(); }
		this.drafts.delete(entry.localId);
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
					if (!account.aborted && outbox.creation(entry.localId) === current) { this.completePendingCreation(current, history); }
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

	private completePendingCreation(entry: PendingChatGPTCreation, history: ChatGPTHistory): void {
		const outbox = this.outbox!;
		if (entry.cancelled) {
			outbox.deleteConversation(history.id, entry.localId);
			this.forgetRemoteConversation(history.id);
			return;
		}
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
		this.rememberHistory(history);
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
						this.completePendingCreation(entry, result.value);
						if (entry.cancelled) { hidden.add(id); }
						unverified?.clear();
						matched = true;
						break;
					}
					if (result.status === 'fulfilled') { unverified?.delete(id); }
				}
				if (matched) { break; }
			}
			for (const id of unverified ?? []) { hidden.add(id); }
		}
		return hidden;
	}

	private restoreCatalog(scope: string): void {
		this.historyValidations.clear();
		this.cacheScope = scope;
		this.remoteTimeline = new ChatTimelineStorage(this.storage, `chatgpt-web:${scope}`);
		this.outbox = new ChatGPTOutbox(this.storage, scope);
		this.update({ conversations: this.withLocalConversations([]) });
		const raw = this.storage.get(`${catalogKey}:${scope}`, StorageScope.PROFILE);
		if (!raw) { return; }
		let value: unknown;
		try { value = JSON.parse(raw); }
		catch { return; }
		if (!isRecord(value)) { return; }
		const conversations = Array.isArray(value.conversations) ? value.conversations.flatMap(item => {
			if (!isRecord(item) || typeof item.id !== 'string' || item.id.startsWith('local:') || typeof item.title !== 'string') { return []; }
			return [{ id: item.id, title: item.title, pinned: item.pinned === true, projectId: typeof item.projectId === 'string' ? item.projectId : undefined }];
		}) : [];
		const projects = Array.isArray(value.projects) ? value.projects.flatMap(item =>
			isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' ? [{ id: item.id, title: item.title }] : []) : [];
		this.update({ conversations: this.withLocalConversations(conversations), projects });
	}

	private updateCatalog(change: Partial<ChatGPTState>): void {
		this.update({ ...change, ...(change.conversations ? { conversations: this.withLocalConversations(change.conversations) } : {}) });
		if (this.cacheScope) {
			const { conversations, projects } = this.model.get();
			this.storage.store(`${catalogKey}:${this.cacheScope}`, JSON.stringify({
				conversations: conversations.filter(item => !item.local),
				projects,
			}), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}
	private update(change: Partial<ChatGPTState>): void {
		if (this.isDisposed) { return; }
		const next = { ...this.model.get(), ...change };
		const creation = !next.conversationId ? this.outbox?.creation(next.localConversationId) : undefined;
		this.model.set({
			...next, canQueue: !!this.outbox, pendingSync: this.outbox?.hasPending() === true,
			pendingCreation: creation && !creation.cancelled ? creation.submittedAgainst ? 'submitted' : 'queued' : undefined,
			explicitDraftModel: !next.conversationId && !!this.drafts.get(next.localConversationId)?.selection,
		});
	}
	private draftKey(): string { return this.model.get().localConversationId; }

	/** The first accepted reply binds a remote conversation to the existing local draft. */
	private bindConversation(remoteId: string, localId: string): void {
		this.localIdsByRemoteId.set(remoteId, localId);
		if (localId === this.newConversationId) { this.newConversationId = crypto.randomUUID(); }
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
		const localIconKey = this.conversationIconKey(localKey)!;
		const remoteIconKey = this.conversationIconKey(remoteId);
		const localIcon = this.storage.get(localIconKey, StorageScope.PROFILE);
		if (remoteIconKey && localIcon) {
			if (!this.storage.get(remoteIconKey, StorageScope.PROFILE)) {
				this.storage.store(remoteIconKey, localIcon, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			this.storage.remove(localIconKey, StorageScope.PROFILE);
		}
		this.timeline.remove(localKey);
		this.update({ conversations: this.model.get().conversations.filter(item => item.id !== localKey) });
		this.rememberHistory({ id: remoteId, title: local.title ?? this.model.get().title });
	}

	private cancelReads(): void {
		this.refreshOperation?.abort();
		this.operation?.abort();
		this.generation++;
	}

	private beginOperation(): { signal: AbortSignal; generation: number; } {
		this.cancelReads();
		this.operation = new AbortController();
		return { signal: AbortSignal.any([this.operation.signal, AbortSignal.timeout(30_000)]), generation: this.generation };
	}

	private async loadCatalog(background?: AbortController): Promise<void> {
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
			if (!this.model.get().networkAvailable) {
				if (!background) { this.update({ busy: false, loading: undefined }); }
				return;
			}
			const [catalog, [projects, pins, conversations]] = await Promise.all([
				!background && (!this.model.get().connected || !this.model.get().conversationId) ? this.client.models(signal) : undefined,
				Promise.allSettled([this.client.projects(signal), this.client.pinnedConversations(signal), this.readLoadedRecentPages(signal)]),
			]);
			if (generation !== this.generation || background?.signal.aborted) { return; }
			// Recent history is auxiliary to restoring a known conversation and its
			// continuation. Its rate limit must not disable an otherwise usable chat.
			const items = new Map((conversations.status === 'fulfilled' ? conversations.value.items : this.model.get().conversations.filter(item => !item.local)).map(item => [item.id, item]));
			if (pins.status === 'fulfilled') {
				if (conversations.status === 'rejected') {
					for (const item of items.values()) {
						if (!item.local && item.pinned) { items.set(item.id, { ...item, pinned: false }); }
					}
				}
				for (const item of pins.value) { items.set(item.id, { ...item, projectId: item.projectId ?? items.get(item.id)?.projectId }); }
			}
			const hidden = await this.reconcilePendingCreations(items, signal);
			if (generation !== this.generation || background?.signal.aborted) { return; }
			for (const id of items.keys()) {
				if (hidden.has(id) || this.outbox?.isDeleted(id)) { items.delete(id); }
			}
			const before = this.model.get();
			const missing = conversations.status === 'fulfilled' ? before.conversations.filter(item => !item.local && !items.has(item.id) && !hidden.has(item.id)) : [];
			const retained = this.retainedConversation() ?? before.conversationId;
			const histories = new Map<string, PromiseSettledResult<ChatGPTHistory>>();
			const ids = missing.filter(item => item.id !== retained && (pins.status === 'fulfilled' || !item.pinned)).map(item => item.id);
			if (retained && !retained.startsWith('local:') && !retained.startsWith('pending:') && !this.outbox?.isDeleted(retained) && retained.length < 1024) { ids.unshift(retained); }
			// Offset pagination can shift as other devices write. Verify omitted
			// rows directly, in bounded batches, before treating them as deleted.
			for (let offset = 0; offset < ids.length && !signal.aborted; offset += 4) {
				const batch = ids.slice(offset, offset + 4);
				const results = await Promise.allSettled(batch.map(id => this.client.history(id, signal)));
				for (const [index, id] of batch.entries()) { histories.set(id, results[index]!); }
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
					items.set(item.id, { ...item, title, pinned: pins.status === 'rejected' && item.pinned === true });
				}
			}
			const history = retained ? histories.get(retained) : undefined;
			if (retained && !deleted.has(retained) && !items.has(retained) && conversations.status === 'fulfilled' && pins.status === 'fulfilled'
				&& history?.status === 'rejected' && isMissingConversation(history.reason)) {
				this.forgetRemoteConversation(retained);
				deleted.add(retained);
			}
			if (conversations.status === 'fulfilled') { this.resetRecentPage(conversations.value); }
			const listError = conversations.status === 'rejected' ? localize('sessions.chatgpt.historyListFailed', 'Could not refresh the conversation list. You can continue the current chat. {0}', this.errorText(conversations.reason)) : '';
			const state = this.model.get();
			const explicitDraft = state.explicitDraftModel;
			const selected = catalog?.models.find(model => model.id === state.model)
				?? (explicitDraft ? undefined : catalog?.models.find(model => model.id === catalog.defaultModel));
			const modelError = catalog && explicitDraft && !selected ? localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.') : '';
			this.updateCatalog({
				connected: true, busy: false, loading: undefined,
				...(catalog ? { models: catalog.models } : {}),
				...(selected ? { model: selected.id, modelPreset: this.resolveModelPreset(selected, state.modelPreset) } : {}),
				conversations: this.withLocalConversations([...items.values()]), hasMore: conversations.status === 'fulfilled' ? conversations.value.hasMore : state.hasMore,
				projects: projects.status === 'fulfilled' ? projects.value : state.projects,
				...(!background ? { error: [...[projects, pins].filter(result => result.status === 'rejected').map(result => this.errorText(result.reason)), listError, modelError].filter(Boolean).join('\n') } : {}),
			});
			const requested = this.retainedConversation();
			if (!background && requested && requested !== retained && !requested.startsWith('local:')) {
				await this.select(requested);
				return;
			}
			if (retained && deleted.has(retained)) {
				if (state.conversationId === retained) {
					this.newChat();
					if (state.draft && !this.model.get().draft) { this.setDraft(state.draft); }
				} else { this.rememberConversation(undefined); }
				return;
			}
			if (history?.status === 'fulfilled') {
				const value = history.value;
				if (!background || state.uncertain || state.parentId !== value.parentId || state.title !== value.title || !equals(state.messages, value.messages)) {
					this.restoreHistory(value, !!background);
					this.rememberConversation(value.id);
				} else {
					this.markHistoryValidated(value);
				}
				if (listError && !items.has(value.id) && !value.archived) { this.rememberHistory(value); }
			} else if (history?.status === 'rejected' && !background) {
				this.update({ error: this.errorText(history.reason) });
			}
		} catch (error) {
			if (generation === this.generation && !background) {
				const authenticationFailed = error instanceof ChatGPTAuthenticationError || (error instanceof ChatGPTRequestError && error.status === 401);
				this.update({ busy: false, loading: undefined, error: this.errorText(error), ...(authenticationFailed ? { connected: false } : {}) });
			}
		}
	}

	private async readLoadedRecentPages(signal: AbortSignal): ReturnType<ChatGPTClient['conversations']> {
		const depth = Math.max(this.recentOffset, this.model.get().conversations.filter(item => !item.local && !item.pinned).length);
		let page = await this.client.conversations(0, signal);
		const items = [...page.items];
		while (page.hasMore && page.nextOffset < depth) {
			try { page = await this.client.conversations(page.nextOffset, signal); }
			catch { break; }
			items.push(...page.items);
		}
		return { ...page, items };
	}

	private resetRecentPage(page: { items: readonly ChatGPTConversation[]; nextOffset: number; }): void {
		this.recentOffset = page.nextOffset;
		this.recentIds.clear();
		for (const item of page.items) { this.recentIds.add(item.id); }
	}

	public newChat(): void {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing || this.voiceStopping) { return; }
		if (this.voiceController) { void this.endVoice(true).then(() => this.newChat()); return; }
		this.openNewChat();
	}

	public async listNewChatModels(signal: AbortSignal): Promise<readonly ChatGPTModel[]> {
		const request = AbortSignal.any([signal, this.management.signal, AbortSignal.timeout(15_000)]);
		request.throwIfAborted();
		const state = this.model.get();
		if (state.connected && state.models.length) return state.models;
		const catalog = await this.client.models(request);
		request.throwIfAborted();
		return catalog.models;
	}

	public async newChatWithModel(modelId: string, draftText?: string): Promise<void> {
		const account = this.management.signal;
		const models = await this.listNewChatModels(account);
		account.throwIfAborted();
		const model = models.find(candidate => candidate.id === modelId);
		if (!model) throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
		const state = this.model.get();
		if (this.isDisposed || state.sending || state.managing || state.coworkStarting || state.voice !== 'idle') {
			throw new Error(localize('sessions.newChatModel.chatGPTBusy', 'Finish the current ChatGPT operation before opening a new ChatGPT chat.'));
		}
		const draft = this.drafts.get(this.newConversationId);
		if (draftText?.trim() && ((draft?.text && draft.text !== draftText) || draft?.attachments.length)) {
			throw new Error(localize('sessions.newChatModel.chatGPTDraftConflict', 'The new ChatGPT chat already has a draft. Open it before copying text from another service.'));
		}
		this.drafts.set(this.newConversationId, {
			text: draftText?.trim() ? draftText : draft?.text ?? '', attachments: draft?.attachments ?? [],
			selection: { model: model.id, modelPreset: model.defaultPreset },
		});
		this.openNewChat(models);
	}

	private openNewChat(models = this.model.get().models): void {
		this.operation?.abort();
		this.refreshOperation?.abort();
		this.generation++;
		this.draftRevision++;
		this.taskWatchers.clear();
		const draft = this.drafts.get(this.newConversationId);
		const selected = models.find(model => model.id === draft?.selection?.model);
		const selection = selected ? { model: selected.id, modelPreset: this.resolveModelPreset(selected, draft?.selection?.modelPreset) } : draft?.selection;
		this.update({ coworkTasks: [], localConversationId: this.newConversationId, draft: draft?.text ?? '', attachments: draft?.attachments ?? [], conversationId: undefined, title: 'ChatGPT', messages: [], parentId: crypto.randomUUID(), error: '', busy: false, loading: undefined, uncertain: false, stopped: false, models, ...selection });
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
		} catch (error) {
			if (generation === this.generation) {
				this.update({
					busy: false,
					loading: undefined,
					error: this.errorText(error)
				});
			}
		}
	}

	private restoreHistory(history: ChatGPTHistory, preserveModel = false, preserveLoading = false): void {
		const state = this.model.get();
		const timeline = this.timelineFor(history.id);
		const scoped = timeline.read(history.id);
		// The successful history read authorizes migration of legacy task references.
		const legacy = !scoped && timeline !== this.timeline ? this.timeline.read(history.id) : undefined;
		const saved = scoped ?? legacy;
		const localId = this.localIdsByRemoteId.get(history.id) ?? saved?.localId ?? crypto.randomUUID();
		const sameConversation = state.localConversationId === localId && (state.conversationId === history.id || !state.conversationId);
		this.bindConversation(history.id, localId);
		this.persistHistory(history, saved?.tasks);
		this.markHistoryValidated(history);
		if (legacy) { this.timeline.remove(history.id); }
		this.update({
			coworkTasks: sameConversation ? state.coworkTasks : saved?.tasks ?? [], localConversationId: localId, draft: this.drafts.get(localId)?.text ?? '', attachments: this.drafts.get(localId)?.attachments ?? [], conversationId: history.id, title: history.title, messages: history.messages, parentId: history.parentId,
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
	private rememberHistory(history: Pick<ChatGPTHistory, 'id' | 'title'>): void {
		if (this.outbox?.isDeleted(history.id)) { return; }
		const state = this.model.get();
		const previous = state.conversations.find(item => item.id === history.id);
		if (!this.recentIds.has(history.id)) { this.recentIds.add(history.id); this.recentOffset++; }
		this.updateCatalog({ conversations: [{ ...previous, id: history.id, title: history.title }, ...state.conversations.filter(item => item.id !== history.id)] });
	}

	public async loadMore(): Promise<void> {
		if (!this.model.get().connected || this.model.get().busy || this.model.get().sending || this.model.get().managing || !this.model.get().hasMore) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, loading: { kind: 'history' }, error: '' });
		try {
			const state = this.model.get();
			const result = await this.client.conversations(this.recentOffset, signal);
			if (generation !== this.generation) { return; }
			const items = new Map(state.conversations.filter(item => !item.local).map(item => [item.id, item]));
			for (const item of result.items) {
				const previous = items.get(item.id);
				items.set(item.id, { ...item, pinned: item.pinned || previous?.pinned === true });
			}
			const hidden = await this.reconcilePendingCreations(items, signal);
			if (generation !== this.generation) { return; }
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
				hasMore: result.hasMore, busy: false, loading: undefined,
			});
		} catch (error) {
			if (generation === this.generation) {
				this.update({
					busy: false,
					loading: undefined,
					error: this.errorText(error)
				});
			}
		}
	}

	public async send(): Promise<void> {
		const state = this.model.get();
		const text = state.draft.trim();
		if (this.isDisposed || state.pendingCreation || state.coworkStarting || state.busy || state.sending || state.managing || state.voice !== 'idle') return;
		this.refreshOperation?.abort();
		if (this.instantiation && isCoworkSubmission(state)) {
			await this.runCoworkTask(state);
			return;
		}
		const preset = state.models.find(model => model.id === state.model)?.presets.find(preset => preset.id === state.modelPreset);
		const creation = canQueueChatGPTCreation(state) ? {
			localId: state.localConversationId, text, messageId: crypto.randomUUID(), parentId: state.parentId,
			model: preset?.model, thinkingEffort: preset?.thinkingEffort,
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
		this.update({ sending: true, stopped: false, error: '', messages: [...state.messages, { id: messageId, role: 'user', text, resources: files.map(file => ({ uri: `file-service://${file.id}`, name: file.name, kind: file.mimeType.startsWith('image/') ? 'image' : 'document', mimeType: file.mimeType })) }] });
		try {
			for await (const event of this.replyBackend.streamReply({ text, model: preset.model, thinkingEffort: preset.thinkingEffort, parentId: state.parentId, conversationId: state.conversationId, messageId, files }, controller.signal, async () => { submitted = true; })) {
				if (this.isDisposed || this.stream !== controller) { return; }
				if (!acknowledged) {
					acknowledged = true;
					this.drafts.delete(draftKey);
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
			}
			this.drafts.delete(draftKey);
			this.update({ draft: '', attachments: [] });
			const current = this.model.get();
			const currentId = current.conversationId;
			if (currentId && !controller.signal.aborted && this.stream === controller) {
				this.persistHistory({ id: currentId, title: current.title, parentId: current.parentId, messages: current.messages });
				if (!current.conversations.some(item => item.id === currentId)) {
					this.rememberHistory({ id: currentId, title: current.title });
				}
				try {
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
					const history = await this.client.history(currentId, signal);
					if (this.stream !== controller || controller.signal.aborted) { return; }
					this.persistHistory(history);
					this.markHistoryValidated(history);
					this.update({ title: history.title, parentId: history.parentId, messages: history.messages });
					this.rememberHistory(history);
				} catch (error) { if (!controller.signal.aborted) { this.update({ error: this.errorText(error) }); } }
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
			if (this.stream === controller) { this.stream = undefined; this.update({ sending: false }); }
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

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : localize('sessions.chatgpt.connectionFailed', 'Could not connect to ChatGPT.');
	}

}
