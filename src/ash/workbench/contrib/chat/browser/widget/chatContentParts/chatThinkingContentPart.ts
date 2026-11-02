import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatAccessibilityProvider } from '../../accessibility/chatAccessibilityProvider.js';
import type { ChatMarkdownContentPart } from './chatMarkdownContentPart.js';
import './media/chatThinkingContent.css';

/** Owns the disclosure around a row-owned Markdown part; transcript data determines its status. */
export class ChatThinkingContentPart extends Disposable {
	public readonly domNode: HTMLDetailsElement;
	private readonly summary: HTMLElement;
	private readonly labels = new ChatAccessibilityProvider();
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;
	private visible: boolean;

	constructor(
		document: Document,
		private readonly markdown: ChatMarkdownContentPart,
		options: { readonly expanded: boolean; readonly visible: boolean; },
	) {
		super();
		this.visible = options.visible;
		this.domNode = h(document, 'details');
		this.domNode.className = 'ash-chat-thinking';
		this.domNode.open = options.expanded;
		this.summary = h(document, 'summary');
		this.summary.setAttribute('aria-live', 'polite');
		this.summary.setAttribute('aria-atomic', 'true');
		this.domNode.append(this.summary, markdown.domNode);
		this._register(addDisposableListener(this.domNode, 'toggle', () => {
			this.markdown.setVisible(this.visible && this.domNode.open);
			this.changedHeight.fire();
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public updateThinking(item: IChatListItem): void {
		const title = this.labels.getAriaLabel(item);
		if (this.summary.textContent !== title) {
			this.summary.textContent = title;
		}
		this.domNode.dataset.state = item.transient ? 'thinking' : 'complete';
		this.summary.setAttribute('aria-busy', String(item.transient));
		this.markdown.tryIncrementalUpdate({ value: item.text, supportThemeIcons: true, supportAlertSyntax: true }, item.transient);
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.markdown.setVisible(visible && this.domNode.open);
	}

	/** Navigation reveals the content synchronously before focusing a reasoning code block. */
	public expandContent(): void {
		this.domNode.open = true;
		this.markdown.setVisible(this.visible);
	}
}
