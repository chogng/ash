import { addDisposableListener, getActiveElement, h, isHTMLElement, stopEvent } from '../../../base/browser/dom.js';
import { ActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../base/browser/ui/inputbox/inputbox.js';
import { Emitter } from '../../../base/common/event.js';
import '../../../base/browser/ui/dialog/dialog.css';
import '../../../base/browser/ui/menu/menu.css';
import { Dialog } from '../../../base/browser/ui/dialog/dialog.js';
import { Menu } from '../../../base/browser/ui/menu/menu.js';
import { Separator, type IAction } from '../../../base/common/actions.js';
import type { Icon } from '../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import './actionWidget.css';

export const enum ActionListItemKind {
	Action = 'action',
	Header = 'header',
	Separator = 'separator',
}

export interface IActionListItem<T> {
	readonly kind: ActionListItemKind;
	readonly item?: T;
	readonly label: string;
	readonly disabled?: boolean;
	readonly group?: { readonly title: string; readonly icon?: Icon; };
	readonly checked?: boolean;
	readonly canPreview?: boolean;
}

export interface IActionListOptions {
	readonly className?: string;
	readonly showFilter?: boolean;
	readonly filterPlaceholder?: string;
}

export interface IActionListDelegate<T> {
	onHide(didCancel?: boolean): void;
	onSelect(action: T, preview?: boolean): void | Promise<void>;
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

/** Owns typed action dispatch and its pending state; Menu owns row focus and navigation. */
export class ActionList<T> extends Disposable {
	public readonly domNode: HTMLElement;
	private menu: Menu | undefined;
	private readonly menuResources = this._register(new DisposableStore());
	private readonly itemsDomNode: HTMLElement;
	private readonly statusDomNode: HTMLElement;
	private readonly filter: InputBox | undefined;
	private readonly preview: Button | undefined;
	private readonly help = this._register(new MutableDisposable<DisposableStore>());
	private readonly layoutRequested = this._register(new Emitter<void>());
	public readonly onDidRequestLayout = this.layoutRequested.event;
	private focusedEntry: IActionListItem<T> | undefined;
	private visibleItems: readonly IActionListItem<T>[] = [];
	private busy = false;

	constructor(
		private readonly user: string,
		private items: readonly IActionListItem<T>[],
		private readonly delegate: IActionListDelegate<T>,
		container: HTMLElement,
		ariaHint: string | undefined,
		private readonly supportsPreview: boolean,
		options: IActionListOptions,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = options.className ? `ash-action-widget ${options.className}` : 'ash-action-widget';
		this.domNode.setAttribute('role', 'group');
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('aria-label', localize('actionWidget.label', 'Actions'));
		if (ariaHint) {
			this.domNode.setAttribute('aria-description', ariaHint);
		}
		if (options.showFilter) {
			const filterHost = h(container.ownerDocument, 'div');
			filterHost.className = 'ash-action-widget-filter';
			this.domNode.append(filterHost);
			this.filter = this._register(new InputBox(filterHost, {
				type: 'search',
				ariaLabel: localize('actionWidget.filter', 'Filter actions'),
				placeholder: options.filterPlaceholder ?? localize('actionWidget.filter', 'Filter actions'),
			}));
			this._register(this.filter.onDidChange(() => this.renderItems()));
			this._register(this.filter.onKeyDown(event => {
				if (event.isComposing) {
					return;
				}
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
					stopEvent(event);
					this.focus();
				}
			}));
		}
		this.itemsDomNode = h(container.ownerDocument, 'div');
		this.itemsDomNode.className = 'ash-action-widget-items';
		this.statusDomNode = h(container.ownerDocument, 'div');
		this.statusDomNode.className = 'ash-action-widget-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.setAttribute('aria-live', 'polite');
		this.domNode.append(this.itemsDomNode, this.statusDomNode);
		if (supportsPreview) {
			const previewHost = h(container.ownerDocument, 'div');
			previewHost.className = 'ash-action-widget-preview';
			this.domNode.append(previewHost);
			this.preview = this._register(new Button(previewHost, {
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
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && this.filter) {
				stopEvent(event);
				this.filter.focus();
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
				const lifetime = new DisposableStore();
				const provider = lifetime.add(createHelpProvider(getActiveElement(this.domNode.ownerDocument)));
				const dialog = lifetime.add(new Dialog(container, {
					title: localize('actionWidget.helpTitle', 'Action menu accessibility help'),
					content: provider.provideContent(),
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
		const terms = (this.filter?.value ?? '').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
		const visible: IActionListItem<T>[] = [];
		let header: IActionListItem<T> | undefined;
		for (const entry of this.items) {
			if (entry.kind === ActionListItemKind.Header) {
				header = entry;
				continue;
			}
			const text = `${entry.label} ${entry.group?.title ?? ''}`.toLocaleLowerCase();
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
		const actions: IAction[] = visible.map((entry, index) => {
			if (entry.kind === ActionListItemKind.Separator) {
				return new Separator();
			}
			const id = `${this.user}.${index}`;
			entries.set(id, entry);
			return {
				id, label: entry.label, tooltip: entry.label,
				enabled: entry.kind === ActionListItemKind.Action && !entry.disabled,
				icon: entry.group?.icon,
				checked: entry.checked,
				run: () => this.select(entry),
			};
		});
		this.menuResources.clear();
		this.visibleItems = visible;
		const menu = this.menu = this.menuResources.add(new Menu(this.itemsDomNode, {
			actions,
			className: 'ash-action-widget-menu',
			getCheckedActionsRepresentation: () => 'radio',
			actionViewItemProvider: action => entries.get(action.id)?.kind === ActionListItemKind.Header ? new ActionListHeader(action) : undefined,
		}));
		menu.element.setAttribute('aria-label', localize('actionWidget.label', 'Actions'));
		const hint = this.domNode.getAttribute('aria-description');
		if (hint) {
			menu.element.setAttribute('aria-description', hint);
		}
		this.menuResources.add(addDisposableListener(menu.element, 'focusin', event => {
			const row = isHTMLElement(event.target) ? event.target.closest<HTMLElement>('[data-action-id]') : null;
			this.focusedEntry = row ? entries.get(row.dataset.actionId!) : undefined;
			this.updatePreview();
		}));
		this.focusedEntry = previous && visible.includes(previous) && !previous.disabled
			? previous
			: visible.find(entry => entry.kind === ActionListItemKind.Action && !entry.disabled && entry.checked)
			?? visible.find(entry => entry.kind === ActionListItemKind.Action && !entry.disabled);
		this.updatePreview();
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
		if (this.preview) {
			this.preview.enabled = !this.busy && this.focusedEntry?.canPreview === true && !this.focusedEntry.disabled;
		}
	}

	public updateItems(items: readonly IActionListItem<T>[]): void {
		this.items = items;
		this.renderItems();
	}

	private async select(entry: IActionListItem<T>, preview = false): Promise<void> {
		if (this.busy || entry.kind !== ActionListItemKind.Action || entry.disabled || (preview && (!this.supportsPreview || !entry.canPreview))) {
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

	public focus(): void {
		if (this.focusedEntry) {
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
		() => localize('actionWidget.help', 'Use Up and Down Arrow to move between available actions. Home and End move to the first and last action. Enter or Space runs the focused action. When tabs are available, Left and Right Arrow move between them, Enter or Space selects a tab, and Down Arrow returns to the actions. When a filter is available, Ctrl+F or Command+F focuses it; type to filter, then Down Arrow returns to the actions. When Preview is available, Ctrl+Enter or Command+Enter previews the focused action. Escape closes the menu and returns focus to its source. Unavailable actions and group labels are skipped.'),
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
