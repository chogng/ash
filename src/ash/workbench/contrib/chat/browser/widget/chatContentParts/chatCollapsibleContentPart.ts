import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { DomWidget } from '../../../../../../platform/domWidget/browser/domWidget.js';

/** A stable native disclosure shared by transcript content parts. */
export abstract class ChatCollapsibleContentPart extends DomWidget {
	readonly domNode: HTMLDetailsElement;
	get element(): HTMLElement { return this.domNode; }
	protected readonly summary: HTMLElement;
	protected readonly changedHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this.changedHeight.event;

	protected constructor(document: Document, className?: string) {
		super();
		this.domNode = h(document, 'details', { className });
		this.summary = h(document, 'summary');
		this.domNode.append(this.summary);
		this._register(addDisposableListener(this.domNode, 'toggle', () => {
			this.expansionDidChange(this.domNode.open);
			this.changedHeight.fire();
		}));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	protected expansionDidChange(_expanded: boolean): void { }
}
