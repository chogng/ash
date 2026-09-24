import { addDisposableListener, ModifierKeyEmitter } from "../../../base/browser/dom.js";
import { setAriaAttribute } from "../../../base/browser/ui/aria/aria.js";
import { ActionViewItem, ButtonActionViewItem, type ActionViewItemOptions } from "../../../base/browser/ui/actionbar/actionViewItems.js";
import type { IContextMenuProvider } from "../../../base/browser/contextmenu.js";
import { DropdownMenuActionViewItem } from "../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js";
import { Separator, SubmenuAction, type IAction } from "../../../base/common/actions.js";
import { isLinux, isWindows } from "../../../base/common/platform.js";
import { MenuItemAction, SubmenuItemAction } from "../common/actions.js";

export interface PrimaryAndSecondaryActions {
	readonly primary: IAction[];
	readonly secondary: IAction[];
}

type MenuActionGroups = ReadonlyArray<readonly [string, readonly IAction[]]>;

export function getContextMenuActions(
	groups: MenuActionGroups,
	primaryGroup?: string,
	targetWindow: Window | undefined = typeof window === "undefined" ? undefined : window,
): PrimaryAndSecondaryActions {
	const target: PrimaryAndSecondaryActions = { primary: [], secondary: [] };
	fillInActions(
		groups,
		target,
		targetWindow ? shouldUseAlternativeMenuActions(targetWindow) : false,
		primaryGroup ? (group) => group === primaryGroup : undefined,
	);
	return target;
}

export function getFlatContextMenuActions(
	groups: MenuActionGroups,
	primaryGroup?: string,
	targetWindow: Window | undefined = typeof window === "undefined" ? undefined : window,
): IAction[] {
	const target: IAction[] = [];
	fillInActions(
		groups,
		target,
		targetWindow ? shouldUseAlternativeMenuActions(targetWindow) : false,
		primaryGroup ? (group) => group === primaryGroup : undefined,
	);
	return target;
}

export function getActionBarActions(
	groups: MenuActionGroups,
	primaryGroup?: string | ((group: string) => boolean),
	shouldInlineSubmenu?: (action: SubmenuAction, group: string, groupSize: number) => boolean,
	useSeparatorsInPrimaryActions = false,
): PrimaryAndSecondaryActions {
	const target: PrimaryAndSecondaryActions = { primary: [], secondary: [] };
	fillInActionBarActions(
		groups,
		target,
		primaryGroup,
		shouldInlineSubmenu,
		useSeparatorsInPrimaryActions,
	);
	return target;
}

export function getFlatActionBarActions(
	groups: MenuActionGroups,
	primaryGroup?: string | ((group: string) => boolean),
	shouldInlineSubmenu?: (action: SubmenuAction, group: string, groupSize: number) => boolean,
	useSeparatorsInPrimaryActions = false,
): IAction[] {
	const target: IAction[] = [];
	fillInActionBarActions(
		groups,
		target,
		primaryGroup,
		shouldInlineSubmenu,
		useSeparatorsInPrimaryActions,
	);
	return target;
}

export function fillInActionBarActions(
	groups: MenuActionGroups,
	target: IAction[] | PrimaryAndSecondaryActions,
	primaryGroup?: string | ((group: string) => boolean),
	shouldInlineSubmenu?: (action: SubmenuAction, group: string, groupSize: number) => boolean,
	useSeparatorsInPrimaryActions = false,
): void {
	const isPrimaryGroup = typeof primaryGroup === "string"
		? (group: string): boolean => group === primaryGroup
		: primaryGroup;
	fillInActions(
		groups,
		target,
		false,
		isPrimaryGroup,
		shouldInlineSubmenu,
		useSeparatorsInPrimaryActions,
	);
}

function fillInActions(
	groups: MenuActionGroups,
	target: IAction[] | PrimaryAndSecondaryActions,
	useAlternativeActions: boolean,
	isPrimaryGroup: (group: string) => boolean = (group) => group === "navigation",
	shouldInlineSubmenu: (action: SubmenuAction, group: string, groupSize: number) => boolean = () => false,
	useSeparatorsInPrimaryActions = false,
): void {
	const primary = Array.isArray(target) ? target : target.primary;
	const secondary = Array.isArray(target) ? target : target.secondary;
	const submenus: Array<{ readonly group: string; readonly action: SubmenuAction; readonly index: number }> = [];

	for (const [group, groupActions] of groups) {
		const isPrimary = isPrimaryGroup(group);
		const bucket = isPrimary ? primary : secondary;
		if (bucket.length > 0 && (!isPrimary || useSeparatorsInPrimaryActions)) {
			bucket.push(new Separator());
		}
		for (const originalAction of groupActions) {
			const action = useAlternativeActions
				? resolveAlternativeMenuAction(originalAction)
				: originalAction;
			const index = bucket.push(action) - 1;
			if (action instanceof SubmenuAction) submenus.push({ group, action, index });
		}
	}

	for (const { group, action, index } of submenus.reverse()) {
		const bucket = isPrimaryGroup(group) ? primary : secondary;
		if (shouldInlineSubmenu(action, group, bucket.length)) {
			bucket.splice(index, 1, ...action.actions);
		}
	}
}

export function shouldUseAlternativeMenuActions(targetWindow: Window): boolean {
	const status = ModifierKeyEmitter.getInstance(targetWindow).keyStatus;
	return status.altKey || ((isWindows || isLinux) && status.shiftKey);
}

export function resolveAlternativeMenuActions(
	actions: readonly IAction[],
	useAlternative: boolean,
): readonly IAction[] {
	if (!useAlternative) return actions;
	return actions.map(resolveAlternativeMenuAction);
}

function resolveAlternativeMenuAction(action: IAction): IAction {
	if (action instanceof MenuItemAction) return action.alt ?? action;
	if (!(action instanceof SubmenuAction)) return action;
	if (action instanceof SubmenuItemAction) {
		return new SubmenuItemAction(
			action.item,
			action.actions.map(resolveAlternativeMenuAction),
		);
	}
	return new SubmenuAction(
		action.id,
		action.label,
		action.actions.map(resolveAlternativeMenuAction),
		action.icon,
	);
}

export type IMenuEntryActionViewItemOptions = ActionViewItemOptions;

/**
 * ActionBar representation of one command resolved from a menu contribution.
 *
 * Popup-menu rows use base Menu's private view items instead; this platform
 * representation is for contributed actions rendered in toolbars and other
 * ActionBar hosts.
 */
export class MenuEntryActionViewItem extends ButtonActionViewItem {
	private readonly menuItemAction: MenuItemAction;
	private activeAction: MenuItemAction;
	private isMouseOver = false;

	constructor(action: MenuItemAction, options: IMenuEntryActionViewItemOptions = {}) {
		super(action, options);
		this.menuItemAction = action;
		this.activeAction = action;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-menu-entry");
		if (!this.menuItemAction.alt) return;
		const targetWindow = container.ownerDocument.defaultView;
		if (!targetWindow) return;
		const modifiers = ModifierKeyEmitter.getInstance(targetWindow);
		const update = (): void => this.updateAlternativeState(modifiers);
		this._register(modifiers.event(update));
		this._register(addDisposableListener(container, "mouseenter", () => {
			this.isMouseOver = true;
			update();
		}));
		this._register(addDisposableListener(container, "mouseleave", () => {
			this.isMouseOver = false;
			update();
		}));
		update();
	}

	protected override runAction(): unknown {
		return this.activeAction.run();
	}

	private updateAlternativeState(modifiers: ModifierKeyEmitter): void {
		const status = modifiers.keyStatus;
		const alternate = this.menuItemAction.alt;
		const nextAction = alternate?.enabled && (status.altKey || (status.shiftKey && this.isMouseOver))
			? alternate
			: this.menuItemAction;
		if (this.activeAction === nextAction) return;
		this.activeAction = nextAction;
		this.button.label = nextAction.label;
		this.button.icon = nextAction.icon;
		this.button.enabled = nextAction.enabled;
		this.button.checked = nextAction.checked;
		this.button.setTitle(nextAction.tooltip);
		setAriaAttribute(this.button.domNode, "label", nextAction.label);
	}
}

/**
 * ActionBar representation of a contributed submenu.
 *
 * The trigger retains toolbar semantics while its popup delegates all menu-row
 * rendering, keyboard navigation, and nested submenus to base Menu.
 */
export class SubmenuEntryActionViewItem
	extends DropdownMenuActionViewItem {
	constructor(
		action: SubmenuItemAction,
		contextMenuProvider: IContextMenuProvider,
		options: IMenuEntryActionViewItemOptions = {},
	) {
		super(action, () => action.actions, contextMenuProvider, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-menu-entry");
	}
}

/**
 * Creates the ActionBar representation for a platform menu contribution.
 *
 * Returning undefined lets ActionBar use its base representation for actions
 * that were not produced by the platform menu service.
 */
export function createActionViewItem(
	action: IAction,
	contextMenuProvider: IContextMenuProvider,
	options: IMenuEntryActionViewItemOptions = {},
): ActionViewItem | undefined {
	if (action instanceof MenuItemAction) {
		return new MenuEntryActionViewItem(action, options);
	}
	if (action instanceof SubmenuItemAction) {
		return new SubmenuEntryActionViewItem(action, contextMenuProvider, options);
	}
	return undefined;
}
