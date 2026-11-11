import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import type { ChatMarkdownContentPart } from './chatMarkdownContentPart.js';

/** Keeps disclosure and visibility in sync with a row-owned Markdown part. */
export class ChatCollapsibleMarkdownContentPart extends ChatCollapsibleContentPart {
	private visible: boolean;

	constructor(document: Document, protected readonly markdown: ChatMarkdownContentPart, options: {
		readonly expanded: boolean;
		readonly visible: boolean;
		readonly className?: string;
		readonly summaryClassName?: string;
		readonly title?: string;
	}) {
		super(document, options.className);
		this.visible = options.visible;
		this.domNode.open = options.expanded;
		this.summary.className = options.summaryClassName ?? '';
		this.summary.textContent = options.title ?? '';
		this.domNode.append(markdown.domNode);
	}

	protected override expansionDidChange(expanded: boolean): void {
		this.markdown.setVisible(this.visible && expanded);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.expansionDidChange(this.domNode.open);
	}

	/** Reveal the text synchronously before navigation focuses its code block. */
	expandContent(): void {
		this.domNode.open = true;
		this.expansionDidChange(true);
	}
}
