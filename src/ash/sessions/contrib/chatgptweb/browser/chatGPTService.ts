import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ChatGPTClient, ChatGPTRequestError, type ChatGPTConversation, type ChatGPTMessage, type ChatGPTModel, type ChatGPTFile, type ChatGPTProject, type ChatGPTHistory } from './chatGPTClient.js';
import { createChatGPTFetch } from './chatGPTFetch.js';
import { getChatGPTRichContentText } from './chatGPTRichContent.js';
import type { ChatGPTVoiceSession } from './chatGPTVoiceSession.js';

export const chatGPTNavigationContainerId = 'sessions.chatgpt.navigation';

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
}

export interface ChatGPTState {
	readonly draft: string;
	readonly attachments: readonly ChatGPTAttachment[];
	readonly voice: 'idle' | 'connecting' | 'connected' | 'stopping';
	readonly voiceTranscript: readonly {
		readonly id: string;
		readonly text: string;
		readonly role: 'user' | 'assistant';
	}[];
	readonly connected: boolean;
	readonly busy: boolean;
	/** Distinguishes content reads from sending, uploads and voice operations. */
	readonly loading?: { readonly kind: 'history' } | { readonly kind: 'conversation'; readonly id: string };
	readonly sending: boolean;
	readonly conversations: readonly ChatGPTConversation[];
	readonly projects: readonly ChatGPTProject[];
	readonly hasMore: boolean;
	readonly models: readonly ChatGPTModel[];
	readonly model: string;
	readonly modelPreset?: string;
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
export interface IChatGPTService {
	readonly state: IObservable<ChatGPTState>;
	initialize(): void;
	reload(): Promise<void>;
	newChat(): void;
	select(id: string): Promise<void>;
	loadMore(): Promise<void>;
	rename(id: string, title: string): Promise<void>;
	setPinned(id: string, pinned: boolean): Promise<void>;
	archive(id: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	moveToProject(id: string, projectId: string): Promise<void>;
	share(id: string): Promise<string | undefined>;
	listProjects(signal: AbortSignal): Promise<readonly ChatGPTProject[]>;
	setDraft(value: string): void;
	setModel(value: string): void;
	setModelPreset(value: string): void;
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
	private readonly model = observableValue<ChatGPTState>('chatgpt', {
		draft: '',
		attachments: [],
		voice: 'idle',
		voiceTranscript: [],
		connected: false,
		busy: false,
		loading: undefined,
		sending: false,
		conversations: [],
		projects: [],
		hasMore: false,
		models: [],
		model: '',
		title: 'ChatGPT',
		parentId: crypto.randomUUID(),
		messages: [],
		error: '',
		uncertain: false,
		stopped: false,
		managing: false,
	});
	private readonly drafts = new Map<string, ChatGPTDraft>();
	private readonly attachmentFiles = new Map<string, File>();
	private readonly uploads = new Map<string, AbortController>();
	private voiceController: AbortController | undefined;
	private voiceMedia: ChatGPTVoiceSession | undefined;
	private voiceMessageId: string | undefined;
	private voiceCreatedConversation = false;
	private voiceStopping: Promise<void> | undefined;
	private operation: AbortController | undefined;
	private stream: AbortController | undefined;
	private stopping: Promise<void> | undefined;
	private generation = 0;
	private readonly management = new AbortController();
	// Auxiliary pin results do not advance the recent-history pagination offset.
	private recentOffset = 0;
	private readonly recentIds = new Set<string>();

	public readonly state: IObservable<ChatGPTState> = this.model;
	private readonly client: ChatGPTClient;
	private initialized = false;
	constructor(
		@IChatGPTTransport transport: IChatGPTTransport,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.client = new ChatGPTClient(createChatGPTFetch(transport));
		this._register(
			toDisposable(() => {
				this.management.abort();
				void this.endVoice(false);
				this.generation++;
				this.operation?.abort();
				this.stream?.abort();
				this.drafts.clear();
				for (const upload of this.uploads.values()) {
					upload.abort();
				}
				this.uploads.clear();
				this.attachmentFiles.clear();
			}),
		);
	}
	public initialize(): void {
		if (!this.initialized) {
			this.initialized = true;
			void this.loadCatalog();
		}
	}
	public async listProjects(signal: AbortSignal): Promise<readonly ChatGPTProject[]> {
		const projects = await this.client.projects(AbortSignal.any([signal, this.management.signal, AbortSignal.timeout(30_000)]));
		const previous = this.model.get().projects;
		if (projects.length !== previous.length || projects.some((project, index) => project.id !== previous[index]?.id || project.title !== previous[index]?.title)) {
			this.update({ projects });
		}
		return projects;
	}

	public async rename(id: string, title: string): Promise<void> {
		const normalized = title.trim();
		if (!normalized || normalized.length > 256) {
			return;
		}
		await this.manage(id, async signal => {
			await this.client.rename(id, normalized, signal);
			this.update({
				conversations: this.model.get().conversations.map(item => (item.id === id ? { ...item, title: normalized } : item)),
				...(this.model.get().conversationId === id ? { title: normalized } : {}),
			});
		});
	}

	public async setPinned(id: string, pinned: boolean): Promise<void> {
		await this.manage(id, async signal => {
			await this.client.updateConversation(id, { is_starred: pinned }, signal);
			this.update({
				conversations: this.model.get().conversations.map(item => (item.id === id ? { ...item, pinned } : item)),
			});
		});
	}

	public archive(id: string): Promise<void> {
		return this.removeConversation(id, false);
	}
	public deleteConversation(id: string): Promise<void> {
		return this.removeConversation(id, true);
	}

	private async removeConversation(id: string, deleted: boolean): Promise<void> {
		const completed = await this.manage(id, async signal => {
			if (deleted) {
				await this.client.deleteConversation(id, signal);
			} else {
				await this.client.updateConversation(id, { is_archived: true }, signal);
			}
			if (this.recentIds.delete(id)) {
				this.recentOffset = Math.max(0, this.recentOffset - 1);
			}
			this.update({ conversations: this.model.get().conversations.filter(item => item.id !== id) });
			if (deleted) {
				for (const attachment of this.drafts.get(id)?.attachments ?? []) {
					this.uploads.get(attachment.id)?.abort();
					this.uploads.delete(attachment.id);
					this.attachmentFiles.delete(attachment.id);
				}
				this.drafts.delete(id);
			}
			return true;
		});
		if (completed && this.model.get().conversationId === id) {
			this.newChat();
		}
	}

	public async moveToProject(id: string, projectId: string): Promise<void> {
		await this.manage(id, async signal => {
			await this.client.updateConversation(id, { gizmo_id: projectId }, signal);
			this.update({
				conversations: this.model.get().conversations.map(item => (item.id === id ? { ...item, projectId } : item)),
			});
		});
	}

	public share(id: string): Promise<string | undefined> {
		return this.manage(id, signal => this.client.share(id, signal));
	}

	/** Serialize writes independently of history reads; navigation must not abort a possibly accepted mutation. */
	private async manage<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.managing || state.voice !== 'idle' || !state.conversations.some(item => item.id === id)) {
			return undefined;
		}
		this.update({ managing: true, error: '' });
		try {
			return await operation(AbortSignal.any([this.management.signal, AbortSignal.timeout(30_000)]));
		} catch (error) {
			this.update({ error: this.errorText(error) });
			return undefined;
		} finally {
			this.update({ managing: false });
		}
	}

	public async reload(): Promise<void> {
		if (this.model.get().busy || this.model.get().sending || this.model.get().managing) {
			return;
		}
		if (this.voiceController) {
			await this.endVoice(true);
			return;
		}
		const id = this.model.get().conversationId;
		if (this.model.get().connected && id) {
			await this.select(id);
		} else {
			await this.loadCatalog();
		}
	}
	public setDraft(draft: string): void {
		this.drafts.set(this.draftKey(), { text: draft, attachments: this.model.get().attachments });
		this.update({ draft });
	}
	public setModel(model: string): void {
		const state = this.model.get();
		const selected = state.models.find(entry => entry.id === model);
		if (!selected || state.busy || state.sending || state.voice !== 'idle') {
			return;
		}
		this.update({ model, modelPreset: this.resolveModelPreset(selected, state.modelPreset) });
	}
	public setModelPreset(modelPreset: string): void {
		const state = this.model.get();
		const selected = state.models.find(entry => entry.id === state.model);
		if (state.busy || state.sending || state.voice !== 'idle' || !selected?.presets.some(preset => preset.id === modelPreset)) {
			return;
		}
		this.update({ modelPreset });
	}

	private resolveModelPreset(model: ChatGPTModel | undefined, preferred: string | undefined): string | undefined {
		return model?.presets.find(preset => preset.id === preferred)?.id ?? model?.defaultPreset;
	}

	public async startVoice(window: Window & typeof globalThis): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.uncertain || state.voice !== 'idle' || state.draft.trim() || state.attachments.length) {
			return;
		}
		if (!window.navigator.userActivation?.isActive) {
			return;
		}
		const controller = new AbortController();
		this.voiceController = controller;
		this.voiceMessageId = undefined;
		this.voiceCreatedConversation = !state.conversationId;
		this.update({ voice: 'connecting', voiceTranscript: [], error: '' });
		try {
			const { ChatGPTVoiceSession } = await import('./chatGPTVoiceSession.js');
			if (controller.signal.aborted || this.voiceController !== controller) {
				return;
			}
			const media = (this.voiceMedia = new ChatGPTVoiceSession(
				window,
				update => {
					if (this.voiceController !== controller || controller.signal.aborted) {
						return;
					}
					if (update.conversationId && update.conversationId !== this.model.get().conversationId) {
						this.update({ conversationId: update.conversationId });
						this.rememberConversation(update.conversationId);
					}
					if (update.parentId) {
						this.voiceMessageId = update.parentId;
					}
					const message = update.message;
					if (message?.text.trim() && !message.activity) {
						this.voiceMessageId = message.id;
						const transcript = this.model.get().voiceTranscript;
						const item = { id: message.id, text: message.text.slice(0, 65536), role: message.role };
						this.update({
							voiceTranscript: (transcript.some(previous => previous.id === item.id)
								? transcript.map(previous => (previous.id === item.id ? item : previous))
								: [...transcript, item]
							).slice(-64),
						});
					}
				},
				error => {
					if (this.voiceController !== controller) {
						return;
					}
					// Even a failed room may have committed turns; reload its continuation node.
					void this.endVoice(true);
					if (error !== undefined) {
						this.update({ error: this.errorText(error) });
					}
				},
			));
			media.unlockAudio();
			await media.connect(
				(sdp, signal) =>
					this.client.voice(
						{
							sdp,
							conversationId: state.conversationId,
							parentId: state.parentId,
							language: getNLSLanguage(),
						},
						signal,
					),
				controller.signal,
			);
			if (this.voiceController === controller && !controller.signal.aborted) {
				this.update({ voice: 'connected' });
			}
		} catch (error) {
			if (this.voiceController === controller && !controller.signal.aborted) {
				await this.endVoice(!!this.voiceMessageId);
				this.update({ error: this.errorText(error) });
			}
		}
	}

	public stopVoice(): Promise<void> {
		return this.endVoice(true);
	}

	private async endVoice(refresh: boolean): Promise<void> {
		if (this.voiceStopping) {
			return this.voiceStopping;
		}
		const controller = this.voiceController;
		if (!controller) {
			return;
		}
		this.voiceController = undefined;
		controller.abort();
		this.voiceMedia?.dispose();
		this.voiceMedia = undefined;
		const id = this.model.get().conversationId;
		const messageId = this.voiceMessageId;
		if (!refresh || this.isDisposed) {
			this.update({ voice: 'idle', voiceTranscript: [] });
			return;
		}
		if (!messageId && this.voiceCreatedConversation) {
			this.update({ voice: 'idle', voiceTranscript: [], conversationId: undefined });
			this.rememberConversation(undefined);
			return;
		}
		const { signal, generation } = this.beginOperation();
		this.update({ voice: 'stopping', busy: true });
		this.voiceStopping = (async () => {
			try {
				if (id) {
					const history = await this.client.voiceHistory(id, messageId, signal);
					if (generation === this.generation) {
						this.restoreHistory(history);
						this.rememberHistory(history);
					}
				}
			} catch (error) {
				if (generation === this.generation) {
					this.update({ error: this.errorText(error), uncertain: !!messageId });
				}
			} finally {
				if (generation === this.generation) {
					this.update({ voice: 'idle', busy: false, loading: undefined, voiceTranscript: [] });
				}
			}
		})();
		try {
			await this.voiceStopping;
		} finally {
			this.voiceStopping = undefined;
		}
	}

	public async attachFiles(files: readonly File[]): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.managing || state.voice !== 'idle') {
			return;
		}
		if (
			state.attachments.length + files.length > 10 ||
			files.some(file => !file.name.trim() || file.name.length > 1024 || file.size > 20 * 1024 * 1024) ||
			[...state.attachments, ...files].reduce((size, file) => size + file.size, 0) > 50 * 1024 * 1024
		) {
			this.update({
				error: localize('sessions.chatgpt.attachmentLimit', 'Attach up to 10 files, with at most 20 MB per file and 50 MB in total.'),
			});
			return;
		}
		const key = this.draftKey();
		const attachments = files.map(file => {
			const id = crypto.randomUUID();
			this.attachmentFiles.set(id, file);
			return { id, name: file.name, size: file.size, status: 'uploading' as const };
		});
		this.drafts.set(key, { text: state.draft, attachments: [...state.attachments, ...attachments] });
		this.update({ attachments: this.drafts.get(key)!.attachments, error: '' });
		await Promise.all(attachments.map(attachment => this.uploadAttachment(key, attachment.id)));
	}

	public removeAttachment(id: string): void {
		if (this.model.get().sending) {
			return;
		}
		this.uploads.get(id)?.abort();
		this.uploads.delete(id);
		this.attachmentFiles.delete(id);
		const state = this.model.get();
		const attachments = state.attachments.filter(attachment => attachment.id !== id);
		this.drafts.set(this.draftKey(), { text: state.draft, attachments });
		this.update({ attachments });
	}

	public async retryAttachment(id: string): Promise<void> {
		if (this.model.get().sending || !this.model.get().attachments.some(attachment => attachment.id === id && attachment.status === 'failed')) {
			return;
		}
		await this.uploadAttachment(this.draftKey(), id);
	}

	private async uploadAttachment(key: string, id: string): Promise<void> {
		const source = this.attachmentFiles.get(id);
		if (!source || this.uploads.has(id)) {
			return;
		}
		const controller = new AbortController();
		this.uploads.set(id, controller);
		const update = (value: Partial<ChatGPTAttachment>): void => {
			const draft = this.drafts.get(key);
			if (this.isDisposed || controller.signal.aborted || !draft || !draft.attachments.some(attachment => attachment.id === id)) {
				return;
			}
			const attachments = draft.attachments.map(attachment => (attachment.id === id ? { ...attachment, ...value } : attachment));
			this.drafts.set(key, { ...draft, attachments });
			if (key === this.draftKey()) {
				this.update({ attachments });
			}
		};
		update({ status: 'uploading', error: undefined });
		try {
			const file = await this.client.upload(source, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
			update({ status: 'ready', file });
			this.attachmentFiles.delete(id);
		} catch (error) {
			update({ status: 'failed', error: this.errorText(error) });
		} finally {
			if (this.uploads.get(id) === controller) {
				this.uploads.delete(id);
			}
		}
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
		return [state.title, ...messages, ...state.voiceTranscript.map(item => `${item.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'}: ${item.text}`), state.error]
			.filter(Boolean)
			.join('\n\n');
	}
	private rememberConversation(id: string | undefined): void {
		if (id) {
			this.storage.store('sessions.chatgpt.conversation', id, StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storage.remove('sessions.chatgpt.conversation', StorageScope.PROFILE);
		}
	}
	private update(change: Partial<ChatGPTState>): void {
		if (!this.isDisposed) {
			this.model.set({ ...this.model.get(), ...change });
		}
	}
	private draftKey(): string {
		return this.model.get().conversationId ?? 'new';
	}
	private beginOperation(): { signal: AbortSignal; generation: number } {
		this.operation?.abort();
		this.operation = new AbortController();
		return {
			signal: AbortSignal.any([this.operation.signal, AbortSignal.timeout(30_000)]),
			generation: ++this.generation,
		};
	}

	private async loadCatalog(): Promise<void> {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing) {
			return;
		}
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, loading: { kind: 'history' }, error: '' });
		try {
			const [catalog, groups] = await Promise.all([
				this.client.models(signal),
				Promise.allSettled([this.client.projects(signal), this.client.pinnedConversations(signal), this.client.conversations(0, signal)]),
			]);
			if (generation !== this.generation) {
				return;
			}
			const [projects, pins, conversations] = groups;
			const state = this.model.get();
			if (conversations.status === 'fulfilled') {
				this.resetRecentPage(conversations.value);
			}
			// Recent history is auxiliary to restoring a known conversation and its
			// continuation. Its rate limit must not disable an otherwise usable chat.
			const items = new Map((conversations.status === 'fulfilled' ? conversations.value.items : state.conversations).map(item => [item.id, item]));
			if (pins.status === 'fulfilled') {
				for (const item of pins.value) {
					items.set(item.id, { ...item, projectId: item.projectId ?? items.get(item.id)?.projectId });
				}
			}
			const listError =
				conversations.status === 'rejected'
					? localize('sessions.chatgpt.historyListFailed', 'Could not refresh the conversation list. You can continue the current chat. {0}', this.errorText(conversations.reason))
					: '';
			const selected = catalog.models.find(model => model.id === state.model) ?? catalog.models.find(model => model.id === catalog.defaultModel)!;
			this.update({
				connected: true,
				busy: false,
				loading: undefined,
				models: catalog.models,
				model: selected.id,
				modelPreset: this.resolveModelPreset(selected, state.modelPreset),
				uncertain: false,
				stopped: false,
				conversations: [...items.values()],
				hasMore: conversations.status === 'fulfilled' ? conversations.value.hasMore : state.hasMore,
				projects: projects.status === 'fulfilled' ? projects.value : state.projects,
				error: [...[projects, pins].filter(result => result.status === 'rejected').map(result => this.errorText(result.reason)), listError].filter(Boolean).join('\n'),
			});
			const retained = state.conversationId ?? this.storage.get('sessions.chatgpt.conversation', StorageScope.PROFILE);
			if (retained && retained.length < 1024) {
				await this.select(retained);
				const restored = this.model.get();
				if (listError && restored.conversationId === retained) {
					if (!restored.conversations.some(item => item.id === retained)) {
						this.rememberHistory({ id: retained, title: restored.title });
					}
					if (!restored.error) {
						this.update({ error: listError });
					}
				}
			}
		} catch (error) {
			if (generation === this.generation) {
				this.update({ busy: false, loading: undefined, error: this.errorText(error) });
			}
		}
	}

	private resetRecentPage(page: { items: readonly ChatGPTConversation[]; nextOffset: number }): void {
		this.recentOffset = page.nextOffset;
		this.recentIds.clear();
		for (const item of page.items) {
			this.recentIds.add(item.id);
		}
	}

	public newChat(): void {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing || this.voiceStopping) {
			return;
		}
		if (this.voiceController) {
			void this.endVoice(true).then(() => this.newChat());
			return;
		}
		this.operation?.abort();
		this.generation++;
		this.update({
			draft: this.drafts.get('new')?.text ?? '',
			attachments: this.drafts.get('new')?.attachments ?? [],
			conversationId: undefined,
			title: 'ChatGPT',
			messages: [],
			parentId: crypto.randomUUID(),
			error: '',
			busy: false,
			loading: undefined,
			uncertain: false,
			stopped: false,
		});
		this.rememberConversation(undefined);
	}

	public async select(id: string): Promise<void> {
		if (this.isDisposed || this.model.get().sending || this.model.get().managing) {
			return;
		}
		await this.endVoice(true);
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, loading: { kind: 'conversation', id }, error: '' });
		try {
			const history = await this.client.history(id, signal);
			if (generation !== this.generation) {
				return;
			}
			this.restoreHistory(history);
			this.rememberConversation(id);
		} catch (error) {
			if (generation === this.generation) {
				this.update({ busy: false, loading: undefined, error: this.errorText(error) });
			}
		}
	}

	private restoreHistory(history: ChatGPTHistory): void {
		const state = this.model.get();
		const selected = state.models.find(model => history.model !== undefined && model.modelIds.includes(history.model)) ?? state.models.find(model => model.id === state.model);
		const preset =
			selected?.presets.find(preset => preset.model === history.model && preset.thinkingEffort === history.thinkingEffort) ??
			selected?.presets.find(preset => preset.model === history.model && preset.thinkingEffort === undefined) ??
			selected?.presets.find(preset => preset.model === history.model);
		this.update({
			draft: this.drafts.get(history.id)?.text ?? '',
			attachments: this.drafts.get(history.id)?.attachments ?? [],
			conversationId: history.id,
			title: history.title,
			messages: history.messages,
			parentId: history.parentId,
			model: selected?.id ?? state.model,
			modelPreset: preset?.id ?? this.resolveModelPreset(selected, state.modelPreset),
			busy: false,
			loading: undefined,
			uncertain: false,
			stopped: false,
		});
	}

	/** An accepted turn already supplies its canonical title and ID; do not refetch every recent chat. */
	private rememberHistory(history: Pick<ChatGPTHistory, 'id' | 'title'>): void {
		const state = this.model.get();
		const previous = state.conversations.find(item => item.id === history.id);
		if (!this.recentIds.has(history.id)) {
			this.recentIds.add(history.id);
			this.recentOffset++;
		}
		this.update({
			conversations: [{ ...previous, id: history.id, title: history.title }, ...state.conversations.filter(item => item.id !== history.id)],
		});
	}

	public async loadMore(): Promise<void> {
		if (!this.model.get().connected || this.model.get().busy || this.model.get().sending || this.model.get().managing || !this.model.get().hasMore) {
			return;
		}
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, loading: { kind: 'history' }, error: '' });
		try {
			const state = this.model.get();
			const result = await this.client.conversations(this.recentOffset, signal);
			if (generation !== this.generation) {
				return;
			}
			this.recentOffset = result.nextOffset;
			for (const item of result.items) {
				this.recentIds.add(item.id);
			}
			const existing = new Set(state.conversations.map(item => item.id));
			this.update({
				conversations: [...state.conversations, ...result.items.filter(item => !existing.has(item.id))],
				hasMore: result.hasMore,
				busy: false,
				loading: undefined,
			});
		} catch (error) {
			if (generation === this.generation) {
				this.update({ busy: false, loading: undefined, error: this.errorText(error) });
			}
		}
	}

	public async send(): Promise<void> {
		const state = this.model.get();
		const text = state.draft.trim();
		const preset = state.models.find(model => model.id === state.model)?.presets.find(preset => preset.id === state.modelPreset);
		if (
			!preset ||
			!state.connected ||
			state.busy ||
			state.sending ||
			state.managing ||
			state.voice !== 'idle' ||
			state.uncertain ||
			(!text && !state.attachments.length) ||
			state.attachments.some(attachment => attachment.status !== 'ready') ||
			!state.model
		) {
			return;
		}
		const controller = (this.stream = new AbortController());
		const messageId = crypto.randomUUID();
		const draftKey = this.draftKey();
		const files = state.attachments.flatMap(attachment => (attachment.file ? [attachment.file] : []));
		let acknowledged = false;
		this.update({
			sending: true,
			stopped: false,
			error: '',
			messages: [
				...state.messages,
				{
					id: messageId,
					role: 'user',
					text,
					resources: files.map(file => ({
						uri: `file-service://${file.id}`,
						name: file.name,
						kind: file.mimeType.startsWith('image/') ? 'image' : 'document',
						mimeType: file.mimeType,
					})),
				},
			],
		});
		try {
			for await (const event of this.client.send(
				{
					text,
					model: preset.model,
					thinkingEffort: preset.thinkingEffort,
					parentId: state.parentId,
					conversationId: state.conversationId,
					messageId,
					files,
				},
				controller.signal,
			)) {
				if (this.isDisposed || this.stream !== controller) {
					return;
				}
				if (!acknowledged) {
					acknowledged = true;
					this.drafts.delete(draftKey);
					this.update({ draft: '', attachments: [] });
				}
				const current = this.model.get();
				let messages = current.messages;
				if (event.message) {
					const message = event.message;
					const index = messages.findIndex(item => item.id === message.id);
					messages = index < 0 ? [...messages, message] : messages.map((item, i) => (i === index ? message : item));
				}
				this.update({
					messages,
					conversationId: event.conversationId ?? current.conversationId,
					parentId: event.message?.id ?? current.parentId,
				});
				if (event.conversationId) {
					this.rememberConversation(event.conversationId);
				}
			}
			this.drafts.delete(draftKey);
			this.update({ draft: '', attachments: [] });
			const currentId = this.model.get().conversationId;
			if (currentId) {
				try {
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
					const history = await this.client.history(currentId, signal);
					this.update({ title: history.title, parentId: history.parentId, messages: history.messages });
					this.rememberHistory(history);
				} catch (error) {
					if (!controller.signal.aborted) {
						this.update({ error: this.errorText(error) });
					}
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				const rejected = error instanceof ChatGPTRequestError && error.status >= 400 && error.status < 500;
				this.update({
					error: this.errorText(error),
					uncertain: !rejected,
					...(rejected ? { messages: state.messages, parentId: state.parentId } : {}),
				});
			}
		} finally {
			// Keep this turn's controls locked until its remote stop settles; a delayed stop
			// must not overlap a new send in the same conversation.
			await this.stopping;
			if (this.stream === controller) {
				this.stream = undefined;
				this.update({ sending: false });
			}
		}
	}

	public async stop(): Promise<void> {
		const controller = this.stream;
		if (!controller || this.stopping) {
			return;
		}
		const state = this.model.get();
		const message = state.messages.at(-1);
		this.stopping = Promise.resolve().then(async () => {
			try {
				if (state.conversationId && message?.role === 'assistant') {
					await this.client.stop(state.conversationId, message.id, AbortSignal.timeout(10_000));
					this.update({ stopped: true });
				} else {
					this.update({
						uncertain: true,
						error: localize(
							'sessions.chatgpt.stopUnconfirmed',
							'The request was interrupted before ChatGPT confirmed this reply. Reload the conversation or check recent conversations before sending it again.',
						),
					});
				}
			} catch (error) {
				this.update({ uncertain: true, error: this.errorText(error) });
			}
		});
		// Cancellation must reach preparation and verification before any remote stop I/O.
		// Otherwise finishing verification while stop is pending could still send the draft.
		controller.abort();
		try {
			await this.stopping;
		} finally {
			this.stopping = undefined;
		}
	}

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : localize('sessions.chatgpt.connectionFailed', 'Could not connect to ChatGPT.');
	}
}
