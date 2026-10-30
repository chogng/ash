import type { IButtonStyles } from '../button/button.js';
import './toolbar.css';
import { localize } from '../../../../nls.js';
import type { IContextMenuProvider } from '../../contextmenu.js';
import type { IAction } from '../../../common/actions.js';
import { Separator } from '../../../common/actions.js';
import { Disposable } from '../../../common/lifecycle.js';
import { Lxicon } from '../../../common/lxicons.js';
import { ActionBar, type ActionBarOrientation, type ActionViewItemProvider } from '../actionbar/actionbar.js';
import type { ActionViewItemOptions } from '../actionbar/actionViewItems.js';
import type { AnchorPosition } from '../contextview/contextview.js';
import { DropdownMenuActionViewItem } from '../dropdown/dropdownMenuActionViewItem.js';

export interface ToolBarOptions {
	readonly buttonStyles?: IButtonStyles;
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
export type ToolBarPresentation = 'default' | 'inherit-foreground';

/**
 * Presents primary actions inline, secondary actions in a menu, and pinned
 * trailing actions after that menu.
 *
 * Callers own action classification. The toolbar owns the synthetic More
 * Actions item and delegates its secondary menu to the supplied provider.
 */
export class ToolBar extends Disposable {
	readonly element: HTMLDivElement;
	private readonly actionBar: ActionBar;
	private readonly moreActions = new MoreActionsAction();
	private readonly moreActionsPlacement: MoreActionsPlacement | undefined;
	private primaryActions: readonly IAction[] = [];
	private menuActions: readonly IAction[] = [];
	private secondaryActions: readonly IAction[] = [];
	private trailingActions: readonly IAction[] = [];
	private renderedActions: readonly IAction[] = [];
	private readonly actionWidths = new Map<IAction, number>();
	private availableWidth: number | undefined;

	constructor(container: HTMLElement, options: ToolBarOptions) {
		super();
		this.moreActionsPlacement = options.moreActionsPlacement;
		const actionViewItemOptions: ActionViewItemOptions = { buttonStyles: options.buttonStyles, hoverAnchorPosition: options.hoverAnchorPosition };
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
		this.element.classList.add('ash-toolbar', `ash-toolbar-${options.presentation ?? 'default'}`);
	}

	setActions(
		primaryActions: readonly IAction[],
		secondaryActions: readonly IAction[] = [],
		trailingActions: readonly IAction[] = [],
	): void {
		const primary = cleanSeparators(primaryActions);
		this.primaryActions = primary;
		this.menuActions = this.secondaryActions = cleanSeparators(secondaryActions);
		this.trailingActions = cleanSeparators(trailingActions);
		this.actionWidths.clear();
		this.renderActions(this.withMoreActions(primary));
		if (this.availableWidth !== undefined) this.layout(this.availableWidth);
	}

	/** Fits primary actions to a host-supplied width, moving the trailing suffix into More Actions. */
	layout(width: number): void {
		this.availableWidth = Math.max(0, width);
		this.element.classList.add('ash-toolbar-responsive');
		const all = [...this.primaryActions, this.moreActions, ...this.trailingActions];
		const activeElement = this.element.ownerDocument.activeElement;
		const focusedAction = this.renderedActions.find((_, index) => this.element.children[index]?.contains(activeElement));
		if (all.some(action => !this.actionWidths.has(action))) {
			// Measure real custom action views and the menu trigger before choosing a prefix.
			this.renderActions(all);
		}
		const styles = this.element.ownerDocument.defaultView!.getComputedStyle(this.element);
		const gap = Number.parseFloat(styles.columnGap) || 0;
		// A restored custom view can have a new label width; measure it once more before settling.
		for (let pass = 0; pass < 2; pass++) {
			for (let index = 0; index < this.renderedActions.length; index++) {
				this.actionWidths.set(this.renderedActions[index]!, this.actionBar.getItemWidth(index));
			}
			const fits = (actions: readonly IAction[]): boolean => {
				const itemWidths = actions.reduce((total, action) => total + (this.actionWidths.get(action) ?? 0), 0);
				return itemWidths + Math.max(0, actions.length - 1) * gap <= this.availableWidth!;
			};
			let count = this.primaryActions.length;
			if (this.menuActions.length > 0 || !fits([...this.primaryActions, ...this.trailingActions])) {
				while (count > 0) {
					const primary = cleanSeparators(this.primaryActions.slice(0, count));
					if (fits([...primary, this.moreActions, ...this.trailingActions])) break;
					count--;
				}
			}
			const overflow = cleanSeparators(this.primaryActions.slice(count));
			this.secondaryActions = cleanSeparators([
				...overflow,
				...(overflow.length && this.menuActions.length ? [new Separator()] : []),
				...this.menuActions,
			]);
			this.renderActions(this.withMoreActions(cleanSeparators(this.primaryActions.slice(0, count))));
		}
		if (focusedAction && !this.renderedActions.includes(focusedAction)) {
			// A shrinking toolbar must keep its focused operation reachable from the keyboard.
			if (this.renderedActions.includes(this.moreActions)) this.actionBar.setTabStop(this.moreActions.id);
			this.actionBar.focus();
		}
	}

	focus(): void {
		this.actionBar.focus();
	}

	/** Refreshes retained action slots when their ordering and presence are unchanged. */
	protected updateActions(
		primaryActions: readonly IAction[],
		secondaryActions: readonly IAction[] = [],
		trailingActions: readonly IAction[] = [],
	): void {
		const primary = cleanSeparators(primaryActions);
		this.primaryActions = primary;
		this.menuActions = this.secondaryActions = cleanSeparators(secondaryActions);
		this.trailingActions = cleanSeparators(trailingActions);
		this.actionWidths.clear();
		this.renderActions(this.withMoreActions(primary), true);
		if (this.availableWidth !== undefined) this.layout(this.availableWidth);
	}

	private renderActions(actions: readonly IAction[], update = false): void {
		this.renderedActions = actions;
		if (update) this.actionBar.updateActions(actions);
		else this.actionBar.setActions(actions);
	}

	private withMoreActions(primary: readonly IAction[]): readonly IAction[] {
		if (this.secondaryActions.length === 0) return [...primary, ...this.trailingActions];
		const beforeActionId = this.moreActionsPlacement?.beforeActionId;
		const index = beforeActionId === undefined
			? -1
			: primary.findIndex((action) => action.id === beforeActionId);
		if (index < 0) return [...primary, this.moreActions, ...this.trailingActions];
		return [
			...primary.slice(0, index),
			this.moreActions,
			...primary.slice(index),
			...this.trailingActions,
		];
	}
}

class MoreActionsAction implements IAction {
	readonly id = 'ash.toolbar.moreActions';
	readonly label = localize('toolbar.moreActions', 'More Actions');
	readonly tooltip = this.label;
	readonly icon = Lxicon.ellipsis;
	readonly enabled = true;
	readonly checked = undefined;

	run(): void { }
}

class MoreActionsViewItem extends DropdownMenuActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-toolbar-more-actions');
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
