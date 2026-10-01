import './breadcrumbsWidget.css';
import { addDisposableListener, h, type Dimension } from '../../dom.js';
import { measure } from '../../scheduler.js';
import { Emitter, type Event } from '../../../common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { ScrollbarVisibility } from '../../../common/scrollable.js';
import type { ThemeIcon } from '../../../common/themables.js';
import { ScrollableElement } from '../scrollbar/scrollableElement.js';
import { appendIcon } from '../lxicons/lxicon.js';

/** Ownership of supplied items transfers to the widget until replacement or disposal. */
export abstract class BreadcrumbsItem {
	public abstract dispose(): void;
	public abstract equals(other: BreadcrumbsItem): boolean;
	public abstract render(container: HTMLElement): void;
}

export interface IBreadcrumbsWidgetStyles {
	readonly breadcrumbsBackground: string | undefined;
	readonly breadcrumbsForeground: string | undefined;
	readonly breadcrumbsHoverForeground: string | undefined;
	readonly breadcrumbsFocusForeground: string | undefined;
	readonly breadcrumbsFocusAndSelectionForeground: string | undefined;
}

export interface IBreadcrumbsItemEvent {
	type: 'select' | 'focus';
	item: BreadcrumbsItem | undefined;
	node: HTMLElement | undefined;
	payload: unknown;
}

interface BreadcrumbEntry {
	readonly item: BreadcrumbsItem;
	readonly domNode: HTMLElement;
	readonly button: HTMLButtonElement;
}

/** Domain-neutral breadcrumb interaction; the host supplies labels and activation behavior. */
export class BreadcrumbsWidget extends Disposable {
	private readonly listDomNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private entries: BreadcrumbEntry[] = [];
	private focused: BreadcrumbsItem | undefined;
	private selected: BreadcrumbsItem | undefined;
	private enabled = true;
	private readonly pendingReveal = this._register(new MutableDisposable());
	private readonly focusEmitter = this._register(new Emitter<IBreadcrumbsItemEvent>());
	private readonly selectionEmitter = this._register(new Emitter<IBreadcrumbsItemEvent>());
	private readonly domFocusEmitter = this._register(new Emitter<boolean>());
	public readonly onDidFocusItem: Event<IBreadcrumbsItemEvent> = this.focusEmitter.event;
	public readonly onDidSelectItem: Event<IBreadcrumbsItemEvent> = this.selectionEmitter.event;
	public readonly onDidChangeFocus: Event<boolean> = this.domFocusEmitter.event;

	constructor(
		container: HTMLElement,
		horizontalScrollbarSize: number,
		horizontalScrollbarVisibility: ScrollbarVisibility = ScrollbarVisibility.Auto,
		private readonly separatorIcon: ThemeIcon,
		styles: IBreadcrumbsWidgetStyles,
		private readonly scheduleMeasure: typeof measure = measure,
	) {
		super();
		this.scrollable = this._register(new ScrollableElement(container, {
			direction: 'horizontal',
			horizontal: horizontalScrollbarVisibility === ScrollbarVisibility.Hidden ? 'hidden'
				: horizontalScrollbarVisibility === ScrollbarVisibility.Visible ? 'visible' : 'auto',
			scrollbarSize: horizontalScrollbarSize,
			tabIndex: -1,
		}));
		this.scrollable.element.classList.add('ash-breadcrumbs-widget');
		this.listDomNode = h(container.ownerDocument, 'div');
		this.listDomNode.className = 'ash-breadcrumbs-list';
		this.listDomNode.setAttribute('role', 'list');
		this.scrollable.setContent(this.listDomNode);
		const styleValues = {
			'--ash-breadcrumbs-widget-background': styles.breadcrumbsBackground,
			'--ash-breadcrumbs-widget-foreground': styles.breadcrumbsForeground,
			'--ash-breadcrumbs-widget-hover': styles.breadcrumbsHoverForeground,
			'--ash-breadcrumbs-widget-focus': styles.breadcrumbsFocusForeground,
			'--ash-breadcrumbs-widget-selection': styles.breadcrumbsFocusAndSelectionForeground,
		};
		for (const [property, value] of Object.entries(styleValues)) {
			if (value !== undefined) {
				this.scrollable.element.style.setProperty(property, value);
			}
		}
		this._register(addDisposableListener(this.listDomNode, 'click', (event: MouseEvent) => {
			const entry = this.entries.find(candidate => candidate.button.contains(event.target as Node));
			if (this.enabled && entry) {
				this.setFocused(entry.item, event);
				this.setSelection(entry.item, event);
			}
		}));
		this._register(addDisposableListener(this.listDomNode, 'focusin', (event: FocusEvent) => {
			const entry = this.entries.find(candidate => candidate.button === event.target);
			if (entry && entry.item !== this.focused) {
				this.setFocused(entry.item, event);
			}
			if (!this.listDomNode.contains(event.relatedTarget as Node | null)) {
				this.domFocusEmitter.fire(true);
			}
		}));
		this._register(addDisposableListener(this.listDomNode, 'focusout', (event: FocusEvent) => {
			if (!this.listDomNode.contains(event.relatedTarget as Node | null)) {
				this.domFocusEmitter.fire(false);
			}
		}));
		this._register(addDisposableListener(this.listDomNode, 'keydown', (event: KeyboardEvent) => {
			if (!this.enabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
				event.preventDefault();
				event.stopPropagation();
				switch (event.key) {
					case 'ArrowLeft': this.focusPrev(event); break;
					case 'ArrowRight': this.focusNext(event); break;
					case 'Home': this.setFocused(this.entries[0]?.item, event); break;
					case 'End': this.setFocused(this.entries.at(-1)?.item, event); break;
				}
			}
		}));
		this._register(toDisposable(() => {
			for (const entry of this.entries) {
				entry.item.dispose();
			}
			this.entries = [];
		}));
	}

	public getItems(): readonly BreadcrumbsItem[] {
		return this.entries.map(entry => entry.item);
	}

	public setHorizontalScrollbarSize(size: number): void {
		this.scrollable.updateOptions({ scrollbarSize: size });
	}

	public setHorizontalScrollbarVisibility(visibility: ScrollbarVisibility): void {
		const values = { [ScrollbarVisibility.Auto]: 'auto', [ScrollbarVisibility.Visible]: 'visible', [ScrollbarVisibility.Hidden]: 'hidden' } as const;
		this.scrollable.updateOptions({ horizontal: values[visibility] });
	}

	public setItems(items: BreadcrumbsItem[]): void {
		this.pendingReveal.clear();
		const previous = this.entries;
		let prefix = 0;
		while (prefix < previous.length && prefix < items.length && previous[prefix]!.item.equals(items[prefix]!)) {
			if (items[prefix] !== previous[prefix]!.item) {
				items[prefix]!.dispose();
			}
			prefix++;
		}
		const next = previous.slice(0, prefix);
		for (const item of items.slice(prefix)) {
			const domNode = h(this.listDomNode.ownerDocument, 'div');
			domNode.className = 'ash-breadcrumb-entry';
			domNode.setAttribute('role', 'listitem');
			const button = h(domNode.ownerDocument, 'button');
			button.type = 'button';
			button.className = 'ash-breadcrumb-item';
			button.disabled = !this.enabled;
			button.tabIndex = -1;
			item.render(button);
			const separator = h(domNode.ownerDocument, 'span');
			separator.className = 'ash-breadcrumb-separator';
			separator.setAttribute('aria-hidden', 'true');
			appendIcon(this.separatorIcon, separator);
			domNode.append(button, separator);
			next.push({ item, domNode, button });
		}
		for (const entry of previous.slice(prefix)) {
			entry.domNode.remove();
			entry.item.dispose();
		}
		this.entries = next;
		for (const entry of next.slice(prefix)) {
			this.listDomNode.append(entry.domNode);
		}
		this.setFocused(undefined);
		this.setSelection(undefined);
		this.layout(undefined);
	}

	public setEnabled(value: boolean): void {
		this.enabled = value;
		this.scrollable.element.classList.toggle('disabled', !value);
		this.listDomNode.setAttribute('aria-disabled', String(!value));
		for (const entry of this.entries) {
			entry.button.disabled = !value;
		}
	}

	public getFocused(): BreadcrumbsItem | undefined { return this.focused; }
	public getSelection(): BreadcrumbsItem | undefined { return this.selected; }
	public isDOMFocused(): boolean { return this.listDomNode.contains(this.listDomNode.ownerDocument.activeElement); }

	public domFocus(): void {
		if (this.enabled) {
			this.setFocused(this.focused ?? this.entries[0]?.item);
		}
	}

	public setFocused(item: BreadcrumbsItem | undefined, payload?: unknown): void {
		this.pendingReveal.clear();
		const entry = this.entries.find(candidate => candidate.item === item);
		this.focused = entry?.item;
		for (const candidate of this.entries) {
			candidate.button.classList.toggle('focused', candidate === entry);
			candidate.button.tabIndex = candidate === (entry ?? this.entries.at(-1)) ? 0 : -1;
		}
		if (this.enabled && entry) {
			entry.button.focus({ preventScroll: true });
			this.scrollable.reveal(entry.button);
		}
		this.focusEmitter.fire({ type: 'focus', item: entry?.item, node: entry?.button, payload });
	}

	public focusPrev(payload?: unknown): void {
		const index = this.entries.findIndex(entry => entry.item === this.focused);
		if (index > 0) {
			this.setFocused(this.entries[index - 1]!.item, payload);
		}
	}

	public focusNext(payload?: unknown): void {
		const index = this.entries.findIndex(entry => entry.item === this.focused);
		if (index + 1 < this.entries.length) {
			this.setFocused(this.entries[index + 1]!.item, payload);
		}
	}

	public setSelection(item: BreadcrumbsItem | undefined, payload?: unknown): void {
		const entry = this.entries.find(candidate => candidate.item === item);
		this.selected = entry?.item;
		for (const candidate of this.entries) {
			candidate.button.classList.toggle('selected', candidate === entry);
			candidate.button.setAttribute('aria-pressed', String(candidate === entry));
		}
		this.selectionEmitter.fire({ type: 'select', item: entry?.item, node: entry?.button, payload });
	}

	public layout(dimension: Dimension | undefined): void {
		if (dimension) {
			this.scrollable.element.style.width = `${dimension.width}px`;
			this.scrollable.element.style.height = `${dimension.height}px`;
		}
		this.scrollable.layout();
	}

	public reveal(item: BreadcrumbsItem): void {
		this.pendingReveal.clear();
		const entry = this.entries.find(candidate => candidate.item === item);
		if (entry) {
			// Hosts update the path before its layout settles; focus reveals remain synchronous.
			this.pendingReveal.value = this.scheduleMeasure(this.listDomNode.ownerDocument.defaultView!, () => {
				this.scrollable.reveal(entry.button);
			});
		}
	}

	public revealLast(): void {
		const item = this.entries.at(-1)?.item;
		if (item) {
			this.reveal(item);
		}
	}
}
