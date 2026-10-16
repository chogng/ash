import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ChatGPTClient, ChatGPTRequestError, type ChatGPTConversation, type ChatGPTMessage, type ChatGPTModel, type ChatGPTFile } from './chatGPTClient.js';
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
interface ChatGPTDraft { readonly text: string; readonly attachments: readonly ChatGPTAttachment[]; }

export interface ChatGPTState {
	readonly draft: string;
	readonly attachments: readonly ChatGPTAttachment[];
	readonly voice: 'idle' | 'connecting' | 'connected';
	readonly voiceTranscript: readonly { readonly id: string; readonly text: string; readonly role: 'user' | 'assistant'; }[];
	readonly connected: boolean;
	readonly busy: boolean;
	readonly sending: boolean;
	readonly conversations: readonly ChatGPTConversation[];
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
}

/** One window-local model shared by the sidebar View and the chat EditorPane. */
export interface IChatGPTService {
	readonly state: IObservable<ChatGPTState>;
	initialize(): void;
	reload(): Promise<void>;
	newChat(): void;
	select(id: string): Promise<void>;
	loadMore(): Promise<void>;
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
		draft: '', attachments: [], voice: 'idle', voiceTranscript: [], connected: false, busy: false, sending: false, conversations: [], hasMore: false,
		models: [], model: '', title: 'ChatGPT', parentId: crypto.randomUUID(), messages: [], error: '', uncertain: false, stopped: false,
	});
	private readonly drafts = new Map<string, ChatGPTDraft>();
	private readonly attachmentFiles = new Map<string, File>();
	private readonly uploads = new Map<string, AbortController>();
	private voiceController: AbortController | undefined;
	private voiceMedia: ChatGPTVoiceSession | undefined;
	private operation: AbortController | undefined;
	private stream: AbortController | undefined;
	private stopping: Promise<void> | undefined;
	private generation = 0;

	public readonly state: IObservable<ChatGPTState> = this.model;
	private readonly client: ChatGPTClient;
	private initialized = false;
	constructor(@IChatGPTTransport transport: IChatGPTTransport, @IStorageService private readonly storage: IStorageService) {
		super();
		this.client = new ChatGPTClient(createChatGPTFetch(transport));
		this._register(toDisposable(() => {
			void this.endVoice(false);
			this.generation++; this.operation?.abort(); this.stream?.abort(); this.drafts.clear();
			for (const upload of this.uploads.values()) { upload.abort(); }
			this.uploads.clear(); this.attachmentFiles.clear();
		}));
	}
	public initialize(): void { if (!this.initialized) { this.initialized = true; void this.loadCatalog(); } }
	public async reload(): Promise<void> {
		if (this.model.get().busy || this.model.get().sending) { return; }
		const id = this.model.get().conversationId;
		if (this.model.get().connected && id) { await this.select(id); } else { await this.loadCatalog(); }
	}
	public setDraft(draft: string): void { this.drafts.set(this.draftKey(), { text: draft, attachments: this.model.get().attachments }); this.update({ draft }); }
	public setModel(model: string): void {
		const state = this.model.get();
		const selected = state.models.find(entry => entry.id === model);
		if (!selected || state.busy || state.sending || state.voice !== 'idle') { return; }
		this.update({ model, modelPreset: this.resolveModelPreset(selected, state.modelPreset) });
	}
	public setModelPreset(modelPreset: string): void {
		const state = this.model.get();
		const selected = state.models.find(entry => entry.id === state.model);
		if (state.busy || state.sending || state.voice !== 'idle' || !selected?.presets.some(preset => preset.id === modelPreset)) { return; }
		this.update({ modelPreset });
	}

	private resolveModelPreset(model: ChatGPTModel | undefined, preferred: string | undefined): string | undefined {
		return model?.presets.find(preset => preset.id === preferred)?.id ?? model?.defaultPreset;
	}

	public async startVoice(window: Window & typeof globalThis): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.uncertain || state.voice !== 'idle' || state.draft.trim() || state.attachments.length) { return; }
		if (!window.navigator.userActivation?.isActive) { return; }
		const controller = new AbortController();
		this.voiceController = controller;
		this.update({ voice: 'connecting', voiceTranscript: [], error: '' });
		try {
			const { ChatGPTVoiceSession } = await import('./chatGPTVoiceSession.js');
			if (controller.signal.aborted || this.voiceController !== controller) { return; }
			const media = this.voiceMedia = new ChatGPTVoiceSession(window, (id, text, role) => {
				if (this.voiceController !== controller || controller.signal.aborted) { return; }
				const transcript = this.model.get().voiceTranscript;
				const item = { id, text: text.slice(0, 65536), role };
				this.update({ voiceTranscript: (transcript.some(previous => previous.id === id) ? transcript.map(previous => previous.id === id ? item : previous) : [...transcript, item]).slice(-64) });
			}, error => {
				if (this.voiceController !== controller) { return; }
				// Even a failed room may have committed turns; reload its continuation node.
				void this.endVoice(true);
				if (error !== undefined) { this.update({ error: this.errorText(error) }); }
			});
			media.unlockAudio();
			const connection = await this.client.voice({ conversationId: state.conversationId, parentId: state.parentId, language: getNLSLanguage().split('-')[0]! }, AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]));
			if (this.voiceController !== controller || controller.signal.aborted) { return; }
			if (connection.conversationId && connection.conversationId !== state.conversationId) {
				this.drafts.set(connection.conversationId, { text: state.draft, attachments: state.attachments });
				if (!state.conversationId) { this.drafts.delete('new'); }
				this.update({ conversationId: connection.conversationId });
				this.rememberConversation(connection.conversationId);
			}
			await media.connect(connection, controller.signal);
			if (this.voiceController === controller && !controller.signal.aborted) { this.update({ voice: 'connected' }); }
		} catch (error) {
			if (this.voiceController === controller && !controller.signal.aborted) {
				await this.endVoice(false);
				this.update({ error: this.errorText(error) });
			}
		}
	}

	public stopVoice(): Promise<void> { return this.endVoice(true); }

	private async endVoice(refresh: boolean): Promise<void> {
		const controller = this.voiceController;
		if (!controller) { return; }
		this.voiceController = undefined;
		controller.abort();
		this.voiceMedia?.dispose(); this.voiceMedia = undefined;
		const id = this.model.get().conversationId;
		this.update({ voice: 'idle', voiceTranscript: [] });
		if (refresh && !this.isDisposed) {
			if (id) { await this.select(id); }
			else { await this.loadCatalog(); }
		}
	}

	public async attachFiles(files: readonly File[]): Promise<void> {
		const state = this.model.get();
		if (this.isDisposed || !state.connected || state.busy || state.sending || state.voice !== 'idle') { return; }
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
		this.drafts.set(key, { text: state.draft, attachments: [...state.attachments, ...attachments] });
		this.update({ attachments: this.drafts.get(key)!.attachments, error: '' });
		await Promise.all(attachments.map(attachment => this.uploadAttachment(key, attachment.id)));
	}

	public removeAttachment(id: string): void {
		if (this.model.get().sending) { return; }
		this.uploads.get(id)?.abort(); this.uploads.delete(id); this.attachmentFiles.delete(id);
		const state = this.model.get();
		const attachments = state.attachments.filter(attachment => attachment.id !== id);
		this.drafts.set(this.draftKey(), { text: state.draft, attachments });
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
		return [state.title, ...state.messages.map(message => `${message.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'}\n${message.role === 'assistant' ? getChatGPTRichContentText(message.text, message.references) : message.text}\n${message.resources?.map(resource => resource.name).join('\n') ?? ''}`), ...state.voiceTranscript.map(item => `${item.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'}: ${item.text}`), state.error].filter(Boolean).join('\n\n');
	}
	private rememberConversation(id: string | undefined): void {
		if (id) { this.storage.store('sessions.chatgpt.conversation', id, StorageScope.PROFILE, StorageTarget.MACHINE); }
		else { this.storage.remove('sessions.chatgpt.conversation', StorageScope.PROFILE); }
	}
	private update(change: Partial<ChatGPTState>): void { if (!this.isDisposed) { this.model.set({ ...this.model.get(), ...change }); } }
	private draftKey(): string { return this.model.get().conversationId ?? 'new'; }
	private beginOperation(): { signal: AbortSignal; generation: number; } {
		this.operation?.abort();
		this.operation = new AbortController();
		return { signal: AbortSignal.any([this.operation.signal, AbortSignal.timeout(30_000)]), generation: ++this.generation };
	}

	private async loadCatalog(): Promise<void> {
		if (this.isDisposed || this.model.get().sending) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, error: '' });
		try {
			const [catalog, conversations] = await Promise.all([this.client.models(signal), this.client.conversations(0, signal)]);
			if (generation !== this.generation) { return; }
			const state = this.model.get();
			const selected = catalog.models.find(model => model.id === state.model) ?? catalog.models.find(model => model.id === catalog.defaultModel)!;
			this.update({
				connected: true, busy: false, models: catalog.models,
				model: selected.id, modelPreset: this.resolveModelPreset(selected, state.modelPreset),
				uncertain: false, stopped: false, conversations: conversations.items, hasMore: conversations.hasMore,
			});
			const retained = state.conversationId ?? this.storage.get('sessions.chatgpt.conversation', StorageScope.PROFILE);
			if (retained && retained.length < 1024) { await this.select(retained); }
		} catch (error) {
			if (generation === this.generation) { this.update({ busy: false, error: this.errorText(error) }); }
		}
	}

	public newChat(): void {
		if (this.isDisposed || this.model.get().sending) { return; }
		void this.endVoice(false);
		this.operation?.abort();
		this.generation++;
		this.update({ draft: this.drafts.get('new')?.text ?? '', attachments: this.drafts.get('new')?.attachments ?? [], conversationId: undefined, title: 'ChatGPT', messages: [], parentId: crypto.randomUUID(), error: '', busy: false, uncertain: false, stopped: false });
		this.rememberConversation(undefined);
	}

	public async select(id: string): Promise<void> {
		if (this.isDisposed || this.model.get().sending) { return; }
		void this.endVoice(false);
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, error: '' });
		try {
			const history = await this.client.history(id, signal);
			if (generation !== this.generation) { return; }
			const state = this.model.get();
			const selected = state.models.find(model => history.model !== undefined && model.modelIds.includes(history.model)) ?? state.models.find(model => model.id === state.model);
			const preset = selected?.presets.find(preset => preset.model === history.model && preset.thinkingEffort === history.thinkingEffort)
				?? selected?.presets.find(preset => preset.model === history.model && preset.thinkingEffort === undefined)
				?? selected?.presets.find(preset => preset.model === history.model);
			this.update({
				draft: this.drafts.get(id)?.text ?? '', attachments: this.drafts.get(id)?.attachments ?? [], conversationId: id, title: history.title, messages: history.messages, parentId: history.parentId,
				model: selected?.id ?? state.model, modelPreset: preset?.id ?? this.resolveModelPreset(selected, state.modelPreset),
				busy: false, uncertain: false, stopped: false
			});
			this.rememberConversation(id);
		} catch (error) { if (generation === this.generation) { this.update({ busy: false, error: this.errorText(error) }); } }
	}

	public async loadMore(): Promise<void> {
		if (!this.model.get().connected || this.model.get().busy || this.model.get().sending || !this.model.get().hasMore) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, error: '' });
		try {
			const state = this.model.get();
			const result = await this.client.conversations(state.conversations.length, signal);
			if (generation !== this.generation) { return; }
			const existing = new Set(state.conversations.map(item => item.id));
			this.update({ conversations: [...state.conversations, ...result.items.filter(item => !existing.has(item.id))], hasMore: result.hasMore, busy: false });
		} catch (error) { if (generation === this.generation) { this.update({ busy: false, error: this.errorText(error) }); } }
	}

	public async send(): Promise<void> {
		const state = this.model.get();
		const text = state.draft.trim();
		const preset = state.models.find(model => model.id === state.model)?.presets.find(preset => preset.id === state.modelPreset);
		if (!preset || !state.connected || state.busy || state.sending || state.voice !== 'idle' || state.uncertain || (!text && !state.attachments.length) || state.attachments.some(attachment => attachment.status !== 'ready') || !state.model) { return; }
		const controller = this.stream = new AbortController();
		const messageId = crypto.randomUUID();
		const draftKey = this.draftKey();
		const files = state.attachments.flatMap(attachment => attachment.file ? [attachment.file] : []);
		let acknowledged = false;
		this.update({ sending: true, stopped: false, error: '', messages: [...state.messages, { id: messageId, role: 'user', text, resources: files.map(file => ({ uri: `file-service://${file.id}`, name: file.name, kind: file.mimeType.startsWith('image/') ? 'image' : 'document', mimeType: file.mimeType })) }] });
		try {
			for await (const event of this.client.send({ text, model: preset.model, thinkingEffort: preset.thinkingEffort, parentId: state.parentId, conversationId: state.conversationId, messageId, files }, controller.signal)) {
				if (this.isDisposed || this.stream !== controller) { return; }
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
					messages = index < 0 ? [...messages, message] : messages.map((item, i) => i === index ? message : item);
				}
				this.update({ messages, conversationId: event.conversationId ?? current.conversationId, parentId: event.message?.id ?? current.parentId });
				if (event.conversationId) { this.rememberConversation(event.conversationId); }
			}
			this.drafts.delete(draftKey);
			this.update({ draft: '', attachments: [] });
			const currentId = this.model.get().conversationId;
			if (currentId) {
				try {
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
					const [history, catalog] = await Promise.all([this.client.history(currentId, signal), this.client.conversations(0, signal)]);
					this.update({ title: history.title, parentId: history.parentId, messages: history.messages, conversations: catalog.items, hasMore: catalog.hasMore });
				} catch (error) { if (!controller.signal.aborted) { this.update({ error: this.errorText(error) }); } }
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				const rejected = error instanceof ChatGPTRequestError && error.status >= 400 && error.status < 500;
				this.update({
					error: this.errorText(error), uncertain: !rejected,
					...(rejected ? { messages: state.messages, parentId: state.parentId } : {}),
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
					await this.client.stop(state.conversationId, message.id, AbortSignal.timeout(10_000));
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
