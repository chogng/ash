import { addDisposableListener, h } from '../../dom.js';
import type { IAction } from '../../../common/actions.js';
import type { Icon } from '../../../common/icon.js';
import { Lxicon } from '../../../common/lxicons.js';
import { MutableDisposable } from '../../../common/lifecycle.js';
import type { IManagedHover } from '../hover/hoverDelegate.js';
import { assertDefined } from '../../../common/types.js';
import { ActionBar } from '../actionbar/actionbar.js';
import { ActionViewItem } from '../actionbar/actionViewItems.js';
import { IconLabel } from '../iconlabel/iconlabel.js';
import type { TabListItem } from './tabList.js';
import { localize } from '../../../../nls.js';

export const TAB_CLOSE_ACTION_ID = 'ash.tab.close';

/** Internal action representation of one selectable TabList item. */
export class TabAction<T> implements IAction {
	get label(): string {
		return this.tab.label;
	}
	get tooltip(): string {
		return this.tab.tooltip ?? this.tab.label;
	}
	readonly enabled = true;

	constructor(
		public tab: TabListItem<T>,
		public checked: boolean,
		public selected: boolean,
		readonly activate: (value: T) => void,
		readonly select?: (value: T, event: MouseEvent | KeyboardEvent) => boolean,
	) {}

	get id(): string {
		return this.tab.id;
	}

	run(): void {
		this.activate(this.tab.value);
	}
}

/** Browser representation responsible for one TabList item's DOM and actions. */
export class TabActionViewItem<T> extends ActionViewItem {
	private readonly tabAction: TabAction<T>;
	private readonly onClose: ((value: T) => void) | undefined;
	private readonly closeActionIcon: Icon | undefined;
	private tabElement: HTMLButtonElement | undefined;
	private container: HTMLElement | undefined;
	private label: IconLabel | undefined;
	private rendered: TabListItem<T> | undefined;
	private hover: IManagedHover | undefined;
	private closeAction: IAction | undefined;
	private readonly toolbar = this._register(new MutableDisposable<ActionBar>());

	constructor(action: TabAction<T>, onClose: ((value: T) => void) | undefined, closeActionIcon: Icon | undefined, draggable: boolean) {
		super(action, { draggable });
		this.tabAction = action;
		this.onClose = onClose;
		this.closeActionIcon = closeActionIcon;
	}

	get domNode(): HTMLElement {
		assertDefined(this.container, `TabList item is not rendered: ${this.action.id}`);
		return this.container;
	}

	override render(container: HTMLElement): void {
		if (this.tabElement) {
			throw new Error(`TabList item is already rendered: ${this.action.id}`);
		}
		const item = this.tabAction.tab;
		container.classList.add('ash-tab');
		this.container = container;

		const tab = h(container.ownerDocument, 'button');
		this.tabElement = tab;
		tab.className = 'ash-tab-label';
		tab.type = 'button';
		tab.setAttribute('role', 'tab');
		this.hover = this.setupHover(tab, this.tabAction.tooltip);
		if (item.renderLabel) {
			this._register(item.renderLabel(tab));
		} else {
			this.label = this._register(new IconLabel(tab, { label: item.label, icon: item.icon, description: item.description }));
		}
		container.append(tab);

		this._register(
			addDisposableListener(tab, 'click', event => {
				event.preventDefault();
				event.stopPropagation();
				if (this.tabAction.select?.(this.tabAction.tab.value, event)) {
					return;
				}
				this.tabAction.run();
			}),
		);
		if (this.onClose || this.tabAction.select) {
			tab.setAttribute('aria-keyshortcuts', [this.onClose ? 'Delete' : '', this.tabAction.select ? 'Control+Space Shift+Space' : ''].filter(Boolean).join(' '));
			this._register(
				addDisposableListener(tab, 'keydown', event => {
					if (this.tabAction.select && event.key === ' ' && (event.ctrlKey || event.metaKey || event.shiftKey)) {
						event.preventDefault();
						event.stopPropagation();
						this.tabAction.select(this.tabAction.tab.value, event);
						return;
					}
					if (!this.onClose || event.key !== 'Delete') {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					this.onClose(this.tabAction.tab.value);
				}),
			);
		}
		this.update();
	}

	update(): void {
		const item = this.tabAction.tab;
		const previous = this.rendered;
		const container = this.container!;
		const tab = this.tab;
		container.classList.toggle('checked', this.tabAction.checked);
		container.classList.toggle('selected', this.tabAction.selected);
		container.classList.toggle('icon', item.icon !== undefined);
		container.classList.toggle('preview', item.preview === true);
		if (previous?.state !== item.state) {
			if (item.state === undefined) {
				delete container.dataset.state;
			} else {
				container.dataset.state = item.state;
			}
		}
		if (previous?.tabId !== item.tabId) {
			tab.id = item.tabId;
		}
		const selected = String(this.tabAction.selected);
		if (tab.getAttribute('aria-selected') !== selected) {
			tab.setAttribute('aria-selected', selected);
		}
		const ariaLabel = item.ariaLabel ?? item.label;
		if ((previous?.ariaLabel ?? previous?.label) !== ariaLabel) {
			tab.setAttribute('aria-label', ariaLabel);
		}
		if (previous?.ariaDescription !== item.ariaDescription) {
			if (item.ariaDescription) {
				tab.setAttribute('aria-description', item.ariaDescription);
			} else {
				tab.removeAttribute('aria-description');
			}
		}
		if (previous?.panelId !== item.panelId) {
			if (item.panelId) {
				tab.setAttribute('aria-controls', item.panelId);
			} else {
				tab.removeAttribute('aria-controls');
			}
		}
		// Managed hover and IconLabel were initialized by render; unchanged content needs no DOM work.
		if (previous && (previous.tooltip ?? previous.label) !== this.tabAction.tooltip) {
			this.hover?.update(this.tabAction.tooltip);
		}
		this.rendered = item;
		if (this.label && previous && (previous.label !== item.label || previous.description !== item.description || previous.icon !== item.icon)) {
			this.label.setLabel(item.label, item.description, { icon: item.icon });
		}
		if (
			previous &&
			previous.label === item.label &&
			previous.actions === item.actions &&
			previous.primaryAction === item.primaryAction &&
			previous.closeActionTooltip === item.closeActionTooltip
		) {
			return;
		}
		if (this.onClose && !item.primaryAction && (!this.closeAction || previous?.primaryAction || previous?.label !== item.label || previous.closeActionTooltip !== item.closeActionTooltip)) {
			this.closeAction = closeTabAction(this.tabAction, this.onClose, this.closeActionIcon);
		}
		const primaryAction = item.primaryAction ?? this.closeAction;
		const actions = [...(item.actions?.items ?? []), ...(primaryAction ? [primaryAction] : [])];
		const hadActionFocus = this.toolbar.value?.element.contains(container.ownerDocument.activeElement);
		if (actions.length === 0) {
			this.toolbar.clear();
		} else {
			const ariaLabel = item.actions?.ariaLabel ?? localize('tabList.actions', '{0} actions', item.label);
			let actionBar = this.toolbar.value;
			if (actionBar) {
				actionBar.updateActions(actions);
				if (actionBar.element.getAttribute('aria-label') !== ariaLabel) {
					actionBar.element.setAttribute('aria-label', ariaLabel);
				}
			} else {
				actionBar = new ActionBar(container, { actions, ariaLabel });
				this.toolbar.value = actionBar;
				actionBar.element.classList.add('ash-tab-actions');
			}
			for (const actionContainer of actionBar.element.children) {
				const isPrimary = (actionContainer as HTMLElement).dataset.actionId === primaryAction?.id;
				actionContainer.classList.toggle('ash-tab-primary-action', isPrimary);
				actionContainer.classList.toggle('ash-tab-close-action', isPrimary && item.primaryAction === undefined);
				actionContainer.classList.toggle('custom-action', isPrimary && item.primaryAction !== undefined);
			}
		}
		if (hadActionFocus && container.ownerDocument.activeElement === container.ownerDocument.body) {
			this.focus();
		}
	}

	override focus(): void {
		this.tab.focus();
	}

	override setTabbable(tabbable: boolean): void {
		const tabIndex = tabbable ? 0 : -1;
		if (this.tab.tabIndex !== tabIndex) {
			this.tab.tabIndex = tabIndex;
		}
	}

	private get tab(): HTMLButtonElement {
		assertDefined(this.tabElement, `TabList item is not rendered: ${this.action.id}`);
		return this.tabElement;
	}
}

function closeTabAction<T>(action: TabAction<T>, close: (value: T) => void, icon: Icon | undefined): IAction {
	const label = localize('tabList.closeTab', 'Close {0}', action.tab.label);
	return {
		id: TAB_CLOSE_ACTION_ID,
		label,
		tooltip: action.tab.closeActionTooltip ?? localize('tabList.close', 'Close'),
		icon: icon ?? Lxicon.close,
		enabled: true,
		run: () => close(action.tab.value),
	};
}
