import { addDisposableListener, getActiveElement, isNode } from '../../../base/browser/dom.js';
import { AnchorPosition } from '../../../base/browser/ui/contextview/contextview.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ActionListItemKind, type IActionListItem } from './actionList.js';
import { IActionWidgetService } from './actionWidget.js';

export interface IMultiSelectDropdownItem {
	/** Unique across all sections. */
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly disabled?: boolean;
}

export interface IMultiSelectDropdownSection {
	readonly label: string;
	readonly items: readonly IMultiSelectDropdownItem[];
}

export interface IMultiSelectDropdownOptions {
	readonly anchor: HTMLElement;
	readonly ariaLabel: string;
	/** Callers localize content and persist user selection changes. */
	readonly sections: readonly IMultiSelectDropdownSection[];
	readonly selectedIds: readonly string[];
	readonly searchable?: boolean;
	readonly filterPlaceholder?: string;
	readonly width?: number;
	readonly contextViewLayer?: number;
}

/** An immediate multi-choice popup; dismissal leaves the caller's selection intact. */
export class MultiSelectDropdown extends Disposable {
	private popup: object | undefined;
	private readonly listeners = this._register(new DisposableStore());
	private readonly selectionChanged = this._register(new Emitter<readonly string[]>());
	/** Snapshots follow section order, including selected items hidden by filtering. */
	public readonly onDidChangeSelection = this.selectionChanged.event;
	private readonly hidden = this._register(new Emitter<void>());
	public readonly onDidHide = this.hidden.event;

	constructor(@IActionWidgetService private readonly actionWidgetService: IActionWidgetService) {
		super();
		this._register(toDisposable(() => this.hide()));
	}

	public get isVisible(): boolean { return this.popup !== undefined; }

	public show(options: IMultiSelectDropdownOptions): void {
		this.assertNotDisposed();
		const catalog = options.sections.flatMap(section => section.items);
		const known = new Set(catalog.map(item => item.id));
		if (known.size !== catalog.length || known.has('') || options.selectedIds.some(id => !known.has(id))) {
			throw new TypeError('Multi-select items require unique nonempty IDs and known selected IDs');
		}
		if (options.width !== undefined && (!Number.isFinite(options.width) || options.width <= 0)) {
			throw new RangeError('Multi-select width must be positive and finite');
		}
		if (options.contextViewLayer !== undefined && !Number.isSafeInteger(options.contextViewLayer)) {
			throw new RangeError('Multi-select context view layer must be an integer');
		}
		this.hide();
		const selected = new Set(options.selectedIds);
		const items = (): IActionListItem<IMultiSelectDropdownItem>[] => {
			const result: IActionListItem<IMultiSelectDropdownItem>[] = [];
			for (const section of options.sections) {
				if (!section.items.length) {
					continue;
				}
				if (result.length) {
					result.push({ kind: ActionListItemKind.Separator, label: '' });
				}
				result.push({ kind: ActionListItemKind.Header, label: section.label });
				for (const item of section.items) {
					result.push({
						id: item.id, kind: ActionListItemKind.Action, item, label: item.label,
						description: item.description, detail: section.label,
						disabled: item.disabled, checked: selected.has(item.id),
					});
				}
			}
			return result;
		};
		const anchor = options.anchor;
		const previousExpanded = anchor.getAttribute('aria-expanded');
		const previousPopup = anchor.getAttribute('aria-haspopup');
		// Capture the trigger as the shared host's focus-return target.
		anchor.focus({ preventScroll: true });
		const popup = this.popup = {};
		anchor.setAttribute('aria-expanded', 'true');
		anchor.setAttribute('aria-haspopup', options.searchable ? 'listbox' : 'menu');
		this.actionWidgetService.show('multiSelectDropdown', false, items(), {
			onShow: container => {
				this.listeners.add(addDisposableListener(container, 'focusout', event => {
					const next = event.relatedTarget;
					if (isNode(next) && !container.contains(next) && !anchor.contains(next)) {
						// Let focusin reach the shared host before it decides whether to restore focus.
						queueMicrotask(() => {
							const active = getActiveElement(container.ownerDocument);
							if (this.popup === popup && active && !container.contains(active) && !anchor.contains(active)) {
								this.hide();
							}
						});
					}
				}));
			},
			onSelect: item => {
				if (selected.has(item.id)) {
					selected.delete(item.id);
				} else {
					selected.add(item.id);
				}
				this.actionWidgetService.updateItems(items(), { preserveScrollPosition: true });
				this.selectionChanged.fire(catalog.filter(item => selected.has(item.id)).map(item => item.id));
			},
			onHide: () => {
				if (this.popup !== popup) {
					return;
				}
				this.popup = undefined;
				this.listeners.clear();
				for (const [name, value] of [['aria-expanded', previousExpanded], ['aria-haspopup', previousPopup]] as const) {
					if (value === null) {
						anchor.removeAttribute(name);
					} else {
						anchor.setAttribute(name, value);
					}
				}
				queueMicrotask(() => this.hidden.fire());
			},
		}, anchor, {
			ariaLabel: options.ariaLabel, ariaMultiselectable: true,
			className: 'ash-multi-select-dropdown', anchorPosition: AnchorPosition.Below,
			showFilter: options.searchable, filterAsCombobox: options.searchable,
			focusFilterOnOpen: options.searchable, filterPlaceholder: options.filterPlaceholder,
			minWidth: options.width ?? 280, maxWidth: options.width ?? 280,
		}, options.contextViewLayer);
	}

	public hide(): void {
		if (this.popup) {
			this.actionWidgetService.hide();
		}
	}
}
