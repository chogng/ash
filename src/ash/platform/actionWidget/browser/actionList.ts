import { getTabbableElements } from '../../../base/browser/focus.js';
import { defaultButtonStyles, defaultDialogStyles, defaultInputBoxStyles, defaultMenuStyles, defaultKeybindingLabelStyles, defaultCheckboxStyles } from '../../theme/browser/defaultStyles.js';
import { addDisposableListener, getActiveElement, getWindow, h, isHTMLElement, stopEvent } from '../../../base/browser/dom.js';
import { ActionViewItem, ButtonActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../base/browser/ui/inputbox/inputbox.js';
import { Emitter } from '../../../base/common/event.js';
import '../../../base/browser/ui/dialog/dialog.css';
import '../../../base/browser/ui/menu/menu.css';
import { Dialog } from '../../../base/browser/ui/dialog/dialog.js';
import type { AnchorPosition } from '../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../base/browser/ui/menu/menu.js';
import { Separator, SubmenuAction, type IAction } from '../../../base/common/actions.js';
import type { Icon } from '../../../base/common/icon.js';
import type { ResolvedKeybinding } from '../../../base/common/keybindings.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import { finishActionWidgetOpeningAnimation } from './actionWidgetMotion.js';
import './actionWidget.css';

export const enum ActionListItemKind {
	Action = 'action',
	Header = 'header',
	Separator = 'separator',
}

export interface IActionListItem<T> {
	readonly id?: string;
	readonly kind: ActionListItemKind;
	readonly item?: T;
	readonly submenu?: readonly IActionListItem<T>[];
	readonly label: string;
	readonly disabled?: boolean;
	readonly group?: { readonly title: string; readonly icon?: Icon; };
	readonly checked?: boolean;
	readonly canPreview?: boolean;
	readonly keybinding?: ResolvedKeybinding;
	/** Visible status text, included in search and the accessible description. */
	readonly badge?: string;
	/** Searchable metadata announced with the action, separate from the visible label and badge. */
	readonly detail?: string;
	readonly description?: string;
}

export interface IActionListOptions {
	readonly anchorPosition?: AnchorPosition;
	readonly className?: string;
	readonly presentation?: 'menu' | 'details';
	/** Disable row tooltips when the visible content already conveys the full description. */
	readonly showRowTooltips?: boolean;
	readonly showFilter?: boolean;
	readonly filterPlaceholder?: string;
	readonly onDidChangeFilter?: (text: string) => void;
	readonly focusFilterOnOpen?: boolean;
	readonly focusItemOnOpen?: boolean;
	readonly filterAsCombobox?: boolean;
	readonly ariaMultiselectable?: boolean;
	readonly ariaLabel?: string;
	readonly header?: HTMLElement;
	readonly footer?: HTMLElement;
	readonly accessibilityHelp?: () => void;
	readonly filterVisible?: boolean;
	readonly itemsVisible?: boolean;
	/** Minimum popup width in CSS pixels, including its border. */
	readonly minWidth?: number;
	/** Maximum popup width in CSS pixels; longer labels are truncated. */
	readonly maxWidth?: number;
}

export interface IActionListUpdateOptions {
	readonly preserveScrollPosition?: boolean;
	readonly filterVisible?: boolean;
	readonly itemsVisible?: boolean;
}

export interface IActionListDelegate<T> {
	onHide(didCancel?: boolean): void;
	onSelect(action: T, preview?: boolean): void | Promise<void>;
	onShow?(container: HTMLElement): void;
	onFocus?(action: T, anchor: HTMLElement): void;
	onHover?(action: T, anchor: HTMLElement): void;
}

/** A group label is descriptive content, never a disabled action button. */
class ActionListHeader extends ActionViewItem {
	constructor(action: IAction) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		const label = h(container.ownerDocument, 'div');
		label.className = 'ash-action-widget-header';
		label.textContent = this.action.label;
		container.append(label);
	}

	public override setTabbable(_tabbable: boolean): void { }
}

/** A selectable row keeps its checked state, summary and badge within one navigation stop. */
class ActionListAction extends ButtonActionViewItem {
	constructor(action: IAction, private readonly entry: IActionListItem<unknown>, private readonly options: IActionListOptions) {
		super(action, { buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet' });
	}

	public override render(container: HTMLElement): void {
		container.classList.add('ash-action-widget-action');
		super.render(container);
		const button = this.button.domNode;
		button.classList.add('ash-action-widget-primary');
		const listbox = this.options.ariaMultiselectable && this.options.filterAsCombobox;
		let role = this.entry.checked === undefined ? 'menuitem' : 'menuitemradio';
		if (this.options.ariaMultiselectable) {
			button.id = `${this.action.id}.option`;
			role = listbox ? 'option' : 'menuitemcheckbox';
		}
		button.setAttribute('role', role);
		button.removeAttribute('aria-pressed');
		if (this.entry.checked !== undefined) {
			button.setAttribute('aria-checked', String(this.entry.checked));
			if (listbox) { button.setAttribute('aria-selected', String(this.entry.checked)); }
			const check = h(container.ownerDocument, 'span');
			check.className = 'ash-action-widget-check';
			check.hidden = !this.entry.checked;
			check.setAttribute('aria-hidden', 'true');
			appendIcon(Lxicon.check, check);
			button.append(check);
		}
		const description = [this.entry.detail, this.entry.description, this.entry.badge].filter(Boolean).join(' · ');
		if (description) { button.setAttribute('aria-description', description); }
		if (this.entry.description) {
			const summary = h(container.ownerDocument, 'span');
			summary.className = 'ash-action-widget-summary';
			summary.textContent = this.entry.description;
			button.append(summary);
		}
		if (this.entry.badge) {
			const badge = h(container.ownerDocument, 'span');
			badge.className = 'ash-menu-badge';
			badge.textContent = this.entry.badge;
			button.append(badge);
		}
	}

	protected override setupTooltip(): void {
		if (this.options.showRowTooltips === false) { return; }
		this.setupDelayedHover(this.button.domNode, [this.action.label, this.entry.description].filter(Boolean).join(' · '));
	}
}

/** Owns typed action dispatch and its pending state; Menu owns row focus and navigation. */
export class ActionList<T> extends Disposable {
	public readonly domNode: HTMLElement;
	private menu: Menu | undefined;
	private readonly menuResources = this._register(new DisposableStore());
	private readonly itemsDomNode: HTMLElement;
	private readonly statusDomNode: HTMLElement;
	private readonly filter: InputBox | undefined;
	private filterText = '';
	private readonly filterHost: HTMLElement | undefined;
	private readonly preview: Button | undefined;
	private readonly help = this._register(new MutableDisposable<DisposableStore>());
	private readonly layoutRequested = this._register(new Emitter<void>());
	public readonly onDidRequestLayout = this.layoutRequested.event;
	private focusedEntry: IActionListItem<T> | undefined;
	private visibleItems: readonly IActionListItem<T>[] = [];
	private busy = false;
	private contentWidth: number | undefined;

	constructor(
		private readonly user: string,
		private items: readonly IActionListItem<T>[],
		private readonly delegate: IActionListDelegate<T>,
		container: HTMLElement,
		ariaHint: string | undefined,
		private readonly supportsPreview: boolean,
		private readonly options: IActionListOptions,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = options.className ? `ash-action-widget ${options.className}` : 'ash-action-widget';
		this.domNode.classList.toggle('ash-action-widget-details', options.presentation === 'details');
		this.domNode.setAttribute('role', options.filterAsCombobox ? 'dialog' : 'group');
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('aria-label', options.ariaLabel ?? localize('actionWidget.label', 'Actions'));
		if (ariaHint) {
			this.domNode.setAttribute('aria-description', ariaHint);
		}
		if (options.showFilter) {
			const filterHost = this.filterHost = h(container.ownerDocument, 'div');
			filterHost.className = 'ash-action-widget-filter';
			filterHost.hidden = options.filterVisible === false;
			this.domNode.append(filterHost);
			this.filter = this._register(new InputBox(filterHost, {
				inputBoxStyles: defaultInputBoxStyles,
				type: 'search',
				presentation: 'filter',
				ariaLabel: options.ariaLabel ?? localize('actionWidget.filter', 'Filter actions'),
				placeholder: options.filterPlaceholder ?? localize('actionWidget.filter', 'Filter actions'),
				role: options.filterAsCombobox ? 'combobox' : undefined,
				ariaAutoComplete: options.filterAsCombobox ? 'list' : undefined,
				ariaExpanded: options.filterAsCombobox ? true : undefined,
			}));
			if (options.filterAsCombobox) {
				this.domNode.id = `${user}.popup`;
				this.filter.inputElement.setAttribute('aria-haspopup', 'dialog');
				this.filter.inputElement.setAttribute('aria-controls', this.domNode.id);
			}
			const filter = this.filter;
			let composing = false;
			const applyFilter = (text: string): void => {
				if (composing || text === this.filterText) { return; }
				this.filterText = text;
				const items = this.items;
				options.onDidChangeFilter?.(text);
				// A consumer that replaced the items has already rendered with this filter.
				if (this.items === items) { this.renderItems(); }
			};
			this._register(addDisposableListener(filter.inputElement, 'compositionstart', () => { composing = true; }));
			this._register(addDisposableListener(filter.inputElement, 'compositionend', () => {
				composing = false;
				applyFilter(filter.value);
			}));
			this._register(filter.onDidChange(applyFilter));
			this._register(this.filter.onKeyDown(event => {
				if (composing || event.isComposing) {
					return;
				}
				if (!this.options.filterAsCombobox && this.handleNavigationShortcut(event, true)) { return; }
				if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
					return;
				}
				if (event.key === 'Enter' && this.focusedEntry) {
					stopEvent(event);
					void this.select(this.focusedEntry);
				} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					stopEvent(event);
					if (this.options.ariaMultiselectable) {
						const candidates = this.visibleItems.filter(item => item.kind === ActionListItemKind.Action && !item.disabled);
						if (candidates.length) {
							const index = candidates.indexOf(this.focusedEntry!);
							this.focusedEntry = candidates[(index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length];
						}
						this.focus();
						this.filter!.focus();
						this.updatePreview();
						return;
					}
					if (this.options.filterAsCombobox) {
						this.focus();
					} else {
						this.focusFromFilter(event.key === 'ArrowDown' ? 1 : -1);
					}
				}
			}));
		}
		if (options.header) {
			this.domNode.append(options.header);
		}
		this.itemsDomNode = h(container.ownerDocument, 'div');
		this.itemsDomNode.className = 'ash-action-widget-items';
		this.statusDomNode = h(container.ownerDocument, 'div');
		this.statusDomNode.className = 'ash-action-widget-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.setAttribute('aria-live', 'polite');
		this.domNode.append(this.itemsDomNode, this.statusDomNode);
		this.itemsDomNode.hidden = options.itemsVisible === false;
		this.statusDomNode.hidden = options.itemsVisible === false;
		if (options.footer) {
			this.domNode.append(options.footer);
		}
		if (supportsPreview) {
			const previewHost = h(container.ownerDocument, 'div');
			previewHost.className = 'ash-action-widget-preview';
			this.domNode.append(previewHost);
			this.preview = this._register(new Button(previewHost, {
				...defaultButtonStyles,
				label: localize('actionWidget.preview', 'Preview'),
				enabled: false,
				onClick: () => {
					if (this.focusedEntry) {
						void this.select(this.focusedEntry, true);
					}
				},
			}));
		}
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.renderItems();
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'mousedown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.isComposing) {
				return;
			}
			if (event.key === 'Tab') {
				// This host owns the filter/footer traversal; standalone Menu traps Tab.
				const controls = getTabbableElements(this.domNode);
				const current = controls.indexOf(getActiveElement(this.domNode.ownerDocument) as HTMLElement);
				const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
				controls[next]?.focus();
				stopEvent(event);
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && this.filter) {
				stopEvent(event);
				this.focusFilter();
				return;
			}
			if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && this.supportsPreview) {
				stopEvent(event);
				if (this.focusedEntry) {
					void this.select(this.focusedEntry, true);
				}
				return;
			}
			if (event.altKey && event.key === 'F1') {
				stopEvent(event);
				if (this.options.accessibilityHelp) {
					this.options.accessibilityHelp();
					return;
				}
				const lifetime = new DisposableStore();
				const provider = lifetime.add(createHelpProvider(getActiveElement(this.domNode.ownerDocument)));
				const dialog = lifetime.add(new Dialog(container, localize('actionWidget.helpTitle', 'Action menu accessibility help'), [], {
					buttonStyles: defaultButtonStyles,
					dialogStyles: defaultDialogStyles,
					checkboxStyles: defaultCheckboxStyles,
					inputBoxStyles: defaultInputBoxStyles,
					disableDefaultAction: true,
					detail: provider.provideContent(),
				}));
				this.help.value = lifetime;
				void dialog.show().finally(() => {
					if (this.help.value === lifetime) {
						this.help.clear();
					}
				});
				return;
			}
		}, true));
	}

	private renderItems(): void {
		const focused = this.itemsDomNode.contains(getActiveElement(this.domNode.ownerDocument));
		const previous = this.focusedEntry;
		const terms = this.filterText.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
		const visible: IActionListItem<T>[] = [];
		let header: IActionListItem<T> | undefined;
		for (const entry of this.items) {
			if (entry.kind === ActionListItemKind.Header) {
				header = entry;
				continue;
			}
			const text = `${entry.label} ${entry.description ?? ''} ${entry.detail ?? ''} ${entry.badge ?? ''} ${entry.group?.title ?? ''}`.toLocaleLowerCase();
			if (!terms.every(term => text.includes(term))) {
				continue;
			}
			if (header) {
				visible.push(header);
				header = undefined;
			}
			visible.push(entry);
		}
		const entries = new Map<string, IActionListItem<T>>();
		const toAction = (entry: IActionListItem<T>, id: string): IAction => {
			if (entry.kind === ActionListItemKind.Separator) {
				return new Separator();
			}
			entries.set(id, entry);
			if (entry.submenu && !entry.disabled) {
				return new SubmenuAction(id, entry.label, entry.submenu.map((child, index) => toAction(child, `${id}.${index}`)), entry.group?.icon);
			}
			return {
				id, label: entry.label, tooltip: entry.label,
				enabled: entry.kind === ActionListItemKind.Action && !entry.disabled,
				icon: entry.group?.icon,
				checked: entry.checked,
				badge: entry.badge,
				run: () => this.select(entry),
			};
		};
		const actions = visible.map((entry, index) => toAction(entry, `${this.user}.${index}`));
		this.menuResources.clear();
		this.visibleItems = visible;
		const menu = this.menu = this.menuResources.add(new Menu(this.itemsDomNode, actions, {
			buttonStyles: defaultButtonStyles,
			keybindingLabelStyles: defaultKeybindingLabelStyles,
			className: 'ash-action-widget-menu',
			submenuClassName: 'ash-action-widget-menu ash-action-widget-submenu',
			getCheckedActionsRepresentation: () => 'radio',
			getKeyBinding: action => entries.get(action.id)?.keybinding,
			getAriaDescription: action => [entries.get(action.id)?.detail, entries.get(action.id)?.badge].filter(Boolean).join(' · '),
			actionViewItemProvider: action => {
				const entry = entries.get(action.id);
				if (!entry || action instanceof SubmenuAction) { return undefined; }
				if (entry.kind === ActionListItemKind.Header) { return new ActionListHeader(action); }
				return this.options.presentation === 'details' || this.options.ariaMultiselectable ? new ActionListAction(action, entry, this.options) : undefined;
			}
		}, defaultMenuStyles));
		menu.getContainer().setAttribute('aria-label', this.options.ariaLabel ?? localize('actionWidget.label', 'Actions'));
		if (this.options.ariaMultiselectable && this.options.filterAsCombobox) {
			menu.getContainer().id = `${this.user}.items`;
			menu.getContainer().setAttribute('role', 'listbox');
			menu.getContainer().setAttribute('aria-multiselectable', 'true');
			menu.getContainer().setAttribute('aria-label', this.options.ariaLabel ?? localize('actionWidget.label', 'Actions'));
			this.filter!.inputElement.setAttribute('aria-controls', menu.getContainer().id);
			this.filter!.inputElement.setAttribute('aria-haspopup', 'listbox');
		}
		const hint = this.domNode.getAttribute('aria-description');
		if (hint) {
			menu.getContainer().setAttribute('aria-description', hint);
		}
		if (!this.options.filterAsCombobox) {
			this.menuResources.add(addDisposableListener(menu.getContainer(), 'keydown', event => {
				if (event.isComposing || this.handleNavigationShortcut(event, false)) { return; }
				if (this.filter && !this.filterHost?.hidden && event.key.length === 1 && event.key !== ' ' &&
					!event.altKey && !event.ctrlKey && !event.metaKey) {
					stopEvent(event);
					this.filter.focus();
					this.filter.value = event.key;
				}
			}, true));
		}
		if (this.options.focusItemOnOpen === false) {
			const menuElement = menu.getContainer();
			this.menuResources.add(addDisposableListener(menuElement, 'keydown', event => {
				if (event.target !== menuElement || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !this.focusedEntry) {
					return;
				}
				if (event.key === 'Enter' || event.key === ' ') {
					stopEvent(event);
					void this.select(this.focusedEntry);
				} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					stopEvent(event);
					this.focusAdjacentItem(event.key === 'ArrowDown' ? 1 : -1);
				}
			}, true));
		}
		if (this.filterHost && !this.options.filterAsCombobox) {
			this.menuResources.add(addDisposableListener(menu.getContainer(), 'keydown', event => {
				if (this.filterHost!.hidden || !this.focusedEntry || event.isComposing ||
					event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
					(event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
					return;
				}
				const candidates = this.visibleItems.filter(item => item.kind === ActionListItemKind.Action && !item.disabled);
				const boundary = event.key === 'ArrowUp' ? candidates[0] : candidates.at(-1);
				if (this.focusedEntry === boundary) {
					stopEvent(event);
					this.focusedEntry = undefined;
					this.updatePreview();
					this.focusFilter();
				}
			}, true));
		}
		this.menuResources.add(addDisposableListener(menu.getContainer(), 'focusin', event => {
			if (this.options.focusItemOnOpen === false && event.target === menu.getContainer()) { return; }
			const row = isHTMLElement(event.target) ? event.target.closest<HTMLElement>('[data-action-id]') : null;
			this.focusedEntry = row ? entries.get(row.dataset.actionId!) : undefined;
			if (this.focusedEntry && !this.focusedEntry.submenu && row) {
				this.delegate.onFocus?.(this.focusedEntry.item!, row);
			}
			this.updatePreview();
		}));
		this.menuResources.add(addDisposableListener(menu.getContainer(), 'mousemove', event => {
			const row = isHTMLElement(event.target) ? event.target.closest<HTMLElement>('[data-action-id]') : null;
			const entry = row ? entries.get(row.dataset.actionId!) : undefined;
			if (entry?.kind === ActionListItemKind.Action && !entry.submenu && !entry.disabled && row) {
				this.delegate.onHover?.(entry.item!, row);
			}
		}));
		const retained = previous && visible.find(entry => entry === previous || (entry.id !== undefined && entry.id === previous.id));
		this.focusedEntry = retained && !retained.disabled
			? retained
			: visible.find(entry => entry.kind === ActionListItemKind.Action && !entry.disabled && entry.checked)
			?? visible.find(entry => entry.kind === ActionListItemKind.Action && !entry.disabled);
		this.updatePreview();
		if (this.focusedEntry && !this.focusedEntry.submenu && previous) {
			const row = menu.getContainer().children[visible.indexOf(this.focusedEntry)] as HTMLElement;
			this.delegate.onFocus?.(this.focusedEntry.item!, row);
		}
		const count = visible.filter(entry => entry.kind === ActionListItemKind.Action).length;
		this.statusDomNode.textContent = '';
		if (count === 0) {
			this.statusDomNode.textContent = localize('actionWidget.noMatches', 'No matching actions.');
		} else if (terms.length > 0) {
			this.statusDomNode.textContent = localize('actionWidget.matches', '{0} actions match.', count);
		}
		if (focused) {
			this.focus();
		}
		this.layoutRequested.fire();
	}

	private updatePreview(): void {
		if (this.options.ariaMultiselectable && this.filter) {
			if (this.focusedEntry) {
				this.filter.inputElement.setAttribute('aria-activedescendant', `${this.user}.${this.visibleItems.indexOf(this.focusedEntry)}.option`);
			} else {
				this.filter.inputElement.removeAttribute('aria-activedescendant');
			}
		}
		if (this.preview) {
			this.preview.enabled = !this.busy && this.focusedEntry?.canPreview === true && !this.focusedEntry.disabled;
		}
	}

	public updateItems(items: readonly IActionListItem<T>[], options: IActionListUpdateOptions = {}): void {
		const scrollTop = this.domNode.scrollTop;
		const menuScrollTop = this.menu?.scrollOffset ?? 0;
		this.items = items;
		if (this.filterHost && options.filterVisible !== undefined) {
			this.filterHost.hidden = !options.filterVisible;
		}
		if (options.itemsVisible !== undefined) {
			this.itemsDomNode.hidden = !options.itemsVisible;
			this.statusDomNode.hidden = !options.itemsVisible;
		}
		this.renderItems();
		if (options.preserveScrollPosition) {
			this.domNode.scrollTop = scrollTop;
			if (this.menu) { this.menu.getContainer().scrollTop = menuScrollTop; }
		}
	}

	private handleNavigationShortcut(event: KeyboardEvent, fromFilter: boolean): boolean {
		if (event.altKey || event.shiftKey) { return false; }
		const command = isMacintosh ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
		const macControl = isMacintosh && event.ctrlKey && !event.metaKey;
		if (command && event.key === '.' && this.focusedEntry) {
			stopEvent(event);
			void this.select(this.focusedEntry);
			return true;
		}
		const previous = command && event.key === 'ArrowUp' || macControl && event.key === 'p';
		const next = command && event.key === 'ArrowDown' || macControl && event.key === 'n';
		if (!previous && !next) { return false; }
		stopEvent(event);
		const direction = previous ? -1 : 1;
		if (fromFilter) { this.focusFromFilter(direction); }
		else { this.focusAdjacentItem(direction); }
		return true;
	}

	private focusAdjacentItem(direction: 1 | -1): void {
		const candidates = this.visibleItems.filter(item => item.kind === ActionListItemKind.Action && !item.disabled);
		if (!candidates.length) { return; }
		const current = this.focusedEntry ? candidates.indexOf(this.focusedEntry) : -1;
		const next = current < 0 ? (direction === 1 ? 0 : candidates.length - 1) : current + direction;
		if (current >= 0 && (next < 0 || next >= candidates.length) && this.filterHost && !this.filterHost.hidden) {
			this.focusedEntry = undefined;
			this.updatePreview();
			this.focusFilter();
			return;
		}
		this.menu?.focus(this.visibleItems.indexOf(candidates[(next + candidates.length) % candidates.length]!));
	}

	private focusFromFilter(direction: 1 | -1): void {
		const candidates = this.visibleItems.filter(item => item.kind === ActionListItemKind.Action && !item.disabled);
		const current = this.focusedEntry ? candidates.indexOf(this.focusedEntry) : -1;
		const index = current < 0 ? (direction === 1 ? 0 : candidates.length - 1) : current + direction;
		const next = candidates[index];
		if (next) {
			this.menu?.focus(this.visibleItems.indexOf(next));
		} else if (direction === 1 && this.focusedEntry) {
			this.focus();
		}
	}

	public clearFocusedFilter(): boolean {
		const filter = this.filter;
		if (!filter || this.options.filterAsCombobox || !filter.value ||
			getActiveElement(this.domNode.ownerDocument) !== filter.inputElement) {
			return false;
		}
		filter.value = '';
		return true;
	}

	public focusFilter(): void {
		if (this.filterHost && !this.filterHost.hidden) {
			this.filter?.focus();
		}
	}

	public getFocusedElement(): IActionListItem<T> | undefined { return this.focusedEntry; }

	public layout(minWidth: number): number {
		finishActionWidgetOpeningAnimation(this.domNode);
		// Measure the existing menu at its intrinsic width, including icons, shortcuts and chrome.
		// Filtering retains the full menu width so typing does not move the popup's edge.
		if (this.filterHost?.hidden || !this.filterText.trim() || this.contentWidth === undefined) {
			const previousWidth = this.domNode.style.width;
			this.domNode.style.width = 'max-content';
			this.contentWidth = Math.ceil(this.domNode.getBoundingClientRect().width);
			this.domNode.style.width = previousWidth;
		}
		const minimum = Math.max(100, minWidth, this.options.minWidth ?? 0);
		const maximum = Math.min(getWindow(this.domNode).innerWidth * 0.8, Math.max(minimum, this.options.maxWidth ?? Infinity));
		return Math.min(maximum, Math.max(minimum, this.contentWidth));
	}

	private async select(entry: IActionListItem<T>, preview = false): Promise<void> {
		if (this.busy || entry.kind !== ActionListItemKind.Action || entry.disabled || (preview && (!this.supportsPreview || !entry.canPreview))) {
			return;
		}
		if (entry.submenu) {
			if (!preview) {
				const index = this.visibleItems.indexOf(entry);
				this.menu?.focus(index);
				this.menu?.getContainer().children[index]?.querySelector<HTMLButtonElement>('button')?.click();
			}
			return;
		}
		this.busy = true;
		this.updatePreview();
		this.domNode.setAttribute('aria-busy', 'true');
		try {
			await this.delegate.onSelect(entry.item!, preview);
		} finally {
			if (!this.isDisposed) {
				this.busy = false;
				this.domNode.removeAttribute('aria-busy');
				this.updatePreview();
			}
		}
	}

	public contains(target: Node): boolean {
		return this.domNode.contains(target) || this.menu?.contains(target) === true;
	}

	public focus(focusItem = true): void {
		if (!focusItem) {
			// Keep keyboard navigation in the menu without drawing a ring on pointer open.
			const pointerFocus: FocusOptions & { focusVisible: boolean; } = { focusVisible: false };
			this.menu?.focus(false, pointerFocus);
		} else if (this.focusedEntry) {
			this.menu?.focus(this.visibleItems.indexOf(this.focusedEntry));
		}
		if (!this.domNode.contains(getActiveElement(this.domNode.ownerDocument))) {
			this.domNode.focus({ preventScroll: true });
		}
	}
}

function createHelpProvider(source: Element | null): AccessibleContentProvider {
	return new AccessibleContentProvider(
		AccessibleViewProviderId.ActionWidget,
		{ type: AccessibleViewType.Help },
		() => {
			if (source?.closest('.ash-multi-select-dropdown')) {
				return localize('actionWidget.multiSelectHelp', 'Use Up and Down Arrow to move between choices. Enter or Space toggles the focused choice immediately and keeps the menu open. In the search box, Space inserts text and Enter toggles the active result. Tab and Shift+Tab move between search and choices. Escape closes the menu and returns focus to its trigger without undoing selections. Disabled choices and group headings are skipped.');
			}
			return localize('actionWidget.help', 'Use Up and Down Arrow to move between available actions. Tab and Shift+Tab move between the filter, actions and footer controls. Home and End move to the first and last action. Enter or Space runs the focused action. When tabs are available, Left and Right Arrow move between them, Enter or Space selects a tab, and Down Arrow returns to the actions. When a filter is available, Ctrl+F or Command+F focuses it; type to filter, then Down Arrow returns to the actions. When Preview is available, Ctrl+Enter or Command+Enter previews the focused action. Escape closes the menu and returns focus to its source. Unavailable actions and group labels are skipped.');
		},
		() => {
			if (isHTMLElement(source) && source.isConnected) {
				source.focus({ preventScroll: true });
			}
		},
		AccessibilityVerbositySettingId.ActionWidget,
	);
}

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'action-widget',
	getProvider: accessor => {
		const active = getActiveElement(accessor.get(IContextViewService).container.ownerDocument);
		return active?.closest('.ash-action-widget') ? createHelpProvider(active) : undefined;
	},
});
