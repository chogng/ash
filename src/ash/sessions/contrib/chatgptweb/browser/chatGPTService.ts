import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IChatGPTTransport } from '../common/chatGPTTransport.js';
import { ChatGPTClient, ChatGPTRequestError, type ChatGPTConversation, type ChatGPTMessage, type ChatGPTModel } from './chatGPTClient.js';
import { createChatGPTFetch } from './chatGPTFetch.js';

export const chatGPTNavigationContainerId = 'sessions.chatgpt.navigation';

export interface ChatGPTState {
	readonly draft: string;
	readonly name: string;
	readonly connected: boolean;
	readonly busy: boolean;
	readonly sending: boolean;
	readonly conversations: readonly ChatGPTConversation[];
	readonly hasMore: boolean;
	readonly models: readonly ChatGPTModel[];
	readonly model: string;
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
	connect(): Promise<void>;
	reload(): Promise<void>;
	newChat(): void;
	select(id: string): Promise<void>;
	loadMore(): Promise<void>;
	setDraft(value: string): void;
	setModel(value: string): void;
	send(): Promise<void>;
	stop(): Promise<void>;
	getAccessibleContent(): string;
}
export const IChatGPTService = createServiceIdentifier<IChatGPTService>('chatGPTService');

export class ChatGPTService extends Disposable implements IChatGPTService {
	private readonly model = observableValue<ChatGPTState>('chatgpt', {
		draft: '', name: '', connected: false, busy: false, sending: false, conversations: [], hasMore: false,
		models: [], model: '', title: 'ChatGPT', parentId: crypto.randomUUID(), messages: [], error: '', uncertain: false, stopped: false,
	});
	private readonly drafts = new Map<string, string>();
	private operation: AbortController | undefined;
	private stream: AbortController | undefined;
	private stopping: Promise<void> | undefined;
	private generation = 0;
	private accountId: string | undefined;

	public readonly state: IObservable<ChatGPTState> = this.model;
	private readonly client: ChatGPTClient;
	private initialized = false;
	constructor(@IChatGPTTransport transport: IChatGPTTransport, @IStorageService private readonly storage: IStorageService) {
		super();
		this.client = new ChatGPTClient(createChatGPTFetch(transport));
		this._register(toDisposable(() => {
			this.generation++; this.operation?.abort(); this.stream?.abort(); this.client.clear(); this.drafts.clear();
		}));
	}
	public initialize(): void { if (!this.initialized) { this.initialized = true; void this.connect(); } }
	public async reload(): Promise<void> {
		if (this.model.get().busy || this.model.get().sending) { return; }
		const id = this.model.get().conversationId;
		if (this.model.get().connected && id) { await this.select(id); } else { await this.connect(); }
	}
	public setDraft(draft: string): void { this.drafts.set(this.draftKey(), draft); this.update({ draft }); }
	public setModel(model: string): void { this.update({ model }); }
	public getAccessibleContent(): string {
		const state = this.model.get();
		return [state.title, ...state.messages.map(message => `${message.role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'}\n${message.text}`), state.error].filter(Boolean).join('\n\n');
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

	public async connect(): Promise<void> {
		if (this.isDisposed || this.model.get().sending) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ draft: '', busy: true, connected: false, name: '', conversations: [], models: [], messages: [], error: '' });
		try {
			const account = await this.client.connect(signal);
			if (generation !== this.generation) { return; }
			if (!account.id || account.id !== this.accountId) {
				this.drafts.clear();
				if (this.accountId !== undefined) { this.rememberConversation(undefined); }
			}
			this.accountId = account.id;
			const [catalog, conversations] = await Promise.all([this.client.models(signal), this.client.conversations(0, signal)]);
			if (generation !== this.generation) { return; }

			this.update({
				name: account.name, connected: true, busy: false, models: catalog.models, model: catalog.defaultModel, uncertain: false, stopped: false,
				draft: this.drafts.get('new') ?? '', conversations: conversations.items, hasMore: conversations.hasMore, messages: [], conversationId: undefined, parentId: crypto.randomUUID(), title: 'ChatGPT'
			});
			const retained = this.storage.get('sessions.chatgpt.conversation', StorageScope.PROFILE);
			if (retained && retained.length < 1024) { await this.select(retained); }
		} catch (error) {
			if (generation === this.generation) {
				this.client.clear();
				this.update({ connected: false, busy: false, name: '', conversations: [], models: [], messages: [], error: this.errorText(error) });
			}
		}
	}

	public newChat(): void {
		if (this.isDisposed || this.model.get().sending) { return; }
		this.operation?.abort();
		this.generation++;
		this.update({ draft: this.drafts.get('new') ?? '', conversationId: undefined, title: 'ChatGPT', messages: [], parentId: crypto.randomUUID(), error: '', busy: false, uncertain: false, stopped: false });
		this.rememberConversation(undefined);
	}

	public async select(id: string): Promise<void> {
		if (this.isDisposed || this.model.get().sending) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, error: '' });
		try {
			const history = await this.client.history(id, signal);
			if (generation !== this.generation) { return; }
			const available = this.model.get().models.some(model => model.id === history.model);
			this.update({
				draft: this.drafts.get(id) ?? '', conversationId: id, title: history.title, messages: history.messages, parentId: history.parentId,
				model: available ? history.model! : this.model.get().model, busy: false, uncertain: false, stopped: false
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
		if (!state.connected || state.busy || state.sending || state.uncertain || !text || !state.model) { return; }
		const controller = this.stream = new AbortController();
		const messageId = crypto.randomUUID();
		const draftKey = this.draftKey();
		let acknowledged = false;
		this.update({ sending: true, stopped: false, error: '', messages: [...state.messages, { id: messageId, role: 'user', text }] });
		try {
			for await (const event of this.client.send({ text, model: state.model, parentId: state.parentId, conversationId: state.conversationId, messageId }, controller.signal)) {
				if (this.isDisposed || this.stream !== controller) { return; }
				if (!acknowledged) {
					acknowledged = true;
					this.drafts.delete(draftKey);
					this.update({ draft: '' });
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
			this.update({ draft: '' });
			const currentId = this.model.get().conversationId;
			if (currentId) {
				try {
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
					const [history, catalog] = await Promise.all([this.client.history(currentId, signal), this.client.conversations(0, signal)]);
					this.update({ title: history.title, parentId: history.parentId, conversations: catalog.items, hasMore: catalog.hasMore });
				} catch (error) { if (!controller.signal.aborted) { this.update({ error: this.errorText(error) }); } }
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				const rejected = error instanceof ChatGPTRequestError && error.status >= 400 && error.status < 500;
				this.update({
					error: this.errorText(error), uncertain: !rejected,
					...(rejected ? { messages: state.messages, parentId: state.parentId } : {}),
					...(error instanceof ChatGPTRequestError && (error.status === 401 || error.status === 409) ? { connected: false } : {}),
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
