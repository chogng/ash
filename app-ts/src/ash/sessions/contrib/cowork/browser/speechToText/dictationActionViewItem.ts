import { ButtonActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../../base/common/actions.js';

/** The ActionBar owns this button's lifetime; the editor session owns its action and state. */
export class DictationActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction) {
		super(action);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-cowork-input-mic');
		container.classList.toggle('disabled', !this.action.enabled);
		this.button.toggleClassName('ash-cowork-input-action', true);
		this.button.toggleClassName('ash-cowork-input-mic-action', true);
		this.button.toggleClassName('disabled', !this.action.enabled);
	}
}
