import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatResultListSubPart } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatResultListSubPart.js';
import { ChatContentMarkdownRenderer } from '../../../../workbench/contrib/chat/browser/widget/chatContentMarkdownRenderer.js';
import { wrapTablesWithScrollable } from '../../../../workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownTableScrolling.js';
import type { IRenderedMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { coworkTaskStatus, type ChatCoworkTaskView } from './chatGPTService.js';

/** A Chat timeline entry renders the owning Cowork thread's progress and result resources. */
export class ChatCoworkTaskContent extends Disposable {
	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly body: HTMLElement;
	private task: ChatCoworkTaskView | undefined;
	private readonly results = this._register(new DisposableMap<string, ChatResultListSubPart>());
	private readonly markdown = this._register(new DisposableMap<string, IRenderedMarkdown>());
	private readonly renderer: ChatContentMarkdownRenderer;
	private readonly renderedText = new Map<string, string>();

	constructor(
		document: Document,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionsService sessions: ISessionsService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.renderer = this._register(instantiation.createInstance(ChatContentMarkdownRenderer));
		this.element = h(document, 'article');
		this.element.className = 'ash-chatgpt-turn assistant';
		this.element.setAttribute('aria-label', localize('sessions.chat.coworkTask', 'Cowork task'));
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.detail = h(document, 'p');
		this.body = h(document, 'div');
		this.element.append(this.status, this.detail, this.body);
		this._register(new Button(this.element, {
			...defaultButtonStyles,
			label: localize('sessions.chat.openCoworkTask', 'Open Cowork task'),
			presentation: 'secondary',
			onClick: () => {
				const task = this.task;
				if (task) void sessions.openThread(task.sessionId, task.threadId).catch(error => notifications.error(error));
			},
		}));
	}

	render(task: ChatCoworkTaskView): void {
		this.task = task;
		const status = coworkTaskStatus(task);
		if (this.status.textContent !== status) this.status.textContent = status;
		this.detail.textContent = [task.prompt, task.thread?.turns.at(-1)?.error?.message ?? task.error ?? task.readError].filter(Boolean).join('\n');
		const nodes: HTMLElement[] = [];
		const present = new Set<string>();
		for (const turn of task.thread?.turns ?? []) {
			for (const item of turn.items) {
				if (item.type === 'agentMessage' || item.type === 'plan') {
					present.add(item.itemId);
					let rendered = this.markdown.get(item.itemId);
					if (!rendered || this.renderedText.get(item.itemId) !== item.text) {
						rendered = this.renderer.render({ value: item.text, isTrusted: false }, { ownerDocument: this.element.ownerDocument });
						wrapTablesWithScrollable(rendered.element);
						this.markdown.set(item.itemId, rendered);
						this.renderedText.set(item.itemId, item.text);
					}
					nodes.push(rendered.element);
				} else if (item.type === 'toolResult' && item.content?.some(part => part.type === 'artifact')) {
					present.add(item.itemId);
					let result = this.results.get(item.itemId);
					if (!result) {
						result = this.instantiation.createInstance(ChatResultListSubPart, this.element.ownerDocument);
						this.results.set(item.itemId, result);
					}
					result.render(item.content, item.itemId, { sessionId: task.sessionId, threadId: task.threadId, itemId: item.itemId });
					nodes.push(result.domNode);
				}
			}
		}
		for (const [id] of this.results) if (!present.has(id)) this.results.deleteAndDispose(id);
		for (const [id] of this.markdown) {
			if (!present.has(id)) { this.markdown.deleteAndDispose(id); this.renderedText.delete(id); }
		}
		const keep = new Set(nodes);
		for (const node of [...this.body.children]) if (!keep.has(node as HTMLElement)) node.remove();
		for (const [index, node] of nodes.entries()) {
			const current = this.body.children.item(index);
			if (current !== node) this.body.insertBefore(node, current);
		}
	}
}
