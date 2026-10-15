import { addDisposableListener } from '../../../../base/browser/dom.js';
import { renderMarkdown, type IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { ChatGPTMessage, ChatGPTModel } from './chatGPTClient.js';
import { IChatGPTService, type ChatGPTState } from './chatGPTService.js';
import './media/chatGPTWidget.css';

export class ChatGPTWidget extends Disposable {
	private readonly rendered = new Map<string, { element: HTMLElement; body: HTMLElement; markdown?: IRenderedMarkdown; text: string; }>();
	private renderedConversationId: string | undefined;
	private modelReference: readonly ChatGPTModel[] | undefined;
	private readonly scroll = this.element('div', 'ash-chatgpt-scroll');
	private readonly messages = this.element('div', 'ash-chatgpt-messages');
	private readonly welcome = this.element('h1', 'ash-chatgpt-welcome');
	private readonly input = document.createElement('textarea');
	private readonly model = document.createElement('select');
	private readonly error = this.element('p', 'ash-chatgpt-error');
	private readonly status = this.element('span', 'ash-chatgpt-status');
	private readonly sendButton: HTMLButtonElement;
	private readonly jumpButton: HTMLButtonElement;

	constructor(private readonly root: HTMLElement, @IChatGPTService private readonly chat: IChatGPTService, @IOpenerService private readonly opener: IOpenerService) {
		super();
		root.className = 'ash-chatgpt-widget';
		root.tabIndex = -1;
		const main = this.element('main', 'ash-chatgpt-main');
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
		this.listen(this.input, 'input', () => { this.chat.setDraft(this.input.value); this.resizeInput(); });
		this.listen(this.input, 'keydown', event => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); composer.requestSubmit(); }
		});
		this.listen(composer, 'submit', event => { event.preventDefault(); void (this.chat.state.get().sending ? this.chat.stop() : this.chat.send()); });
		const controls = this.element('div', 'ash-chatgpt-composer-controls');
		this.model.setAttribute('aria-label', localize('sessions.chatgpt.model', 'Model'));
		this.listen(this.model, 'change', () => this.chat.setModel(this.model.value));
		this.sendButton = this.button(localize('sessions.chatgpt.send', 'Send'), () => { composer.requestSubmit(); });
		this.sendButton.classList.add('ash-chatgpt-send');
		controls.append(this.model, this.sendButton);
		composer.append(this.input, controls);
		this.error.setAttribute('role', 'alert');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		const footer = this.element('div', 'ash-chatgpt-footer');
		footer.append(composer, this.error, this.status);
		main.append(this.scroll, this.jumpButton, footer);
		root.append(main);
		this._register(autorun(reader => this.render(this.chat.state.read(reader))));
		this._register(toDisposable(() => { for (const item of this.rendered.values()) { item.markdown?.dispose(); } }));
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

	public focus(): void { if (this.input.disabled) { this.root.focus(); } else { this.input.focus(); } }
	public setScrollingOptimization(enabled: boolean): void { this.root.classList.toggle('optimize-scrolling', enabled); }
	private atBottom(): boolean { return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80; }
	private resizeInput(): void { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`; }
	private roleLabel(role: ChatGPTMessage['role']): string { return role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'; }
	private render(state: ChatGPTState): void {
		const follow = this.atBottom() || state.conversationId !== this.renderedConversationId;
		this.renderedConversationId = state.conversationId;
		this.root.classList.toggle('empty', !state.messages.length);
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
		if (this.modelReference !== state.models) {
			this.modelReference = state.models;
			this.model.replaceChildren(...state.models.map(model => new Option(model.title, model.id)));
		}
		this.model.value = state.model;
		if (this.input.value !== state.draft) { this.input.value = state.draft; this.resizeInput(); }
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
					actionHandler: href => { if (/^https?:\/\//iu.test(href)) { void this.opener.open(href); } },
				});
				row.body.replaceChildren(row.markdown.element);
			}
		}
		if (follow) { this.scroll.scrollTop = this.scroll.scrollHeight; }
		else if (state.sending) { this.jumpButton.hidden = false; }
	}

}
