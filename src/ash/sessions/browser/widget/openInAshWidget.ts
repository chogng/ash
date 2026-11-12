import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../base/common/actions.js';
import '../media/openInAsh.css';

/** Reveals the IDE action's label without adding a second focus target. */
export class OpenInAshTitleBarWidget extends ButtonActionViewItem {
	constructor(action: IAction, options: ActionViewItemOptions) {
		super(action, { ...options, iconOnly: false });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		// Let this action size to its caption when expanded.
		container.classList.remove('icon');
		this.button.domNode.classList.add('ash-open-in-ash-widget');
	}

	protected override setupTooltip(): void {
		// The button itself reveals the action label on hover and keyboard focus.
	}
}
