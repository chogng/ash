import { addDisposableListener } from '../../../../base/browser/dom.js';
import { type IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContentMarkdownRenderer } from '../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import type { ChatGPTMessage, ChatGPTResource } from './chatGPTClient.js';
import { ChatAttachmentsContentPart, type IChatAttachmentResource } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatAttachmentsContentPart.js';
import { IChatGPTService, type ChatGPTState } from './chatGPTService.js';
import { completeChatGPTRichContent, getChatGPTMarkdownRenderOptions } from './chatGPTRichContent.js';
import { ChatGPTInputWidget } from './chatGPTInputWidget.js';
import './media/chatGPTWidget.css';

export class ChatGPTWidget extends Disposable {
	private readonly markdownRenderer: ChatContentMarkdownRenderer;
	private readonly rendered = new Map<string, { element: HTMLElement; body: HTMLElement; markdown?: IRenderedMarkdown; attachments?: ChatAttachmentsContentPart; resources: readonly ChatGPTResource[]; text: string; }>();
	private readonly activities = new Map<string, {
		element: HTMLDetailsElement; summary: HTMLElement; label: HTMLElement; active: boolean;
		entries: Map<string, { element: HTMLDetailsElement; summary: HTMLElement; content: HTMLElement; }>;
	}>();
	private renderedConversationId: string | undefined;
	private readonly scroll = this.element('div', 'ash-chatgpt-scroll');
	private readonly messages = this.element('div', 'ash-chatgpt-messages');
	private readonly welcome = this.element('h1', 'ash-chatgpt-welcome');
	private readonly input: ChatGPTInputWidget;
	private readonly error = this.element('p', 'ash-chatgpt-error');
	private readonly status = this.element('span', 'ash-chatgpt-status');
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
		this.error.setAttribute('role', 'alert');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		const footer = this.element('div', 'ash-chatgpt-footer');
		this.input = this._register(instantiation.createInstance(ChatGPTInputWidget, footer));
		footer.append(this.error, this.status);
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

	public focus(): void { this.input.focus(); }
	public setVisible(visible: boolean): void {
		this.input.setVisible(visible);
		for (const row of this.rendered.values()) row.attachments?.setVisible(visible);
	}
	public setScrollingOptimization(enabled: boolean): void { this.root.classList.toggle('optimize-scrolling', enabled); }
	private atBottom(): boolean { return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80; }
	private roleLabel(role: ChatGPTMessage['role']): string { return role === 'user' ? localize('sessions.chatgpt.you', 'You') : 'ChatGPT'; }

	private renderActivity(id: string, messages: readonly ChatGPTMessage[], active: boolean): HTMLDetailsElement {
		let row = this.activities.get(id);
		if (!row) {
			const element = this.element('details', 'ash-chatgpt-activity');
			const summary = this.element('summary', 'ash-chatgpt-activity-summary');
			const label = this.element('span', 'ash-chatgpt-activity-label');
			label.setAttribute('aria-live', 'polite');
			summary.append(label);
			element.append(summary);
			row = { element, summary, label, active, entries: new Map() };
			this.activities.set(id, row);
		}
		// Collapse once when the answer starts. Later answer deltas must not close
		// details the user has deliberately reopened, or remove their keyboard focus.
		if (row.active && !active) {
			if (row.element.contains(row.element.ownerDocument.activeElement)) { row.summary.focus({ preventScroll: true }); }
			row.element.open = false;
		}
		row.active = active;
		row.element.classList.toggle('complete', !active);
		const latest = messages.at(-1)!;
		const failed = messages.some(message => message.activity?.failed);
		const steps = messages.length === 1 ? localize('sessions.chatgpt.activityOneStep', '1 step') : localize('sessions.chatgpt.activitySteps', '{0} steps', messages.length);
		const label = failed ? localize('sessions.chatgpt.activityFailed', 'Execution process · Some steps failed') : active
			? latest.activity?.tool ? localize('sessions.chatgpt.activityUsing', 'Using {0}… · {1}', latest.activity.tool, steps)
				: localize('sessions.chatgpt.activityWorking', 'Working… · {0}', steps)
			: localize('sessions.chatgpt.activityComplete', 'Execution process · {0}', steps);
		if (row.label.textContent !== label) { row.label.textContent = label; }
		row.label.title = label;
		row.element.classList.toggle('failed', failed);
		const ids = new Set(messages.map(message => message.id));
		for (const [entryId, entry] of row.entries) {
			if (!ids.has(entryId)) { entry.element.remove(); row.entries.delete(entryId); }
		}
		for (const message of messages) {
			let entry = row.entries.get(message.id);
			if (!entry) {
				const element = this.element('details', 'ash-chatgpt-activity-entry');
				const summary = this.element('summary', 'ash-chatgpt-activity-summary');
				const content = this.element('pre', 'ash-chatgpt-activity-content');
				element.append(summary, content);
				entry = { element, summary, content };
				row.entries.set(message.id, entry);
				row.element.append(element);
			}
			const activity = message.activity!;
			const name = activity.kind === 'call' ? localize('sessions.chatgpt.activityCall', 'Tool call: {0}', activity.tool ?? '')
				: activity.kind === 'result' ? localize('sessions.chatgpt.activityResult', 'Tool result: {0}', activity.tool ?? '')
					: localize('sessions.chatgpt.activityProgress', 'Progress');
			entry.summary.textContent = activity.failed ? localize('sessions.chatgpt.activityStepFailed', '{0} · Failed', name) : name;
			// Tool input is untrusted data, never Markdown or executable rich content.
			if (entry.content.textContent !== message.text) { entry.content.textContent = message.text; }
		}
		return row.element;
	}

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
		this.status.textContent = state.sending ? localize('sessions.chatgpt.replying', 'ChatGPT is replying…') :
			state.stopped ? localize('sessions.chatgpt.replyStopped', 'Reply stopped') : '';
		this.status.hidden = !this.status.textContent;
		this.messages.setAttribute('aria-busy', String(state.sending || state.busy));
		const ids = new Set(state.messages.filter(message => !message.activity).map(message => message.id));
		// One execution entry per user turn, derived from the service-owned record.
		const groups = new Map<string, ChatGPTMessage[]>();
		let group: ChatGPTMessage[] | undefined;
		let latest: ChatGPTMessage | undefined;
		for (const message of state.messages) {
			if (message.activity || message.text.trim() || message.resources?.length) { latest = message; }
			if (message.role === 'user') { group = undefined; }
			if (message.activity) {
				if (!group) { group = []; groups.set(message.id, group); }
				group.push(message);
			}
		}
		for (const [id, row] of this.activities) {
			if (!groups.has(id)) { row.element.remove(); this.activities.delete(id); }
		}
		for (const [id, row] of this.rendered) {
			if (!ids.has(id)) { row.markdown?.dispose(); row.attachments?.dispose(); row.element.remove(); this.rendered.delete(id); }
		}
		let previous: HTMLElement | undefined;
		const place = (element: HTMLElement): void => {
			const next = previous ? previous.nextElementSibling : this.messages.firstElementChild;
			if (next !== element) { this.messages.insertBefore(element, next); }
			previous = element;
		};
		for (const message of state.messages) {
			if (message.activity) {
				const activities = groups.get(message.id);
				if (activities) { place(this.renderActivity(message.id, activities, state.sending && activities.at(-1) === latest)); }
				continue;
			}
			let row = this.rendered.get(message.id);
			if (!row) {
				const element = this.element('article', `ash-chatgpt-turn ${message.role}`);
				element.setAttribute('aria-label', this.roleLabel(message.role));
				const body = this.element('div', 'ash-chatgpt-message-body');
				element.append(body);
				row = { element, body, resources: [], text: '' };
				this.rendered.set(message.id, row);
			}
			place(row.element);
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
