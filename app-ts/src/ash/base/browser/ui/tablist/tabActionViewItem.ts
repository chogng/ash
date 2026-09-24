import { addDisposableListener, h } from "../../dom.js";
import type { IAction } from "../../../common/actions.js";
import type { Icon } from "../../../common/icon.js";
import { lxiconsLibrary } from "../../../common/lxiconsLibrary.js";
import { assertDefined } from "../../../common/types.js";
import { ActionBar } from "../actionbar/actionbar.js";
import { ActionViewItem } from "../actionbar/actionViewItems.js";
import { IconLabel } from "../iconlabel/iconlabel.js";
import type { TabListItem } from "./tabList.js";

export const TAB_CLOSE_ACTION_ID = "ash.tab.close";

/** Internal action representation of one selectable TabList item. */
export class TabAction<T> implements IAction {
	readonly label: string;
	readonly tooltip: string;
	readonly enabled = true;

	constructor(
		readonly tab: TabListItem<T>,
		readonly checked: boolean,
		readonly activate: (value: T) => void,
	) {
		this.label = tab.label;
		this.tooltip = tab.tooltip ?? tab.label;
	}

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

	constructor(action: TabAction<T>, onClose: ((value: T) => void) | undefined, closeActionIcon: Icon | undefined, draggable: boolean) {
		super(action, { draggable });
		this.tabAction = action;
		this.onClose = onClose;
		this.closeActionIcon = closeActionIcon;
	}

	override render(container: HTMLElement): void {
		if (this.tabElement) {
			throw new Error(`TabList item is already rendered: ${this.action.id}`);
		}
		const item = this.tabAction.tab;
		container.classList.add("ash-tab");
		container.classList.toggle("checked", this.tabAction.checked);
		container.classList.toggle("icon", item.icon !== undefined);
		container.classList.toggle("preview", item.preview === true);
		if (item.state !== undefined) container.dataset.state = item.state;

		const tab = h(container.ownerDocument, "button");
		this.tabElement = tab;
		tab.id = item.tabId;
		tab.className = "ash-tab-label";
		tab.type = "button";
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(this.tabAction.checked));
		tab.setAttribute("aria-label", item.ariaLabel ?? item.label);
		if (item.panelId) tab.setAttribute("aria-controls", item.panelId);
		this.setupHover(tab, this.tabAction.tooltip);
		const label = this._register(new IconLabel(tab, {
			label: item.label,
			icon: item.icon,
			description: item.description,
		}));
		container.append(tab);

		this._register(addDisposableListener(tab, "click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.tabAction.run();
		}));
		if (this.onClose) {
			tab.setAttribute("aria-keyshortcuts", "Delete");
			this._register(addDisposableListener(tab, "keydown", (event) => {
				if (event.key !== "Delete") return;
				event.preventDefault();
				event.stopPropagation();
				this.onClose?.(item.value);
			}));
		}
		const actions = [
			...(item.actions?.items ?? []),
			...(this.onClose ? [closeTabAction(item, this.onClose, this.closeActionIcon)] : []),
		];
		if (actions.length > 0) {
			const actionBar = this._register(new ActionBar(container, {
				actions,
				ariaLabel: item.actions?.ariaLabel ?? `${item.label} actions`,
			}));
			actionBar.element.classList.add("ash-tab-actions");
			if (this.onClose) {
				const closeActionContainer = actionBar.element.querySelector<HTMLElement>(`[data-action-id="${TAB_CLOSE_ACTION_ID}"]`);
				if (!closeActionContainer) {
					throw new Error("TabList close action was not rendered");
				}
				closeActionContainer.classList.add("ash-tab-close-action");
			}
		}
	}

	override focus(): void {
		this.tab.focus();
	}

	override setTabbable(tabbable: boolean): void {
		this.tab.tabIndex = tabbable ? 0 : -1;
	}

	private get tab(): HTMLButtonElement {
		assertDefined(this.tabElement, `TabList item is not rendered: ${this.action.id}`);
		return this.tabElement;
	}
}

function closeTabAction<T>(item: TabListItem<T>, close: (value: T) => void, icon: Icon | undefined): IAction {
	const label = `Close ${item.label}`;
	return {
		id: TAB_CLOSE_ACTION_ID,
		label,
		tooltip: label,
		icon: icon ?? lxiconsLibrary.close,
		enabled: true,
		run: () => close(item.value),
	};
}
