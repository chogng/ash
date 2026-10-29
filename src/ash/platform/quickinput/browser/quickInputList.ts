import { defaultCheckboxStyles, defaultKeybindingLabelStyles, defaultListStyles } from '../../theme/browser/defaultStyles.js';
import { scoreFuzzy } from '../../../base/common/fuzzyScorer.js';
import { List } from '../../../base/browser/ui/list/listWidget.js';
import { KeybindingLabel } from '../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import { setRole } from '../../../base/browser/ui/aria/aria.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import type { IKeyMods, IQuickPickItem, IQuickPickItemButton, IQuickPickSeparator } from '../common/quickInput.js';
import { QuickPickFocus } from '../common/quickInput.js';
import { addDisposableListener, h, isElement, stopEvent } from '../../../base/browser/dom.js';
import { localize } from '../../../nls.js';
import { appendIcon, getRegisteredIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { ActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../base/common/actions.js';
import { Checkbox } from '../../../base/browser/ui/toggle/toggle.js';

export interface QuickInputListActiveChangeEvent<TItem> {
	readonly item: TItem | undefined;
	readonly rowId: string | undefined;
}

/** Searchable list shared by browser Quick Inputs. */
export class QuickInputList<TItem extends IQuickPickItem>
	extends Disposable {
	readonly element: HTMLDivElement;
	private readonly empty: HTMLDivElement;
	private readonly list: List<TItem>;
	private readonly keybindingLabels = this._register(new DisposableMap<HTMLDivElement, KeybindingLabel>());
	private readonly rowActions = this._register(new DisposableMap<HTMLDivElement, ActionBar>());
	private readonly rowCheckboxes = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private readonly _onDidAccept = this._register(new Emitter<TItem>());
	private readonly _onDidChangeActive =
		this._register(new Emitter<QuickInputListActiveChangeEvent<TItem>>());
	private readonly buttonEmitter = this._register(new Emitter<{ readonly item: TItem; readonly button: IQuickPickItemButton; }>());
	private _items: readonly (TItem | IQuickPickSeparator)[] = [];
	private readonly headings = new Map<TItem, IQuickPickSeparator>();
	public keyMods: IKeyMods = { ctrlCmd: false, alt: false, shift: false };
	private _visibleItems: readonly TItem[] = [];
	private singleLineRows: boolean;
	private maxHeight = Number.POSITIVE_INFINITY;
	private query = '';
	private _sortByLabel = true;
	private multiple = false;
	// Checked references survive filtering; List selection contains only visible rows.
	private readonly checked = new Set<TItem>();
	private readonly selectionEmitter = this._register(new Emitter<readonly TItem[]>());
	public readonly onDidChangeSelection = this.selectionEmitter.event;

	public get canSelectMany(): boolean { return this.multiple; }
	public set canSelectMany(value: boolean) {
		this.multiple = value;
		this.list.element.setAttribute('aria-multiselectable', String(value));
		this.render();
	}
	public get selectedItems(): readonly TItem[] { return [...this.checked]; }
	public set selectedItems(items: readonly TItem[]) {
		this.checked.clear();
		for (const item of items) { this.checked.add(item); }
		this.render();
		this.selectionEmitter.fire(this.selectedItems);
	}
	public toggleActive(): void { if (this.activeItem) { this.toggleSelection(this.activeItem); } }
	private toggleSelection(item: TItem): void {
		if (this.checked.has(item)) { this.checked.delete(item); }
		else { this.checked.add(item); }
		this.render();
		this.selectionEmitter.fire(this.selectedItems);
	}

	readonly onDidAccept: Event<TItem> = this._onDidAccept.event;
	readonly onDidChangeActive:
		Event<QuickInputListActiveChangeEvent<TItem>> =
		this._onDidChangeActive.event;
	readonly onDidTriggerItemButton = this.buttonEmitter.event;

	constructor(container: HTMLElement, private readonly presentation: 'quickPick' | 'menu' | 'compactMenu' = 'quickPick') {
		super();
		this.singleLineRows = presentation === 'quickPick';
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'ash-quick-pick-list';
		if (presentation !== 'quickPick') this.element.classList.add('ash-quick-pick-list-menu');
		if (presentation === 'compactMenu') this.element.classList.add('ash-quick-pick-list-compact-menu');
		this._register(toDisposable(() => this.element.remove()));
		container.append(this.element);

		const owner = this;
		const singleLineHeight = () => 22;
		this.list = this._register(new List<TItem>(this.element, {
			styles: defaultListStyles,
			ariaLabel: localize('quickInput.results', 'Quick Pick results'),
			domFocusable: true,
			scrolling: 'managed',
			// Details and menus retain their content-sized geometry. Ordinary results
			// share the standard row height, so only the viewport needs DOM rows.
			get getHeight() { return owner.singleLineRows ? singleLineHeight : undefined; },
			accessibilityProvider: {
				getAriaSetSize: () => this._visibleItems.length,
				getAriaPosInSet: item => this._visibleItems.indexOf(item) + 1,
			},
			renderItem: (item, _index, row) => this.renderItem(item, row),
			onDidRemoveRow: row => {
				this.keybindingLabels.deleteAndDispose(row);
				this.rowActions.deleteAndDispose(row);
				this.rowCheckboxes.deleteAndDispose(row);
			},
		}));
		this.list.element.classList.add('ash-quick-pick-list-items');
		if (presentation === 'quickPick') {
			// Pointer focus still determines acceptance; only its visual treatment differs from keyboard focus.
			this._register(addDisposableListener(this.list.element, 'mousemove', event => {
				if (isElement(event.target) && event.target.closest('.ash-list-row')) {
					this.element.classList.add('pointer-navigation');
				}
			}));
			this._register(addDisposableListener(container, 'keydown', () => {
				this.element.classList.remove('pointer-navigation');
			}, true));
		}
		this.list.domNode.classList.add('ash-quick-pick-list-scrollable');
		this.list.domNode.hidden = true;
		this.empty = h(ownerDocument, 'div');
		this.empty.className = 'ash-quick-pick-empty';
		setRole(this.empty, 'status');
		this.empty.textContent = localize('quickInput.empty', 'No matching results');
		this.empty.hidden = true;
		this.element.append(this.empty);

		this._register(this.list.onDidAccept(({ item, browserEvent }) => {
			if (browserEvent) this.keyMods = { ctrlCmd: browserEvent.ctrlKey || browserEvent.metaKey, alt: browserEvent.altKey, shift: browserEvent.shiftKey };
			if (this.multiple && browserEvent?.type === 'click') {
				this.toggleSelection(item);
				return;
			}
			this._onDidAccept.fire(item);
		}));
		this._register(this.list.onDidChangeActive(({ item, rowId }) => {
			this._onDidChangeActive.fire({ item, rowId });
		}));
		// The focused option can mount after the input received logical focus,
		// or leave the DOM during scrolling. Keep the combobox's reference live.
		this._register(this.list.onDidRenderRows(() => {
			this._onDidChangeActive.fire({ item: this.list.activeItem, rowId: this.list.row(this.list.activeIndex)?.id });
		}));
	}

	get listId(): string {
		return this.list.element.id;
	}

	get items(): readonly (TItem | IQuickPickSeparator)[] {
		return this._items;
	}

	set items(items: readonly (TItem | IQuickPickSeparator)[]) {
		this._items = [...items];
		const previous = this.selectedItems;
		for (const item of previous) { if (!items.includes(item)) { this.checked.delete(item); } }
		for (const item of items) { if (!('type' in item) && item.picked) { this.checked.add(item); } }
		this.render();
		if (previous.length !== this.checked.size || previous.some(item => !this.checked.has(item))) { this.selectionEmitter.fire(this.selectedItems); }
	}

	get visibleItems(): readonly TItem[] {
		return this._visibleItems;
	}

	public get sortByLabel(): boolean { return this._sortByLabel; }
	public set sortByLabel(value: boolean) {
		if (this._sortByLabel === value) return;
		this._sortByLabel = value;
		this.render();
	}

	get activeItem(): TItem | undefined {
		return this.list.activeItem;
	}

	public setActiveItem(item: TItem): void {
		const index = this._visibleItems.indexOf(item);
		if (index >= 0) this.list.setActiveIndex(index);
	}

	filter(query: string): void {
		if (this.query === query) return;
		this.query = query;
		this.render();
	}

	focus(what: QuickPickFocus): void {
		this.element.classList.remove('pointer-navigation');
		switch (what) {
			case QuickPickFocus.First:
				this.list.setActiveIndex(0);
				break;
			case QuickPickFocus.Second:
				this.list.setActiveIndex(Math.min(1, this._visibleItems.length - 1));
				break;
			case QuickPickFocus.Last:
				this.list.setActiveIndex(this._visibleItems.length - 1);
				break;
			case QuickPickFocus.Next:
				this.list.focusNext();
				break;
			case QuickPickFocus.Previous:
				this.list.focusPrevious();
				break;
			case QuickPickFocus.NextPage:
				void this.list.focusNextPage();
				break;
			case QuickPickFocus.PreviousPage:
				void this.list.focusPreviousPage();
				break;
		}
	}

	acceptActive(event?: KeyboardEvent): void {
		this.list.acceptActive(event);
	}

	layout(maxHeight = this.maxHeight): void {
		this.maxHeight = maxHeight;
		if (this.list.domNode.hidden) return;
		const contentHeight = this.list.element.scrollHeight;
		this.element.classList.toggle('scrolling', contentHeight > maxHeight);
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
		this.headings.clear();
		const candidates: TItem[] = [];
		let heading: IQuickPickSeparator | undefined;
		for (const item of this._items) {
			if ('type' in item && item.type === 'separator') {
				heading = item;
			} else {
				const candidate = item as TItem;
				candidates.push(candidate);
				if (heading) this.headings.set(candidate, heading);
			}
		}
		this._visibleItems = filterQuickPickItems(
			candidates,
			this.query,
		);
		if (!this.sortByLabel) {
			const matches = new Set(this._visibleItems);
			this._visibleItems = candidates.filter(item => matches.has(item));
		}
		const active = this.list.activeItem;
		this.singleLineRows = this.presentation === 'quickPick' && !this._visibleItems.some(item => !!item.detail);
		this.element.classList.toggle('ash-quick-pick-list-virtualized', this.singleLineRows);
		this.list.items = this._visibleItems;
		// Item actions already provide Tab targets; otherwise the list needs its own.
		this.list.element.tabIndex = this._visibleItems.some(item => item.buttons?.length) ? -1 : 0;
		const activeIndex = active ? this._visibleItems.indexOf(active) : -1;
		if (activeIndex >= 0) { this.list.setActiveIndex(activeIndex); }
		if (this.multiple) { this.list.setSelection(this._visibleItems.flatMap((item, index) => this.checked.has(item) ? [index] : [])); }
		const empty = this._visibleItems.length === 0;
		this.list.domNode.hidden = empty;
		this.empty.hidden = !empty;
		this.layout();
	}

	private renderItem(item: TItem, row: HTMLDivElement): HTMLDivElement {
		this.rowActions.deleteAndDispose(row);
		this.rowCheckboxes.deleteAndDispose(row);
		const ownerDocument = this.element.ownerDocument;
		const content = h(ownerDocument, 'div');
		content.className = 'ash-quick-pick-row-content';
		const index = this._visibleItems.indexOf(item);
		const heading = this.headings.get(item);
		if (heading && (index === 0 || this.headings.get(this._visibleItems[index - 1]) !== heading)) {
			if (heading.label) {
				const separator = h(ownerDocument, 'div');
				separator.className = 'ash-quick-pick-separator';
				separator.setAttribute('role', 'separator');
				separator.setAttribute('aria-label', heading.label);
				separator.textContent = heading.label;
				separator.title = heading.label;
				content.append(separator);
			}
			content.classList.add('has-separator');
		}
		if (item.className) content.classList.add(...item.className.split(/\s+/).filter(Boolean));
		if (this.multiple) {
			// The active option announces checked state; the visual control shares
			// its keyboard target instead of adding another stop to every row.
			row.setAttribute('aria-checked', String(this.checked.has(item)));
			const resources = new DisposableStore();
			const checkbox = resources.add(new Checkbox(content, {
				...defaultCheckboxStyles,
				checked: this.checked.has(item),
				ariaLabel: item.label,
				onChange: () => this.toggleSelection(item),
			}));
			checkbox.element.classList.add('ash-quick-pick-row-checkbox');
			checkbox.element.setAttribute('aria-hidden', 'true');
			checkbox.input.tabIndex = -1;
			resources.add(addDisposableListener(checkbox.element, 'click', event => {
				// Native activation changes the checkbox once; row activation is
				// handled separately when clicking the rest of the option.
				event.stopPropagation();
				this.list.domFocus();
				this.setActiveItem(item);
			}));
			this.rowCheckboxes.set(row, resources);
		} else {
			row.removeAttribute('aria-checked');
		}
		if (item.iconClass) {
			const classes = item.iconClass.split(/\s+/).filter(Boolean);
			const iconId = classes.find(name => name.startsWith('ash-icon-'))?.slice('ash-icon-'.length);
			const registeredIcon = iconId ? getRegisteredIcon(iconId, ownerDocument) : undefined;
			const icon = registeredIcon ? appendIcon(registeredIcon, content) : h(ownerDocument, 'span');
			icon.classList.add(...classes);
			icon.setAttribute('aria-hidden', 'true');
			content.append(icon);
		}
		const text = h(ownerDocument, 'span');
		text.className = 'ash-quick-pick-row-text';
		const label = h(ownerDocument, 'span');
		label.className = 'ash-quick-pick-row-label';
		label.textContent = item.label;
		label.title = item.label;
		text.append(label);
		appendOptionalText(
			text,
			item.description,
			'ash-quick-pick-row-description',
			ownerDocument,
		);
		appendOptionalText(
			text,
			item.detail,
			'ash-quick-pick-row-detail',
			ownerDocument,
		);
		content.append(text);
		if (!this.multiple && item.picked !== undefined) {
			content.classList.toggle('picked', !!item.picked);
			const check = h(ownerDocument, 'span');
			check.className = 'ash-quick-pick-row-check';
			check.setAttribute('aria-hidden', 'true');
			appendIcon(Lxicon.check, check);
			content.append(check);
		}
		if (item.keybinding) {
			const keybinding = new KeybindingLabel(content, {
				...defaultKeybindingLabelStyles,
				keybinding: item.keybinding,
				presentation: 'keycap',
			});
			keybinding.element.classList.add('ash-quick-pick-row-keybinding');
			this.keybindingLabels.set(row, keybinding);
		}
		if (item.buttons?.length) {
			const buttons = item.buttons;
			const actions = new ActionBar(content, {
				ariaLabel: localize('quickInput.itemActions', 'Actions for {0}', item.label),
				actionViewItemProvider: action => new QuickInputButtonActionViewItem(action, buttons.find(button => button.id === action.id)?.iconClass),
				actions: buttons.map(button => ({
					id: button.id,
					label: button.label,
					tooltip: button.label,
					enabled: true,
					run: context => {
						// The view supplies the native click event for both pointer and keyboard activation.
						const event = context as MouseEvent;
						this.keyMods = { ctrlCmd: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey };
						this.buttonEmitter.fire({ item, button });
					},
				})),
			});
			actions.element.classList.add('ash-quick-pick-row-actions');
			this.rowActions.set(row, actions);
		}
		return content;
	}
}

/** Keeps the approved row-button presentation while ActionBar owns action navigation and lifetime. */
class QuickInputButtonActionViewItem extends ActionViewItem {
	private button: HTMLButtonElement | undefined;

	constructor(action: IAction, private readonly iconClass: string | undefined) {
		super(action);
	}

	override render(container: HTMLElement): void {
		const ownerDocument = container.ownerDocument;
		const button = h(ownerDocument, 'button');
		button.type = 'button';
		button.disabled = !this.action.enabled;
		button.className = 'ash-quick-pick-row-action';
		button.textContent = this.iconClass ? '' : this.action.label;
		button.setAttribute('aria-label', this.action.label);
		if (this.iconClass) {
			button.classList.add('icon-only');
			const iconId = this.iconClass.split(/\s+/).find(name => name.startsWith('ash-icon-'))?.slice('ash-icon-'.length);
			const icon = iconId ? getRegisteredIcon(iconId, ownerDocument) : undefined;
			if (icon) {
				appendIcon(icon, button);
			} else {
				const artwork = h(ownerDocument, 'span');
				artwork.className = this.iconClass;
				artwork.setAttribute('aria-hidden', 'true');
				button.append(artwork);
			}
		}
		this._register(addDisposableListener(button, 'click', event => {
			stopEvent(event);
			this.action.run(event);
		}));
		this.setupHover(button, this.action.tooltip);
		this._register(toDisposable(() => button.remove()));
		this.button = button;
		container.append(button);
	}

	override setTabbable(tabbable: boolean): void {
		if (this.button) this.button.tabIndex = tabbable ? 0 : -1;
	}

	override focus(): void {
		this.button?.focus();
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
			score: item.alwaysShow ? 0 : scoreItem(item, tokens),
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
		[item.label, item.description, item.detail].filter(Boolean).join(' '),
	);
	let score = 0;
	for (const token of tokens) {
		const [labelMatch] = scoreFuzzy(label, token, token, true);
		const [searchableMatch] = scoreFuzzy(searchable, token, token, true);
		const labelScore = labelMatch > 0 ? labelMatch - Math.max(0, label.length - token.length) / 100 : -1;
		const searchableScore = searchableMatch > 0 ? searchableMatch - Math.max(0, searchable.length - token.length) / 100 : -1;
		const tokenScore = labelScore >= 0
			? Math.max(labelScore + 40, searchableScore)
			: searchableScore;
		if (tokenScore < 0) return -1;
		score += tokenScore;
	}
	return score;
}

function appendOptionalText(
	container: HTMLElement,
	value: string | undefined,
	className: string,
	ownerDocument: Document,
): void {
	if (!value) return;
	const element = h(ownerDocument, 'span');
	element.className = className;
	element.textContent = value;
	element.title = value;
	container.append(element);
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase('en-US');
}
