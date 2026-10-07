import { h } from '../../../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';

/** Displays the catalog description without changing model preferences. */
export class ModelCard extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly descriptionDomNode: HTMLElement;

	constructor(ownerDocument: Document) {
		super();
		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-chat-model-card';
		this.domNode.tabIndex = -1;
		this.descriptionDomNode = h(ownerDocument, 'p');
		this.descriptionDomNode.className = 'ash-chat-model-card-description';
		this.domNode.append(this.descriptionDomNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public update(entry: ModelCatalogEntry): void {
		const description = entry.description?.trim() ?? '';
		this.domNode.setAttribute('aria-label', entry.displayName);
		this.descriptionDomNode.textContent = description;
		this.domNode.hidden = description.length === 0;
		if (description) { this.domNode.setAttribute('aria-description', description); }
		else { this.domNode.removeAttribute('aria-description'); }
	}

	public focus(): void {
		if (!this.domNode.hidden) { this.domNode.focus(); }
	}
}
