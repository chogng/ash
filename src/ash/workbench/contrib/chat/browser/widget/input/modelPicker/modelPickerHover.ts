import { h } from '../../../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ModelRef } from '../../../../../../services/chat/common/chatService.js';
import type { ModelCatalogEntry } from '../../../../../../services/chat/common/modelCatalog.js';
import { ModelCard } from './modelPickerCard.js';

/** Owns the active model card and positions it beside the flat menu. */
export class ModelPickerDetailsMenu extends Disposable {
	public readonly domNode: HTMLElement;
	private model: ModelRef | undefined;
	private readonly cardScope = this._register(new MutableDisposable<DisposableStore>());
	private card: ModelCard | undefined;
	private active: { entry: ModelCatalogEntry; row: HTMLElement; } | undefined;

	constructor(private readonly picker: HTMLElement) {
		super();
		this.domNode = h(picker.ownerDocument, 'div');
		this.domNode.className = 'ash-chat-model-picker-details-menu';
		this.domNode.hidden = true;
		picker.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public show(entry: ModelCatalogEntry, row: HTMLElement): void {
		if (!entry.description?.trim()) { this.hide(); return; }
		this.active = { entry, row };
		if (!this.card || this.model?.provider !== entry.model.provider || this.model.model !== entry.model.model) {
			const scope = new DisposableStore();
			this.cardScope.value = scope;
			this.model = entry.model;
			const cards = ModelCard.createObservable(scope, this.picker.ownerDocument);
			this.card = cards.get();
			this.domNode.append(this.card.element);
			scope.add(cards.onDidChange(card => {
				const previous = this.card!;
				const hadFocus = previous.element.contains(this.picker.ownerDocument.activeElement);
				previous.element.replaceWith(card.element);
				this.card = card;
				if (this.active) { this.show(this.active.entry, this.active.row); }
				if (hadFocus) { card.focus(); }
			}));
		}
		this.card.update(entry);
		this.domNode.hidden = false;
		const pickerBounds = this.picker.getBoundingClientRect();
		const rowBounds = row.getBoundingClientRect();
		const detailsBounds = this.domNode.getBoundingClientRect();
		const viewport = this.picker.ownerDocument.defaultView!;
		const rightSpace = viewport.innerWidth - pickerBounds.right;
		this.domNode.classList.toggle('is-left', pickerBounds.left >= detailsBounds.width + 4 || pickerBounds.left > rightSpace);
		const bottom = viewport.innerHeight - pickerBounds.top - detailsBounds.height - 8;
		this.domNode.style.top = `${Math.max(-pickerBounds.top + 8, Math.min(rowBounds.top - pickerBounds.top, bottom))}px`;
	}

	public focus(): void {
		this.card?.focus();
	}

	public hide(): void {
		this.domNode.hidden = true;
		this.active = undefined;
		this.cardScope.clear();
		this.card = undefined;
	}
}
