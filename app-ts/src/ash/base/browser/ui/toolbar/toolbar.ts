import type { IContextMenuProvider } from "../../contextmenu.js";
import type { IAction } from "../../../common/actions.js";
import { Separator } from "../../../common/actions.js";
import { Disposable } from "../../../common/lifecycle.js";
import { Lxicon } from "../../../common/lxicons.js";
import { ActionBar, type ActionBarOrientation, type ActionViewItemProvider } from "../actionbar/actionbar.js";
import type { ActionViewItemOptions } from "../actionbar/actionViewItems.js";
import type { AnchorPosition } from "../contextview/contextview.js";
import { DropdownMenuActionViewItem } from "../dropdown/dropdownMenuActionViewItem.js";

export interface ToolBarOptions {
	readonly contextMenuProvider: IContextMenuProvider;
	readonly ariaLabel?: string;
	readonly orientation?: ActionBarOrientation;
	readonly actionViewItemProvider?: ActionViewItemProvider;
	readonly presentation?: ToolBarPresentation;
	readonly highlightToggledItems?: boolean;
	readonly moreActionsPlacement?: MoreActionsPlacement;
	readonly hoverAnchorPosition?: AnchorPosition;
}

/** Places the synthetic More Actions item relative to a primary action. */
export interface MoreActionsPlacement {
	readonly beforeActionId: string;
}

/** Component-owned visual adaptation selected by a toolbar host. */
export type ToolBarPresentation = "default" | "inherit-foreground";

/**
 * Presents primary actions inline and secondary actions in a trailing menu.
 *
 * Callers own action classification. The toolbar owns the synthetic More
 * Actions item and delegates its secondary menu to the supplied provider.
 */
export class ToolBar extends Disposable {
	readonly element: HTMLDivElement;
	private readonly actionBar: ActionBar;
	private readonly moreActions = new MoreActionsAction();
	private readonly moreActionsPlacement: MoreActionsPlacement | undefined;
	private secondaryActions: readonly IAction[] = [];

	constructor(container: HTMLElement, options: ToolBarOptions) {
		super();
		this.moreActionsPlacement = options.moreActionsPlacement;
		const actionViewItemOptions: ActionViewItemOptions = { hoverAnchorPosition: options.hoverAnchorPosition };
		this.actionBar = this._register(new ActionBar(container, {
			ariaLabel: options.ariaLabel,
			orientation: options.orientation,
			highlightToggledItems: options.highlightToggledItems,
			actionViewItemOptions,
			actionViewItemProvider: (action, actionOptions) => {
				if (action === this.moreActions) {
					return new MoreActionsViewItem(
						action,
						() => this.secondaryActions,
						options.contextMenuProvider,
						actionOptions,
					);
				}
				return options.actionViewItemProvider?.(action, actionOptions);
			},
		}));
		this.element = this.actionBar.element;
		this.element.classList.add("ash-toolbar", `ash-toolbar-${options.presentation ?? "default"}`);
	}

	setActions(
		primaryActions: readonly IAction[],
		secondaryActions: readonly IAction[] = [],
	): void {
		const primary = cleanSeparators(primaryActions);
		this.secondaryActions = cleanSeparators(secondaryActions);
		this.actionBar.setActions(this.withMoreActions(primary));
	}

	focus(): void {
		this.actionBar.focus();
	}

	/** Refreshes retained action slots when their ordering and presence are unchanged. */
	protected updateActions(
		primaryActions: readonly IAction[],
		secondaryActions: readonly IAction[] = [],
	): void {
		const primary = cleanSeparators(primaryActions);
		this.secondaryActions = cleanSeparators(secondaryActions);
		this.actionBar.updateActions(this.withMoreActions(primary));
	}

	private withMoreActions(primary: readonly IAction[]): readonly IAction[] {
		if (this.secondaryActions.length === 0) return primary;
		const beforeActionId = this.moreActionsPlacement?.beforeActionId;
		const index = beforeActionId === undefined
			? -1
			: primary.findIndex((action) => action.id === beforeActionId);
		if (index < 0) return [...primary, this.moreActions];
		return [
			...primary.slice(0, index),
			this.moreActions,
			...primary.slice(index),
		];
	}
}

class MoreActionsAction implements IAction {
	readonly id = "ash.toolbar.moreActions";
	readonly label = "More Actions";
	readonly tooltip = "More Actions";
	readonly icon = Lxicon.ellipsis;
	readonly enabled = true;
	readonly checked = undefined;

	run(): void {}
}

class MoreActionsViewItem extends DropdownMenuActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-toolbar-more-actions");
	}
}

function cleanSeparators(actions: readonly IAction[]): IAction[] {
	const result: IAction[] = [];
	for (const action of actions) {
		if (
			action instanceof Separator &&
			(result.length === 0 || result[result.length - 1] instanceof Separator)
		) {
			continue;
		}
		result.push(action);
	}
	if (result[result.length - 1] instanceof Separator) result.pop();
	return result;
}
