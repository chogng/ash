import { addDisposableListener } from '../../../../base/browser/dom.js';
import { type IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContentMarkdownRenderer } from '../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import type { ChatGPTMessage, ChatGPTModel, ChatGPTResource } from './chatGPTClient.js';
import { ChatAttachmentsContentPart, type IChatAttachmentResource } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatAttachmentsContentPart.js';
import { IChatGPTService, type ChatGPTState } from './chatGPTService.js';
import { completeChatGPTRichContent, getChatGPTMarkdownRenderOptions } from './chatGPTRichContent.js';
import './media/chatGPTWidget.css';

export class ChatGPTWidget extends Disposable {
	private readonly markdownRenderer: ChatContentMarkdownRenderer;
	private readonly rendered = new Map<string, { element: HTMLElement; body: HTMLElement; markdown?: IRenderedMarkdown; attachments?: ChatAttachmentsContentPart; resources: readonly ChatGPTResource[]; text: string; }>();
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
	private followOutput = true;

	constructor(private readonly root: HTMLElement, @IChatGPTService private readonly chat: IChatGPTService, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.markdownRenderer = this._register(instantiation.createInstance(ChatContentMarkdownRenderer));
		root.className = 'ash-chatgpt-widget';
		root.tabIndex = -1;
		const main = this.element('main', 'ash-chatgpt-main');
		this.scroll.append(this.welcome, this.messages);
		this.messages.setAttribute('role', 'log');
		this.messages.setAttribute('aria-label', localize('sessions.chatgpt.conversation', 'Conversation'));
		this.messages.setAttribute('aria-live', 'off');
		this.listen(this.scroll, 'scroll', () => {
			this.followOutput = this.atBottom();
			if (this.followOutput) { this.jumpButton.hidden = true; }
		});
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
		this._register(toDisposable(() => { for (const item of this.rendered.values()) { item.markdown?.dispose(); item.attachments?.dispose(); } }));
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
	public setVisible(visible: boolean): void { for (const row of this.rendered.values()) row.attachments?.setVisible(visible); }
	public setScrollingOptimization(enabled: boolean): void { this.root.classList.toggle('optimize-scrolling', enabled); }
	private atBottom(): boolean { return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80; }
	private resizeInput(): void { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`; }
	private roleLabel(role: ChatGPTMessage['role']): string { return role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'; }
	private render(state: ChatGPTState): void {
		const conversationChanged = state.conversationId !== this.renderedConversationId;
		const follow = this.atBottom() || conversationChanged;
		this.followOutput = follow;
		this.renderedConversationId = state.conversationId;
		this.root.classList.toggle('empty', !state.messages.length);
		this.welcome.textContent = localize('sessions.chatgpt.welcome', 'What can I help with?');
		this.welcome.hidden = state.messages.length > 0;
		this.error.textContent = state.error;
		this.error.hidden = !state.error;
		this.status.textContent = state.busy ? localize('sessions.chatgpt.loading', 'Loading…') : state.sending ? localize('sessions.chatgpt.replying', 'ChatGPT is replying…') :
			state.stopped ? localize('sessions.chatgpt.replyStopped', 'Reply stopped') : '';
		this.status.hidden = !this.status.textContent;
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
			if (!ids.has(id)) { row.markdown?.dispose(); row.attachments?.dispose(); row.element.remove(); this.rendered.delete(id); }
		}
		for (const message of state.messages) {
			let row = this.rendered.get(message.id);
			if (!row) {
				const element = this.element('article', `ash-chatgpt-turn ${message.role}`);
				element.setAttribute('aria-label', this.roleLabel(message.role));
				const body = this.element('div', 'ash-chatgpt-message-body');
				element.append(body);
				row = { element, body, resources: [], text: '' };
				this.rendered.set(message.id, row);
				this.messages.append(element);
			}
			row.element.classList.toggle('complete', !state.sending || message !== state.messages.at(-1));
			const contentIdentity = JSON.stringify([message.text, message.references]);
			if (row.text !== contentIdentity) {
				row.text = contentIdentity;
				row.markdown?.dispose();
				row.markdown = this.markdownRenderer.render({ value: message.text, isTrusted: false, supportHtml: message.role === 'assistant' }, {
					...getChatGPTMarkdownRenderOptions(message.role, message.references),
					ownerDocument: row.body.ownerDocument,
					fillInIncompleteTokens: state.sending,
					asyncRenderCallback: () => {
						if (this.followOutput) { this.scroll.scrollTop = this.scroll.scrollHeight; }
					},
				});
				completeChatGPTRichContent(row.markdown.element, state.conversationId);
				row.resources = [];
				for (const placeholder of row.markdown.element.querySelectorAll<HTMLElement>('[data-chatgpt-resource]')) {
					try {
						const value: unknown = JSON.parse(placeholder.dataset.chatgptResource!);
						if (isRecord(value) && typeof value.uri === 'string' && typeof value.name === 'string' && ['image', 'audio', 'video', 'document', 'html'].includes(value.kind as string)) {
							let frameOrigin: string | undefined;
							if (typeof value.frameOrigin === 'string') {
								const url = new URL(value.frameOrigin);
								if (url.protocol === 'https:' && url.origin === value.frameOrigin) frameOrigin = url.origin;
							}
							row.resources = [...row.resources, { uri: value.uri, name: value.name, kind: value.kind as ChatGPTResource['kind'], mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined, frameOrigin }];
						}
					} catch { /* A malformed resource keeps its readable label. */ }
					placeholder.removeAttribute('data-chatgpt-resource');
				}
				row.body.replaceChildren(row.markdown.element);
			} else if (conversationChanged && row.markdown) {
				// The web stream may assign its conversation ID after its first content.
				completeChatGPTRichContent(row.markdown.element, state.conversationId);
			}
			const resources = [...row.resources, ...(message.resources ?? [])];
			const unique = resources.filter((resource, index) => resources.findIndex(other => other.uri === resource.uri) === index && (!resource.uri.startsWith('sandbox:') || !!state.conversationId));
			if (unique.length) {
				const variables: IChatAttachmentResource[] = unique.map(resource => ({ type: 'resource', resource: URI.parse(resource.uri), name: resource.name, presentation: resource.kind, mimeType: resource.mimeType, frameOrigin: resource.frameOrigin }));
				if (row.attachments) { row.attachments.updateVariables(variables); }
				else {
					row.attachments = this.instantiation.createInstance(ChatAttachmentsContentPart, {
						ownerDocument: row.body.ownerDocument, variables,
						readResource: (resource: URI, signal: AbortSignal) => this.chat.readResource(resource.toString(), this.renderedConversationId, message.id, signal),
					});
					row.element.append(row.attachments.domNode);
				}
			} else { row.attachments?.dispose(); row.attachments = undefined; }
		}
		if (follow) { this.scroll.scrollTop = this.scroll.scrollHeight; }
		else if (state.sending) { this.jumpButton.hidden = false; }
	}

}
