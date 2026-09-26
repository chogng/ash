import { List } from "../../../base/browser/ui/list/listWidget.js";
import { setRole } from "../../../base/browser/ui/aria/aria.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IQuickPickItem, IQuickPickItemButton } from "../common/quickInput.js";
import { h, stopEvent } from "../../../base/browser/dom.js";
import { localize } from '../../../nls.js';

export interface QuickInputListActiveChangeEvent<TItem> {
	readonly item: TItem | undefined;
	readonly rowId: string | undefined;
}

/** Searchable single-selection list shared by browser Quick Inputs. */
export class QuickInputList<TItem extends IQuickPickItem>
	extends Disposable {
	readonly element: HTMLDivElement;
	private readonly empty: HTMLDivElement;
	private readonly list: List<TItem>;
	private readonly _onDidAccept = this._register(new Emitter<TItem>());
	private readonly _onDidChangeActive =
		this._register(new Emitter<QuickInputListActiveChangeEvent<TItem>>());
	private readonly buttonEmitter = this._register(new Emitter<{ readonly item: TItem; readonly button: IQuickPickItemButton }>());
	private _items: readonly TItem[] = [];
	private _visibleItems: readonly TItem[] = [];
	private maxHeight = Number.POSITIVE_INFINITY;
	private query = "";

	readonly onDidAccept: Event<TItem> = this._onDidAccept.event;
	readonly onDidChangeActive:
		Event<QuickInputListActiveChangeEvent<TItem>> =
			this._onDidChangeActive.event;
	readonly onDidTriggerItemButton = this.buttonEmitter.event;

	constructor(container: HTMLElement) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-quick-pick-list";
		this._register(toDisposable(() => this.element.remove()));
		container.append(this.element);

		this.list = this._register(new List<TItem>(this.element, {
			ariaLabel: localize('quickInput.results', 'Quick Pick results'),
			scrolling: 'managed',
			renderItem: (item) => this.renderItem(item),
		}));
		this.list.element.classList.add("ash-quick-pick-list-items");
		this.list.domNode.classList.add('ash-quick-pick-list-scrollable');
		this.list.domNode.hidden = true;
		this.empty = h(ownerDocument, "div");
		this.empty.className = "ash-quick-pick-empty";
		setRole(this.empty, "status");
		this.empty.textContent = localize('quickInput.empty', 'No matching results');
		this.empty.hidden = true;
		this.element.append(this.empty);

		this._register(this.list.onDidAccept(({ item }) => {
			this._onDidAccept.fire(item);
		}));
		this._register(this.list.onDidChangeActive(({ item, rowId }) => {
			this._onDidChangeActive.fire({ item, rowId });
		}));
	}

	get listId(): string {
		return this.list.element.id;
	}

	get items(): readonly TItem[] {
		return this._items;
	}

	set items(items: readonly TItem[]) {
		this._items = [...items];
		this.render();
	}

	get visibleItems(): readonly TItem[] {
		return this._visibleItems;
	}

	get activeItem(): TItem | undefined {
		return this.list.activeItem;
	}

	filter(query: string): void {
		if (this.query === query) return;
		this.query = query;
		this.render();
	}

	focusNext(): void {
		this.list.focusNext();
	}

	focusPrevious(): void {
		this.list.focusPrevious();
	}

	acceptActive(): void {
		this.list.acceptActive();
	}

	layout(maxHeight = this.maxHeight): void {
		this.maxHeight = maxHeight;
		if (this.list.domNode.hidden) return;
		const contentHeight = this.list.element.scrollHeight;
		let height = Math.min(contentHeight, maxHeight);
		if (height < contentHeight) {
			let fullRowsHeight = 0;
			for (let index = 0; index < this._visibleItems.length; index++) {
				const rowHeight = this.list.getElementHeight(index);
				if (fullRowsHeight + rowHeight > height) break;
				fullRowsHeight += rowHeight;
			}
			if (fullRowsHeight > 0) height = fullRowsHeight;
		}
		this.list.layout(height);
	}

	private render(): void {
		this._visibleItems = filterQuickPickItems(
			this._items,
			this.query,
		);
		this.list.items = this._visibleItems;
		const empty = this._visibleItems.length === 0;
		this.list.domNode.hidden = empty;
		this.empty.hidden = !empty;
		this.layout();
	}

	private renderItem(item: TItem): HTMLDivElement {
		const ownerDocument = this.element.ownerDocument;
		const content = h(ownerDocument, "div");
		content.className = "ash-quick-pick-row-content";
		if (item.className) content.classList.add(...item.className.split(/\s+/).filter(Boolean));
		const text = h(ownerDocument, "span");
		text.className = "ash-quick-pick-row-text";
		const label = h(ownerDocument, "span");
		label.className = "ash-quick-pick-row-label";
		label.textContent = item.label;
		text.append(label);
		appendOptionalText(
			text,
			item.description,
			"ash-quick-pick-row-description",
			ownerDocument,
		);
		appendOptionalText(
			text,
			item.detail,
			"ash-quick-pick-row-detail",
			ownerDocument,
		);
		content.append(text);
		if (item.keybinding) {
			const keybinding = h(ownerDocument, "kbd");
			keybinding.className = "ash-quick-pick-row-keybinding";
			keybinding.textContent = item.keybinding;
			content.append(keybinding);
		}
		for (const button of item.buttons ?? []) {
			const action = h(ownerDocument, 'button');
			action.type = 'button';
			action.className = 'ash-quick-pick-row-action';
			action.textContent = button.label;
			action.setAttribute('aria-label', button.label);
			action.addEventListener('click', event => {
				stopEvent(event);
				this.buttonEmitter.fire({ item, button });
			});
			content.append(action);
		}
		return content;
	}
}

export function filterQuickPickItems<TItem extends IQuickPickItem>(
	items: readonly TItem[],
	query: string,
): readonly TItem[] {
	const tokens = normalize(query).split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [...items];
	return items
		.map((item, index) => ({
			item,
			index,
			score: scoreItem(item, tokens),
		}))
		.filter((entry) => entry.score >= 0)
		.sort((left, right) =>
			right.score - left.score || left.index - right.index
		)
		.map((entry) => entry.item);
}

function scoreItem(
	item: IQuickPickItem,
	tokens: readonly string[],
): number {
	const label = normalize(item.label);
	const searchable = normalize(
		[item.label, item.description, item.detail].filter(Boolean).join(" "),
	);
	let score = 0;
	for (const token of tokens) {
		const labelScore = scoreSubsequence(label, token);
		const searchableScore = scoreSubsequence(searchable, token);
		const tokenScore = labelScore >= 0
			? Math.max(labelScore + 40, searchableScore)
			: searchableScore;
		if (tokenScore < 0) return -1;
		score += tokenScore;
	}
	return score;
}

function scoreSubsequence(value: string, query: string): number {
	let valueIndex = 0;
	let score = 0;
	let previousMatch = -2;
	for (const character of query) {
		const match = value.indexOf(character, valueIndex);
		if (match < 0) return -1;
		score += match === previousMatch + 1 ? 8 : 2;
		if (match === 0 || /[\s._:/-]/.test(value[match - 1] ?? "")) {
			score += 6;
		}
		previousMatch = match;
		valueIndex = match + 1;
	}
	return score - Math.max(0, value.length - query.length) / 100;
}

function appendOptionalText(
	container: HTMLElement,
	value: string | undefined,
	className: string,
	ownerDocument: Document,
): void {
	if (!value) return;
	const element = h(ownerDocument, "span");
	element.className = className;
	element.textContent = value;
	container.append(element);
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase("en-US");
}
