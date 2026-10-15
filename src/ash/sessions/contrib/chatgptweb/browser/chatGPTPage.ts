import { addDisposableListener } from '../../../../base/browser/dom.js';
import { renderMarkdown, type IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { localize, setNlsMessages } from '../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../workbench/services/localization/common/localizationCatalogs.js';
import { ChatGPTClient, ChatGPTRequestError, type ChatGPTConversation, type ChatGPTMessage, type ChatGPTModel } from './chatGPTClient.js';
import './media/chatGPTPage.css';

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
setNlsMessages(locale, productLanguagePackCatalogs.find(catalog => catalog.locale === locale)?.bundles ?? {});
document.documentElement.lang = locale;

interface PageState {
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

/** The retained browser page owns only the current view and unsent drafts, never durable chats. */
class ChatGPTPage extends Disposable {
	private readonly client = new ChatGPTClient();
	private readonly state = observableValue<PageState>('chatgptPage', {
		name: '', connected: false, busy: false, sending: false, conversations: [], hasMore: false,
		models: [], model: '', title: 'ChatGPT', parentId: crypto.randomUUID(), messages: [], error: '', uncertain: false, stopped: false,
	});
	private readonly drafts = new Map<string, string>();
	private readonly rendered = new Map<string, { element: HTMLElement; body: HTMLElement; markdown?: IRenderedMarkdown; text: string; }>();
	private operation: AbortController | undefined;
	private stream: AbortController | undefined;
	private stopping: Promise<void> | undefined;
	private generation = 0;
	private accountId: string | undefined;
	private listReference: readonly ChatGPTConversation[] | undefined;
	private modelReference: readonly ChatGPTModel[] | undefined;
	private readonly sidebar = this.element('aside', 'ash-chatgpt-sidebar');
	private readonly list = this.element('nav', 'ash-chatgpt-conversations');
	private readonly search = document.createElement('input');
	private readonly scroll = this.element('div', 'ash-chatgpt-scroll');
	private readonly messages = this.element('div', 'ash-chatgpt-messages');
	private readonly welcome = this.element('h1', 'ash-chatgpt-welcome');
	private readonly input = document.createElement('textarea');
	private readonly model = document.createElement('select');
	private readonly error = this.element('p', 'ash-chatgpt-error');
	private readonly status = this.element('span', 'ash-chatgpt-status');
	private readonly title = this.element('span', 'ash-chatgpt-title');
	private readonly sendButton: HTMLButtonElement;
	private readonly newButton: HTMLButtonElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly connectButton: HTMLButtonElement;
	private readonly loginButton: HTMLButtonElement;
	private readonly jumpButton: HTMLButtonElement;

	constructor(private readonly root: HTMLElement) {
		super();
		root.className = 'ash-chatgpt-page';
		this.sidebar.setAttribute('aria-label', localize('sessions.chatgpt.conversations', 'ChatGPT conversations'));
		const heading = this.element('h2', 'ash-chatgpt-brand');
		heading.textContent = 'ChatGPT';
		this.newButton = this.button(localize('sessions.chatgpt.newChat', 'New chat'), () => this.newChat());
		this.search.type = 'search';
		this.search.placeholder = localize('sessions.chatgpt.search', 'Search conversations');
		this.search.setAttribute('aria-label', this.search.placeholder);
		this.listen(this.search, 'input', () => this.filterList());
		this.list.setAttribute('aria-label', localize('sessions.chatgpt.recent', 'Recent conversations'));
		this.listen(this.list, 'click', event => {
			const button = event.target instanceof Element ? event.target.closest('button') : null;
			if (button instanceof HTMLButtonElement && button.dataset.conversation) { void this.select(button.dataset.conversation); }
		});
		this.moreButton = this.button(localize('sessions.chatgpt.loadMore', 'Load more'), () => { void this.loadMore(); });
		this.sidebar.append(heading, this.newButton, this.search, this.list, this.moreButton);
		const main = this.element('main', 'ash-chatgpt-main');
		const header = this.element('header', 'ash-chatgpt-header');
		const toggle = this.button(localize('sessions.chatgpt.toggleSidebar', 'Toggle conversations'), () => {
			const hidden = root.classList.toggle('sidebar-hidden');
			toggle.setAttribute('aria-expanded', String(!hidden));
		});
		toggle.setAttribute('aria-expanded', 'true');
		this.connectButton = this.button(localize('sessions.chatgpt.connect', 'Connect'), () => { void this.connect(); });
		this.loginButton = this.button(localize('sessions.chatgpt.openLogin', 'Open ChatGPT'), () => {
			const state = this.state.get();
			window.open(state.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(state.conversationId)}` : 'https://chatgpt.com/', '_blank', 'noopener');
		});
		const help = this.button(localize('sessions.chatgpt.help', 'Help'), () => this.showText(localize('sessions.chatgpt.help', 'Help'), this.helpText()));
		const accessible = this.button(localize('sessions.chatgpt.readConversation', 'Read conversation'), () => this.showText(this.state.get().title,
			this.state.get().messages.map(message => `${this.roleLabel(message.role)}\n${message.text}`).join('\n\n')));
		const reload = this.button(localize('sessions.chatgpt.reloadShort', 'Reload'), () => {
			const id = this.state.get().conversationId;
			if (id) { void this.select(id); } else { void this.connect(); }
		});
		header.append(toggle, this.title, reload, accessible, help, this.loginButton, this.connectButton);
		this.scroll.append(this.welcome, this.messages);
		this.messages.setAttribute('role', 'log');
		this.messages.setAttribute('aria-label', localize('sessions.chatgpt.conversation', 'Conversation'));
		this.messages.setAttribute('aria-live', 'off');
		this.listen(this.scroll, 'scroll', () => { if (this.atBottom()) { this.jumpButton.hidden = true; } });
		this.jumpButton = this.button(localize('sessions.chatgpt.latest', 'Latest message'), () => { this.scroll.scrollTop = this.scroll.scrollHeight; this.jumpButton.hidden = true; });
		this.jumpButton.classList.add('ash-chatgpt-jump');
		this.jumpButton.hidden = true;
		const composer = this.element('form', 'ash-chatgpt-composer');
		this.input.rows = 1;
		this.input.maxLength = 500_000;
		this.input.placeholder = localize('sessions.chatgpt.prompt', 'Ask ChatGPT');
		this.input.setAttribute('aria-label', this.input.placeholder);
		this.listen(this.input, 'input', () => { this.drafts.set(this.draftKey(), this.input.value); this.resizeInput(); });
		this.listen(this.input, 'keydown', event => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
		});
		this.listen(composer, 'submit', event => { event.preventDefault(); void (this.state.get().sending ? this.stop() : this.send()); });
		const controls = this.element('div', 'ash-chatgpt-composer-controls');
		this.model.setAttribute('aria-label', localize('sessions.chatgpt.model', 'Model'));
		this.listen(this.model, 'change', () => this.update({ model: this.model.value }));
		this.sendButton = this.button(localize('sessions.chatgpt.send', 'Send'), () => { composer.requestSubmit(); });
		this.sendButton.classList.add('ash-chatgpt-send');
		controls.append(this.model, this.sendButton);
		composer.append(this.input, controls);
		this.error.setAttribute('role', 'alert');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		const footer = this.element('div', 'ash-chatgpt-footer');
		footer.append(composer, this.error, this.status);
		main.append(header, this.scroll, this.jumpButton, footer);
		root.append(this.sidebar, main);
		if (window.innerWidth < 720) { root.classList.add('sidebar-hidden'); toggle.setAttribute('aria-expanded', 'false'); }
		this._register(autorun(reader => this.render(this.state.read(reader))));
		this._register(toDisposable(() => {
			this.generation++;
			this.operation?.abort();
			this.stream?.abort();
			this.client.clear();
			for (const item of this.rendered.values()) { item.markdown?.dispose(); }
			this.drafts.clear();
		}));
		void this.connect();
	}

	private element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
		const element = document.createElement(tag);
		element.className = className;
		return element;
	}

	private listen<K extends keyof HTMLElementEventMap>(element: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void): void {
		this._register(addDisposableListener(element, type, listener));
	}

	private button(label: string, action: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		this.listen(button, 'click', action);
		return button;
	}

	private update(change: Partial<PageState>): void { if (!this.isDisposed) { this.state.set({ ...this.state.get(), ...change }); } }
	private draftKey(): string { return this.state.get().conversationId ?? 'new'; }
	private atBottom(): boolean { return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80; }
	private resizeInput(): void { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`; }
	private roleLabel(role: ChatGPTMessage['role']): string { return role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'; }

	private beginOperation(): { signal: AbortSignal; generation: number; } {
		this.operation?.abort();
		this.operation = new AbortController();
		return { signal: AbortSignal.any([this.operation.signal, AbortSignal.timeout(30_000)]), generation: ++this.generation };
	}

	private async connect(): Promise<void> {
		if (this.state.get().sending) { return; }
		const { signal, generation } = this.beginOperation();
		this.input.value = '';
		this.resizeInput();
		this.update({ busy: true, connected: false, name: '', conversations: [], models: [], messages: [], error: '' });
		try {
			const account = await this.client.connect(signal);
			if (generation !== this.generation) { return; }
			if (!account.id || account.id !== this.accountId) { this.drafts.clear(); }
			this.accountId = account.id;
			const [catalog, conversations] = await Promise.all([this.client.models(signal), this.client.conversations(0, signal)]);
			if (generation !== this.generation) { return; }
			this.input.value = this.drafts.get('new') ?? '';
			this.update({
				name: account.name, connected: true, busy: false, models: catalog.models, model: catalog.defaultModel, uncertain: false, stopped: false,
				conversations: conversations.items, hasMore: conversations.hasMore, messages: [], conversationId: undefined, parentId: crypto.randomUUID(), title: 'ChatGPT'
			});
			const retained = location.hash.slice(1);
			if (retained && retained.length < 1024) { await this.select(retained); }
		} catch (error) {
			if (generation === this.generation) {
				this.client.clear();
				this.update({ connected: false, busy: false, name: '', conversations: [], models: [], messages: [], error: this.errorText(error) });
			}
		}
	}

	private newChat(): void {
		if (this.state.get().sending) { return; }
		this.operation?.abort();
		this.generation++;
		this.update({ conversationId: undefined, title: 'ChatGPT', messages: [], parentId: crypto.randomUUID(), error: '', busy: false, uncertain: false, stopped: false });
		history.replaceState(null, '', location.pathname + location.search);
		this.input.value = this.drafts.get('new') ?? '';
		this.resizeInput();
		this.input.focus();
	}

	private async select(id: string): Promise<void> {
		if (this.state.get().sending) { return; }
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, error: '' });
		try {
			const history = await this.client.history(id, signal);
			if (generation !== this.generation) { return; }
			const available = this.state.get().models.some(model => model.id === history.model);
			this.update({
				conversationId: id, title: history.title, messages: history.messages, parentId: history.parentId,
				model: available ? history.model! : this.state.get().model, busy: false, uncertain: false, stopped: false
			});
			window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
			this.input.value = this.drafts.get(id) ?? '';
			if (window.innerWidth < 720) { this.root.classList.add('sidebar-hidden'); }
			this.resizeInput();
			this.scroll.scrollTop = this.scroll.scrollHeight;
		} catch (error) { if (generation === this.generation) { this.update({ busy: false, error: this.errorText(error) }); } }
	}

	private async loadMore(): Promise<void> {
		const { signal, generation } = this.beginOperation();
		this.update({ busy: true, error: '' });
		try {
			const state = this.state.get();
			const result = await this.client.conversations(state.conversations.length, signal);
			if (generation !== this.generation) { return; }
			const existing = new Set(state.conversations.map(item => item.id));
			this.update({ conversations: [...state.conversations, ...result.items.filter(item => !existing.has(item.id))], hasMore: result.hasMore, busy: false });
		} catch (error) { if (generation === this.generation) { this.update({ busy: false, error: this.errorText(error) }); } }
	}

	private async send(): Promise<void> {
		const state = this.state.get();
		const text = this.input.value.trim();
		if (!state.connected || state.busy || state.sending || state.uncertain || !text || !state.model) { return; }
		const controller = this.stream = new AbortController();
		const messageId = crypto.randomUUID();
		const draftKey = this.draftKey();
		let acknowledged = false;
		this.update({ sending: true, stopped: false, error: '', messages: [...state.messages, { id: messageId, role: 'user', text }] });
		this.scroll.scrollTop = this.scroll.scrollHeight;
		try {
			for await (const event of this.client.send({ text, model: state.model, parentId: state.parentId, conversationId: state.conversationId, messageId }, controller.signal)) {
				if (this.isDisposed || this.stream !== controller) { return; }
				if (!acknowledged) {
					acknowledged = true;
					this.drafts.delete(draftKey);
					this.input.value = '';
					this.resizeInput();
				}
				const current = this.state.get();
				let messages = current.messages;
				if (event.message) {
					const message = event.message;
					const index = messages.findIndex(item => item.id === message.id);
					messages = index < 0 ? [...messages, message] : messages.map((item, i) => i === index ? message : item);
				}
				this.update({ messages, conversationId: event.conversationId ?? current.conversationId, parentId: event.message?.id ?? current.parentId });
				if (event.conversationId) { history.replaceState(null, '', `#${encodeURIComponent(event.conversationId)}`); }
			}
			this.drafts.delete(draftKey);
			this.input.value = '';
			this.resizeInput();
			const currentId = this.state.get().conversationId;
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

	private async stop(): Promise<void> {
		const controller = this.stream;
		if (!controller || this.stopping) { return; }
		const state = this.state.get();
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

	private render(state: PageState): void {
		const follow = this.atBottom();
		this.root.classList.toggle('empty', !state.messages.length);
		this.title.textContent = state.title;
		document.title = `${state.title} — ChatGPT`;
		this.welcome.textContent = state.name ? localize('sessions.chatgpt.greeting', 'Hi, {0}. Ready to start?', state.name) : localize('sessions.chatgpt.welcome', 'What can I help with?');
		this.welcome.hidden = state.messages.length > 0;
		this.error.textContent = state.error;
		this.error.hidden = !state.error;
		this.status.textContent = state.busy ? localize('sessions.chatgpt.loading', 'Loading…') : state.sending ? localize('sessions.chatgpt.replying', 'ChatGPT is replying…') :
			state.stopped ? localize('sessions.chatgpt.replyStopped', 'Reply stopped') : !state.error && state.messages.at(-1)?.role === 'assistant' ? localize('sessions.chatgpt.replyComplete', 'Reply complete') : '';
		this.messages.setAttribute('aria-busy', String(state.sending || state.busy));
		this.input.disabled = !state.connected || state.busy || state.sending;
		this.model.disabled = !state.connected || state.busy || state.sending;
		this.sendButton.disabled = !state.connected || state.busy || state.uncertain;
		this.sendButton.textContent = state.sending ? localize('sessions.chatgpt.stop', 'Stop') : localize('sessions.chatgpt.send', 'Send');
		this.connectButton.disabled = state.busy || state.sending;
		this.loginButton.disabled = state.sending;
		this.newButton.disabled = !state.connected || state.sending;
		this.moreButton.hidden = !state.hasMore;
		this.moreButton.disabled = state.busy || state.sending;
		if (this.modelReference !== state.models) {
			this.modelReference = state.models;
			this.model.replaceChildren(...state.models.map(model => new Option(model.title, model.id)));
		}
		this.model.value = state.model;
		if (this.listReference !== state.conversations) {
			this.listReference = state.conversations;
			this.list.replaceChildren(...state.conversations.map(item => {
				const button = document.createElement('button');
				button.type = 'button';
				button.textContent = item.title;
				button.title = item.title;
				button.dataset.conversation = item.id;
				return button;
			}));
			// The retained nav owns one delegated listener, independent of catalog refreshes.
		}
		for (const button of this.list.querySelectorAll('button')) {
			button.disabled = state.sending;
			if (button.dataset.conversation === state.conversationId) { button.setAttribute('aria-current', 'page'); }
			else { button.removeAttribute('aria-current'); }
		}
		this.filterList();
		const ids = new Set(state.messages.map(message => message.id));
		for (const [id, row] of this.rendered) {
			if (!ids.has(id)) { row.markdown?.dispose(); row.element.remove(); this.rendered.delete(id); }
		}
		for (const message of state.messages) {
			let row = this.rendered.get(message.id);
			if (!row) {
				const element = this.element('article', `ash-chatgpt-turn ${message.role}`);
				const label = this.element('h3', 'ash-chatgpt-role');
				label.textContent = this.roleLabel(message.role);
				const body = this.element('div', 'ash-chatgpt-message-body');
				element.append(label, body);
				row = { element, body, text: '' };
				this.rendered.set(message.id, row);
				this.messages.append(element);
			}
			row.element.classList.toggle('complete', !state.sending || message !== state.messages.at(-1));
			if (row.text !== message.text) {
				row.text = message.text;
				row.markdown?.dispose();
				row.markdown = renderMarkdown({ value: message.text, isTrusted: false, supportHtml: false }, {
					// Reply text must not trigger network or local-file reads through embedded images.
					transformUri: (href, kind) => kind === 'image' && !/^data:image\//iu.test(href) ? '' : href,
					actionHandler: href => { if (/^https?:\/\//iu.test(href)) { window.open(href, '_blank', 'noopener,noreferrer'); } },
				});
				row.body.replaceChildren(row.markdown.element);
			}
		}
		if (follow) { this.scroll.scrollTop = this.scroll.scrollHeight; }
		else if (state.sending) { this.jumpButton.hidden = false; }
	}

	private filterList(): void {
		const query = this.search.value.trim().toLocaleLowerCase();
		for (const button of this.list.querySelectorAll('button')) { button.hidden = !button.textContent?.toLocaleLowerCase().includes(query); }
	}

	private showText(title: string, content: string): void {
		const previous = document.activeElement as HTMLElement | null;
		const dialog = document.createElement('dialog');
		dialog.className = 'ash-chatgpt-dialog';
		const heading = document.createElement('h2');
		heading.id = 'ash-chatgpt-dialog-title';
		heading.textContent = title;
		dialog.setAttribute('aria-labelledby', heading.id);
		const text = document.createElement('pre');
		text.tabIndex = 0;
		text.textContent = content;
		const close = document.createElement('button');
		close.textContent = localize('sessions.chatgpt.close', 'Close');
		close.onclick = () => dialog.close();
		dialog.addEventListener('close', () => { dialog.remove(); previous?.focus(); }, { once: true });
		dialog.append(heading, text, close);
		this.root.append(dialog);
		dialog.showModal();
		text.focus();
	}

	private helpText(): string {
		return localize('sessions.chatgpt.helpContent', 'Choose a conversation from the sidebar, or select New chat. Use Tab to move between controls. Enter sends a message; Shift+Enter inserts a line break. Select Stop to interrupt a reply. Right-click text, the input, links or images for the browser menu. Read conversation opens a selectable plain-text view. Your existing local Codex login is reused automatically. After updating that login in Codex, select Connect. Your unsent draft is retained while switching conversations.');
	}

}

const page = new ChatGPTPage(document.getElementById('app')!);
window.addEventListener('pagehide', () => page.dispose(), { once: true });
